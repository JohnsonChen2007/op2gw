import { Agent, ProxyAgent, type Dispatcher } from 'undici'

import type { ExitNode } from '../core/types.js'

/**
 * Per-exit undici dispatcher cache.
 *
 * This is the structural advantage of a standalone gateway over an in-process
 * DSH plugin: op2gw owns every outbound request, so instead of the fragile
 * global-dispatcher swap (which opencode2dsh needed because pi-ai captured the
 * built-in fetch), we simply pass `{ dispatcher }` to each undici request and
 * pick the dispatcher that dials through the chosen exit. Direct egress uses a
 * plain keep-alive Agent; http/socks5 exits use a ProxyAgent.
 *
 * Dispatchers are created lazily and cached per exit id, with an LRU cap so a
 * large free pool cannot leak connection pools.
 */

export interface DispatcherCacheOptions {
  /** Max cached dispatchers (excluding direct). Default 64. */
  cap?: number
  /** Request/connect timeout hints (ms). */
  connectTimeoutMs?: number
  headersTimeoutMs?: number
  bodyTimeoutMs?: number
}

export class DispatcherCache {
  #plainDirect: Dispatcher
  /** When a default proxy is set, the 'direct' exit egresses through it too. */
  #directProxy: Dispatcher | null = null
  #defaultProxy = ''
  #cache = new Map<string, Dispatcher>()
  readonly #cap: number
  readonly #opts: Required<Omit<DispatcherCacheOptions, 'cap'>>

  constructor(options: DispatcherCacheOptions & { defaultProxy?: string } = {}) {
    this.#cap = options.cap ?? 64
    this.#opts = {
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      // headersTimeout covers time-to-response-headers only; the gateway owns
      // the body-idle watchdog separately (like opencode2dsh learned).
      headersTimeoutMs: options.headersTimeoutMs ?? 60_000,
      bodyTimeoutMs: options.bodyTimeoutMs ?? 0, // 0 = no undici body timeout; watchdog handles it.
    }
    this.#plainDirect = new Agent({
      connect: { timeout: this.#opts.connectTimeoutMs },
      headersTimeout: this.#opts.headersTimeoutMs,
      bodyTimeout: this.#opts.bodyTimeoutMs,
    })
    if (options.defaultProxy) this.setDefaultProxy(options.defaultProxy)
  }

  /** The current default proxy uri ('' = none). */
  get defaultProxy(): string {
    return this.#defaultProxy
  }

  /**
   * Set (or clear) the default egress proxy. All 'direct' traffic — gateway
   * inference and the catalog fetch — flows through it. Live-applied: replaces
   * the direct-proxy dispatcher and closes the old one. Empty clears it.
   */
  setDefaultProxy(uri: string): void {
    const next = (uri ?? '').trim()
    if (next === this.#defaultProxy) return
    const old = this.#directProxy
    this.#defaultProxy = next
    this.#directProxy = next ? this.#buildProxy(next) : null
    void old?.close?.().catch(() => {})
  }

  /** A dispatcher for the default-proxy path (used by the catalog fetch). */
  directDispatcher(): Dispatcher {
    return this.#directProxy ?? this.#plainDirect
  }

  /**
   * A fetch bound to the default egress.
   *
   * This exists because the built-in `fetch` CANNOT be trusted for egress
   * control. Under Node >= 24 a bare `fetch` honours `NODE_USE_ENV_PROXY` (or
   * `--use-env-proxy`) and otherwise silently ignores the proxy environment
   * variables entirely, and even when it does honour them it follows
   * `HTTP(S)_PROXY` rather than the configured exit. Both failure modes are
   * catastrophic rather than cosmetic: an upstream that gates on the caller's
   * country (Zen's RegionError) sees the operator's REAL country instead of the
   * configured exit's, so region-limited models fail even though the exit is
   * perfectly healthy. Undici's `dispatcher` option leaves no such ambiguity.
   *
   * Use this for every gateway-owned outbound HTTP call (catalog, metadata,
   * proxy-source lists) so their egress is exactly the configured one.
   */
  boundFetch(): typeof fetch {
    const dispatchers = this
    return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(input, { ...(init ?? {}), dispatcher: dispatchers.directDispatcher() } as never)) as typeof fetch
  }

  /** Resolve the dispatcher for an exit, creating and caching as needed. */
  forExit(exit: ExitNode): Dispatcher {
    if (exit.kind === 'direct') return this.#directProxy ?? this.#plainDirect
    const cached = this.#cache.get(exit.id)
    if (cached) {
      // LRU touch.
      this.#cache.delete(exit.id)
      this.#cache.set(exit.id, cached)
      return cached
    }
    const dispatcher = this.#build(exit)
    this.#evictIfNeeded()
    this.#cache.set(exit.id, dispatcher)
    return dispatcher
  }

  #build(exit: ExitNode): Dispatcher {
    return this.#buildProxy(exit.id)
  }

  #buildProxy(uri: string): Dispatcher {
    // undici ProxyAgent accepts http(s):// and socks proxies via the uri.
    // For SOCKS, undici v7 supports `socks5://` uris on ProxyAgent through the
    // connect layer; when unsupported it throws and the caller falls back to
    // marking the exit dead on first dispatch.
    return new ProxyAgent({
      uri,
      connectTimeout: this.#opts.connectTimeoutMs,
      // A wild proxy that keeps a half-open tunnel breaks keep-alive; disabling
      // pipelining is the known mitigation (opencode2dsh / dsh-llm-proxy).
      pipelining: 0,
      headersTimeout: this.#opts.headersTimeoutMs,
      bodyTimeout: this.#opts.bodyTimeoutMs,
    } as ConstructorParameters<typeof ProxyAgent>[0])
  }

  #evictIfNeeded(): void {
    while (this.#cache.size >= this.#cap) {
      const oldest = this.#cache.keys().next().value as string | undefined
      if (!oldest) break
      const dispatcher = this.#cache.get(oldest)
      this.#cache.delete(oldest)
      void dispatcher?.close?.().catch(() => {})
    }
  }

  /** Drop a single exit's dispatcher (on eviction/removal). */
  drop(exitId: string): void {
    const dispatcher = this.#cache.get(exitId)
    if (dispatcher) {
      this.#cache.delete(exitId)
      void dispatcher.close?.().catch(() => {})
    }
  }

  async destroy(): Promise<void> {
    const all = [this.#plainDirect, ...(this.#directProxy ? [this.#directProxy] : []), ...this.#cache.values()]
    this.#cache.clear()
    await Promise.allSettled(all.map((d) => d.close?.()))
  }
}
