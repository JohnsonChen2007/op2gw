import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ScopedLogger } from './core/logger.js'
import type { Op2gwConfig } from './core/config.js'
import type { ModelCatalog } from './catalog/catalog.js'
import type { ExitPool } from './pool/pool.js'

/**
 * SelfHealer — a periodic watchdog that keeps the gateway serving without
 * operator intervention.
 *
 * Checks each tick:
 *   - Catalog stale (last successful S1 older than catalogStaleMs) -> force a
 *     refresh. If it stays empty, the gateway still serves the S3 static list.
 *   - Pool has no usable exit for a probe model while enabled -> re-probe due
 *     exits immediately and log a degraded warning.
 *   - Direct exit accidentally marked dead but pool disabled -> revive it (a
 *     transient network blip must not permanently kill the only exit).
 *   - Writes a status.json health snapshot for external monitoring.
 */

export interface SelfHealDeps {
  logger: ScopedLogger
  catalog: ModelCatalog
  pool: ExitPool
  config: Op2gwConfig
  intervalMs?: number
  now?: () => number
}

export class SelfHealer {
  #timer: NodeJS.Timeout | null = null
  readonly #d: SelfHealDeps
  readonly #interval: number
  readonly #now: () => number

  constructor(deps: SelfHealDeps) {
    this.#d = deps
    this.#interval = deps.intervalMs ?? 60_000
    this.#now = deps.now ?? Date.now
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.tick(), this.#interval)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  async tick(): Promise<void> {
    try {
      await this.#healCatalog()
      this.#healPool()
      await this.#writeStatus()
    } catch (err) {
      this.#d.logger.warn('self-heal tick error', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  async #healCatalog(): Promise<void> {
    const age = this.#d.catalog.ageMs()
    if (age > this.#d.config.selfHeal.catalogStaleMs) {
      this.#d.logger.warn('catalog stale; forcing refresh', { ageMs: Number.isFinite(age) ? age : -1 })
      await this.#d.catalog.refreshOnce()
    }
  }

  #healPool(): void {
    // Direct is only a floor when the operator allows direct egress. With
    // pool.includeDirect = false the whole point is to refuse to leak the real
    // IP, so reviving direct here would silently defeat that contract.
    if (this.#d.config.pool.includeDirect) this.#d.pool.ensureDirect()
    if (!this.#d.config.pool.enabled) return
    // If nothing is usable, log the degraded state so the UI/operator sees
    // quota pressure. With direct excluded this is a hard outage, not a
    // silent fallback — that is intended.
    const probeModel = '*'
    const usable = this.#d.pool.usableCount(probeModel)
    if (usable === 0) {
      this.#d.logger.warn(
        this.#d.config.pool.includeDirect
          ? 'pool degraded: no usable exit; direct is the floor'
          : 'pool degraded: no usable proxy exit and direct egress is disallowed; requests will be refused',
      )
    }
  }

  async #writeStatus(): Promise<void> {
    const snapshot = {
      writtenAt: new Date().toISOString(),
      catalog: this.#d.catalog.snapshot(),
      poolEnabled: this.#d.config.pool.enabled,
      poolSize: this.#d.pool.size(),
    }
    const path = join(this.#d.config.dataDir, 'status.json')
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8')
    } catch {
      // status file is best-effort
    }
  }
}
