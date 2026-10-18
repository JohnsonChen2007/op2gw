/**
 * Instant-length truncation guard.
 *
 * The Zen lane's overflow behavior is pathological: when a request's prompt
 * exceeds the model's REAL serving window (the advertised context_window is
 * optimistic), the lane answers HTTP 200, streams a plausible opener and then
 * ends with `finish_reason: "length"` after ~0-1 completion tokens — instead
 * of a proper `context_length_exceeded` rejection.
 *
 * Downstream this is poison: OpenAI-compatible clients (DSH notably) map
 * finish_reason=length to "max tokens reached", show an amber
 * "Output token limit reached — send continue" notice, and the user keeps
 * re-sending into the same overflowing request forever.
 *
 * This guard watches the chat-completions SSE stream and, when the length
 * cutoff consumed only a sliver of the output budget, swallows the length
 * tail and emits a real in-stream error (`context_length_exceeded`) carrying
 * the measured prompt size and the advertised window. Clients throw an
 * APIError on an in-stream error object (openai-node does since v4), turning
 * the silent loop into an actionable failure.
 *
 * A GENUINE max-tokens cutoff (client-set `max_tokens`, e.g. the 4096 cap a
 * title generator sends) burns thousands of tokens before finishing — well
 * past the instant threshold — and passes through untouched.
 */

import { Readable } from 'node:stream'

type Json = Record<string, unknown>

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface InstantLengthGuardOptions {
  /** Model id, for the error message. */
  model: string
  /** Advertised context window (tokens), quoted in the error when known. */
  contextWindow?: number
  /**
   * A length cutoff that consumed at most this many completion tokens is
   * treated as an instant truncation rather than a real cap. Default 2.
   */
  maxInstantTokens?: number
  /** Called once when the guard converts a stream (observability seam). */
  onConvert?: (info: { promptTokens?: number; completionTokens?: number }) => void
  /**
   * Throw (instead of emitting an error frame) when a truncation converts.
   * For non-streaming consumers whose aggregator turns an in-body error object
   * into a regular upstream failure — this one must surface as a NON-rotatable
   * 400 so a deterministic overflow cannot burn the exit-rotation budget.
   */
  throwOnConvert?: boolean
}

/** The UpstreamError thrown for a converted truncation when throwOnConvert. */
export interface OverflowError extends Error {
  kind: 'server'
  status: 400
}

interface GuardState {
  /** Characters of meaningful output seen so far (text / reasoning). */
  chars: number
  tools: boolean
  completionTokens?: number
  promptTokens?: number
  finishLength: boolean
}

/** Extract the tuning-relevant facts from one SSE `data:` payload. */
function observePayload(payload: string, state: GuardState): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return
  }
  if (!isRecord(parsed)) return
  if (isRecord(parsed.usage)) {
    const usage = parsed.usage as Json
    if (typeof usage.completion_tokens === 'number') state.completionTokens = usage.completion_tokens
    if (typeof usage.prompt_tokens === 'number') state.promptTokens = usage.prompt_tokens
  }
  const choices = Array.isArray(parsed.choices) ? parsed.choices : []
  const choice = isRecord(choices[0]) ? (choices[0] as Json) : undefined
  if (choice === undefined) return
  if (choice.finish_reason === 'length') state.finishLength = true
  const delta = isRecord(choice.delta) ? (choice.delta as Json) : {}
  for (const field of [delta.content, delta.reasoning_content, delta.reasoning, delta.reasoning_text]) {
    if (typeof field === 'string') state.chars += field.length
  }
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) state.tools = true
  if (isRecord(delta.function_call)) state.tools = true
}

/**
 * Slack allowed when usage never arrives but a sliver-of-content length cutoff
 * streamed: fewer output characters than this (and no tool calls) cannot be a
 * working generation.
 */
const TINY_CONTENT_CHARS = 24

/**
 * True when the observed cutoff is an instant truncation rather than a real
 * max-tokens cap. Direct rule: usage present and tiny. Fallback (usage couldn't
 * be seen before EOF): a near-empty opener with no tool calls.
 */
function isInstantTruncation(state: GuardState, maxInstantTokens: number): boolean {
  if (!state.finishLength) return false
  if (state.completionTokens !== undefined) return state.completionTokens <= maxInstantTokens
  return state.chars <= TINY_CONTENT_CHARS && !state.tools
}

/**
 * Wrap an upstream chat SSE stream. Events pass through byte-identical until a
 * length cutoff with a near-empty output budget is observed; then the guard
 * emits one synthesized error frame and closes, releasing the upstream.
 * The sliver-of-content EOF fallback also converts, so a length finish with no
 * usage frame cannot slip through as a fake success.
 */
export function wrapInstantLengthGuard(source: Readable, options: InstantLengthGuardOptions): Readable {
  const maxInstantTokens = options.maxInstantTokens ?? 2
  const state: GuardState = { chars: 0, tools: false, finishLength: false }
  let buffer = ''

  const errorMessage = (): string => {
    const completed = state.completionTokens !== undefined ? `${state.completionTokens}` : '<=2'
    const prompt = state.promptTokens !== undefined
      ? `\nMeasured prompt: ~${state.promptTokens} tokens.`
      : ''
    const window = options.contextWindow !== undefined
      ? `\nAdvertised context window: ${options.contextWindow} tokens (the lane serves less; treat the advert as optimistic).`
      : ''
    return (
      `[op2gw] ${options.model}: the upstream ended the request with finish_reason=length after ` +
      `${completed} completion token(s)${prompt}${window}\n` +
      'The prompt overflowed the model\'s real serving window before generation could start. ' +
      'Reduce the session context (compact, trim, or start a fresh session) or switch to a model with a larger window. ' +
      'Retrying or sending "continue" cannot succeed.'
    )
  }

  const errorFrame = (): string => {
    return `data: ${JSON.stringify({ error: { message: errorMessage(), type: 'invalid_request_error', code: 'context_length_exceeded' } })}\n\n`
  }

  const throwAsOverflow = (): never => {
    const e = new Error(`upstream error in response body: ${errorMessage()}`) as OverflowError
    e.kind = 'server'
    e.status = 400
    throw e
  }

  const scanEventFrames = (event: string): void => {
    for (const line of event.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      observePayload(payload, state)
    }
  }

  const generator = async function* (): AsyncGenerator<Buffer> {
    let converted = false
    /** Set once the guard is delivering its converted verdict (frame or throw). */
    let delivering = false
    try {
      for await (const raw of source) {
        if (converted) return
        buffer += typeof raw === 'string' ? raw : raw.toString('utf8')
        const split = buffer.split(/\r?\n\r?\n/)
        buffer = split.pop() ?? ''
        for (const event of split) {
          if (event.trim() === '') continue
          scanEventFrames(event)
          if (isInstantTruncation(state, maxInstantTokens)) {
            converted = true
            options.onConvert?.({ promptTokens: state.promptTokens, completionTokens: state.completionTokens })
            if (options.throwOnConvert) {
              delivering = true
              throwAsOverflow()
            }
            yield Buffer.from(errorFrame())
            source.destroy()
            return
          }
          yield Buffer.from(`${event}\n\n`)
        }
      }
      // EOF: flush what is buffered, then judge the un-verdictable cases.
      const rest = buffer
      buffer = ''
      let convertedAtEof = false
      for (const event of rest.split(/\r?\n\r?\n/)) {
        if (event.trim() === '') continue
        scanEventFrames(event)
        if (isInstantTruncation(state, maxInstantTokens)) {
          convertedAtEof = true
          break
        }
        yield Buffer.from(`${event}\n\n`)
      }
      if (convertedAtEof) {
        options.onConvert?.({ promptTokens: state.promptTokens, completionTokens: state.completionTokens })
        if (options.throwOnConvert) {
          delivering = true
          throwAsOverflow()
        }
        yield Buffer.from(errorFrame())
        return
      }
    } catch (err) {
      if (converted && !delivering) return
      throw err
    } finally {
      if (!converted && !source.readableEnded && !source.destroyed) source.destroy()
    }
  }

  return Readable.from(generator())
}
