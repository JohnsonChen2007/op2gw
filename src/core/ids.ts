import { createHash, randomBytes } from 'node:crypto'

import type { RequestIDs } from './types.js'

/**
 * CLI-identical request disguise.
 *
 * The OpenCode Zen free lane only accepts traffic that looks like the official
 * OpenCode CLI. As of 2026-10 the lane additionally DECODES the correlation ids
 * it receives: the leading 12 hex characters of a `ses_`/`msg_` id are the
 * client's own `tU()` timestamp encoding —
 *
 *   base = Date.now() * 0x1000 + counterWithinMs   (ascending ids, msg_*)
 *   bits = ~base                                   (descending ids, ses_*)
 *   head = bits as 6 big-endian bytes, then 14 base62 random chars
 *
 * Random hex in that head — even in the canonical length/prefix shape — reads
 * as a forged id and the request is rejected with `FreeTierError: OpenCode's
 * free tier can only be used from within OpenCode` (live-probed 2026-10-13:
 * sha-derived heads 403, tU-shaped heads 200, year-old/future timestamps
 * both accepted, so only the encoding is checked, not the clock).
 *
 * Conversations keep a stable session id through an LRU cache keyed by the
 * conversation seed, so multi-turn chats preserve upstream prompt-cache
 * affinity while different conversations separate cleanly.
 *
 * Semantics ported from the opencode-ai binary's id module (tU/u_/oU) and
 * opencode2dsh's adapter/ids.ts.
 */

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Shared per-millisecond counter, mirroring tU()'s `x4`/`cU` globals. */
let lastMs = 0
let counter = 0

/**
 * One id in the official client's `tU()` shape: 12 hex timestamp head + 14
 * base62 random tail. `descending` mirrors the `~base` complement the CLI uses
 * for session ids; message ids use the plain ascending encoding.
 */
function tUId(descending: boolean, at: number = Date.now()): string {
  if (at !== lastMs) {
    lastMs = at
    counter = 0
  }
  counter += 1
  const base = BigInt(at) * 0x1000n + BigInt(counter)
  const bits = descending ? ~base : base
  const head = Array.from({ length: 6 }, (_, i) => Number((bits >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')).join('')
  const tail = Array.from(randomBytes(14), (x) => BASE62[x % 62]).join('')
  return head + tail
}

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

/**
 * Conversation seed → minted session id. The first turn of a conversation
 * mints one tU session; every later turn of the same conversation reuses it
 * (prompt-cache affinity), while a gateway restart re-mints — the lane only
 * validates the id encoding, so both are fine.
 */
const SESSION_CACHE_LIMIT = 8192
const sessionsBySeed = new Map<string, string>()

function cachedSession(signal: string): string {
  const hit = sessionsBySeed.get(signal)
  if (hit !== undefined) {
    // LRU touch: re-insert so the entry moves to the back of the map order.
    sessionsBySeed.delete(signal)
    sessionsBySeed.set(signal, hit)
    return hit
  }
  const session = `ses_${tUId(true)}`
  if (sessionsBySeed.size >= SESSION_CACHE_LIMIT) {
    const oldest = sessionsBySeed.keys().next().value
    if (oldest !== undefined) sessionsBySeed.delete(oldest)
  }
  sessionsBySeed.set(signal, session)
  return session
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 hex (tU time head) + 14
 * Base62. A signal already in that shape passes through unchanged; anything
 * else mints (and caches) a fresh, decodable tU session.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  return cachedSession(signal)
}

/**
 * The conversation signal: JSON of the first user message's content. Using the
 * first user turn keeps a growing conversation stable while separating
 * conversations with different beginnings.
 */
export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/** Derive correlation ids for one upstream request. */
export function deriveRequestIDs(messages: Array<{ role: string; content: unknown }>): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('anon', 16)
  return {
    session: canonicalSessionID(signal),
    // The CLI fills x-opencode-request with the user MESSAGE id (msg_...),
    // ascending tU shape — not a random req_ id. Fresh per request.
    request: `msg_${tUId(false)}`,
    // The CLI sends the real project id; "global" is what headless/anonymous
    // contexts use and the lane accepts it.
    project: 'global',
  }
}

/**
 * CLI-identical user agent. The official binary ships exactly this string
 * (bun-compiled with `--user-agent=opencode/<version>` and the ai-sdk prefix
 * `@ai-sdk/provider-utils` appends); observed live 2026-10-13.
 */
export function opencodeUserAgent(): string {
  return 'opencode/1.18.35 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14'
}

/** The full disguise header set for every upstream request. */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-opencode-session-id': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
