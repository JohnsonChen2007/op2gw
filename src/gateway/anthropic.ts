import { Readable } from 'node:stream'

/**
 * Anthropic Messages API <-> OpenAI Chat Completions bridge.
 *
 * WHY THIS EXISTS
 * Claude Code speaks the Anthropic Messages protocol exclusively: it POSTs to
 * `/v1/messages` with `system` as a top-level string, content blocks, and
 * `tool_use` / `tool_result` blocks, and it expects the Anthropic response
 * envelope back. op2gw's existing surface is OpenAI-shaped
 * (`/v1/chat/completions`, `/v1/responses`), so pointing Claude Code straight at
 * the gateway 404s.
 *
 * This module is PURELY ADDITIVE. It converts:
 *   request:  Anthropic Messages  -> OpenAI chat body   (messagesToChatBody)
 *   response: OpenAI chat body   -> Anthropic Messages  (chatToMessagesBody)
 *   stream:   OpenAI chat SSE    -> Anthropic SSE events (chatToMessagesStream)
 *
 * Nothing here touches the upstream Zen dialect: the gateway still decides the
 * wire API from the model (see protocol.ts) and still runs the free-lane gate.
 * Anthropic is a CLIENT dialect only, exactly like `chat` and `responses`.
 *
 * Streaming contract: Anthropic SSE requires this exact event order —
 *   message_start -> content_block_start -> content_block_delta* ->
 *   content_block_stop -> message_delta -> message_stop
 * Claude Code's parser is strict about it, so the stream builder emits all six
 * unconditionally (an empty delta run is legal and still carries usage).
 */

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Anthropic stop_reason -> OpenAI finish_reason. */
function finishToStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'stop':
    case 'end_turn':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

/** Flatten Anthropic content (string or block array) into plain text. */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!isRecord(block)) continue
    // thinking / redacted_thinking carry no user-visible text
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * Convert one Anthropic content block to its OpenAI message fragment.
 * Returns a partial message object to be merged by the caller.
 */
function blockToOpenAI(block: Json): Json | null {
  const type = typeof block.type === 'string' ? block.type : 'text'
  if (type === 'text') {
    const text = typeof block.text === 'string' ? block.text : ''
    return { kind: 'text', text }
  }
  if (type === 'tool_use') {
    return {
      kind: 'tool_call',
      id: typeof block.id === 'string' ? block.id : `call_${Math.random().toString(36).slice(2, 10)}`,
      name: typeof block.name === 'string' ? block.name : 'unknown',
      args: isRecord(block.input) ? block.input : {},
    }
  }
  if (type === 'tool_result') {
    return {
      kind: 'tool_result',
      toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
      content: blocksToText(block.content),
      isError: block.is_error === true,
    }
  }
  // thinking / redacted_thinking / image / document: keep only the text we can
  // express in the OpenAI dialect; dropping the rest is safer than emitting a
  // shape the upstream rejects with a 400.
  if (type === 'thinking' && typeof block.thinking === 'string') {
    return { kind: 'text', text: block.thinking }
  }
  return null
}

/** Convert Anthropic `tools` to OpenAI function tools. */
function toolsToOpenAI(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return []
  const out: Json[] = []
  for (const tool of tools) {
    if (!isRecord(tool)) continue
    if (typeof tool.name !== 'string') continue
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} },
      },
    })
  }
  return out
}

/** Convert Anthropic `tool_choice` to the OpenAI union. */
function toolChoiceToOpenAI(choice: unknown): unknown {
  if (!isRecord(choice)) return undefined
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } }
  }
  return undefined
}

/**
 * Anthropic Messages request -> OpenAI Chat Completions request.
 *
 * Claude Code always sends `stream: true`, but we honour either: the gateway
 * forces wire streaming anyway and re-aggregates for non-streaming clients, so
 * we simply pass the client's intent through as `stream`.
 */
export function messagesToChatBody(body: unknown): Json {
  const src = isRecord(body) ? body : {}
  const messages: Json[] = []

  // Anthropic carries the system prompt as a top-level field, not a message.
  const system = blocksToText(src.system)
  if (system.length > 0) messages.push({ role: 'system', content: system })

  const raw = Array.isArray(src.messages) ? src.messages : []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const role = typeof entry.role === 'string' ? entry.role : 'user'
    const content = entry.content

    if (typeof content === 'string') {
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content })
      continue
    }
    if (!Array.isArray(content)) {
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: '' })
      continue
    }

    // Group consecutive fragments so one Anthropic turn can become several
    // OpenAI messages (Anthropic interleaves tool_use/tool_result in one turn;
    // OpenAI wants tool_calls on the assistant turn and role:'tool' replies).
    const pendingText: string[] = []
    const pendingCalls: Json[] = []

    const flushText = (asRole: string): void => {
      if (pendingText.length === 0) return
      messages.push({ role: asRole, content: pendingText.join('') })
      pendingText.length = 0
    }

    for (const rawBlock of content) {
      const block = isRecord(rawBlock) ? rawBlock : null
      const frag = block ? blockToOpenAI(block) : typeof rawBlock === 'string' ? { kind: 'text', text: rawBlock } : null
      if (!frag) continue
      if (frag.kind === 'text') {
        pendingText.push(String(frag.text))
        continue
      }
      if (frag.kind === 'tool_call') {
        flushText(role === 'assistant' ? 'assistant' : 'user')
        pendingCalls.push({
          id: frag.id,
          type: 'function',
          function: { name: frag.name, arguments: JSON.stringify(frag.args) },
        })
        continue
      }
      if (frag.kind === 'tool_result') {
        // A tool result always belongs to the assistant turn that requested it.
        flushText(role === 'assistant' ? 'assistant' : 'user')
        if (pendingCalls.length > 0) {
          messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls.splice(0) })
        }
        messages.push({
          role: 'tool',
          tool_call_id: frag.toolUseId,
          content: frag.isError ? `[tool error] ${frag.content}` : frag.content,
        })
      }
    }

    if (pendingCalls.length > 0) {
      flushText(role === 'assistant' ? 'assistant' : 'user')
      messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls })
    } else {
      flushText(role === 'assistant' ? 'assistant' : 'user')
    }
  }

  const out: Json = {
    model: typeof src.model === 'string' ? src.model : '',
    messages,
    stream: src.stream === true,
  }

  const maxTokens = typeof src.max_tokens === 'number' ? src.max_tokens : undefined
  if (maxTokens !== undefined) out.max_tokens = maxTokens
  const temperature = typeof src.temperature === 'number' ? src.temperature : undefined
  if (temperature !== undefined) out.temperature = temperature
  const topP = typeof src.top_p === 'number' ? src.top_p : undefined
  if (topP !== undefined) out.top_p = topP
  if (src.stop_sequences !== undefined) out.stop = src.stop_sequences

  const tools = toolsToOpenAI(src.tools)
  if (tools.length > 0) out.tools = tools
  const toolChoice = toolChoiceToOpenAI(src.tool_choice)
  if (toolChoice !== undefined) out.tool_choice = toolChoice

  return out
}

/** Build the Anthropic `usage` block from an OpenAI usage object. */
function toAnthropicUsage(usage: unknown): Json {
  const u = isRecord(usage) ? usage : {}
  const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0
  const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0
  const cacheRead = isRecord(u.prompt_tokens_details) && typeof u.prompt_tokens_details.cached_tokens === 'number'
    ? u.prompt_tokens_details.cached_tokens
    : 0
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead }
}

function textFromChatContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (isRecord(part) && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('')
}

/** Parse a possibly-partial `tool_calls[].function.arguments` string. */
function safeParseArgs(args: string): Json {
  if (args.length === 0) return {}
  try {
    const parsed = JSON.parse(args)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Reasoning models (muse-spark-*) can spend the whole `max_tokens` budget on
 * their thinking and return an EMPTY `content` alongside a populated
 * `reasoning` field. Claude Code renders an empty message as a broken turn, so
 * when there is no visible text we fall back to the reasoning text rather than
 * handing back nothing.
 */
function visibleOrReasoningText(message: Json): string {
  const text = textFromChatContent(message.content)
  if (text.length > 0) return text
  if (typeof message.reasoning === 'string' && message.reasoning.length > 0) return message.reasoning
  if (Array.isArray(message.reasoning_content)) {
    const joined = textFromChatContent(message.reasoning_content)
    if (joined.length > 0) return joined
  }
  return ''
}

/** OpenAI chat completion (object) -> Anthropic Messages response. */
export function chatToMessagesBody(body: unknown, requestedModel: string): Json {
  const src = isRecord(body) ? body : {}
  const choices = Array.isArray(src.choices) ? src.choices : []
  const choice = isRecord(choices[0]) ? (choices[0] as Json) : {}
  const message = isRecord(choice.message) ? (choice.message as Json) : {}

  const content: Json[] = []
  const text = visibleOrReasoningText(message)
  if (text.length > 0) content.push({ type: 'text', text })

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call)) continue
      const fn = isRecord(call.function) ? (call.function as Json) : {}
      content.push({
        type: 'tool_use',
        id: typeof call.id === 'string' ? call.id : `call_${Math.random().toString(36).slice(2, 10)}`,
        name: typeof fn.name === 'string' ? fn.name : 'unknown',
        input: safeParseArgs(typeof fn.arguments === 'string' ? fn.arguments : ''),
      })
    }
  }

  const stopReason = finishToStopReason(typeof choice.finish_reason === 'string' ? choice.finish_reason : null)
  return {
    id: typeof src.id === 'string' && src.id.length > 0 ? `msg_${src.id}` : `msg_${Math.random().toString(36).slice(2, 20)}`,
    type: 'message',
    role: 'assistant',
    model: typeof src.model === 'string' && src.model.length > 0 ? src.model : requestedModel,
    content,
    stop_reason: content.length === 0 ? 'end_turn' : stopReason,
    stop_sequence: null,
    usage: toAnthropicUsage(src.usage),
  }
}

/** Render one Anthropic SSE event. */
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * OpenAI chat SSE -> Anthropic Messages SSE.
 *
 * Emits the full Anthropic event sequence. Text deltas share content block
 * index 0; each tool call gets its own index. `message_delta` carries the final
 * stop_reason and usage, which is where Claude Code reads token counts.
 */
export function chatToMessagesStream(source: Readable, requestedModel: string): Readable {
  const model = requestedModel
  let textOpen = false
  // tool index -> { blockIndex, json buffer, name }
  const toolState = new Map<number, { blockIndex: number; args: string; name: string }>()
  let nextBlockIndex = 1 // 0 is reserved for text
  let finishReason: string | null = null
  let usage: unknown

  const start = (): string => {
    return (
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${Math.random().toString(36).slice(2, 20)}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }) + sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    )
  }

  const finish = (): string => {
    let out = ''
    if (textOpen) {
      out += sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
      textOpen = false
    }
    for (const [, state] of toolState) {
      out += sseEvent('content_block_stop', { type: 'content_block_stop', index: state.blockIndex })
    }
    out += sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: finishToStopReason(finishReason), stop_sequence: null },
      usage: toAnthropicUsage(usage),
    })
    out += sseEvent('message_stop', { type: 'message_stop' })
    return out
  }

  // `Readable` has no `start` hook, so the source is wired after construction
  // and the opening events are pushed immediately.
  const out = new Readable({ read() {} })
  const push = (text: string): void => {
    out.push(Buffer.from(text, 'utf8'))
  }
  push(start())
  let buffer = ''

  source.on('data', (chunk: Buffer | string) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data.length === 0 || data === '[DONE]') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }
        if (!isRecord(parsed)) continue

        if (isRecord(parsed.error)) {
          // Surface an in-stream upstream error as an Anthropic error event
          // rather than silently ending the message.
          const err = parsed.error as Json
          push(
            sseEvent('error', {
              type: 'error',
              error: {
                type: 'api_error',
                message: typeof err.message === 'string' ? err.message : 'upstream error',
              },
            }),
          )
          return
        }

        if (isRecord(parsed.usage)) usage = parsed.usage
        const choices = Array.isArray(parsed.choices) ? parsed.choices : []
        const choice = isRecord(choices[0]) ? (choices[0] as Json) : {}
        if (typeof choice.finish_reason === 'string' && choice.finish_reason !== null) {
          finishReason = choice.finish_reason
        }
        const delta = isRecord(choice.delta) ? (choice.delta as Json) : {}

        // Same reasoning-fallback rule as the non-streaming path: a reasoning
        // model that spent its budget on thinking sends text_delta-less chunks.
        const text = visibleOrReasoningText(delta)
        if (text.length > 0) {
          textOpen = true
          push(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            }),
          )
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (!isRecord(call)) continue
            const callIndex = typeof call.index === 'number' ? call.index : 0
            const fn = isRecord(call.function) ? (call.function as Json) : {}
            let state = toolState.get(callIndex)
            if (!state) {
              state = { blockIndex: nextBlockIndex, args: '', name: typeof fn.name === 'string' ? fn.name : 'unknown' }
              nextBlockIndex += 1
              toolState.set(callIndex, state)
              push(
                sseEvent('content_block_start', {
                  type: 'content_block_start',
                  index: state.blockIndex,
                  content_block: { type: 'tool_use', id: `call_${Math.random().toString(36).slice(2, 12)}`, name: state.name, input: {} },
                }),
              )
            }
            if (typeof fn.name === 'string' && fn.name.length > 0) state.name = fn.name
            if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
              state.args += fn.arguments
              push(
                sseEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: state.blockIndex,
                  delta: { type: 'input_json_delta', partial_json: fn.arguments },
                }),
              )
            }
          }
        }
      }
    }
  })

  source.on('end', () => {
    push(finish())
    out.push(null)
  })
  source.on('error', (err) => out.destroy(err))
  return out
}

/** Gateway error -> Anthropic error envelope (Claude Code reads `error.type`). */
export function toAnthropicErrorBody(message: string, type: string): string {
  // Anthropic's own error types must pass through unchanged (Claude Code
  // branches on `authentication_error` vs `invalid_request_error`); anything
  // else is reported as a generic API error.
  const known = new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'api_error'])
  const anthropicType = known.has(type) ? type : 'api_error'
  return JSON.stringify({ type: 'error', error: { type: anthropicType, message } })
}
