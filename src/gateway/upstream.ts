import { request, type Dispatcher } from 'undici'
import { Readable } from 'node:stream'

import type { ExitNode, FailureKind, RequestIDs, UpstreamApi } from '../core/types.js'
import { ANONYMOUS_KEY } from '../core/freelane.js'
import { disguiseHeaders } from '../core/ids.js'
import type { DispatcherCache } from '../pool/dispatchers.js'

/**
 * Upstream forwarder: sends one prepared request to the OpenCode Zen anonymous
 * lane through a specific exit's dispatcher, with the CLI disguise headers and
 * `Authorization: Bearer public`. Returns the raw upstream response so the
 * gateway can stream it back verbatim (OpenAI-in / OpenAI-out, zero transcode).
 *
 * A body-idle watchdog wraps the response stream: neither undici's bodyTimeout
 * (we disable it) nor fetch owns silence detection once headers arrive, and a
 * proxy can hold a tunnel open while never streaming. The watchdog aborts a
 * stream that goes silent past the idle window (opencode2dsh's lesson).
 */

export interface UpstreamResult {
  status: number
  headers: Record<string, string>
  /** Node Readable of the upstream body (may be a passthrough with watchdog). */
  body: Readable
  /** The raw upstream body before the idle watchdog is applied. Non-streaming
   *  aggregators should prefer this so a long silent stretch (e.g. a reasoning
   *  model marked 'incomplete' by the upstream) does not truncate the body. */
  rawBody: Readable
  /** For diagnostics. */
  contentType: string
}

export interface UpstreamError extends Error {
  kind: FailureKind
  status?: number
  /** Milliseconds the upstream asked us to back off (`Retry-After`), if any. */
  retryAfterMs?: number
}

/**
 * Parse a `Retry-After` header into milliseconds. Accepts both forms the spec
 * allows (delta-seconds and an HTTP-date), returns undefined when absent or
 * unparseable, and caps the result so a hostile/absurd value cannot park an
 * exit in cooldown for hours.
 */
export function parseRetryAfter(value: string | string[] | undefined, now = Date.now()): number | undefined {
  if (value === undefined) return undefined
  const raw = (Array.isArray(value) ? value[0] : value)?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return undefined
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS)
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  const delta = at - now
  return delta > 0 ? Math.min(delta, RETRY_AFTER_CAP_MS) : undefined
}

const RETRY_AFTER_CAP_MS = 5 * 60_000

export function classifyStatus(status: number, bodyHint = ''): FailureKind {
  if (status === 429) return 'limited'
  if (status === 401 || status === 403) {
    if (/regionerror|not available in your country/i.test(bodyHint)) return 'region'
    return 'refused'
  }
  if (status >= 500) return 'server'
  return 'server'
}

export function classifyTransport(message: string): FailureKind {
  const text = message.toLowerCase()
  if (/\b429\b|rate.?limit/.test(text)) return 'limited'
  if (/\b(401|403)\b|regionerror/.test(text)) return 'refused'
  if (/\b5\d\d\b|internal server error|headers timeout|body timeout|socket timeout/i.test(text)) return 'server'
  return 'transport'
}

function upstreamPath(api: UpstreamApi): string {
  return api === 'responses' ? '/v1/responses' : '/v1/chat/completions'
}

export interface ForwardOptions {
  zenBaseUrl: string
  api: UpstreamApi
  ids: RequestIDs
  body: unknown
  exit: ExitNode
  dispatchers: DispatcherCache
  signal?: AbortSignal
  /** Body-idle window (ms); 0 disables the watchdog. */
  bodyIdleMs?: number
  /** First-byte window (ms) before any body chunk. */
  firstByteMs?: number
  /**
   * When true, skip the body-idle watchdog and return the raw upstream body.
   * Non-streaming aggregator consumers need the full body without any silent
   * stretch (a reasoning model marked 'incomplete' by the upstream can sit idle
   * mid-stream) cutting the response short; the aggregator owns end-of-body via
   * stream EOF instead.
   */
  noWatchdog?: boolean
  /**
   * Hard wall-clock budget for reading a NON-STREAMING response body. This is
   * the only bound that path has: with `noWatchdog` set and undici's
   * `bodyTimeout` disabled, a half-open upstream or proxy that never sends FIN
   * would otherwise hang the request forever. An idle window cannot be used
   * here — a legitimately slow reasoning model may go quiet for minutes — so we
   * bound total time instead. Streaming keeps its first-byte/idle watchdogs
   * (which must stay idle-based or they would truncate long generations) and
   * ignores this budget. 0 disables it.
   */
  bodyTotalMs?: number
}

export async function forwardUpstream(options: ForwardOptions): Promise<UpstreamResult> {
  const url = `${options.zenBaseUrl.replace(/\/+$/, '')}${upstreamPath(options.api)}`
  const dispatcher: Dispatcher = options.dispatchers.forExit(options.exit)
  const headers: Record<string, string> = {
    ...disguiseHeaders(options.ids),
    authorization: `Bearer ${ANONYMOUS_KEY}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }

  let res: Dispatcher.ResponseData
  try {
    res = await request(url, {
      dispatcher,
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      signal: options.signal,
      headersTimeout: options.api === 'responses' ? 300_000 : 120_000,
      bodyTimeout: 0,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const e = new Error(`upstream transport failure: ${message}`) as UpstreamError
    e.kind = classifyTransport(message)
    throw e
  }

  const contentType = String(res.headers['content-type'] ?? '')
  const outHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue
    outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v)
  }

  // Non-2xx: read a small body hint for classification, then throw so the
  // gateway can rotate/surface. We cap the read so a huge error body can't hang.
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let hint = ''
    try {
      hint = (await res.body.text()).slice(0, 2000)
    } catch {
      // ignore
    }
    const e = new Error(`upstream HTTP ${res.statusCode}: ${hint.slice(0, 300)}`) as UpstreamError
    e.kind = classifyStatus(res.statusCode, hint)
    e.status = res.statusCode
    e.retryAfterMs = parseRetryAfter(res.headers['retry-after'])
    throw e
  }

  const source = res.body as unknown as Readable
  // Non-streaming aggregators consume the raw body directly (no watchdog), so we
  // must NOT attach a 'data' listener to `source` here — doing so flips it into
  // flowing mode and starves the raw reader. Only build the watchdog stream when
  // actually streaming. `wrapDeadline` is safe on this path: it owns the reader
  // and hands the consumer its own wrapper, so nothing else reads `source`.
  if (options.noWatchdog) {
    const budget = options.bodyTotalMs ?? 0
    const bounded = budget > 0 ? wrapDeadline(source, budget) : source
    return { status: res.statusCode, headers: outHeaders, body: bounded, rawBody: bounded, contentType }
  }
  const body = wrapWatchdog(source, options.firstByteMs ?? 30_000, options.bodyIdleMs ?? 120_000)
  return { status: res.statusCode, headers: outHeaders, body, rawBody: source, contentType }
}

/**
 * Wrap a readable so it errors if no chunk arrives within firstByteMs (before
 * any data) or bodyIdleMs (between chunks). A 0 window disables that check.
 */
export function wrapWatchdog(source: Readable, firstByteMs: number, bodyIdleMs: number): Readable {
  if (firstByteMs <= 0 && bodyIdleMs <= 0) return source
  const out = new Readable({ read() {} })
  let sawData = false
  let timer: NodeJS.Timeout | undefined
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    const window = sawData ? bodyIdleMs : firstByteMs
    if (window <= 0) return
    timer = setTimeout(() => {
      const msg = sawData
        ? 'op2gw: upstream stream body idle timeout'
        : 'op2gw: upstream first-byte timeout'
      source.destroy(new Error(msg))
      out.destroy(new Error(msg))
    }, window)
    timer.unref?.()
  }
  arm()
  source.on('data', (chunk) => {
    sawData = true
    arm()
    if (!out.push(chunk)) source.pause()
  })
  out.on('drain', () => source.resume())
  source.on('end', () => {
    if (timer) clearTimeout(timer)
    out.push(null)
  })
  source.on('error', (err) => {
    if (timer) clearTimeout(timer)
    out.destroy(err)
  })
  // Consumer gone (client disconnect, pipeline error): release the upstream
  // instead of draining a whole generation into a stream nobody reads.
  out.on('close', () => {
    if (timer) clearTimeout(timer)
    if (!source.readableEnded && !source.destroyed) source.destroy()
  })
  return out
}

/**
 * Wrap a readable so it errors once `budgetMs` of wall-clock time has elapsed,
 * regardless of how much data has flowed. Unlike `wrapWatchdog` this never
 * rearms, so it bounds TOTAL time rather than silence — which is exactly what a
 * non-streaming body read needs (that path deliberately tolerates long quiet
 * stretches, so an idle window cannot protect it).
 *
 * A 0 budget returns the source untouched. The wrapper also destroys the source
 * when its own consumer drops it, so an abandoned read does not keep an upstream
 * connection pinned open.
 */
export function wrapDeadline(source: Readable, budgetMs: number): Readable {
  if (budgetMs <= 0) return source
  const out = new Readable({ read() {} })
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    const err = new Error(`op2gw: upstream body exceeded its ${budgetMs}ms budget`)
    source.destroy(err)
    out.destroy(err)
  }, budgetMs)
  timer.unref?.()
  const settle = (): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
  }
  source.on('data', (chunk) => {
    if (!out.push(chunk)) source.pause()
  })
  out.on('drain', () => source.resume())
  source.on('end', () => {
    settle()
    out.push(null)
  })
  source.on('error', (err) => {
    settle()
    out.destroy(err)
  })
  out.on('close', () => {
    settle()
    if (!source.readableEnded && !source.destroyed) source.destroy()
  })
  return out
}
