import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ScopedLogger } from '../core/logger.js'
import { opencodeUserAgent } from '../core/ids.js'
import { ANONYMOUS_KEY } from '../core/freelane.js'
import type { FreeDecision } from '../core/types.js'
import { fallbackFreeModels, verifiedFreeModels, disabledModels } from './static-models.js'

/**
 * Model catalog with the S1/S2/S3 fallback chain.
 *
 *   S1  GET {zen}/v1/models           live in-sale ids (free or paid)
 *   S2  GET https://models.dev/...    pricing metadata -> free decision
 *   S3  compile-time knowledge        bootstrap list + free vouchers
 *
 * Exposed models = **every in-sale model that is free**, computed live:
 *
 *   - zero-cost by S2 metadata                      -> exposed
 *   - S2 has no row for the id (models.dev lags Zen) and the id is a known
 *     zero-cost Zen id (S3 voucher) or is name-marked "free" -> exposed
 *   - deprecated / paid / unknown-cost              -> not exposed
 *
 * The list is therefore driven by upstream, not by a hand-maintained array:
 * a new free model on Zen shows up on the next S1 refresh with no code change.
 *
 * Ported and adapted from opencode2dsh's adapter/catalog.ts, keeping the
 * deprecation-first Decide fix.
 */

const METADATA_REFRESH_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

export interface ModelPrice {
  input?: number
  output?: number
  deprecated: boolean
  reasoning?: boolean
  effortValues?: string[]
  contextWindow?: number
  maxOutput?: number
}

export interface CatalogSnapshot {
  status: 'pending' | 'ready' | 'stale' | 'error'
  total: number
  exposed: number
  lastRefresh?: string
  lastError: string
}

export interface CatalogOptions {
  zenBaseUrl: string
  metadataUrl: string
  refreshSeconds: number
  cachePath: string
  logger: ScopedLogger
  fetchImpl?: typeof fetch
  now?: () => number
  staleMs?: number
  onRefresh?: (snapshot: CatalogSnapshot) => void
}

export function isFreeByName(model: string): boolean {
  return model.toLowerCase().includes('free')
}

/**
 * Decide whether a model is free. A ready negative metadata verdict
 * (deprecated/paid) always wins; the name heuristic only fires when metadata
 * cannot speak (pending or model missing).
 */
export function decide(model: string, prices: Map<string, ModelPrice>, ready: boolean): FreeDecision {
  const nameFree = isFreeByName(model)
  const fallback = (source: string): FreeDecision =>
    nameFree ? { allowed: true, source: 'name_free', known: false } : { allowed: false, source, known: false }
  if (!ready || prices.size === 0) return fallback('metadata_pending')
  const price = prices.get(model)
  if (!price) return fallback('metadata_model_missing')
  if (price.deprecated) return { allowed: false, source: 'metadata_deprecated', known: true }
  if (price.input === 0 && price.output === 0) {
    return { allowed: true, source: nameFree ? 'name_and_metadata_free' : 'metadata_free', known: true }
  }
  if (price.input === undefined || price.output === undefined) {
    return { allowed: false, source: 'metadata_cost_unknown', known: false }
  }
  return { allowed: false, source: 'metadata_paid', known: true }
}

/**
 * The disambiguated verdict: is this id a FREE model?
 *
 * Differs from `decide` only for the zero-cost rows that models.dev marks
 * `status: deprecated`. Those rows are demonstrably stale for ids Zen is still
 * selling and still serving for free (measured 2026-10-01: muse-spark-1.2-
 * contributor-free, mimo-v2.5-free and deepseek-v4-flash-free are all still in
 * the live /v1/models listing AND still answer the anonymous lane, while 32
 * other deprecated rows really are delisted).
 *
 * So for an id that is in-sale (S1) and zero-cost (S2) we trust the live facts
 * over the stale lifecycle flag, and keep serving it. `inSale` is deliberately
 * required: it means "upstream currently advertises this id", which makes a
 * zero-cost row mean "free right now" rather than "free once".
 *
 * A ready *paid* verdict is never overridden this way — only zero-cost rows
 * qualify — so this cannot leak paid models into the free list.
 */
export function decideSold(model: string, prices: Map<string, ModelPrice>, ready: boolean, inSale: boolean): FreeDecision {
  const verdict = decide(model, prices, ready)
  if (!inSale || verdict.source !== 'metadata_deprecated') return verdict
  const price = prices.get(model)
  if (!price || price.input !== 0 || price.output !== 0) return verdict
  return { allowed: true, source: 'in_sale_zero_cost', known: true }
}function metadataDeprecated(model: Record<string, unknown>): boolean {
  if (model.deprecated === true) return true
  const status = String(model.status ?? model.lifecycle ?? '').toLowerCase()
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true
  return model.deprecated_at != null || model.retirement_date != null
}

function decodeEffortValues(raw: unknown): { effortValues?: string[] } {
  if (!Array.isArray(raw)) return {}
  const values: string[] = []
  for (const option of raw) {
    if (typeof option !== 'object' || option === null) continue
    const entry = option as { type?: unknown; values?: unknown }
    if (entry.type !== 'effort' || !Array.isArray(entry.values)) continue
    for (const value of entry.values) {
      if (typeof value === 'string' && value.length > 0 && !values.includes(value)) values.push(value)
    }
  }
  return values.length > 0 ? { effortValues: values } : { effortValues: [] }
}

/** Pick the OpenCode provider section of models.dev. */
export function decodeModelsDev(data: unknown): Map<string, ModelPrice> {
  const result = new Map<string, ModelPrice>()
  if (!data || typeof data !== 'object') return result
  const providers = data as Record<string, { models?: Record<string, Record<string, unknown>>; id?: unknown; name?: unknown }>
  const rank = (key: string): number => {
    const lower = key.toLowerCase()
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0
    if (lower.includes('opencode')) return 1
    return 2
  }
  const keys = Object.keys(providers).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const key of keys) {
    if (rank(key) > 1) continue
    const provider = providers[key]
    if (!provider || typeof provider !== 'object') continue
    if (rank(key) === 1) {
      const identity = `${provider.id ?? ''} ${provider.name ?? ''}`.toLowerCase().trim()
      if (!identity.includes('opencode')) continue
    }
    const models = provider.models
    if (!models || typeof models !== 'object') continue
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue
      const modelId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey
      const cost = (raw.cost ?? {}) as Record<string, unknown>
      const limit = (raw.limit ?? {}) as Record<string, unknown>
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const contextWindow = num(limit.context)
      const maxOutput = num(limit.output)
      result.set(modelId, {
        input: num(cost.input),
        output: num(cost.output),
        deprecated: metadataDeprecated(raw),
        reasoning: raw.reasoning === true,
        ...decodeEffortValues(raw.reasoning_options),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
      })
    }
    if (result.size > 0) return result
  }
  return result
}

export class ModelCatalog {
  #zen = new Set<string>()
  #updatedAt = 0
  #prices = new Map<string, ModelPrice>()
  #pricesReady = false
  #lastError = ''
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  readonly #opts: Required<Pick<CatalogOptions, 'zenBaseUrl' | 'metadataUrl' | 'refreshSeconds' | 'cachePath' | 'logger'>> & CatalogOptions
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #staleMs: number

  constructor(options: CatalogOptions) {
    this.#opts = options as never
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#staleMs = options.staleMs ?? 10 * 60_000
  }

  async start(): Promise<void> {
    await this.refreshOnce()
    let attempts = 0
    while (this.#zen.size === 0 && attempts < 4 && !this.#stopped) {
      attempts += 1
      await new Promise((r) => setTimeout(r, 15_000))
      if (this.#stopped) return
      await this.refreshOnce()
    }
    if (this.#stopped) return
    this.#timer = setInterval(() => void this.refreshOnce(), this.#opts.refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /** Age of the last successful S1 fetch (ms). Infinity when never fetched. */
  ageMs(): number {
    return this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt
  }

  async refreshOnce(): Promise<void> {
    await Promise.allSettled([this.#refreshZen(), this.#refreshMetadata()])
    this.#opts.onRefresh?.(this.snapshot())
  }

  async #refreshZen(): Promise<void> {
    try {
      const ids = await this.#fetchZenModels()
      this.#zen = new Set(ids)
      this.#updatedAt = this.#now()
      this.#lastError = ''
      this.#opts.logger.debug('S1 refreshed', { total: ids.length })
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err)
      this.#opts.logger.warn('S1 refresh failed', { error: this.#lastError })
    }
  }

  async #fetchZenModels(): Promise<string[]> {
    const url = `${this.#opts.zenBaseUrl.replace(/\/+$/, '')}/v1/models`
    const res = await this.#withTimeout(
      this.#fetch(url, {
        headers: {
          authorization: `Bearer ${ANONYMOUS_KEY}`,
          'user-agent': opencodeUserAgent(),
          'x-opencode-client': 'cli',
          accept: 'application/json',
        },
      }),
    )
    if (!res.ok) throw new Error(`models endpoint HTTP ${res.status}`)
    const payload = (await res.json()) as { data?: Array<{ id?: unknown }> }
    const ids: string[] = []
    for (const item of payload.data ?? []) {
      if (typeof item?.id === 'string' && item.id.length > 0) ids.push(item.id)
    }
    if (ids.length === 0) throw new Error('models endpoint returned empty list')
    return ids
  }

  async #refreshMetadata(): Promise<void> {
    try {
      const res = await this.#withTimeout(this.#fetch(this.#opts.metadataUrl, { headers: { accept: 'application/json' } }))
      if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
      const prices = decodeModelsDev(await res.json())
      if (prices.size === 0) throw new Error('models.dev has no OpenCode metadata')
      this.#prices = prices
      this.#pricesReady = true
      await this.#saveCache(prices)
      this.#opts.logger.debug('S2 refreshed', { models: prices.size })
    } catch (err) {
      if (!this.#pricesReady) {
        const cached = await this.#loadCache().catch(() => null)
        if (cached && cached.size > 0) {
          this.#prices = cached
          this.#pricesReady = true
          this.#opts.logger.info('S2 loaded from cache', { models: cached.size })
          return
        }
      }
      this.#lastError = err instanceof Error ? err.message : String(err)
      this.#opts.logger.warn('S2 refresh failed', { error: this.#lastError })
    }
  }

  decision(model: string): FreeDecision {
    if (disabledModels.includes(model)) {
      return { allowed: false, source: 'model_disabled', known: true }
    }
    const metadata = decideSold(model, this.#prices, this.#pricesReady, this.#zen.has(model))
    // S3 vouchers only speak when metadata cannot. They never override a ready
    // verdict (a paid row is authoritative).
    if (!metadata.known && fallbackFreeModels.includes(model)) {
      return { allowed: true, source: 'static_verified', known: true }
    }
    return metadata
  }

  /**
   * Ids exposed to clients: every in-sale model that is free, computed live
   * from the current S1 x S2 verdicts. Falls back to the verified bootstrap
   * list only while S1 has never produced a list (cold start / upstream down).
   * Permanently broken/dead models are explicitly filtered out.
   */
  list(): string[] {
    if (this.#zen.size === 0) return [...verifiedFreeModels].filter((m) => !disabledModels.includes(m))
    const out: string[] = []
    for (const model of this.#zen) {
      if (!disabledModels.includes(model) && this.decision(model).allowed) {
        out.push(model)
      }
    }
    return out.sort()
  }

  /** Diagnostic histogram of the current verdicts, one entry per source. */
  decisionSummary(): Array<{ model: string; source: string }> {
    return this.list().map((model) => ({ model, source: this.decision(model).source }))
  }

  limits(model: string): { contextWindow?: number; maxOutput?: number } | undefined {
    const price = this.#prices.get(model)
    if (!price) return undefined
    if (price.contextWindow === undefined && price.maxOutput === undefined) return undefined
    return {
      ...(price.contextWindow !== undefined ? { contextWindow: price.contextWindow } : {}),
      ...(price.maxOutput !== undefined ? { maxOutput: price.maxOutput } : {}),
    }
  }

  reasoningCapability(model: string): { reasoning: boolean; effortValues: string[] } | undefined {
    const price = this.#prices.get(model)
    if (!price) return undefined
    return { reasoning: price.reasoning === true, effortValues: price.effortValues ?? [] }
  }

  snapshot(): CatalogSnapshot {
    const age = this.ageMs()
    const stale = this.#updatedAt !== 0 && age > this.#staleMs
    return {
      status: this.#updatedAt === 0 ? 'pending' : stale ? 'stale' : 'ready',
      total: this.#zen.size,
      exposed: this.list().length,
      ...(this.#updatedAt !== 0 ? { lastRefresh: new Date(this.#updatedAt).toISOString() } : {}),
      lastError: this.#lastError,
    }
  }

  async #withTimeout(promise: Promise<Response>, ms = FETCH_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      return await promise
    } finally {
      clearTimeout(timer)
    }
  }

  async #saveCache(prices: Map<string, ModelPrice>): Promise<void> {
    const path = this.#opts.cachePath
    const cache = { updatedAt: this.#now(), prices: [...prices] }
    const tmp = `${path}.${process.pid}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify(cache), 'utf8')
    await rm(path, { force: true })
    await rename(tmp, path)
  }

  async #loadCache(): Promise<Map<string, ModelPrice>> {
    const raw = JSON.parse(await readFile(this.#opts.cachePath, 'utf8')) as {
      updatedAt: number
      prices: Array<[string, ModelPrice]>
    }
    if (this.#now() - raw.updatedAt > 7 * METADATA_REFRESH_MS) throw new Error('cache too old')
    return new Map(raw.prices)
  }
}

export function defaultCachePath(dataDir: string): string {
  return join(dataDir, 'models.dev.cache.json')
}
