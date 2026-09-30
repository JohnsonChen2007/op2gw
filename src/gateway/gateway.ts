import { Readable } from 'node:stream'

import type { Logger, ScopedLogger } from '../core/logger.js'
import type { ExitNode, FailureKind, RequestIDs, RequestTrace, UpstreamApi } from '../core/types.js'
import { deriveRequestIDs } from '../core/ids.js'
import { ensureChatFreeLaneShape, ensureResponsesFreeLaneShape } from '../core/freelane.js'
import { ModelCatalog } from '../catalog/catalog.js'
import { ExitPool } from '../pool/pool.js'
import { DispatcherCache } from '../pool/dispatchers.js'
import { forwardUpstream, type UpstreamError, type UpstreamResult } from './upstream.js'
import {
  chatToResponsesBody,
  chatToResponsesCompletion,
  chatToResponsesStream,
  isResponsesWireModel,
  resolveUpstreamApi,
  responsesToChatBody,
  responsesToChatCompletion,
  responsesToChatStream,
} from './protocol.js'

/**
 * Gateway — the request orchestrator.
 *
 * Responsibilities for one OpenAI v1 request:
 *   1. resolve the model & confirm it is free (catalog)
 *   2. derive CLI disguise ids from the conversation
 *   3. inject the free-lane gate tools into the body
 *   4. pick an exit (pool), forward through its dispatcher (upstream)
 *   5. on a pre-response failure, rotate to another exit (bounded)
 *   6. stream the upstream body back verbatim, or aggregate for non-stream
 *
 * The pool is optional: when disabled, everything routes through the single
 * 'direct' exit and the rotate loop is a no-op (one attempt).
 */

export interface GatewayDeps {
  logger: Logger
  scoped: ScopedLogger
  catalog: ModelCatalog
  pool: ExitPool
  dispatchers: DispatcherCache
  zenBaseUrl: string
  maxRotateAttempts: number
  poolEnabled: boolean
  /**
   * Whether the machine's own egress may serve requests. false = every request
   * must leave through a proxy exit; direct egress is refused outright so
   * the operator's real country/IP can never leak upstream.
   */
  directAllowed?: boolean
}

export interface GatewayRequest {
  api: UpstreamApi
  body: Record<string, unknown>
  /** Whether the client asked for a streaming response. */
  clientStream: boolean
  signal?: AbortSignal
}

export interface GatewayResponse {
  status: number
  headers: Record<string, string>
  /** Stream to pipe to the client (SSE or a single JSON blob as a stream). */
  body: Readable
  trace: RequestTrace
}

export class Gateway {
  readonly #d: GatewayDeps

  constructor(deps: GatewayDeps) {
    this.#d = deps
  }

  /** Resolve the exposed model list for GET /v1/models. */
  listModels(): string[] {
    return this.#d.catalog.list()
  }

  isFree(model: string): boolean {
    return this.#d.catalog.decision(model).allowed
  }

  /**
   * Handle one inference request. Throws a GatewayHttpError for client-visible
   * 4xx/5xx that never got a stream; returns a GatewayResponse otherwise.
   */
  async handle(req: GatewayRequest): Promise<GatewayResponse> {
    const started = Date.now()
    const model = typeof req.body.model === 'string' ? req.body.model : ''
    const requestId = this.#d.logger.nextRequestId()
    const log = this.#d.scoped

    if (!model) throw new GatewayHttpError(400, 'invalid_request_error', 'missing "model"')
    if (!this.isFree(model)) {
      const d = this.#d.catalog.decision(model)
      throw new GatewayHttpError(400, 'invalid_request_error', `model "${model}" is not an available free model (${d.source})`)
    }

    const messages = extractMessages(req.body)
    const ids = deriveRequestIDs(messages)

    // The dialect upstream accepts is decided by the MODEL (Zen partitions its
    // endpoints strictly); the client may speak either one. See protocol.ts.
    const wireApi = resolveUpstreamApi(model)

    // Force wire streaming (the free lane requires it) and inject gate tools.
    const wireBody = this.#prepareBody(wireApi, req.api, { ...req.body, stream: true })

    // Rotate budget: on a 429 (or other exit-shaped failure) we want to keep
    // hopping to a *different* IP until we run out of usable exits. So the
    // effective budget tracks the pool size — one shot per distinct exit — and
    // the configured maxRotateAttempts acts as the floor (a minimum guarantee
    // even for a tiny pool). This is what makes "rate-limited -> switch IP"
    // actually traverse the whole pool instead of giving up after 2-3 tries.
    const poolSize = this.#d.pool.size()
    const maxAttempts = this.#d.poolEnabled
      ? Math.max(1, this.#d.maxRotateAttempts, poolSize)
      : 1
    const story: string[] = []
    let lastError: UpstreamError | Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const exit = this.#pickExit(model, ids.session)
      if (!exit) {
        const directAllowed = this.#d.directAllowed ?? this.#d.pool.includeDirect
        throw new GatewayHttpError(
          503,
          'upstream_error',
          directAllowed && this.#d.pool.includeDirect
            ? 'no usable exit available (all cooling/dead/banned)'
            : 'no usable proxy exit available (all cooling/dead/banned) and direct egress is disallowed — add or enable a proxy',
        )
      }
      if (this.#sealDirect(model) && exit.kind === 'direct') {
        // Belt and braces: the pool already filters direct when egress is
        // locked to proxies. If one still slips through, refuse rather than
        // leak the operator's real country/IP upstream.
        throw new GatewayHttpError(
          503,
          'upstream_error',
          `direct egress is disallowed but no proxy exit is available for "${model}"; refusing to send it out over the direct path`,
        )
      }
      try {
        const result = await forwardUpstream({
          zenBaseUrl: this.#d.zenBaseUrl,
          api: wireApi,
          ids,
          body: wireBody,
          exit,
          dispatchers: this.#d.dispatchers,
          signal: req.signal,
          bodyIdleMs: wireApi === 'responses' ? 300_000 : 120_000,
          firstByteMs: 30_000,
          noWatchdog: !req.clientStream,
        })
        // Response headers landed = success from the pool's view; the body may
        // still error mid-stream, but we do not rotate once bytes are flowing
        // (a partially delivered stream must never be replayed).
        this.#d.pool.markSuccess(exit.id, model)
        // The upstream can answer HTTP 200 and still put an error object inside
        // the SSE body (observed on nemotron-3-ultra-free: an Nvidia 503 wrapped
        // as a chat chunk). That is a failure, not an empty answer: it must not
        // be marked as a model success, and a Responses client must be told.
        //
        // Streaming only: the peek consumes the head of `result.body` and replays
        // it. In no-watchdog (non-streaming) mode body === rawBody, so peeking
        // here would steal the first chunk from the aggregator below. The
        // aggregators (aggregateSse / *Completion) detect in-body errors
        // themselves, so non-streaming clients skip this step.
        if (req.clientStream) {
          await this.#inspectPreContentError(wireApi, result, model, exit.id, log)
        }
        const trace: RequestTrace = {
          id: requestId,
          ts: started,
          model,
          stream: req.clientStream,
          status: result.status,
          exit: exit.id,
          exitIP: exit.exitIP,
          attempts: attempt,
          durationMs: Date.now() - started,
          outcome: 'ok',
        }
        this.#d.logger.trace(trace)
        log.info('request ok', { model, exit: exit.id, attempt, stream: req.clientStream, api: wireApi, clientApi: req.api })
        const body = req.clientStream
          ? await this.#toClientStream(req.api, wireApi, result.body, model)
          : await this.#toClientCompletion(req.api, wireApi, result.rawBody, model)
        return { status: 200, headers: this.#responseHeaders(req.clientStream), body, trace }
      } catch (err) {
        lastError = err as Error
        const kind = (err as UpstreamError).kind ?? 'transport'
        this.#d.pool.markFailure(exit.id, model, kind)
        story.push(`#${attempt} ${exit.id} ${kind}: ${(err as Error).message.slice(0, 80)}`)
        log.warn('attempt failed', { model, exit: exit.id, attempt, kind, error: (err as Error).message })
        const status = (err as UpstreamError).status
        // Deterministic client errors (region) still allow a rotate to another
        // exit; other non-retryable statuses (400 from our own guard already
        // handled) surface. We keep rotating within budget on exit-shaped
        // failures only.
        const rotatable = kind === 'limited' || kind === 'transport' || kind === 'server' || kind === 'refused' || kind === 'region'
        if (!rotatable || attempt >= maxAttempts) {
          break
        }
        // Break the sticky binding so the next pick moves to a fresh exit.
        this.#d.pool.rerouteSession(ids.session)
      }
    }

    // All attempts exhausted.
    const trace: RequestTrace = {
      id: requestId,
      ts: started,
      model,
      stream: req.clientStream,
      status: (lastError as UpstreamError)?.status ?? 502,
      exit: '',
      exitIP: '',
      attempts: maxAttempts,
      durationMs: Date.now() - started,
      outcome: 'error',
      error: lastError?.message ?? 'unknown',
    }
    this.#d.logger.trace(trace)
    const status = (lastError as UpstreamError)?.status ?? 502
    const detail = story.length > 1 ? `${lastError?.message} (op2gw rotated ${story.length - 1}x: ${story.join(' -> ')})` : lastError?.message ?? 'upstream failure'
    throw new GatewayHttpError(status >= 400 ? status : 502, 'upstream_error', detail)
  }

  #pickExit(model: string, session: string): ExitNode | null {
    const directAllowed = this.#d.directAllowed ?? this.#d.pool.includeDirect
    if (!this.#d.poolEnabled) {
      if (!directAllowed || !this.#d.pool.includeDirect) return null
      this.#d.pool.ensureDirect()
      return this.#d.pool.get('direct') ?? null
    }
    const pick = this.#d.pool.pick(model, session)
    if (pick && pick.exit.kind === 'direct' && (!directAllowed || !this.#d.pool.includeDirect)) return null
    return pick?.exit ?? null
  }

  /**
   * Should the gateway refuse rather than let the request egress over the direct path?
   *
   * 1. If direct egress is disallowed (!directAllowed || !pool.includeDirect), ALL requests
   *    must go through a proxy in the IP pool; direct fallback is refused outright so the
   *    operator's real egress IP can never leak upstream.
   * 2. Country-gated models (muse-spark-*): falling back to direct silently turns
   *    "country-gated model" into "wrong-country request" AND leaks the operator's
   *    real country upstream.
   */
  #sealDirect(model: string): boolean {
    const directAllowed = this.#d.directAllowed ?? this.#d.pool.includeDirect
    if (!directAllowed || !this.#d.pool.includeDirect) return true
    return this.#d.poolEnabled && isResponsesWireModel(model)
  }

  /**
   * Peek at a 200 response whose body is an SSE stream and detect an error
   * object that arrived *before any content* — the upstream's habit of
   * answering 200 and then streaming `{"error":…}` (nemotron-3-ultra-free
   * wraps an Nvidia 503 that way).
   *
   * A real error is rethrown so the caller can rotate/classify it. An empty
   * peek (or one that already carries content) is replayed into a fresh stream
   * placed back on `result`, so the caller streams the same bytes it would have.
   *
   * Only applies to streaming clients: non-streaming consumers read the raw
   * body through their aggregator, which handles errors itself.
   */
  async #inspectPreContentError(
    wireApi: UpstreamApi,
    result: UpstreamResult,
    model: string,
    exitId: string,
    log: ScopedLogger,
  ): Promise<void> {
    const source = result.body
    if (typeof (source as unknown as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') return
    const iterator = source[Symbol.asyncIterator]()
    let first: IteratorResult<Buffer | string>
    try {
      first = await iterator.next()
    } catch (err) {
      await iterator.return?.().catch(() => {})
      throw err
    }
    if (first.done) {
      // Completely empty stream: rebuild an empty one and let the caller finish.
      result.body = Readable.from([])
      return
    }
    const head = Buffer.isBuffer(first.value) ? first.value.toString('utf8') : String(first.value)
    const errorObject = findSseError(head)
    if (errorObject) {
      await iterator.return?.().catch(() => {})
      const e = new Error(`upstream error in stream body: ${errorObject.message}`) as UpstreamError
      e.kind = classifyStreamError(errorObject.message)
      e.status = errorObject.status
      log.warn('upstream 200 body carried an error before content', { model, exit: exitId, error: errorObject.message })
      throw e
    }
    // Not an error: replay what we consumed, then the rest of the stream.
    const replay = Readable.from(
      (async function* () {
        yield Buffer.isBuffer(first.value) ? first.value : Buffer.from(String(first.value))
        for (;;) {
          const next = await iterator.next()
          if (next.done) return
          yield Buffer.isBuffer(next.value) ? next.value : Buffer.from(String(next.value))
        }
      })(),
    )
    result.body = replay
    void wireApi
  }

  /** Translate the client body to the wire dialect, then apply the free-lane gate. */
  #prepareBody(wireApi: UpstreamApi, clientApi: UpstreamApi, body: Record<string, unknown>): unknown {
    if (wireApi === 'responses') {
      const translated = clientApi === 'chat' ? chatToResponsesBody(body) : body
      const { body: shaped } = ensureResponsesFreeLaneShape(translated)
      return shaped
    }
    const translated = clientApi === 'responses' ? responsesToChatBody(body) : body
    const { body: shaped } = ensureChatFreeLaneShape(translated)
    return shaped
  }

  /** Wire SSE stream -> client dialect (identity when both dialects match). */
  #toClientStream(clientApi: UpstreamApi, wireApi: UpstreamApi, source: Readable, model: string): Readable {
    if (clientApi === wireApi) return source
    return wireApi === 'responses' ? responsesToChatStream(source, model) : chatToResponsesStream(source, model)
  }

  /** Wire body -> single JSON in the client dialect. */
  async #toClientCompletion(
    clientApi: UpstreamApi,
    wireApi: UpstreamApi,
    source: Readable,
    model: string,
  ): Promise<Readable> {
    if (clientApi === wireApi) return aggregateSse({ body: source } as UpstreamResult, wireApi)
    return wireApi === 'responses'
      ? responsesToChatCompletion(source, model)
      : chatToResponsesCompletion(source, model)
  }

  #responseHeaders(stream: boolean): Record<string, string> {
    return stream
      ? { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }
      : { 'content-type': 'application/json; charset=utf-8' }
  }
}

export class GatewayHttpError extends Error {
  readonly status: number
  readonly type: string

  constructor(status: number, type: string, message: string) {
    super(message)
    this.status = status
    this.type = type
  }

  toOpenAIBody(): string {
    return JSON.stringify({ error: { message: this.message, type: this.type, code: null } })
  }
}

function extractMessages(body: Record<string, unknown>): Array<{ role: string; content: unknown }> {
  if (Array.isArray(body.messages)) return body.messages as Array<{ role: string; content: unknown }>
  // Responses API uses `input`; treat it as a single user turn signal.
  if (body.input !== undefined) return [{ role: 'user', content: body.input }]
  return []
}

/**
 * Aggregate an upstream SSE stream into a single non-streaming JSON body for
 * clients that did not ask to stream. We forced `stream: true` on the wire
 * (free-lane requirement), so this reconstructs a Chat Completions object from
 * the deltas. Best-effort: unknown shapes pass the raw concatenated text.
 */
async function aggregateSse(result: UpstreamResult, api: UpstreamApi): Promise<Readable> {
  const chunks: Buffer[] = []
  for await (const chunk of result.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  const raw = Buffer.concat(chunks).toString('utf8')

  const events = parseSseData(raw)
  if (api === 'responses') {
    // A failed response must not masquerade as an empty success: surface the
    // error object the bridge emitted (or the upstream's own error body) as a
    // proper OpenAI error envelope.
    const failed = events.find(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'response.failed',
    )
    if (failed) {
      const response = isRecord((failed as { response?: unknown }).response) ? (failed as { response: Record<string, unknown> }).response : {}
      const error = isRecord(response.error) ? response.error : {}
      const message = typeof error.message === 'string' ? error.message : 'upstream response failed'
      const code = typeof error.code === 'string' ? error.code : 'upstream_error'
      return blobStream(JSON.stringify({ error: { message, type: 'upstream_error', code } }))
    }
    const bareError = events.find(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'error',
    )
    if (bareError && typeof (bareError as { message?: unknown }).message === 'string') {
      return blobStream(
        JSON.stringify({
          error: { message: (bareError as { message: string }).message, type: 'upstream_error', code: (bareError as { code?: string }).code ?? null },
        }),
      )
    }
    // OpenAI returns the *response object* for a non-streaming /v1/responses
    // call, so unwrap response.completed; falling back to the last non-ping
    // event (the previous code reversed blindly and returned {"type":"ping"}).
    const completed = events.find(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'response.completed',
    )
    const inner =
      completed && typeof (completed as { response?: unknown }).response === 'object'
        ? (completed as { response: unknown }).response
        : events.reverse().find((e) => e && typeof e === 'object' && (e as Record<string, unknown>).type !== 'ping')
    return blobStream(JSON.stringify(inner ?? { object: 'response', output: [] }))
  }

  // Chat: an upstream (or gateway-injected) error object inside an HTTP 200 SSE
  // body is still a failure — never return it as an empty "successful" answer.
  const chatError = events.find(
    (e): e is Record<string, unknown> => typeof e === 'object' && e !== null && isRecord((e as Record<string, unknown>).error),
  )
  if (chatError && !Array.isArray((chatError as Record<string, unknown>).choices)) {
    const err = (chatError as { error: Record<string, unknown> }).error
    const message = typeof err.message === 'string' ? err.message : 'upstream error'
    const code = typeof err.code === 'string' ? err.code : null
    return blobStream(JSON.stringify({ error: { message, type: 'upstream_error', code } }))
  }

  let content = ''
  const toolCalls = new Map<number, { id?: string; name?: string; args: string }>()
  let finishReason: string | null = null
  let modelId = ''
  let created = Math.floor(Date.now() / 1000)
  let id = ''
  let usage: unknown
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const obj = ev as Record<string, unknown>
    if (typeof obj.id === 'string') id = obj.id
    if (typeof obj.model === 'string') modelId = obj.model
    if (typeof obj.created === 'number') created = obj.created
    if (obj.usage) usage = obj.usage
    const choices = Array.isArray(obj.choices) ? obj.choices : []
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue
      const c = choice as Record<string, unknown>
      const delta = (c.delta ?? {}) as Record<string, unknown>
      if (typeof delta.content === 'string') content += delta.content
      if (typeof c.finish_reason === 'string') finishReason = c.finish_reason
      const deltaCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const call of deltaCalls) {
        const tc = call as Record<string, unknown>
        const index = typeof tc.index === 'number' ? tc.index : 0
        const slot = toolCalls.get(index) ?? { args: '' }
        if (typeof tc.id === 'string') slot.id = tc.id
        const fn = (tc.function ?? {}) as Record<string, unknown>
        if (typeof fn.name === 'string') slot.name = fn.name
        if (typeof fn.arguments === 'string') slot.args += fn.arguments
        toolCalls.set(index, slot)
      }
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: content || null }
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()].map(([index, slot]) => ({
      index,
      id: slot.id ?? `call_${index}`,
      type: 'function',
      function: { name: slot.name ?? '', arguments: slot.args },
    }))
  }
  const payload = {
    id: id || `chatcmpl-${created}`,
    object: 'chat.completion',
    created,
    model: modelId,
    choices: [{ index: 0, message, finish_reason: finishReason ?? 'stop' }],
    ...(usage ? { usage } : {}),
  }
  return blobStream(JSON.stringify(payload))
}

function parseSseData(raw: string): unknown[] {
  const out: unknown[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    try {
      out.push(JSON.parse(data))
    } catch {
      // ignore non-JSON keepalives
    }
  }
  return out
}

function blobStream(text: string): Readable {
  return Readable.from([Buffer.from(text, 'utf8')])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Look for an error object at the head of an SSE stream: either an event whose
 * payload has `error`, or a `type: "error"` event. Only the leading window is
 * examined, so this is a cheap "did it fail before producing anything" check.
 */
function findSseError(head: string): { message: string; status: number } | null {
  for (const line of head.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const inner = parsed.error
    if (isRecord(inner) && typeof inner.message === 'string') {
      return { message: inner.message, status: 502 }
    }
    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      return { message: parsed.message, status: 502 }
    }
  }
  return null
}

/** Classify an in-body error message into the pool's failure taxonomy. */
function classifyStreamError(message: string): FailureKind {
  const text = message.toLowerCase()
  if (/regionerror|not available in your country/.test(text)) return 'region'
  if (/rate.?limit|quota|too many requests|\b429\b/.test(text)) return 'limited'
  if (/unauthor|forbidden|missing api key|\b40[13]\b/.test(text)) return 'refused'
  return 'server'
}
