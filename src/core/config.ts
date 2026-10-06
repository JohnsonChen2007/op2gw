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
  /**
   * Gateway API keys clients must present as `Authorization: Bearer <key>`.
   * Empty array = open (loopback dev). Generated + persisted on first run when
   * left unset and host is non-loopback.
   */
  apiKeys: string[]
  /** Upstream base, default https://opencode.ai/zen . */
  zenBaseUrl: string
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
  /** Target size for the auto-fetched free pool. */
  freeTargetSize: number
  /** Max rotate attempts inside one client request (pre-content failures). */
  maxRotateAttempts: number
  /** Per-exit 429 cooldown (ms). */
  cooldownMs: number
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

export function defaultConfig(): Op2gwConfig {
  const dataDir = join(homedir(), '.op2gw')
  return {
    host: '127.0.0.1',
    port: 8787,
    apiKeys: [],
    zenBaseUrl: 'https://opencode.ai/zen',
    metadataUrl: 'https://models.dev/api.json',
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
      freeSources: [],
      freeTargetSize: 20,
      maxRotateAttempts: 3,
      cooldownMs: 60_000,
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
  const apiKeys = splitList(env.OP2GW_API_KEYS)
  if (apiKeys) cfg.apiKeys = apiKeys
  cfg.pool.enabled = coerceBool(env.OP2GW_POOL_ENABLED, cfg.pool.enabled)
  const manual = splitList(env.OP2GW_POOL_MANUAL)
  if (manual) cfg.pool.manual = manual
  const freeSources = splitList(env.OP2GW_POOL_FREE_SOURCES)
  if (freeSources) cfg.pool.freeSources = freeSources
  cfg.pool.pinnedExitId = env.OP2GW_POOL_PINNED ?? cfg.pool.pinnedExitId
  cfg.pool.includeDirect = coerceBool(env.OP2GW_POOL_INCLUDE_DIRECT, cfg.pool.includeDirect)

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
    apiKeys: cfg.apiKeys,
    zenBaseUrl: cfg.zenBaseUrl,
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
    if (key === 'pool' && typeof value === 'object') {
      Object.assign(target.pool, value)
    } else if (key === 'selfHeal' && typeof value === 'object') {
      Object.assign(target.selfHeal, value)
    } else {
      // @ts-expect-error index write across the union of scalar fields
      target[key] = value
    }
  }
}
