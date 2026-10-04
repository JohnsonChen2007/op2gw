import { join } from 'node:path'
import type { Dispatcher } from 'undici'

import type { ExitNode } from './core/types.js'
import type { Op2gwConfig } from './core/config.js'
import { configFilePath, detectEnvProxy } from './core/config.js'
import { Logger } from './core/logger.js'
import { ModelCatalog, defaultCachePath, type CatalogSnapshot } from './catalog/catalog.js'
import { ExitPool } from './pool/pool.js'
import { DispatcherCache } from './pool/dispatchers.js'
import { FreeSources, parseProxyLine } from './pool/sources.js'
import { normalizeProxyUri } from './core/config.js'
import { Prober } from './pool/prober.js'
import { Gateway } from './gateway/gateway.js'
import { SelfHealer } from './selfheal.js'

/**
 * Runtime — owns every long-lived subsystem and their lifecycle.
 *
 * Assembly order matters: logger -> catalog -> pool (+ dispatchers, sources,
 * prober) -> gateway -> self-healer. start() brings the catalog and pool
 * online; stop() tears everything down cleanly.
 */

export interface RuntimeStatus {
  version: string
  uptimeMs: number
  catalog: CatalogSnapshot
  pool: {
    enabled: boolean
    total: number
    exits: ReturnType<ExitPool['view']>
    sources: ReturnType<FreeSources['states']> | []
  }
  logLevel: string
  proxy: string
}

const VERSION = '0.2.1'

export class Runtime {
  readonly config: Op2gwConfig
  readonly logger: Logger
  readonly catalog: ModelCatalog
  readonly pool: ExitPool
  readonly dispatchers: DispatcherCache
  readonly gateway: Gateway
  readonly #sources: FreeSources | null
  readonly #prober: Prober | null
  readonly #selfHealer: SelfHealer
  #freeTimer: NodeJS.Timeout | null = null
  #startedAt = 0

  constructor(config: Op2gwConfig) {
    this.config = config
    this.logger = new Logger({ level: config.logLevel, capacity: 3000, traceCapacity: 800 })

    // Dispatchers first: the catalog fetch must egress through the default
    // proxy too (a region-locked upstream blocks /v1/models otherwise).
    this.dispatchers = new DispatcherCache({ cap: 128, defaultProxy: config.proxy })
    if (config.proxy) this.logger.child('runtime').info('default proxy active', { proxy: config.proxy })

    this.catalog = new ModelCatalog({
      zenBaseUrl: config.zenBaseUrl,
      metadataUrl: config.metadataUrl,
      refreshSeconds: config.refreshSeconds,
      cachePath: defaultCachePath(config.dataDir),
      logger: this.logger.child('catalog'),
      staleMs: config.selfHeal.catalogStaleMs,
      fetchImpl: this.#proxyFetch(),
    })

    this.pool = new ExitPool({
      cooldownMs: config.pool.cooldownMs,
      banTtlMs: config.pool.banTtlMs,
      deadRecheckMs: config.selfHeal.deadRecheckMs,
      deadEvictions: config.selfHeal.deadEvictions,
    })

    // Seed the pool. Direct is only registered when includeDirect is true.
    this.pool.setIncludeDirect(config.pool.includeDirect)
    if (config.pool.includeDirect) {
      this.pool.ensureDirect()
    }
    if (config.pool.enabled) {
      for (const raw of config.pool.manual) {
        const uri = parseProxyLine(normalizeProxyUri(raw))
        if (!uri) {
          this.logger.child('pool').warn('ignored invalid manual proxy', { raw })
          continue
        }
        this.pool.add({
          id: uri,
          kind: uri.startsWith('socks5') ? 'socks5' : 'http',
          source: 'manual',
          pinned: uri === config.pool.pinnedExitId,
          exitIP: '',
          location: '',
          latencyMs: 0,
        })
      }
      if (config.pool.pinnedExitId) this.pool.setPinned(config.pool.pinnedExitId)
    }

    this.#sources =
      config.pool.enabled && config.pool.freeSources.length > 0
        ? new FreeSources(config.pool.freeSources, this.logger.child('sources'), {
            // Route source fetches through the default egress proxy too — the
            // source lists themselves are often unreachable without it.
            fetchImpl: this.#proxyFetch(),
          })
        : null

    this.#prober = config.pool.enabled
      ? new Prober(this.pool, this.dispatchers, this.logger.child('prober'), {
          maxConcurrent: config.pool.maxConcurrentProbes,
          // Probe the gateway's own upstream models endpoint first: an exit
          // that can serve inference traffic must never be judged dead by
          // generic connectivity sites the proxy line happens to block.
          upstreamUrl: `${config.zenBaseUrl.replace(/\/+$/, '')}/v1/models`,
        })
      : null

    this.gateway = new Gateway({
      logger: this.logger,
      scoped: this.logger.child('gateway'),
      catalog: this.catalog,
      pool: this.pool,
      dispatchers: this.dispatchers,
      zenBaseUrl: config.zenBaseUrl,
      maxRotateAttempts: config.pool.maxRotateAttempts,
      poolEnabled: config.pool.enabled,
      directAllowed: config.pool.includeDirect,
      // Refusing a request is also a recovery signal: verify every exit right
      // now (multi-site) instead of waiting for the scheduled probe rounds.
      onPoolStarved: () => {
        if (this.#prober) void this.#prober.tick(true)
      },
    })

    this.#selfHealer = new SelfHealer({
      logger: this.logger.child('selfheal'),
      catalog: this.catalog,
      pool: this.pool,
      config,
    })
  }

  /**
   * A fetch bound to egress through the IP pool (or configured default proxy) —
   * used by the model catalog and the free-source fetcher so their traffic follows
   * the proxy pool and never leaks the host's direct IP when direct egress is disallowed.
   */
  #proxyFetch(): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      let exit: ExitNode | null = null
      let dispatcher: Dispatcher | undefined

      if (this.config.pool.enabled) {
        const pick = this.pool.pick('*', 'catalog')
        if (pick && pick.exit.kind !== 'direct') {
          exit = pick.exit
          dispatcher = this.dispatchers.forExit(pick.exit)
        }
      }
      if (!dispatcher && this.dispatchers.defaultProxy) {
        dispatcher = this.dispatchers.directDispatcher()
      }
      if (!dispatcher) {
        if (!this.config.pool.includeDirect) {
          throw new Error('All requests must go through the IP pool, but no usable proxy is available')
        }
        dispatcher = this.dispatchers.directDispatcher()
      }

      try {
        const res = await fetch(input, { ...(init ?? {}), dispatcher } as never)
        if (exit) {
          if (res.ok) {
            this.pool.markSuccess(exit.id, '*')
          } else if (res.status === 429) {
            this.pool.markFailure(exit.id, '*', 'limited')
            this.pool.rerouteSession('catalog')
          }
        }
        return res
      } catch (err) {
        if (exit) {
          this.pool.markFailure(exit.id, '*', 'transport')
          this.pool.rerouteSession('catalog')
        }
        throw err
      }
    }) as typeof fetch
  }

  /**
   * Live-apply the default egress proxy without a restart. Updates the shared
   * config, swaps the direct-proxy dispatcher (catalog + gateway direct exit
   * both read it), and forces a catalog refresh so the model list reflects the
   * new egress region immediately.
   */
  setProxy(uri: string): void {
    this.config.proxy = uri
    this.dispatchers.setDefaultProxy(uri)
    // The 'direct' exit IS the configured default proxy. Reset its health and
    // drop stale per-model bans: a cooldown/dead verdict or a region/model ban
    // learned under the previous proxy's egress IP must not divert inference
    // traffic to other pool exits under the new proxy. Sticky bindings are
    // cleared so sessions re-resolve. The catalog refresh (fired below) then
    // reflects the new egress region immediately.
    if (this.config.pool.includeDirect) {
      this.pool.markSuccess('direct', '*')
      this.pool.clearModelBans('direct')
    }
    this.pool.clearSticky()
    this.logger.child('runtime').info('proxy reconfigured', { proxy: uri || '(direct)' })
    void this.catalog.refreshOnce()
  }

  /** Live-set the log level. */
  setLogLevel(level: Op2gwConfig['logLevel']): void {
    this.config.logLevel = level
    this.logger.setLevel(level)
  }

  /**
   * Reconcile the persisted manual proxy list (pool.manual) with the live pool:
   * add new entries, remove dropped ones (pool + dispatcher), keep probe
   * metadata on re-add, and invalidate a pinned id that no longer exists.
   * This is how the settings page edits the proxy pool — the list is persisted
   * verbatim to the config file and applied without a restart.
   */
  applyManualPool(next: string[]): { added: string[]; removed: string[] } {
    const normalized: string[] = []
    for (const item of next) {
      const uri = parseProxyLine(normalizeProxyUri(String(item)))
      if (uri && !normalized.includes(uri)) normalized.push(uri)
    }
    const prev = [...this.config.pool.manual]
    const removed = prev.filter((u) => !normalized.includes(u))
    this.config.pool.manual = normalized
    for (const uri of removed) {
      this.pool.remove(uri)
      this.dispatchers.drop(uri)
      this.logger.child('pool').info('manual exit removed', { uri })
    }
    if (this.config.pool.enabled) {
      for (const uri of normalized) {
        const old = this.pool.get(uri)
        this.pool.add({
          id: uri,
          kind: uri.startsWith('socks5') ? 'socks5' : 'http',
          source: 'manual',
          pinned: uri === this.config.pool.pinnedExitId,
          exitIP: old?.exitIP ?? '',
          location: old?.location ?? '',
          latencyMs: old?.latencyMs ?? 0,
        })
        if (!prev.includes(uri)) this.logger.child('pool').info('manual exit added', { uri })
      }
    }
    if (this.config.pool.pinnedExitId && !normalized.includes(this.config.pool.pinnedExitId)) {
      this.config.pool.pinnedExitId = ''
      this.pool.setPinned('')
      this.logger.child('pool').info('pinned exit cleared (removed from manual list)')
    }
    return { added: normalized.filter((u) => !prev.includes(u)), removed }
  }

  async start(): Promise<void> {
    this.#startedAt = Date.now()
    this.logger.child('runtime').info('starting', { version: VERSION, poolEnabled: this.config.pool.enabled })
    // Catalog first (non-blocking retries inside).
    void this.catalog.start()
    if (this.config.pool.enabled) {
      await this.refreshFreePool()
      this.#prober?.start(this.config.pool.probeIntervalMs)
      // Periodic free-pool top-up.
      this.#freeTimer = setInterval(() => void this.refreshFreePool(), 10 * 60_000)
      this.#freeTimer.unref?.()
    }
    this.#selfHealer.start()
  }

  async stop(): Promise<void> {
    this.logger.child('runtime').info('stopping')
    this.catalog.stop()
    this.#prober?.stop()
    this.#selfHealer.stop()
    if (this.#freeTimer) clearInterval(this.#freeTimer)
    await this.dispatchers.destroy()
  }

  /** Fetch free sources and admit new candidates up to the target size. */
  async refreshFreePool(): Promise<void> {
    if (!this.#sources) return
    const current = this.pool.view().filter((e) => e.source === 'free').length
    const need = Math.max(0, this.config.pool.freeTargetSize - current)
    if (need === 0) return
    try {
      const candidates = await this.#sources.fetchAll(need * 2)
      let added = 0
      for (const candidate of candidates) {
        if (this.pool.has(candidate.id)) continue
        this.pool.add(candidate)
        added += 1
        if (added >= need) break
      }
      if (added > 0) {
        this.logger.child('pool').info('admitted free candidates', { added, total: this.pool.size() })
        // Kick a probe round so new nodes get an admission verdict promptly.
        void this.#prober?.tick()
      }
    } catch (err) {
      this.logger.child('pool').warn('free pool refresh failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  status(): RuntimeStatus {
    return {
      version: VERSION,
      uptimeMs: this.#startedAt === 0 ? 0 : Date.now() - this.#startedAt,
      catalog: this.catalog.snapshot(),
      pool: {
        enabled: this.config.pool.enabled,
        total: this.pool.size(),
        exits: this.pool.view(),
        sources: this.#sources ? this.#sources.states() : [],
      },
      logLevel: this.logger.level,
      proxy: this.dispatchers.defaultProxy,
    }
  }

  /** The user-editable settings surface for the config page. */
  settings(): {
    host: string
    port: number
    proxy: string
    logLevel: string
    refreshSeconds: number
    poolEnabled: boolean
    hasApiKeys: boolean
    envProxyDetected: string
    configPath: string
    /** Persisted manual proxy pool (auth-aware URIs, verbatim config order). */
    proxyPool: string[]
    /** Id of the pinned pool exit ('' = none). */
    pinnedExitId: string
    /** Whether direct egress is included in the pool. */
    includeDirect: boolean
  } {
    return {
      host: this.config.host,
      port: this.config.port,
      proxy: this.dispatchers.defaultProxy,
      logLevel: this.logger.level,
      refreshSeconds: this.config.refreshSeconds,
      poolEnabled: this.config.pool.enabled,
      hasApiKeys: this.config.apiKeys.length > 0,
      envProxyDetected: detectEnvProxy(),
      configPath: configFilePath(this.config),
      proxyPool: [...this.config.pool.manual],
      pinnedExitId: this.config.pool.pinnedExitId,
      includeDirect: this.config.pool.includeDirect,
    }
  }

  /** Write a health snapshot file (self-heal + external monitoring). */
  statusFilePath(): string {
    return join(this.config.dataDir, 'status.json')
  }
}

export { VERSION }
