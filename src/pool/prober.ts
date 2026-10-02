import { request } from 'undici'

import type { ScopedLogger } from '../core/logger.js'
import type { ExitNode } from '../core/types.js'
import type { DispatcherCache } from './dispatchers.js'
import type { ExitPool } from './pool.js'

/**
 * Prober — background health/admission checks for exit nodes.
 *
 * A probe round is MULTI-SITE reachability verification, tried in order: the
 * gateway's own upstream (`GET {zen}/v1/models`, the one endpoint this gateway
 * actually needs), then Google's connectivity-check endpoint (generate_204),
 * YouTube, and the egress-IP echo (api.ipify.org). ANY one site answering
 * proves the tunnel stands; the round fails (and the pool may mark the exit
 * dead) only when every site is unreachable through that exit. Single-endpoint
 * probing was the old failure mode: ipify hiccuping through one tunnel wrongly
 * killed healthy exits, and one 10s connect timeout on the request path killed
 * the whole pool. Both paths now defer the dead verdict to this verifier.
 *
 * The upstream target is first because the generic connectivity sites are not
 * equivalent to "this exit can serve the gateway": some proxy lines hard-reset
 * google.com/youtube.com (observed 2026-10-02: both remote exits RST every
 * Google/YouTube connect in ~0.3s while opencode.ai worked fine), so a round
 * built only from those sites degenerates to ipify — and when ipify is slow or
 * rate-limited over the shared exit IP, a healthy exit is marked dead and the
 * pool starves while inference traffic would have succeeded.
 *
 * Any HTTP response — 2xx/3xx but equally a 404/429/5xx — counts as "the site
 * answered": completing TCP+TLS+HTTP through the tunnel is the claim under
 * test, and an application-level status says nothing about reachability. Only
 * a transport error (connect timeout, ECONNRESET, abort) fails a target.
 *
 * Concurrency: at most maxConcurrent probes across exits; each exit is
 * serialized by the pool's inflight flag (dueForProbe sets it).
 */

interface ProbeTarget {
  url: string
  /** True when this target also yields the egress IP (display/routing). */
  identity: boolean
}

const PROBE_TARGETS: ProbeTarget[] = [
  { url: 'https://www.google.com/generate_204', identity: false },
  { url: 'https://www.youtube.com/', identity: false },
  { url: 'https://api.ipify.org?format=json', identity: true },
]
const PROBE_TIMEOUT_MS = 6_000

export interface ProberOptions {
  maxConcurrent?: number
  /** The gateway's upstream models endpoint (GET {zen}/v1/models). Probed
   *  first: an exit that can serve gateway traffic must never be judged dead
   *  by generic connectivity sites it happens to block. */
  upstreamUrl?: string
  fetchIp?: (
    exit: ExitNode,
    dispatchers: DispatcherCache,
    upstreamUrl?: string,
  ) => Promise<{ ip: string; latencyMs: number } | null>
}

export class Prober {
  #timer: NodeJS.Timeout | null = null
  #running = false
  readonly #pool: ExitPool
  readonly #dispatchers: DispatcherCache
  readonly #logger: ScopedLogger
  readonly #maxConcurrent: number
  readonly #upstreamUrl: string | undefined
  readonly #fetchIp: NonNullable<ProberOptions['fetchIp']>

  constructor(pool: ExitPool, dispatchers: DispatcherCache, logger: ScopedLogger, options: ProberOptions = {}) {
    this.#pool = pool
    this.#dispatchers = dispatchers
    this.#logger = logger
    this.#maxConcurrent = options.maxConcurrent ?? 6
    this.#upstreamUrl = options.upstreamUrl
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

  /** One probe round: probe all due exits with bounded concurrency.
   *  `forceAll` verifies every non-direct exit regardless of schedule —
   *  driven when the pool is starved and requests are being refused. */
  async tick(forceAll = false): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      const due = this.#pool.dueForProbe(forceAll)
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
      const result = await this.#fetchIp(node, this.#dispatchers, this.#upstreamUrl)
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

/**
 * Multi-site reachability verification through the exit. The round passes as
 * soon as ANY target answers — the upstream models endpoint first (an exit
 * that serves gateway traffic is alive, full stop), then the generic
 * connectivity sites — and fails (null) only when every target errors at the
 * transport layer. Any HTTP status (404/429/5xx included) proves the tunnel:
 * only connect timeouts, resets and aborts say the exit cannot carry traffic.
 *
 * When a reachability site answers we still try the identity echo afterwards
 * to record the egress IP for display/routing — but an ipify miss never
 * invalidates an already-proven tunnel.
 *
 * `targets` is injectable so tests can run fully offline against a local
 * server; production always uses PROBE_TARGETS (+ upstream first).
 */
export async function defaultFetchIp(
  exit: ExitNode,
  dispatchers: DispatcherCache,
  upstreamUrl?: string,
  targets: ProbeTarget[] = PROBE_TARGETS,
): Promise<{ ip: string; latencyMs: number } | null> {
  const dispatcher = dispatchers.forExit(exit)
  const round: ProbeTarget[] = upstreamUrl
    ? [{ url: upstreamUrl, identity: false }, ...targets]
    : targets
  let reached: { ip: string; latencyMs: number } | null = null
  for (const target of round) {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await request(target.url, {
        dispatcher,
        signal: controller.signal,
        headers: { accept: target.identity ? 'application/json' : '*/*' },
      })
      const latencyMs = Date.now() - started
      if (target.identity && res.statusCode >= 200 && res.statusCode < 400) {
        const json = (await res.body.json()) as { ip?: unknown }
        const ip = typeof json.ip === 'string' ? json.ip : ''
        if (ip) return { ip, latencyMs }
      }
      await res.body.dump()
      // Any HTTP response through the tunnel counts as reached, with or
      // without an identity payload.
      reached ??= { ip: '', latencyMs }
    } catch {
      // This target failed through this exit; try the next one.
    } finally {
      clearTimeout(timer)
    }
  }
  return reached
}
