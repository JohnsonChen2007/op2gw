import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { LogLevel } from './logger.js'

/**
 * op2gw configuration. Layered resolution (later wins):
 *   defaults  <  config file (JSON, --config or ~/.op2gw/config.json)  <  env
 *
 * Everything has a working default so `op2gw` runs with zero configuration:
 * direct egress, live catalog, anonymous free lane.
 */

export interface Op2gwConfig {
  /** HTTP listen host. Default 127.0.0.1 (loopback only). */
  host: string
  /** HTTP listen port. Default 8787. */
  port: number
  /** Upstream base, default https://opencode.ai/inference (the anonymous free
   *  lane moved off `/zen`, which now 403s every anonymous request). */
  zenBaseUrl: string
  /**
   * Upstream Zen API key. Empty = anonymous (`Bearer public`).
   *
   * Since the 2026-10 transport gating the anonymous lane rejects non-CLI
   * stacks with FreeTierError, a key is the reliable path: set it via the
   * OPENCODE_API_KEY environment variable (same name the CLI uses) or this
   * field. The keyed channel is unaffected by the gate.
   */
  zenApiKey: string
  /** models.dev metadata endpoint. */
  metadataUrl: string
  /** Live catalog refresh cadence (seconds). */
  refreshSeconds: number
  /**
   * Hard wall-clock budget (ms) for reading a NON-STREAMING response body.
   * That path deliberately skips the idle watchdog (a slow reasoning model may
   * go quiet for minutes), so without this a half-open upstream would hang the
   * request forever. Streaming is unaffected. 0 disables the budget.
   */
  bodyBudgetMs: number
  /** Log level. */
  logLevel: LogLevel
  /**
   * Default upstream proxy (http:// or socks5://). When set, every request
   * egresses through it even with the IP pool disabled — this is how "use my
   * local proxy" works. Left empty = direct. Auto-seeded from the environment
   * proxy variables on first run.
   */
  proxy: string
  /** Data dir for caches, tokens, persisted pool state. */
  dataDir: string
  /** IP pool settings. */
  pool: PoolConfig
  /** Self-healing settings. */
  selfHeal: SelfHealConfig
  /** Runtime model visibility (auto-hide after repeated upstream failures). */
  modelVisibility: ModelVisibilityConfig
}

export interface PoolConfig {
  /** Master switch. false = always direct (default). */
  enabled: boolean
  /** Manual proxies: 'http://h:p' | 'socks5://h:p'. */
  manual: string[]
  /**
   * Fixed primary exit id; when set and healthy it serves first and the pool
   * only rotates away from it on failure.
   */
  pinnedExitId: string
  /** Include the machine's own direct egress as a pool candidate. */
  includeDirect: boolean
  /** Free public-proxy source lists (raw text URLs, http:// or socks5:// lines). */
  freeSources: string[]
  /** Target size for the auto-fetched free pool. 0 = disabled (default). */
  freeTargetSize: number
  /** Max rotate attempts inside one client request (pre-content failures). */
  maxRotateAttempts: number
  /**
   * Wall-clock ceiling (ms) for the whole rotation loop. Attempt count alone
   * cannot bound latency: each attempt on a half-dead exit costs a connect
   * timeout, so a dirty pool could hold a request for minutes before erroring.
   * 0 disables. Default 45s.
   */
  rotateBudgetMs: number
  /**
   * Credit the upstream's `Retry-After` towards an exit's quota cooldown.
   * Zen resets a free-lane window in HOURS; ignoring the header re-samples a
   * burned egress all day. Default true.
   */
  honorRetryAfter: boolean
  /** Ceiling on any single Retry-After-derived cooldown (ms). Default 8h. */
  maxCooldownMs: number
  /** Per-exit 429 cooldown (ms), used as the floor and for transport failures. */
  cooldownMs: number
  /**
   * Max concurrent in-flight requests per exit (0 = unlimited). The free lane
   * meters quota per egress IP, so one IP's budget lasts longer when a burst
   * of long streams cannot pile onto it. Default 4.
   */
  maxInflightPerExit: number
  /** Auto-expire an exit×model ban after this many ms (prevents a transient
   *  refusal from permanently stranding the pairing). */
  banTtlMs: number
  /** Probe cadence for background health checks (ms). */
  probeIntervalMs: number
  /** Cross-exit probe concurrency (same exit is always serial). */
  maxConcurrentProbes: number
}

export interface SelfHealConfig {
  /** Restart the catalog refresh loop if it goes stale beyond this (ms). */
  catalogStaleMs: number
  /** Re-probe dead exits after this cooldown (ms). */
  deadRecheckMs: number
  /** Evict a free exit after this many consecutive dead rechecks. */
  deadEvictions: number
}

/**
 * Runtime model visibility policy.
 *
 * Some ids are broken at the upstream for one region while working fine in
 * another (measured 2026-10-22: `flint-40b-free` 503s on us-east-1 and passes
 * on ap-southeast-1). That is not a permanent defect, so it does not belong in
 * the build-time `disabledModels` list — hiding it there would take down the
 * region where it works, for every deployment of the artifact.
 *
 * Instead a model that keeps failing with an upstream `server` fault is hidden
 * from `GET /v1/models` for a while, then re-advertised so the upstream gets
 * re-probed. The policy is per-process, so each deployment (and each region)
 * converges on what actually works for it.
 */
export interface ModelVisibilityConfig {
  /** Consecutive upstream server failures before an id is hidden. 0 disables. Default 5. */
  hideAfterFailures: number
  /** How long a hidden id stays hidden before being re-advertised (ms). Default 5min. */
  hideForMs: number
}

export function defaultConfig(): Op2gwConfig {
  const dataDir = join(homedir(), '.op2gw')
  return {
    host: '127.0.0.1',
    port: 8787,
    zenBaseUrl: 'https://opencode.ai/inference',
    zenApiKey: '',
    metadataUrl: 'https://models.dev/api.json',
    // The upstream moves fast (2026-10: the lane migrated /zen -> /inference and
    // its UA window narrowed twice). A day-long catalog would keep advertising
    // models that moved dialect or delisted; 5 minutes tracks it at negligible
    // cost, and the refresh is already single-flight + cached.
    refreshSeconds: 300,
    // Generous: this only has to be shorter than "forever". A non-streaming
    // turn legitimately takes minutes, so 10 minutes bounds a hung upstream
    // without ever cutting off a real answer.
    bodyBudgetMs: 10 * 60_000,
    logLevel: 'info',
    proxy: '',
    dataDir,
    pool: {
      enabled: false,
      manual: [],
      pinnedExitId: '',
      includeDirect: true,
      // Off by default: public proxy lists had a 0% hit rate against
      // opencode.ai in the 2026-10-22 measurement (8/8 admitted free exits
      // dead), while every dead slot still costs a probe round and a
      // connect-timeout slot on the request path. Exits should come from a
      // node library that is actually reachable (see scripts/xray-pool.mjs).
      freeSources: [],
      freeTargetSize: 0,
      maxRotateAttempts: 3,
      rotateBudgetMs: 45_000,
      honorRetryAfter: true,
      maxCooldownMs: 8 * 60 * 60_000,
      cooldownMs: 60_000,
      maxInflightPerExit: 4,
      // A region/model refusal is often transient or egress-dependent, so a ban
      // must expire on its own; otherwise one bad exit×model sample strands the
      // pairing until restart. 10 minutes matches the cooldown scale.
      banTtlMs: 10 * 60_000,
      probeIntervalMs: 90_000,
      maxConcurrentProbes: 6,
    },
    selfHeal: {
      catalogStaleMs: 15 * 60_000,
      deadRecheckMs: 5 * 60_000,
      deadEvictions: 3,
    },
    modelVisibility: {
      // 5 sits above the in-request rotation count (maxAttempts defaults to 3),
      // so one unlucky request that burns every attempt cannot hide a model by
      // itself — but two consecutive failed requests will.
      hideAfterFailures: 5,
      // Short on purpose: this is a self-correcting hint, not a verdict. Five
      // minutes is long enough to stop clients hammering a dead endpoint and
      // short enough that a recovered model returns without an operator action.
      hideForMs: 5 * 60_000,
    },
  }
}

function coerceBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

function coerceNum(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Load config from an optional JSON file then overlay environment variables.
 * The file path comes from --config <path> or OP2GW_CONFIG or the default
 * ~/.op2gw/config.json (silently skipped when absent).
 */
export async function loadConfig(argv: string[] = process.argv.slice(2)): Promise<Op2gwConfig> {
  const cfg = defaultConfig()

  // --config <path> or OP2GW_CONFIG or default location.
  let configPath = process.env.OP2GW_CONFIG
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config' && argv[i + 1]) configPath = argv[i + 1]
  }
  if (!configPath) {
    const fallback = join(cfg.dataDir, 'config.json')
    if (existsSync(fallback)) configPath = fallback
  }
  if (configPath && existsSync(configPath)) {
    try {
      const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Partial<Op2gwConfig>
      mergeConfig(cfg, parsed)
    } catch (err) {
      process.stderr.write(`op2gw: failed to read config ${configPath}: ${String(err)}\n`)
    }
  }

  // Environment overlay.
  const env = process.env
  cfg.host = env.OP2GW_HOST ?? cfg.host
  cfg.port = coerceNum(env.OP2GW_PORT, cfg.port)
  cfg.zenBaseUrl = env.OP2GW_ZEN_URL ?? cfg.zenBaseUrl
  // Same variable name the official CLI uses, so one export serves both.
  if (env.OPENCODE_API_KEY !== undefined) cfg.zenApiKey = env.OPENCODE_API_KEY.trim()
  cfg.refreshSeconds = coerceNum(env.OP2GW_REFRESH_SECONDS, cfg.refreshSeconds)
  cfg.bodyBudgetMs = coerceNum(env.OP2GW_BODY_BUDGET_MS, cfg.bodyBudgetMs)
  cfg.logLevel = (env.OP2GW_LOG_LEVEL as LogLevel) ?? cfg.logLevel
  cfg.dataDir = env.OP2GW_DATA_DIR ?? cfg.dataDir

  // Proxy resolution order: explicit config/env OP2GW_PROXY wins; otherwise, on
  // first run (no proxy set anywhere), auto-seed from the standard environment
  // proxy variables so "use my local proxy" works out of the box.
  if (env.OP2GW_PROXY !== undefined) {
    cfg.proxy = normalizeProxyUri(env.OP2GW_PROXY)
  } else if (cfg.proxy === '') {
    const envProxy = detectEnvProxy()
    if (envProxy) cfg.proxy = envProxy
  } else {
    cfg.proxy = normalizeProxyUri(cfg.proxy)
  }
  cfg.pool.enabled = coerceBool(env.OP2GW_POOL_ENABLED, cfg.pool.enabled)
  const manual = splitList(env.OP2GW_POOL_MANUAL)
  if (manual) cfg.pool.manual = manual
  const freeSources = splitList(env.OP2GW_POOL_FREE_SOURCES)
  if (freeSources) cfg.pool.freeSources = freeSources
  cfg.pool.freeTargetSize = coerceNum(env.OP2GW_POOL_FREE_TARGET, cfg.pool.freeTargetSize)
  cfg.pool.maxRotateAttempts = coerceNum(env.OP2GW_POOL_MAX_ROTATE, cfg.pool.maxRotateAttempts)
  cfg.pool.rotateBudgetMs = coerceNum(env.OP2GW_POOL_ROTATE_BUDGET_MS, cfg.pool.rotateBudgetMs)
  cfg.pool.cooldownMs = coerceNum(env.OP2GW_POOL_COOLDOWN_MS, cfg.pool.cooldownMs)
  cfg.pool.maxCooldownMs = coerceNum(env.OP2GW_POOL_MAX_COOLDOWN_MS, cfg.pool.maxCooldownMs)
  cfg.pool.maxInflightPerExit = coerceNum(env.OP2GW_POOL_MAX_INFLIGHT, cfg.pool.maxInflightPerExit)
  cfg.pool.honorRetryAfter = coerceBool(env.OP2GW_POOL_HONOR_RETRY_AFTER, cfg.pool.honorRetryAfter)
  cfg.pool.pinnedExitId = env.OP2GW_POOL_PINNED ?? cfg.pool.pinnedExitId
  cfg.pool.includeDirect = coerceBool(env.OP2GW_POOL_INCLUDE_DIRECT, cfg.pool.includeDirect)

  // Model visibility: 0 disables auto-hiding entirely (the pre-existing
  // behaviour), which is the escape hatch if a deployment prefers to always
  // advertise every free id regardless of upstream health.
  cfg.modelVisibility.hideAfterFailures = coerceNum(
    env.OP2GW_HIDE_AFTER_FAILURES,
    cfg.modelVisibility.hideAfterFailures,
  )
  cfg.modelVisibility.hideForMs = coerceNum(env.OP2GW_HIDE_FOR_MS, cfg.modelVisibility.hideForMs)

  // --port / --host convenience flags.
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) cfg.port = coerceNum(argv[i + 1], cfg.port)
    if (argv[i] === '--host' && argv[i + 1]) cfg.host = argv[i + 1] as string
    if (argv[i] === '--pool') cfg.pool.enabled = true
    if (argv[i] === '--no-direct') cfg.pool.includeDirect = false
    if (argv[i] === '--log-level' && argv[i + 1]) cfg.logLevel = argv[i + 1] as LogLevel
    if (argv[i] === '--proxy' && argv[i + 1]) cfg.proxy = normalizeProxyUri(argv[i + 1] as string)
    if (argv[i] === '--no-proxy') cfg.proxy = ''
  }

  return cfg
}

/** The persisted config file path (also used by the settings API). */
export function configFilePath(cfg: Op2gwConfig): string {
  return process.env.OP2GW_CONFIG ?? join(cfg.dataDir, 'config.json')
}

/**
 * Persist a config to disk (atomic write). Only the user-editable, portable
 * fields are stored; dataDir/urls stay implicit unless overridden. The debug
 * UI's settings page writes through this.
 */
export async function saveConfig(cfg: Op2gwConfig): Promise<string> {
  const { writeFile, mkdir, rm, rename } = await import('node:fs/promises')
  const path = configFilePath(cfg)
  const persisted = {
    host: cfg.host,
    port: cfg.port,
    zenBaseUrl: cfg.zenBaseUrl,
    zenApiKey: cfg.zenApiKey,
    refreshSeconds: cfg.refreshSeconds,
    bodyBudgetMs: cfg.bodyBudgetMs,
    logLevel: cfg.logLevel,
    proxy: cfg.proxy,
    pool: cfg.pool,
  }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(persisted, null, 2), 'utf8')
  await rm(path, { force: true })
  await rename(tmp, path)
  return path
}

/** Normalize a proxy string: bare host:port -> http://host:port; socks5h -> socks5. */
export function normalizeProxyUri(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^socks5h:\/\//i.test(trimmed)) return trimmed.replace(/^socks5h:\/\//i, 'socks5://')
  if (/^(https?|socks5):\/\//i.test(trimmed)) return trimmed
  if (/^[a-z0-9.\-]+:\d{2,5}$/i.test(trimmed)) return `http://${trimmed}`
  return trimmed
}

/** Read the standard environment proxy variables (lowercase preferred). */
export function detectEnvProxy(): string {
  const env = process.env
  const candidate = env.OP2GW_PROXY ?? env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? ''
  return normalizeProxyUri(candidate)
}

function mergeConfig(target: Op2gwConfig, patch: Partial<Op2gwConfig>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    if (key === 'apiKeys') continue
    if (key === 'pool' && typeof value === 'object') {
      Object.assign(target.pool, value)
    } else if (key === 'selfHeal' && typeof value === 'object') {
      Object.assign(target.selfHeal, value)
    } else if (key === 'modelVisibility' && typeof value === 'object') {
      Object.assign(target.modelVisibility, value)
    } else {
      // @ts-expect-error index write across the union of scalar fields
      target[key] = value
    }
  }
}
