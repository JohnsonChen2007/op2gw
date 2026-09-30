import { Readable } from 'node:stream'

import type { UpstreamApi } from '../core/types.js'

/**
 * Protocol bridge — decouples the dialect a client speaks from the dialect the
 * upstream serves for a given model.
 *
 * Zen's endpoints are partitioned by model, and NOT in the way the names
 * suggest. Measured 2026-10-01 against the anonymous lane:
 *
 *   - zero-cost "free" chat models (big-pickle, longcat-*, mimo-*, space-bunny,
 *     nemotron-*, ling-3.0-flash-fin-free, jev-1.13-free, …) answer
 *     /v1/chat/completions 200 and /v1/responses 500.
 *   - the contributor-free muse-spark ids answer BOTH endpoints, and both are
 *     403 RegionError, so no endpoint choice can serve them from outside
 *     OpenCode's supported regions. They are still routed through /v1/responses
 *     because that is the only dialect they are documented against.
 *   - paid / non-free ids answer 401 (AuthError) on both.
 *
 * So the gateway picks the upstream dialect from the MODEL and translates in
 * both directions:
 *   client chat      + responses-model -> upstream responses, SSE -> chat chunks
 *   client responses + chat-model      -> upstream chat,      SSE -> responses events
 *
 * The mapping is a table (`RESPONSES_WIRE_MODELS`) rather than a hard-coded
 * regex so a future responses-only model is a one-line addition. When both
 * dialects already match, the gateway skips this module entirely.
 */

/**
 * Model families upstream serves over the Responses API. Every other model
 * (including every zero-cost chat model) is served over Chat Completions.
 *
 * Keep the patterns anchored: an unanchored `/muse-spark/` would also match a
 * hypothetical chat-served `muse-spark-*-instruct` id.
 */
const RESPONSES_WIRE_MODELS: RegExp[] = [/^muse-spark-1\.\d+-contributor/, /^muse-spark-\d/]

/** The dialect upstream will accept for this model. */
export function resolveUpstreamApi(model: string): UpstreamApi {
  return RESPONSES_WIRE_MODELS.some((re) => re.test(model)) ? 'responses' : 'chat'
}

/** True when the model is expected to be served over the Responses API. */
export function isResponsesWireModel(model: string): boolean {
  return resolveUpstreamApi(model) === 'responses'
}

type Json = Record<string, unknown>

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

/**
 * chat body -> responses body. Produces a well-formed `input` array so the
 * responses free-lane gate (which requires an array) can inject its tools.
 *
 * The two dialects do NOT share a message vocabulary, and sending chat-shaped
 * roles upstream is rejected outright (`input[1] did not match any supported
 * type`). Two translations are therefore mandatory:
 *
 *   - `system` has no role slot in `input`; the Responses API carries the
 *     system prompt as a top-level `instructions` string. Emitting
 *     `{role:'system'}` happens to be tolerated by Zen today, but it is not a
 *     supported input type and `developer` is outright rejected.
 *   - a `tool` result is not a message either: it is a `function_call_output`
 *     item keyed by `call_id`. Leaving it as `{role:'tool'}` is the exact 400
 *     that breaks any tool-using conversation on a Responses-wire model.
 */
export function chatToResponsesBody(body: Json): Json {
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : []
  const instructions: string[] = []
  const input: Json[] = []

  for (const m of messages) {
    const msg = isRecord(m) ? m : {}
    const role = typeof msg.role === 'string' ? msg.role : 'user'

    if (role === 'system' || role === 'developer') {
      const text = textOf(role === 'system' ? msg.content : msg.content)
      if (text.length > 0) instructions.push(text)
      continue
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(msg.tool_call_id ?? msg.call_id ?? 'call_0'),
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
      })
      continue
    }
    // An assistant turn that requested tools must become function_call items,
    // otherwise the following function_call_output has no call to bind to.
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const text = textOf(msg.content)
      if (text.length > 0) input.push({ role: 'assistant', content: toResponsesContent(msg.content) })
      for (const call of msg.tool_calls) {
        if (!isRecord(call)) continue
        const fn = isRecord(call.function) ? call.function : {}
        input.push({
          type: 'function_call',
          call_id: String(call.id ?? 'call_0'),
          name: String(fn.name ?? ''),
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? ''),
        })
      }
      continue
    }
    input.push({ role, content: toResponsesContent(msg.content) })
  }

  const out: Json = {
    model: body.model,
    input: input.length > 0 ? input : [{ role: 'user', content: '' }],
    stream: body.stream !== false,
  }
  const instructionsText = instructions.join('\n\n')
  if (instructionsText.length > 0) out.instructions = instructionsText
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  if (typeof maxTokens === 'number') out.max_output_tokens = maxTokens
  if (typeof body.parallel_tool_calls === 'boolean') out.parallel_tool_calls = body.parallel_tool_calls
  if (typeof body.user === 'string') out.metadata = { user_id: body.user }

  const tools = Array.isArray(body.tools) ? body.tools : []
  const mapped = tools.map(chatToolToResponses).filter((t): t is Json => t !== null)
  if (mapped.length > 0) out.tools = mapped

  const choice = chatToolChoiceToResponses(body.tool_choice)
  if (choice !== undefined) out.tool_choice = choice
  return out
}

/** responses body -> chat body. Produces a `messages` array for the chat gate. */
export function responsesToChatBody(body: Json): Json {
  const raw = Array.isArray(body.input) ? body.input : [body.input]
  const messages: Json[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.length > 0) messages.push({ role: 'user', content: item })
      continue
    }
    if (!isRecord(item)) continue
    const type = typeof item.type === 'string' ? item.type : ''
    if (type === 'reasoning') continue
    if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        tool_calls: [
          {
            id: String(item.call_id ?? item.id ?? 'call_0'),
            type: 'function',
            function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '') },
          },
        ],
      })
      continue
    }
    if (type === 'function_call_output') {
      const output = item.output
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id ?? ''),
        content: typeof output === 'string' ? output : JSON.stringify(output ?? null),
      })
      continue
    }
    const role = typeof item.role === 'string' ? item.role : 'user'
    messages.push({ role, content: fromResponsesContent(item.content) })
  }
  if (messages.length === 0) messages.push({ role: 'user', content: '' })

  const out: Json = { model: body.model, messages, stream: body.stream !== false }
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (typeof body.max_output_tokens === 'number') out.max_tokens = body.max_output_tokens
  if (typeof body.parallel_tool_calls === 'boolean') out.parallel_tool_calls = body.parallel_tool_calls

  const tools = Array.isArray(body.tools) ? body.tools : []
  const mapped = tools.map(responsesToolToChat).filter((t): t is Json => t !== null)
  if (mapped.length > 0) out.tools = mapped

  const choice = responsesToolChoiceToChat(body.tool_choice)
  if (choice !== undefined) out.tool_choice = choice
  return out
}

/** Flatten any chat content shape into plain text (for `instructions`). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') parts.push(part)
      else if (isRecord(part) && typeof part.text === 'string') parts.push(part.text)
    }
    return parts.join('')
  }
  if (content === null || content === undefined) return ''
  return String(content)
}

function toResponsesContent(content: unknown): unknown {  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: Json[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push({ type: 'input_text', text: part })
        continue
      }
      if (!isRecord(part)) continue
      if (part.type === 'input_text' || part.type === 'input_image') {
        parts.push(part)
        continue
      }
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push({ type: 'input_text', text: part.text })
        continue
      }
      if (part.type === 'image_url') {
        const url = isRecord(part.image_url) ? part.image_url.url : part.image_url
        parts.push({ type: 'input_image', image_url: typeof url === 'string' ? url : '' })
        continue
      }
      if (typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text })
    }
    return parts.length > 0 ? parts : ''
  }
  if (content === null || content === undefined) return ''
  return JSON.stringify(content)
}

function fromResponsesContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    const images: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        texts.push(part)
        continue
      }
      if (!isRecord(part)) continue
      if (typeof part.text === 'string') texts.push(part.text)
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url
      if (typeof url === 'string') images.push(url)
    }
    if (images.length === 0) return texts.join('')
    const out: Json[] = texts.map((text) => ({ type: 'text', text }))
    for (const url of images) out.push({ type: 'image_url', image_url: { url } })
    return out
  }
  if (content === null || content === undefined) return ''
  return JSON.stringify(content)
}

function chatToolToResponses(tool: unknown): Json | null {
  if (!isRecord(tool)) return null
  if (tool.type === 'function' && isRecord(tool.function)) {
    const fn = tool.function
    return {
      type: 'function',
      name: String(fn.name ?? ''),
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
    }
  }
  if (tool.type === 'function' && typeof tool.name === 'string') return tool
  return null
}

function responsesToolToChat(tool: unknown): Json | null {
  if (!isRecord(tool)) return null
  if (tool.type === 'function' && typeof tool.name === 'string' && !isRecord(tool.function)) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: isRecord(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
      },
    }
  }
  if (isRecord(tool.function)) return tool
  return null
}

function chatToolChoiceToResponses(choice: unknown): unknown {
  if (typeof choice === 'string') return choice
  if (isRecord(choice) && choice.type === 'function') {
    const fn = isRecord(choice.function) ? choice.function : choice
    return { type: 'function', name: String(fn.name ?? '') }
  }
  return undefined
}

function responsesToolChoiceToChat(choice: unknown): unknown {
  if (typeof choice === 'string') return choice
  if (isRecord(choice) && choice.type === 'function') {
    return { type: 'function', function: { name: String(choice.name ?? '') } }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Response translation — helpers
// ---------------------------------------------------------------------------

async function collectSseObjects(source: Readable): Promise<Json[]> {
  const out: Json[] = []
  let buf = ''
  for await (const chunk of source) {
    buf += String(chunk)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      const payload = ssePayload(line)
      if (!payload || payload === '[DONE]') continue
      try {
        const obj = JSON.parse(payload)
        if (isRecord(obj)) out.push(obj)
      } catch {
        // ignore keep-alives / non-JSON
      }
    }
  }
  const rest = ssePayload(buf)
  if (rest && rest !== '[DONE]') {
    try {
      const obj = JSON.parse(rest)
      if (isRecord(obj)) out.push(obj)
    } catch {
      // ignore
    }
  }
  return out
}

function ssePayload(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''
  return trimmed.slice(5).trim()
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function chatChunk(ctx: { id: string; created: number; model: string }, delta: Json, finish: string | null, usage?: Json): string {
  return sseLine({
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })
}

// ---------------------------------------------------------------------------
// responses (upstream) -> chat (client)
// ---------------------------------------------------------------------------

interface ChatCtx {
  id: string
  created: number
  model: string
  roleSent: boolean
  finished: boolean
  finish: string | null
  text: string
  toolIndex: Map<string, number>
  toolCalls: Map<number, { id?: string; name?: string; args: string }>
}

function newChatCtx(model: string): ChatCtx {
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    created: nowSeconds(),
    model,
    roleSent: false,
    finished: false,
    finish: null,
    text: '',
    toolIndex: new Map(),
    toolCalls: new Map(),
  }
}

function ensureRole(ctx: ChatCtx): string[] {
  if (ctx.roleSent) return []
  ctx.roleSent = true
  return [chatChunk(ctx, { role: 'assistant', content: '' }, null)]
}

function mapUsage(usage: unknown): Json | undefined {
  if (!isRecord(usage)) return undefined
  const input = usage.input_tokens ?? usage.prompt_tokens
  const output = usage.output_tokens ?? usage.completion_tokens
  const total = usage.total_tokens ?? 0
  if (typeof input !== 'number' && typeof output !== 'number') return undefined
  return {
    prompt_tokens: typeof input === 'number' ? input : 0,
    completion_tokens: typeof output === 'number' ? output : 0,
    total_tokens: typeof total === 'number' ? total : 0,
  }
}

/** Feed one upstream responses event; returns SSE lines to emit. */
function responsesEventToChat(ctx: ChatCtx, evt: Json): string[] {
  const type = typeof evt.type === 'string' ? evt.type : ''
  const out: string[] = []

  if (type === 'response.created' || type === 'response.in_progress') {
    const resp = isRecord(evt.response) ? evt.response : undefined
    if (resp) {
      if (typeof resp.id === 'string') ctx.id = `chatcmpl-${resp.id.replace(/^resp_/, '')}`
      if (typeof resp.created_at === 'number') ctx.created = resp.created_at
      if (typeof resp.model === 'string') ctx.model = resp.model
    }
    out.push(...ensureRole(ctx))
    return out
  }

  if (type === 'response.output_text.delta') {
    ctx.text += String(evt.delta ?? '')
    out.push(...ensureRole(ctx))
    out.push(chatChunk(ctx, { content: String(evt.delta ?? '') }, null))
    return out
  }

  if (type === 'response.output_item.added') {
    const item = isRecord(evt.item) ? evt.item : undefined
    if (item && item.type === 'function_call') {
      const key = String(item.id ?? evt.item_id ?? `tc${ctx.toolCalls.size}`)
      const index = ctx.toolCalls.size
      ctx.toolIndex.set(key, index)
      const call = { id: String(item.call_id ?? item.id ?? `call_${index}`), name: String(item.name ?? ''), args: '' }
      ctx.toolCalls.set(index, call)
      ctx.finish = 'tool_calls'
      out.push(...ensureRole(ctx))
      out.push(
        chatChunk(ctx, {
          tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }],
        }, null),
      )
    }
    return out
  }

  if (type === 'response.function_call_arguments.delta') {
    const key = String(evt.item_id ?? '')
    const index = ctx.toolIndex.get(key)
    if (index !== undefined) {
      const call = ctx.toolCalls.get(index)
      const delta = String(evt.delta ?? '')
      if (call) call.args += delta
      out.push(chatChunk(ctx, { tool_calls: [{ index, function: { arguments: delta } }] }, null))
    }
    return out
  }

  if (type === 'response.output_item.done') {
    const item = isRecord(evt.item) ? evt.item : undefined
    if (item && item.type === 'function_call') {
      const key = String(item.id ?? evt.item_id ?? '')
      const index = ctx.toolIndex.get(key) ?? ctx.toolCalls.size
      const existing = ctx.toolCalls.get(index)
      const call = {
        id: String(item.call_id ?? item.id ?? existing?.id ?? `call_${index}`),
        name: String(item.name ?? existing?.name ?? ''),
        args: typeof item.arguments === 'string' ? item.arguments : (existing?.args ?? ''),
      }
      ctx.toolIndex.set(key, index)
      ctx.toolCalls.set(index, call)
      ctx.finish = 'tool_calls'
      out.push(...ensureRole(ctx))
      out.push(
        chatChunk(ctx, {
          tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }],
        }, null),
      )
    }
    return out
  }

  if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
    const resp = isRecord(evt.response) ? evt.response : undefined
    if (resp) {
      if (typeof resp.id === 'string') ctx.id = `chatcmpl-${resp.id.replace(/^resp_/, '')}`
      if (typeof resp.model === 'string') ctx.model = resp.model
    }
    const finish = ctx.finish ?? 'stop'
    const usage = resp ? mapUsage(resp.usage) : undefined
    out.push(...ensureRole(ctx))
    out.push(chatChunk(ctx, {}, finish, usage))
    out.push('data: [DONE]\n\n')
    ctx.finished = true
    return out
  }

  return out
}

/** Translate a responses SSE stream into a chat-completions SSE stream. */
export function responsesToChatStream(source: Readable, model: string): Readable {
  const out = new Readable({ read() {} })
  void (async () => {
    const ctx = newChatCtx(model)
    let buf = ''
    try {
      for await (const chunk of source) {
        buf += String(chunk)
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          const payload = ssePayload(line)
          if (!payload || payload === '[DONE]') continue
          let evt: Json
          try {
            const parsed = JSON.parse(payload)
            if (!isRecord(parsed)) continue
            evt = parsed
          } catch {
            continue
          }
          for (const line2 of responsesEventToChat(ctx, evt)) out.push(line2)
        }
      }
      if (!ctx.finished) {
        for (const line2 of responsesEventToChat(ctx, { type: 'response.completed', response: {} })) out.push(line2)
      }
      out.push(null)
    } catch (err) {
      out.destroy(err as Error)
    }
  })()
  return out
}

/** Aggregate a responses SSE stream into a single chat.completion JSON body.
 *
 *  Consumes the upstream SSE with an async iterator rather than by attaching
 *  'data'/'end' listeners. A paused stream that merely has listeners attached
 *  never emits 'end', so the listener-only version resolved only when the
 *  upstream happened to flush on its own — in practice it hung until the client
 *  gave up, with the gateway's own log already reporting "request ok". The
 *  iterator drives the readable to completion and the body-idle watchdog (which
 *  is attached upstream of this) keeps it from waiting forever. */
export async function responsesToChatCompletion(source: Readable, model: string): Promise<Readable> {
  const ctx = newChatCtx(model)
  let usage: Json | undefined
  let finished = false
  let buf = ''

  for await (const chunk of source) {
    buf += String(chunk)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      const payload = ssePayload(line)
      if (!payload || payload === '[DONE]') continue
      let evt: Json
      try {
        const parsed = JSON.parse(payload)
        if (!isRecord(parsed)) continue
        evt = parsed
      } catch {
        continue
      }
      const type = typeof evt.type === 'string' ? evt.type : ''
      if (type === 'response.created' || type === 'response.in_progress') {
        const resp = isRecord(evt.response) ? evt.response : undefined
        if (resp) {
          if (typeof resp.id === 'string') ctx.id = `chatcmpl-${resp.id.replace(/^resp_/, '')}`
          if (typeof resp.created_at === 'number') ctx.created = resp.created_at
          if (typeof resp.model === 'string') ctx.model = resp.model
        }
      } else if (type === 'response.output_text.delta') {
        ctx.text += String(evt.delta ?? '')
      } else if (type === 'response.output_item.done') {
        const item = isRecord(evt.item) ? evt.item : undefined
        if (item && item.type === 'function_call') {
          const index = ctx.toolCalls.size
          ctx.toolCalls.set(index, {
            id: String(item.call_id ?? item.id ?? `call_${index}`),
            name: String(item.name ?? ''),
            args: typeof item.arguments === 'string' ? item.arguments : '',
          })
          ctx.finish = 'tool_calls'
        } else if (item && item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (isRecord(part) && typeof part.text === 'string') ctx.text = part.text
          }
        }
      } else if (type === 'response.completed') {
        finished = true
        const resp = isRecord(evt.response) ? evt.response : undefined
        if (resp) {
          if (typeof resp.id === 'string') ctx.id = `chatcmpl-${resp.id.replace(/^resp_/, '')}`
          if (typeof resp.model === 'string') ctx.model = resp.model
          if (ctx.finish === null && typeof resp.status === 'string') {
            ctx.finish = resp.status === 'incomplete' ? 'length' : 'stop'
          }
          usage = mapUsage(resp.usage)
        }
      } else if (type === 'response.failed') {
        // Surface the failure rather than returning an empty successful answer.
        const resp = isRecord(evt.response) ? evt.response : undefined
        const err = resp && isRecord(resp.error) ? resp.error : undefined
        const message = err && typeof err.message === 'string' ? err.message : 'upstream response failed'
        throw new Error(message)
      }
    }
  }

  if (!finished) {
    // Stream ended without an explicit completed event; synthesize a stop.
    ctx.finish = ctx.finish ?? (ctx.toolCalls.size > 0 ? 'tool_calls' : 'stop')
  }

  const message: Json = { role: 'assistant' }
  if (ctx.toolCalls.size > 0) {
    message.content = ctx.text.length > 0 ? ctx.text : null
    message.tool_calls = [...ctx.toolCalls.entries()].map(([index, call]) => ({
      index,
      id: call.id ?? `call_${index}`,
      type: 'function',
      function: { name: call.name ?? '', arguments: call.args },
    }))
  } else {
    message.content = ctx.text
  }

  const payload: Json = {
    id: ctx.id,
    object: 'chat.completion',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, message, finish_reason: ctx.finish ?? 'stop' }],
    ...(usage ? { usage } : {}),
  }
  return Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')])
}

function collectText(events: Json[]): string {
  let text = ''
  for (const evt of events) {
    if (evt.type === 'response.output_text.delta') text += String(evt.delta ?? '')
    const item = isRecord(evt.item) ? evt.item : undefined
    if (evt.type === 'response.output_item.done' && item && item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isRecord(part) && typeof part.text === 'string') text = part.text
      }
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// chat (upstream) -> responses (client)
// ---------------------------------------------------------------------------

interface ResponsesCtx {
  id: string
  created: number
  model: string
  seq: number
  started: boolean
  finished: boolean
  text: string
  toolCalls: Map<number, { id: string; name: string; args: string }>
  usage?: Json
}

function newResponsesCtx(model: string): ResponsesCtx {
  return {
    id: `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`,
    created: nowSeconds(),
    model,
    seq: 0,
    started: false,
    finished: false,
    text: '',
    toolCalls: new Map(),
  }
}

function respLine(ctx: ResponsesCtx, type: string, fields: Json): string {
  ctx.seq += 1
  return sseLine({ type, sequence_number: ctx.seq, ...fields })
}

function responseShell(ctx: ResponsesCtx, status: string, output: Json[]): Json {
  return {
    id: ctx.id,
    object: 'response',
    created_at: ctx.created,
    status,
    model: ctx.model,
    output,
    tool_choice: 'auto',
    tools: [],
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    instructions: null,
    ...(ctx.usage ? { usage: ctx.usage } : {}),
  }
}

function startResponses(ctx: ResponsesCtx): string[] {
  if (ctx.started) return []
  ctx.started = true
  return [
    respLine(ctx, 'response.created', { response: responseShell(ctx, 'in_progress', []) }),
    respLine(ctx, 'response.in_progress', { response: responseShell(ctx, 'in_progress', []) }),
    respLine(ctx, 'response.output_item.added', {
      output_index: 0,
      item: { id: `msg_${ctx.id}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    }),
    respLine(ctx, 'response.content_part.added', {
      item_id: `msg_${ctx.id}`,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }),
  ]
}

function finishResponses(ctx: ResponsesCtx, finishReason: string | null): string[] {
  if (ctx.finished) return []
  ctx.finished = true
  const out = startResponses(ctx)

  if (ctx.text.length > 0 || ctx.toolCalls.size === 0) {
    out.push(
      respLine(ctx, 'response.output_text.done', {
        item_id: `msg_${ctx.id}`,
        output_index: 0,
        content_index: 0,
        text: ctx.text,
      }),
      respLine(ctx, 'response.content_part.done', {
        item_id: `msg_${ctx.id}`,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: ctx.text, annotations: [] },
      }),
      respLine(ctx, 'response.output_item.done', {
        output_index: 0,
        item: {
          id: `msg_${ctx.id}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: ctx.text, annotations: [] }],
        },
      }),
    )
  }

  let index = 1
  for (const call of ctx.toolCalls.values()) {
    out.push(
      respLine(ctx, 'response.output_item.added', {
        output_index: index,
        item: { id: call.id, type: 'function_call', status: 'in_progress', name: call.name, call_id: call.id, arguments: '' },
      }),
      respLine(ctx, 'response.function_call_arguments.done', {
        item_id: call.id,
        output_index: index,
        arguments: call.args,
      }),
      respLine(ctx, 'response.output_item.done', {
        output_index: index,
        item: {
          id: call.id,
          type: 'function_call',
          status: 'completed',
          name: call.name,
          call_id: call.id,
          arguments: call.args,
        },
      }),
    )
    index += 1
  }

  const output: Json[] = []
  if (ctx.text.length > 0 || ctx.toolCalls.size === 0) {
    output.push({
      id: `msg_${ctx.id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: ctx.text, annotations: [] }],
    })
  }
  for (const call of ctx.toolCalls.values()) {
    output.push({ id: call.id, type: 'function_call', status: 'completed', name: call.name, call_id: call.id, arguments: call.args })
  }

  out.push(respLine(ctx, 'response.completed', { response: responseShell(ctx, finishReason === 'stop' || finishReason === null ? 'completed' : 'completed', output) }))
  out.push('data: [DONE]\n\n')
  return out
}

function chatEventToResponses(ctx: ResponsesCtx, evt: Json): string[] {
  const out: string[] = []
  const choices = Array.isArray(evt.choices) ? evt.choices : []
  if (typeof evt.model === 'string') ctx.model = evt.model
  if (typeof evt.created === 'number') ctx.created = evt.created
  if (isRecord(evt.usage)) ctx.usage = mapUsage(evt.usage)
  out.push(...startResponses(ctx))

  for (const raw of choices) {
    if (!isRecord(raw)) continue
    const delta = isRecord(raw.delta) ? raw.delta : {}
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      ctx.text += delta.content
      out.push(
        respLine(ctx, 'response.output_text.delta', {
          item_id: `msg_${ctx.id}`,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
          logprobs: [],
        }),
      )
    }
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const rawCall of calls) {
      if (!isRecord(rawCall)) continue
      const index = typeof rawCall.index === 'number' ? rawCall.index : 0
      const fn = isRecord(rawCall.function) ? rawCall.function : {}
      const existing = ctx.toolCalls.get(index) ?? {
        id: typeof rawCall.id === 'string' ? rawCall.id : `call_${index}`,
        name: '',
        args: '',
      }
      if (typeof rawCall.id === 'string') existing.id = rawCall.id
      if (typeof fn.name === 'string' && fn.name.length > 0) existing.name = fn.name
      if (typeof fn.arguments === 'string') existing.args += fn.arguments
      ctx.toolCalls.set(index, existing)
    }
    // Only finish on the first terminal finish_reason; reasoning models emit
    // intermediate 'reasoning'/'tool_calls' reasons that must not double-finish.
    if (typeof raw.finish_reason === 'string' && !ctx.finished) {
      out.push(...finishResponses(ctx, raw.finish_reason))
    }
  }
  return out
}

/**
 * Translate a chat-completions SSE stream into a responses SSE stream.
 *
 * `upstreamError` (when set) is a pre-content upstream failure the gateway
 * already classified. The SSE body has to carry it explicitly: a Responses
 * client never sees an HTTP status once the stream opened, so a swallowed
 * failure would look like an empty-but-successful answer. We emit a well-formed
 * `response.failed` event (plus `error`), which both the official SDKs and this
 * gateway's own aggregator (`aggregateSse`) already understand.
 */
export function chatToResponsesStream(source: Readable, model: string, upstreamError?: UpstreamFailure): Readable {
  const out = new Readable({ read() {} })
  void (async () => {
    const ctx = newResponsesCtx(model)
    let buf = ''
    try {
      for await (const chunk of source) {
        buf += String(chunk)
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          const payload = ssePayload(line)
          if (!payload || payload === '[DONE]') continue
          let evt: Json
          try {
            const parsed = JSON.parse(payload)
            if (!isRecord(parsed)) continue
            evt = parsed
          } catch {
            continue
          }
          for (const line2 of chatEventToResponses(ctx, evt)) out.push(line2)
        }
      }
      if (upstreamError) {
        for (const line2 of failResponses(ctx, upstreamError)) out.push(line2)
      } else if (!ctx.finished) {
        for (const line2 of finishResponses(ctx, 'stop')) out.push(line2)
      }
      out.push(null)
    } catch (err) {
      out.destroy(err as Error)
    }
  })()
  return out
}

/** A pre-content upstream failure carried into a Responses SSE stream. */
export interface UpstreamFailure {
  status: number
  message: string
}

/**
 * Emit a terminal `response.failed` for an error that was detected before any
 * content was translated. Shape mirrors what OpenAI returns for a failed
 * response so SDK consumers surface it as an error rather than empty output.
 */
function failResponses(ctx: ResponsesCtx, failure: UpstreamFailure): string[] {
  if (ctx.finished) return []
  ctx.finished = true
  const out = startResponses(ctx)
  const error = { code: `upstream_${failure.status}`, message: failure.message, type: 'upstream_error' }
  const shell = { ...responseShell(ctx, 'failed', []), error }
  out.push(
    respLine(ctx, 'error', { code: error.code, message: error.message, param: null, sequence_number: ctx.seq + 1 }),
    respLine(ctx, 'response.failed', { response: shell }),
  )
  return out
}

/** Aggregate a chat-completions SSE stream into a single responses JSON body. */
export async function chatToResponsesCompletion(source: Readable, model: string): Promise<Readable> {
  const events = await collectSseObjects(source)
  const ctx = newResponsesCtx(model)
  for (const evt of events) for (const line of chatEventToResponses(ctx, evt)) void line
  if (!ctx.finished) finishResponses(ctx, 'stop')

  const output: Json[] = []
  if (ctx.text.length > 0 || ctx.toolCalls.size === 0) {
    output.push({
      id: `msg_${ctx.id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: ctx.text, annotations: [] }],
    })
  }
  for (const call of ctx.toolCalls.values()) {
    output.push({ id: call.id, type: 'function_call', status: 'completed', name: call.name, call_id: call.id, arguments: call.args })
  }
  const payload = responseShell(ctx, 'completed', output)
  return Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')])
}
