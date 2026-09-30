import { createHash, randomBytes } from 'node:crypto'

import type { RequestIDs } from './types.js'

/**
 * CLI-identical request disguise.
 *
 * The OpenCode Zen free lane only accepts traffic that looks like the official
 * OpenCode CLI: a canonical session id shape, the CLI user-agent, and a fixed
 * set of correlation headers. These are derived per request from the
 * conversation itself so a multi-turn chat keeps a stable session id
 * (preserving upstream prompt-cache affinity) while different conversations
 * separate cleanly.
 *
 * Ported (verbatim semantics) from opencode2dsh's adapter/ids.ts, which itself
 * mirrors opencode2api ids.go.
 */

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

function base62Fixed(value: bigint, width: number): string {
  let n = value
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62.charAt(Number(n % 62n))
    n /= 62n
  }
  return out.join('')
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 hex + 14 Base62. A signal
 * already in that shape passes through unchanged; anything else is hashed
 * deterministically into it, so the same conversation keeps a stable session.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const timePart = sum.subarray(0, 6).toString('hex')
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  return `ses_${timePart}${randomPart}`
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
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'op2gw:default-project'),
  }
}

/** CLI-identical user agent. */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/** The full disguise header set for every upstream request. */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
