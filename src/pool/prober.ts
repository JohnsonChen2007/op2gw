import { request } from 'undici'

import type { ScopedLogger } from '../core/logger.js'
import type { ExitNode } from '../core/types.js'
import type { DispatcherCache } from './dispatchers.js'
import type { ExitPool } from './pool.js'

/**
 * Prober — background health/admission checks for exit nodes.
 *
 * For each due exit it runs an egress-IP probe through that exit's dispatcher:
 * a small HTTPS GET that returns the public IP the request came from. Getting
 * the exit IP proves (a) the tunnel stands to a real HTTPS origin and (b) gives
 * the routing key + a display value. Failure marks the exit dead.
 *
 * Concurrency: at most maxConcurrent probes across exits; each exit is
 * serialized by the pool's inflight flag (dueForProbe sets it).
 */

const PROBE_URL = 'https://api.ipify.org?format=json'
const PROBE_TIMEOUT_MS = 8_000

export interface ProberOptions {
  maxConcurrent?: number
  fetchIp?: (exit: ExitNode, dispatchers: DispatcherCache) => Promise<{ ip: string; latencyMs: number } | null>
}

export class Prober {
  #timer: NodeJS.Timeout | null = null
  #running = false
  readonly #pool: ExitPool
  readonly #dispatchers: DispatcherCache
  readonly #logger: ScopedLogger
  readonly #maxConcurrent: number
  readonly #fetchIp: NonNullable<ProberOptions['fetchIp']>

  constructor(pool: ExitPool, dispatchers: DispatcherCache, logger: ScopedLogger, options: ProberOptions = {}) {
    this.#pool = pool
    this.#dispatchers = dispatchers
    this.#logger = logger
    this.#maxConcurrent = options.maxConcurrent ?? 6
    this.#fetchIp = options.fetchIp ?? defaultFetchIp
  }

  start(intervalMs: number): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.tick(), intervalMs)
    this.#timer.unref?.()
    // Kick an immediate round so fresh exits get an admission verdict fast.
    void this.tick()
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /** One probe round: probe all due exits with bounded concurrency. */
  async tick(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      const due = this.#pool.dueForProbe()
      if (due.length === 0) return
      this.#logger.debug('probe round', { due: due.length })
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < due.length) {
          const node = due[cursor++]
          if (!node) break
          await this.#probeOne(node)
        }
      }
      const workers = Array.from({ length: Math.min(this.#maxConcurrent, due.length) }, () => worker())
      await Promise.all(workers)
      const evicted = this.#pool.evictDead()
      for (const id of evicted) this.#dispatchers.drop(id)
      if (evicted.length > 0) this.#logger.info('evicted dead exits', { count: evicted.length })
    } finally {
      this.#running = false
    }
  }

  async #probeOne(node: ExitNode): Promise<void> {
    try {
      const result = await this.#fetchIp(node, this.#dispatchers)
      if (result) {
        this.#pool.markProbe(node.id, true, result.latencyMs, result.ip)
        this.#logger.debug('probe ok', { exit: node.id, ip: result.ip, latencyMs: result.latencyMs })
      } else {
        this.#pool.markProbe(node.id, false, 0)
        this.#logger.debug('probe failed', { exit: node.id })
      }
    } catch (err) {
      this.#pool.markProbe(node.id, false, 0)
      this.#logger.debug('probe error', { exit: node.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

async function defaultFetchIp(
  exit: ExitNode,
  dispatchers: DispatcherCache,
): Promise<{ ip: string; latencyMs: number } | null> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await request(PROBE_URL, {
      dispatcher: dispatchers.forExit(exit),
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump()
      return null
    }
    const json = (await res.body.json()) as { ip?: unknown }
    const ip = typeof json.ip === 'string' ? json.ip : ''
    if (!ip) return null
    return { ip, latencyMs: Date.now() - started }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
