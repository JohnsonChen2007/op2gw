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

/** Floor between two recovery-triggered free-source fetches. */
const RECOVER_REFRESH_MIN_INTERVAL_MS = 60_000

/**
 * How long a free exit that died after admission stays out of the candidate
 * stream. Long enough to cover a whole outage window for that proxy, short
 * enough that a proxy which recovers is eventually given a fair re-test.
 */
const FREE_REJECT_TTL_MS = 6 * 60 * 60_000

/**
 * Probe-latency budget for a FREE exit to be worth keeping. Aligned with the
 * probe's own 6s per-target abort rather than the manual exits' sub-2s norm:
 * a free proxy is allowed to be slow (that is the trade for an extra egress IP),
 * but not so slow that every request routed to it stalls — the request path is
 * bounded by the 6s connect timeout, so this budget is what decides whether a
 * slot is worth the rotation it will occupy. Manual exits are exempt: they are
 * the pool's proven capacity, not a lottery.
 */
const FREE_LATENCY_BUDGET_MS = 5_000

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
  /** Throttles the free-source fetch fired by an on-demand recovery. */
  #lastRecoverRefresh = 0
  /** Free ids currently admitted — an id that disappears has been evicted. */
  readonly #freeAdmitted = new Set<string>()
  /** Evicted free ids -> when, so a stable source file cannot cycle them back. */
  readonly #freeRejected = new Map<string, number>()

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
      // Runtime auto-hide: a model that keeps failing with an upstream `server`
      // fault is dropped from /v1/models for a while, then re-probed. Per
      // process, so each region converges on the ids that actually work there.
      hideAfterFailures: config.modelVisibility.hideAfterFailures,
      hideForMs: config.modelVisibility.hideForMs,
    })

    this.pool = new ExitPool({
      cooldownMs: config.pool.cooldownMs,
      banTtlMs: config.pool.banTtlMs,
      deadRecheckMs: config.selfHeal.deadRecheckMs,
      deadEvictions: config.selfHeal.deadEvictions,
      // A quota 429's Retry-After is the real window reset (hours), not a
      // precautionary backoff — credit it or the pool re-samples a burned
      // egress every cooldownMs for as long as the window lasts.
      honorRetryAfter: config.pool.honorRetryAfter,
      maxCooldownMs: config.pool.maxCooldownMs,
      // Spread concurrent work across egress IPs instead of draining one.
      maxInflightPerExit: config.pool.maxInflightPerExit,
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
      // Read per request so a hot-swapped key (settings page, no restart)
      // takes effect on the very next inference call.
      getApiKey: () => this.config.zenApiKey,
      // Non-streaming bodies have no idle watchdog, so this budget is the only
      // thing keeping a half-open upstream from hanging a request forever.
      bodyBudgetMs: config.bodyBudgetMs,
      // Bounds the pre-content rotation loop in wall-clock terms: attempt count
      // alone let a dirty pool hold a request for attempt-count x connect-timeout.
      rotateBudgetMs: config.pool.rotateBudgetMs,
      // Refusing a request is also a recovery signal: verify every exit right
      // now (multi-site) instead of waiting for the scheduled probe rounds.
      onPoolStarved: () => this.#recoverPool(),
    })

    this.#selfHealer = new SelfHealer({
      logger: this.logger.child('selfheal'),
      catalog: this.catalog,
      pool: this.pool,
      config,
      // An idle gateway must recover on its own too. Previously the only thing
      // that re-verified a starved pool was an incoming client request, so a
      // pool that died overnight stayed dead until somebody showed up.
      onPoolStarved: () => this.#recoverPool(),
    })
  }

  /**
   * Bring a starved pool back without waiting for the schedule: force-verify
   * every exit (a tunnel that quietly recovered is revived now rather than
   * after the next probe round) and top the pool up from the free sources.
   *
   * Shared by the gateway's on-demand kick and the self-heal watchdog so an
   * idle gateway heals too. Both promises are explicitly caught — they are
   * fire-and-forget, and one escaped rejection would become an
   * unhandledRejection. The source fetch is rate-limited because under a
   * sustained outage it would otherwise be hit by every single request.
   */
  #recoverPool(): void {
    if (this.#prober) {
      void this.#prober.tick(true).catch((err) => {
        this.logger.child('prober').warn('on-demand probe round failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    const now = Date.now()
    if (now - this.#lastRecoverRefresh < RECOVER_REFRESH_MIN_INTERVAL_MS) return
    this.#lastRecoverRefresh = now
    void this.refreshFreePool().catch((err) => {
      this.logger.child('pool').warn('on-demand pool refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * Run a full verification round right now, bypassing the probe schedule.
   *
   * Exposed for the admin "probe" endpoint: that route previously called the
   * free-source refresher instead, so the debug UI's probe button never
   * actually probed anything and an operator had no manual way to revive a
   * dead pool.
   */
  forceProbe(): void {
    if (!this.#prober) return
    void this.#prober.tick(true).catch((err) => {
      this.logger.child('prober').warn('forced probe round failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * A fetch for the gateway's OWN outbound HTTP calls (model catalog S1/S2,
   * free proxy-source lists) — never the inference path.
   *
   * These calls need egress control (never leak the host's direct IP when
   * direct egress is disallowed) but NOT the pool's per-IP rotation. The free
   * lane meters inference quota per egress IP, so rotating exits matters for
   * INFERENCE; a catalog fetch is one cheap GET every few minutes and gains
   * nothing from churning IPs.
   *
   * Routing them through the pool first was a footgun: the pool deliberately
   * rotates across exits — including ones that just flapped to 'dead' — so on a
   * bad round the catalog's S1 fetch landed on a dead SOCKS port and timed out
   * ("fetch failed"), leaving the catalog stuck at 'pending' with an EMPTY model
   * list. That then failed every inference request's free-model check
   * (metadata_pending) — a dependency that gates the whole gateway was riding
   * the churning exit pool. Order is therefore: STABLE default proxy (itself a
   * proxy, so no direct-IP leak) -> a non-direct pool exit -> direct (or refuse).
   */
  #proxyFetch(): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      let exit: ExitNode | null = null
      let dispatcher: Dispatcher | undefined

      // 1. Stable default proxy first, when configured (the healthy default).
      if (this.dispatchers.defaultProxy) {
        dispatcher = this.dispatchers.directDispatcher()
      }
      // 2. Fall back to a non-direct pool exit (no default proxy configured).
      if (!dispatcher && this.config.pool.enabled) {
        const pick = this.pool.pick('*', 'catalog')
        if (pick && pick.exit.kind !== 'direct') {
          exit = pick.exit
          dispatcher = this.dispatchers.forExit(pick.exit)
        }
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
   * Live-set the upstream Zen API key (takes effect on the next request; the
   * value itself is never logged). Empty string = back to anonymous.
   */
  setZenApiKey(key: string): void {
    this.config.zenApiKey = key.trim()
    this.logger.child('runtime').info('zen api key updated', { anonymous: this.config.zenApiKey === '' })
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
    // Catalog first (non-blocking retries inside). Caught explicitly: this is
    // fire-and-forget, and a rejection escaping it would otherwise take the
    // process down before it ever served a request.
    void this.catalog.start().catch((err) => {
      this.logger.child('catalog').warn('catalog bootstrap failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
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
    const now = Date.now()
    // Retire what died: an id we admitted that is no longer in the pool was
    // evicted as dead, and these lists are stable enough in order that the next
    // fetch would hand back exactly that same address.
    for (const [id, at] of this.#freeRejected) if (now - at > FREE_REJECT_TTL_MS) this.#freeRejected.delete(id)
    for (const id of [...this.#freeAdmitted]) {
      if (this.pool.has(id)) continue
      this.#freeAdmitted.delete(id)
      this.#freeRejected.set(id, now)
    }

    // Retire free exits that probe alive but too slow to keep (see
    // FREE_LATENCY_BUDGET_MS): they count as "live" and so hold a slot at the
    // target while costing every request that lands on them a full connect
    // timeout. They also go into the rejection set, so the next fetch brings a
    // different address rather than this one back.
    for (const exit of this.pool.view()) {
      if (exit.source !== 'free' || exit.state !== 'ok') continue
      if (exit.latencyMs <= FREE_LATENCY_BUDGET_MS) continue
      this.pool.remove(exit.id)
      this.#freeAdmitted.delete(exit.id)
      this.#freeRejected.set(exit.id, now)
      this.logger.child('pool').info('dropped slow free exit', { uri: exit.id, latencyMs: exit.latencyMs })
    }

    // Target the LIVE set, not the raw count. Dead entries parked at the target
    // size used to block top-up entirely, so the pool sat at its quota ceiling
    // holding mostly-dead members while the source list went unread — the reason
    // a 16-slot free pool ended up contributing about one working exit.
    const live = this.pool.view().filter((e) => e.source === 'free' && e.state !== 'dead').length
    const need = Math.max(0, this.config.pool.freeTargetSize - live)
    if (need === 0) return
    try {
      const candidates = await this.#sources.fetchAll(need * 4)
      let added = 0
      for (const candidate of candidates) {
        if (added >= need) break
        if (this.pool.has(candidate.id) || this.#freeRejected.has(candidate.id)) continue
        this.pool.add(candidate)
        this.#freeAdmitted.add(candidate.id)
        added += 1
      }
      if (added > 0) {
        this.logger.child('pool').info('admitted free candidates', { added, total: this.pool.size() })
        // Kick a probe round so new nodes get an admission verdict promptly.
        void this.#prober?.tick().catch((err) => {
          this.logger.child('prober').warn('admission probe round failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } catch (err) {
      this.logger.child('pool').warn('free pool refresh failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * Liveness/readiness snapshot for `/healthz` and external monitoring.
   *
   * `degraded` means the gateway cannot serve a single request right now: every
   * exit is cooling/dead/banned (or direct egress is disallowed with no proxy
   * left). The old endpoint always answered 200, so a monitor could only tell
   * "the process is up" — never "the process is up but serving nothing", which
   * is precisely the outage self-heal exists to detect.
   */
  health(): {
    status: 'ok' | 'degraded'
    version: string
    uptimeMs: number
    catalog: CatalogSnapshot
    pool: { enabled: boolean; total: number; usable: number }
  } {
    const usable = this.pool.usableCount('*')
    return {
      status: usable === 0 ? 'degraded' : 'ok',
      version: VERSION,
      uptimeMs: this.#startedAt === 0 ? 0 : Date.now() - this.#startedAt,
      catalog: this.catalog.snapshot(),
      pool: { enabled: this.config.pool.enabled, total: this.pool.size(), usable },
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
    envProxyDetected: string
    configPath: string
    /** Persisted manual proxy pool (auth-aware URIs, verbatim config order). */
    proxyPool: string[]
    /** Id of the pinned pool exit ('' = none). */
    pinnedExitId: string
    /** Whether direct egress is included in the pool. */
    includeDirect: boolean
    /** Whether an upstream Zen API key is configured (value never exposed). */
    zenApiKeySet: boolean
    /** Effective upstream credential mode (for display). */
    authMode: 'key' | 'anonymous'
  } {
    return {
      host: this.config.host,
      port: this.config.port,
      proxy: this.dispatchers.defaultProxy,
      logLevel: this.logger.level,
      refreshSeconds: this.config.refreshSeconds,
      poolEnabled: this.config.pool.enabled,
      envProxyDetected: detectEnvProxy(),
      configPath: configFilePath(this.config),
      proxyPool: [...this.config.pool.manual],
      pinnedExitId: this.config.pool.pinnedExitId,
      includeDirect: this.config.pool.includeDirect,
      zenApiKeySet: this.config.zenApiKey.trim().length > 0,
      authMode: this.config.zenApiKey.trim().length > 0 ? 'key' : 'anonymous',
    }
  }

  /** Write a health snapshot file (self-heal + external monitoring). */
  statusFilePath(): string {
    return join(this.config.dataDir, 'status.json')
  }
}

export { VERSION }
