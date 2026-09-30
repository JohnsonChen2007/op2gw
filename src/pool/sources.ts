import type { ScopedLogger } from '../core/logger.js'
import type { ExitNode } from '../core/types.js'

/**
 * Free proxy-source fetcher.
 *
 * Fetches plain-text proxy lists (one endpoint per line) from user-configured
 * URLs and parses them into exit candidates. Only plain http/socks5 proxies
 * are usable directly by undici; encrypted airport nodes (vmess/vless/...) are
 * out of scope for op2gw's built-in dialer (they would need an external
 * sing-box, matching opencode2dsh's boundary).
 *
 * A per-source circuit breaker disables a source after repeated failures and
 * recovers it after a cooldown, so one dead list cannot stall refreshes.
 */

export interface SourceState {
  url: string
  lastFetch: number
  lastError: string
  consecutiveFailures: number
  disabledUntil: number
  yielded: number
}

const LINE_RE = /^(https?|socks5h?|socks4?):\/\/[^\s]+$/i
const HOSTPORT_RE = /^([a-z0-9.\-]+):(\d{2,5})$/i

/**
 * Lowercase only the scheme and host of a proxy URI. The userinfo part
 * (`user:password`) is preserved verbatim — passwords are case-sensitive and
 * may contain uppercase letters or symbols.
 */
function normalizeProxyUriCase(uri: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^@/?#]*@)?([^:/?#]+)(:\d+)?([/?#].*)?$/i.exec(uri)
  if (!m) return uri
  const [, scheme, auth = '', host, port = '', rest = ''] = m as RegExpExecArray & string[]
  return scheme!.toLowerCase() + auth + host!.toLowerCase() + port + rest
}

/** Parse one line into a normalized proxy URI, or null. */
export function parseProxyLine(line: string, defaultScheme: 'http' | 'socks5' = 'http'): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  if (LINE_RE.test(trimmed)) {
    // socks4/socks4a are unsupported by the dialer; reject explicitly.
    if (/^socks4:/i.test(trimmed)) return null
    // Normalize socks5h -> socks5 (undici treats them the same).
    return normalizeProxyUriCase(trimmed.replace(/^socks5h:\/\//i, 'socks5://'))
  }
  const hp = HOSTPORT_RE.exec(trimmed)
  if (hp) return `${defaultScheme}://${hp[1]}:${hp[2]}`
  return null
}

export interface ProxyParts {
  scheme?: string
  host?: string
  port?: number | string
  username?: string
  password?: string
}

const SCHEMES = new Set(['http', 'https', 'socks5'])
const HOST_RE = /^[a-z0-9.\-]+$/i

/**
 * Build a proxy URI from structured parts (the debug UI's add-exit form).
 * Returns null when host/port are missing or invalid. Credentials are
 * percent-encoded so passwords with `@ : / # ?` etc. stay correct.
 */
export function buildProxyUri(parts: ProxyParts): string | null {
  const scheme = String(parts.scheme ?? 'http').toLowerCase().replace(/^socks5h$/, 'socks5')
  if (!SCHEMES.has(scheme)) return null
  const host = String(parts.host ?? '').trim()
  if (!host || !HOST_RE.test(host)) return null
  const port = Number(parts.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const user = String(parts.username ?? '')
  const pass = String(parts.password ?? '')
  let auth = ''
  if (user) {
    auth = encodeURIComponent(user) + (pass ? ':' + encodeURIComponent(pass) : '') + '@'
  } else if (pass) {
    auth = ':' + encodeURIComponent(pass) + '@'
  }
  return `${scheme}://${auth}${host.toLowerCase()}:${port}`
}

/** Split a proxy URI back into structured parts (round-trip for the UI). */
export function splitProxyUri(uri: string): ProxyParts | null {
  const m = /^(https?|socks5):\/\/(?:([^@/:?#]*)(?::([^@/?#]*))?@)?([^:/?#]+):(\d{2,5})(?:[/?#].*)?$/i.exec(uri)
  if (!m) return null
  const [, scheme, rawUser, rawPass, host, port] = m as RegExpExecArray & string[]
  const decode = (v: string): string => {
    try {
      return decodeURIComponent(v)
    } catch {
      return v
    }
  }
  return {
    scheme: scheme!.toLowerCase(),
    username: rawUser !== undefined ? decode(rawUser) : '',
    password: rawPass !== undefined ? decode(rawPass) : '',
    host: host!,
    port: Number(port),
  }
}

export function proxyToExit(uri: string): Omit<ExitNode, 'addedAt'> {
  const kind = uri.startsWith('socks5') ? 'socks5' : 'http'
  return {
    id: uri,
    kind,
    source: 'free',
    pinned: false,
    exitIP: '',
    location: '',
    latencyMs: 0,
  }
}

export class FreeSources {
  #states = new Map<string, SourceState>()
  readonly #fetch: typeof fetch
  readonly #logger: ScopedLogger
  readonly #cooldownMs: number
  readonly #maxFailures: number

  constructor(
    urls: string[],
    logger: ScopedLogger,
    options: { fetchImpl?: typeof fetch; cooldownMs?: number; maxFailures?: number } = {},
  ) {
    this.#fetch = options.fetchImpl ?? fetch
    this.#logger = logger
    this.#cooldownMs = options.cooldownMs ?? 10 * 60_000
    this.#maxFailures = options.maxFailures ?? 3
    for (const url of urls) {
      this.#states.set(url, { url, lastFetch: 0, lastError: '', consecutiveFailures: 0, disabledUntil: 0, yielded: 0 })
    }
  }

  states(): SourceState[] {
    return [...this.#states.values()]
  }

  /** Fetch all enabled sources and return a deduped candidate list. */
  async fetchAll(limit: number): Promise<Array<Omit<ExitNode, 'addedAt'>>> {
    const now = Date.now()
    const seen = new Set<string>()
    const out: Array<Omit<ExitNode, 'addedAt'>> = []
    for (const state of this.#states.values()) {
      if (state.disabledUntil > now) continue
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        const res = await this.#fetch(state.url, { signal: controller.signal }).finally(() => clearTimeout(timer))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        let count = 0
        for (const line of text.split(/\r?\n/)) {
          const uri = parseProxyLine(line)
          if (!uri || seen.has(uri)) continue
          seen.add(uri)
          out.push(proxyToExit(uri))
          count += 1
          if (out.length >= limit) break
        }
        state.lastFetch = now
        state.lastError = ''
        state.consecutiveFailures = 0
        state.yielded = count
        this.#logger.debug('free source fetched', { url: state.url, yielded: count })
        if (out.length >= limit) break
      } catch (err) {
        state.consecutiveFailures += 1
        state.lastError = err instanceof Error ? err.message : String(err)
        if (state.consecutiveFailures >= this.#maxFailures) {
          state.disabledUntil = now + this.#cooldownMs
          this.#logger.warn('free source tripped breaker', { url: state.url, error: state.lastError })
        }
      }
    }
    return out
  }
}
