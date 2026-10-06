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
  normalizeChatToolCallIds,
  resolveUpstreamApi,
  responsesToChatBody,
  responsesToChatCompletion,
  responsesToChatStream,
  stripCallerBoundReasoning,
} from './protocol.js'

/** Ceiling for any single rotation backoff (Retry-After included). */
const MAX_BACKOFF_MS = 4_000
/**
 * Default hard budget for reading a non-streaming response body. That path has
 * no idle watchdog by design, so this is the only thing standing between a
 * half-open upstream and a request that never returns. Generous enough that a
 * slow reasoning model is never cut off mid-answer.
 */
const DEFAULT_BODY_BUDGET_MS = 10 * 60_000

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
  /**
   * Fired when the pool cannot yield any exit for a request (every exit is
   * cooling/dead/banned, or direct is sealed). The runtime wires this to an
   * immediate full verification round so a tunnel that has quietly come back
   * is revived for the NEXT request instead of waiting for the scheduled
   * probe interval / dead-exit recheck window.
   */
  onPoolStarved?: () => void
  /**
   * Hard wall-clock budget (ms) for reading a NON-STREAMING response body.
   * That path deliberately skips the idle watchdog (a reasoning model may go
   * quiet for minutes), so without this a half-open upstream would hang the
   * request forever. 0 disables the budget. Defaults to 10 minutes.
   */
  bodyBudgetMs?: number
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
    /** Set when the CLIENT disconnected mid-request (as opposed to upstream failure). */
    let clientGone = false
    const triedExits = new Set<string>()

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const exit = this.#pickExit(model, ids.session, triedExits)
      if (!exit) {
        // Nobody is usable right now: ask the prober to verify every exit
        // immediately (multi-site) so the next request can route again as
        // soon as a tunnel is truly back.
        this.#d.onPoolStarved?.()
        if (triedExits.size > 0 && lastError) {
          break
        }
        const directAllowed = this.#d.directAllowed ?? this.#d.pool.includeDirect
        throw new GatewayHttpError(
          503,
          'upstream_error',
          directAllowed && this.#d.pool.includeDirect
            ? 'no usable exit available (all cooling/dead/banned)'
            : 'no usable proxy exit available (all cooling/dead/banned) and direct egress is disallowed — add or enable a proxy',
        )
      }
      triedExits.add(exit.id)
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
          bodyTotalMs: req.clientStream ? 0 : (this.#d.bodyBudgetMs ?? DEFAULT_BODY_BUDGET_MS),
        })

        // Validate the body BEFORE recording success. An HTTP 200 can still
        // carry a failure — an SSE error object ahead of any content, or (for a
        // non-streaming client) an error object anywhere in the aggregated body.
        // Both must reach the rotation loop below, and neither may reset the
        // exit's health as though the call had succeeded (recording success
        // first zeroed `consecutiveLimited`, so429 backoff could never
        // accumulate).
        //
        // Streaming only peeks: once bytes have been delivered we must not
        // rotate, because a partially delivered stream can never be replayed.
        let body: Readable
        if (req.clientStream) {
          await this.#inspectPreContentError(wireApi, result, model, exit.id, log)
          body = this.#toClientStream(req.api, wireApi, result.body, model)
        } else {
          // Aggregation throws an UpstreamError on an in-body error, so a
          // non-streaming client gets a real status code and a retry instead of
          // HTTP 200 wrapping an error object.
          body = await this.#toClientCompletion(req.api, wireApi, result.rawBody, model)
        }

        this.#d.pool.markSuccess(exit.id, model)
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
        return { status: 200, headers: this.#responseHeaders(req.clientStream), body, trace }
      } catch (err) {
        lastError = err as Error

        // The client walked away. `req.signal` only fires on a real disconnect,
        // so this failure is ours to absorb: the exit did nothing wrong, and
        // rotating would keep spending the budget on a request nobody is
        // waiting for. Bail out without touching pool health.
        if (req.signal?.aborted) {
          clientGone = true
          story.push(`#${attempt} ${exit.id} client_closed: disconnect before completion`)
          log.warn('client disconnected; abandoning request', { model, exit: exit.id, attempt })
          break
        }

        const kind = (err as UpstreamError).kind ?? 'transport'
        const status = (err as UpstreamError).status
        // A 400 from upstream is a client/request validation error (e.g. invalid param,
        // malformed prompt). It is NOT an exit/proxy node failure and must NOT penalize the exit.
        if (status !== 400) {
          this.#d.pool.markFailure(exit.id, model, kind)
        }
        story.push(`#${attempt} ${exit.id} ${kind}: ${(err as Error).message.slice(0, 80)}`)
        log.warn('attempt failed', { model, exit: exit.id, attempt, kind, error: (err as Error).message })
        if (status === 400) {
          // Surface WHICH tool binding the provider rejected without logging
          // prompt content — the recurring 2026-10-01 400s rotated identically
          // across exits, so the wire body itself was the failing suspect.
          log.warn('upstream 400 wire-body shape', { model, tools: toolShapeSummary(wireBody) })
        }
        // Non-retryable statuses surface immediately; we keep rotating within
        // budget on exit-shaped failures only. Exception: the Console provider's
        // vague 400 is flaky upstream, not a request bug — the identical wire
        // body passes on replay (observed 2026-10-03: one Codex tool round 400'd
        // on two exits ~6min apart, then the same body passed 8/9 direct
        // replays) — so it rotates too. Genuinely invalid bodies are always
        // named by the provider (`unknown variant developer`, `tool_call_id`,
        // `encrypted_content`), so the field-less message is the safe key.
        const rotatable =
          (status !== 400 &&
            (kind === 'limited' || kind === 'transport' || kind === 'server' || kind === 'refused' || kind === 'region')) ||
          (status === 400 && isVagueProvider400((err as Error).message))
        if (!rotatable || attempt >= maxAttempts) {
          break
        }
        // Break the sticky binding so the next pick moves to a fresh exit.
        this.#d.pool.rerouteSession(ids.session)
        // Backoff before rotating, so an overloaded upstream or a rate-limited
        // tunnel gets a moment. A `Retry-After` from the upstream is
        // authoritative and wins; otherwise use full-jitter exponential backoff
        // (uniform in [0, base)) so a burst of concurrent failures does not
        // retry in lockstep and land on the recovering upstream all at once —
        // the fixed delay it replaces made every in-flight request retry
        // simultaneously.
        const retryAfterMs = (err as UpstreamError).retryAfterMs
        if (retryAfterMs !== undefined && retryAfterMs > 0) {
          await sleep(Math.min(retryAfterMs, MAX_BACKOFF_MS))
        } else if (kind === 'server' || kind === 'limited') {
          await sleep(Math.floor(Math.random() * Math.min(400 * 2 ** (attempt - 1), MAX_BACKOFF_MS)))
        }
      }
    }

    // The client disconnected: nothing left to serve, and the pool was
    // deliberately left untouched. Trace it, then report 499 (client closed
    // request) so the HTTP layer knows not to write a body at a dead socket.
    if (clientGone) {
      this.#d.logger.trace({
        id: requestId,
        ts: started,
        model,
        stream: req.clientStream,
        status: 499,
        exit: '',
        exitIP: '',
        attempts: Math.max(1, triedExits.size),
        durationMs: Date.now() - started,
        outcome: 'error',
        error: 'client closed the connection',
      })
      throw new GatewayHttpError(499, 'client_closed_request', 'client closed the connection')
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

  #pickExit(model: string, session: string, exclude?: Set<string>): ExitNode | null {
    const directAllowed = this.#d.directAllowed ?? this.#d.pool.includeDirect
    if (!this.#d.poolEnabled) {
      if (!directAllowed || !this.#d.pool.includeDirect || (exclude && exclude.has('direct'))) return null
      this.#d.pool.ensureDirect()
      return this.#d.pool.get('direct') ?? null
    }
    const pick = this.#d.pool.pick(model, session, exclude)
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

  /** Translate the client body to the wire dialect, then apply the free-lane
   *  gate and normalize the tool-call bindings the provider validates. */
  #prepareBody(wireApi: UpstreamApi, clientApi: UpstreamApi, body: Record<string, unknown>): unknown {
    if (wireApi === 'responses') {
      const translated = clientApi === 'chat' ? chatToResponsesBody(body) : body
      // Codex echoes prior-turn `reasoning.encrypted_content` blobs that are
      // bound to the caller identity that minted them; exit rotation makes
      // that identity unstable, and the provider 400s the whole turn when the
      // echo arrives under a different one. stripCallerBoundReasoning explains
      // the full chain (protocol.ts).
      const sanitized = stripCallerBoundReasoning(translated)
      const { body: shaped } = ensureResponsesFreeLaneShape(sanitized)
      return shaped
    }
    const translated = clientApi === 'responses' ? responsesToChatBody(body) : body
    const { body: shaped } = ensureChatFreeLaneShape(translated)
    return normalizeChatToolCallIds(shaped as Record<string, unknown>)
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
    try {
      if (clientApi === wireApi) return await aggregateSse({ body: source } as UpstreamResult, wireApi)
      return await (wireApi === 'responses'
        ? responsesToChatCompletion(source, model)
        : chatToResponsesCompletion(source, model))
    } catch (err) {
      // Converters throw plain Errors; hand the rotation loop a classified
      // UpstreamError so an in-body failure rotates like any other exit-shaped
      // failure instead of surfacing as a bare 500.
      throw ensureUpstreamError(err)
    }
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

/**
 * The Console provider's flaky 400: an `invalid_request_error` that names no
 * field — `Error from provider (Console): Upstream request failed:
 * [invalid_request_error] invalid request`. Every deterministic validation
 * failure this gateway has observed carries the offending detail instead
 * (`[airlock_error] invalid request: unknown variant \`developer\``,
 * `[400] messages[10]: tool messages must include...`, `reasoning
 * \`encrypted_content\` was not issued to this caller`), so the bare message
 * uniquely identifies the flavor that the same wire body survives on replay.
 * Matching the exact bracketed token also keeps `[airlock_error] invalid
 * request: …` (a REAL shape error) non-rotatable.
 */
function isVagueProvider400(message: string): boolean {
  return message.includes('[invalid_request_error] invalid request')
}

/**
 * A compact, content-free summary of the tool-call bindings in the wire body:
 * one entry per INVALID binding (missing / empty / non-string id on a tool
 * message, or a missing id on an assistant tool_calls entry). An empty array
 * means every binding is well-formed, so a 400 came from something else.
 */
function toolShapeSummary(body: unknown): Record<string, unknown>[] {
  const msgs = isRecord(body) && Array.isArray(body.messages) ? (body.messages as unknown[]) : []
  const bad: Record<string, unknown>[] = []
  msgs.forEach((raw, i) => {
    if (!isRecord(raw)) return
    const role = typeof raw.role === 'string' ? raw.role : ''
    if (role === 'tool') {
      const id = raw.tool_call_id
      if (!(typeof id === 'string' && id.length > 0)) {
        bad.push({ i, kind: 'tool', id: id === '' ? 'empty' : typeof id })
      }
      return
    }
    if (role === 'assistant' && Array.isArray(raw.tool_calls)) {
      raw.tool_calls.forEach((rawCall, j) => {
        const cid = isRecord(rawCall) ? rawCall.id : undefined
        if (!(typeof cid === 'string' && cid.length > 0)) bad.push({ i, j, kind: 'assistant.tool_calls', id: cid === '' ? 'empty' : typeof cid })
      })
    }
  })
  return bad
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
    // A failed response must not masquerade as an empty success: THROW the
    // error the bridge emitted (or the upstream's own error body) so it reaches
    // the rotation loop and the client gets a real status code, instead of an
    // HTTP 200 wrapping an error object that SDKs read as a malformed reply.
    const failed = events.find(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'response.failed',
    )
    if (failed) {
      const response = isRecord((failed as { response?: unknown }).response) ? (failed as { response: Record<string, unknown> }).response : {}
      const error = isRecord(response.error) ? response.error : {}
      const message = typeof error.message === 'string' ? error.message : 'upstream response failed'
      throw inBodyFailure(message)
    }
    const bareError = events.find(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'error',
    )
    if (bareError && typeof (bareError as { message?: unknown }).message === 'string') {
      throw inBodyFailure((bareError as { message: string }).message)
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
  // body is still a failure — never answer with an empty "successful" reply.
  const chatError = events.find(
    (e): e is Record<string, unknown> => typeof e === 'object' && e !== null && isRecord((e as Record<string, unknown>).error),
  )
  if (chatError && !Array.isArray((chatError as Record<string, unknown>).choices)) {
    const err = (chatError as { error: Record<string, unknown> }).error
    const message = typeof err.message === 'string' ? err.message : 'upstream error'
    throw inBodyFailure(message)
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
    // A Responses-wire stream fails with `response.failed` rather than a bare
    // error object; without this arm a failure at the head of the stream was
    // replayed to the client instead of rotating to another exit.
    if (parsed.type === 'response.failed') {
      const resp = isRecord(parsed.response) ? parsed.response : {}
      const err = isRecord(resp.error) ? resp.error : {}
      return { message: typeof err.message === 'string' ? err.message : 'upstream response failed', status: 502 }
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

/**
 * Build the error the rotation loop sees when an HTTP 200 body hides a failure.
 * `status: 502` makes it an upstream error to the client; `kind` decides how the
 * pool records it — a region verdict bans the exit×model pairing outright, a
 * rate limit cools the exit, an unknown 5xx soft-bans only after two samples.
 */
function inBodyFailure(message: string): UpstreamError {
  const e = new Error(`upstream error in response body: ${message}`) as UpstreamError
  e.kind = classifyStreamError(message)
  e.status = 502
  return e
}

/**
 * Give an error a FailureKind/status when its thrower didn't set one. The
 * protocol converters throw plain Errors, and a body-budget overrun surfaces as
 * a stream error, so without this the rotation loop would fall back to
 * 'transport' regardless of cause. Stalls and budget overruns are genuinely
 * transport-shaped (cool the exit, let the prober verify); everything else is
 * judged by its message.
 */
function ensureUpstreamError(err: unknown): Error {
  const existing = err as UpstreamError
  if (existing && typeof existing.kind === 'string') return existing
  const message = err instanceof Error ? err.message : String(err)
  const wrapped = new Error(message) as UpstreamError
  wrapped.kind = /\bbudget\b|timeout|timed out|aborted|econnreset|socket hang up|socket hang|idle/.test(message.toLowerCase())
    ? 'transport'
    : classifyStreamError(message)
  wrapped.status = 502
  return wrapped
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
