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
}

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
  if (/\b5\d\d\b|internal server error/.test(text)) return 'server'
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
    throw e
  }

  const source = res.body as unknown as Readable
  // Non-streaming aggregators consume the raw body directly (no watchdog), so we
  // must NOT attach a 'data' listener to `source` here — doing so flips it into
  // flowing mode and starves the raw reader. Only build the watchdog stream when
  // actually streaming.
  if (options.noWatchdog) {
    return { status: res.statusCode, headers: outHeaders, body: source, rawBody: source, contentType }
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
  return out
}
