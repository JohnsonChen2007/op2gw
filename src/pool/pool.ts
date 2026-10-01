import type { ExitNode, ExitState, BanState, FailureKind } from '../core/types.js'

/**
 * ExitPool — the exit-node table plus two-tier health, per-exit cooldown,
 * per-(exit×model) bans, session stickiness, and pick/rotate selection.
 *
 * Two-tier health (design mirrors opencode2dsh docs/ip-pool.md §3):
 *   Tier 1, per-exit: 429 cools the whole exit (quota is metered per egress IP)
 *                     + transport failures mark it dead.
 *   Tier 2, per-(exit×model): 401/403/region refusals are model-level (region
 *                     blocks / delisting), so they ban only that pairing.
 *
 * Pure state: no IO, no timers. The prober, dispatcher and gateway drive it
 * through mark* and read it through pick(). Injectable now() keeps cooldown
 * math testable.
 */

interface ExitHealth {
  state: ExitState
  lastProbedAt: number
  cooldownUntil: number
  consecutiveLimited: number
  deadStrikes: number
  inflight: boolean
}

interface ModelBan {
  state: BanState
  bannedAt: number
  /** When a suspect was raised; used to expire the ban after banTtlMs. */
  suspectAt: number
  consecutiveFailures: number
}

export interface PoolOptions {
  cooldownMs?: number
  deadRecheckMs?: number
  deadEvictions?: number
  /** TTL after which a model ban (suspect/banned) auto-expires and the pairing
   *  becomes usable again. Prevents a transient refusal (e.g. a one-off 403 from
   *  hitting the wrong endpoint) from permanently stranding an exit×model pair. */
  banTtlMs?: number
  now?: () => number
}

export interface PickResult {
  exit: ExitNode
  /** True when this pick reused the sticky binding for the session. */
  sticky: boolean
}

export interface ExitView extends ExitNode {
  state: ExitState
  cooling: boolean
  cooldownRemainingMs: number
}

const DIRECT: ExitNode = {
  id: 'direct',
  kind: 'direct',
  source: 'direct',
  pinned: false,
  exitIP: '',
  location: '',
  latencyMs: 0,
  addedAt: 0,
}

export class ExitPool {
  #exits = new Map<string, ExitNode>()
  #health = new Map<string, ExitHealth>()
  #bans = new Map<string, ModelBan>() // key: `${exitId}\0${model}`
  #sticky = new Map<string, string>() // session -> exitId
  #pinnedId = ''
  #rrIndex = 0
  /**
   * When false, the 'direct' exit is never returned by pick(): the pool will
   * go exit-starved rather than leak the operator's real egress IP. This is
   * the "all traffic must go through a proxy" contract — see config
   * pool.includeDirect and Gateway's pre-flight refusal.
   */
  #includeDirect = true
  readonly #cooldownMs: number
  readonly #deadRecheckMs: number
  readonly #deadEvictions: number
  readonly #banTtlMs: number
  readonly #now: () => number

  constructor(options: PoolOptions = {}) {
    this.#cooldownMs = options.cooldownMs ?? 60_000
    this.#deadRecheckMs = options.deadRecheckMs ?? 5 * 60_000
    this.#deadEvictions = options.deadEvictions ?? 3
    this.#banTtlMs = options.banTtlMs ?? 10 * 60_000
    this.#now = options.now ?? Date.now
  }

  setPinned(exitId: string): void {
    this.#pinnedId = exitId
  }

  /**
   * Whether the machine's own egress may be used as an exit. When turned off,
   * pick() filters 'direct' out entirely — the gateway then either uses a real
   * proxy or fails loudly, never silently leaking the operator's country/IP.
   */
  setIncludeDirect(include: boolean): void {
    this.#includeDirect = include
    if (!include) {
      this.remove('direct')
    } else {
      this.ensureDirect()
    }
    // A session pinned to direct must not keep serving it after the switch.
    for (const [session, id] of [...this.#sticky.entries()]) {
      if (id === 'direct') this.#sticky.delete(session)
    }
  }

  get includeDirect(): boolean {
    return this.#includeDirect
  }

  /** True when the exit is eligible for selection at all (ignoring health). */
  #eligible(exitId: string): boolean {
    if (exitId === 'direct' && !this.#includeDirect) return false
    return true
  }

  /** Add or replace an exit. Direct is added via ensureDirect(). */
  add(node: Omit<ExitNode, 'addedAt'> & { addedAt?: number }): void {
    const existing = this.#exits.get(node.id)
    const merged: ExitNode = { ...node, addedAt: node.addedAt ?? existing?.addedAt ?? this.#now() }
    this.#exits.set(node.id, merged)
    if (!this.#health.has(node.id)) {
      this.#health.set(node.id, {
        state: 'unknown',
        lastProbedAt: 0,
        cooldownUntil: 0,
        consecutiveLimited: 0,
        deadStrikes: 0,
        inflight: false,
      })
    }
  }

  ensureDirect(): void {
    if (!this.#includeDirect) return
    if (!this.#exits.has('direct')) this.add({ ...DIRECT })
    // Direct egress is assumed live until proven otherwise.
    const h = this.#health.get('direct')
    if (h && h.state === 'unknown') h.state = 'ok'
  }

  remove(exitId: string): void {
    this.#exits.delete(exitId)
    this.#health.delete(exitId)
    for (const key of [...this.#bans.keys()]) {
      if (key.startsWith(exitId + '\x00')) this.#bans.delete(key)
    }
    for (const [session, id] of [...this.#sticky.entries()]) {
      if (id === exitId) this.#sticky.delete(session)
    }
  }

  size(): number {
    return this.#exits.size
  }

  has(exitId: string): boolean {
    return this.#exits.has(exitId)
  }

  get(exitId: string): ExitNode | undefined {
    return this.#exits.get(exitId)
  }

  /** True when the exit is usable for the model right now (not cooling, not
   *  dead, not banned for this model). A ban past its TTL is cleared on read so a
   *  transient refusal can't permanently strand the exit×model pairing. */
  isUsable(exitId: string, model: string): boolean {
    if (!this.#eligible(exitId)) return false
    const node = this.#exits.get(exitId)
    const health = this.#health.get(exitId)
    if (!node || !health) return false
    if (health.state === 'dead') return false
    if (health.cooldownUntil > this.#now()) return false
    const ban = this.#bans.get(this.#banKey(exitId, model))
    if (ban && this.#banActive(ban)) return false
    return true
  }

  /** A ban is active unless it has aged out past banTtlMs. Expired bans are
   *  reset to 'ok' (re-usable) and reported as inactive. */
  #banActive(ban: ModelBan): boolean {
    const raised = ban.state === 'banned' ? ban.bannedAt : ban.suspectAt
    if (raised > 0 && this.#now() - raised > this.#banTtlMs) {
      ban.state = 'ok'
      ban.consecutiveFailures = 0
      ban.bannedAt = 0
      ban.suspectAt = 0
      return false
    }
    // A 'suspect' is a *raised eyebrow*, not a block.
    //
    // The pool's documented contract (see pool.test.ts and the two-tier design
    // above) is: a guessing failure — a 5xx or a plain 401/403, either of which
    // is often endpoint- or model-specific noise — must be SAMPLED TWICE before
    // it is allowed to divert traffic, while a deterministic refusal (region)
    // bans at once. Returning true here contradicted that and blocked the
    // pairing after a single strike, so one transient upstream hiccup could
    // strand a perfectly healthy exit×model for the whole ban TTL.
    return ban.state === 'banned'
  }

  /**
   * Pick an exit for (model, session). Order: sticky binding (if still usable)
   * -> pinned (if usable) -> best usable candidate (freshest health, lowest
   * latency / load-balanced top tier). Accepts an optional `exclude` set of exit IDs
   * to avoid retrying exits that already failed for this request.
   */
  pick(model: string, session: string, exclude?: Set<string>): PickResult | null {
    const stickyId = this.#sticky.get(session)
    if (stickyId && (!exclude || !exclude.has(stickyId)) && this.#eligible(stickyId) && this.isUsable(stickyId, model)) {
      return { exit: this.#exits.get(stickyId)!, sticky: true }
    }
    if (this.#pinnedId && (!exclude || !exclude.has(this.#pinnedId)) && this.#eligible(this.#pinnedId) && this.isUsable(this.#pinnedId, model)) {
      this.#sticky.set(session, this.#pinnedId)
      return { exit: this.#exits.get(this.#pinnedId)!, sticky: false }
    }
    let candidates = [...this.#exits.values()].filter(
      (n) => (!exclude || !exclude.has(n.id)) && this.isUsable(n.id, model),
    )
    if (candidates.length === 0) {
      // Model-ban relief: if every eligible proxy is alive (not dead, not cooling)
      // but marked model-banned due to transient upstream 5xx spikes, allow an alive
      // eligible candidate to be sampled so the system can self-heal on recovery.
      candidates = [...this.#exits.values()].filter((n) => {
        if (exclude && exclude.has(n.id)) return false
        if (!this.#eligible(n.id)) return false
        const health = this.#health.get(n.id)
        return health && health.state !== 'dead' && health.cooldownUntil <= this.#now()
      })
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => {
      // pinned first, then lower latency, then most-recently-added.
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const la = a.latencyMs || Number.MAX_SAFE_INTEGER
      const lb = b.latencyMs || Number.MAX_SAFE_INTEGER
      if (la !== lb) return la - lb
      return b.addedAt - a.addedAt
    })
    const bestCandidate = candidates[0]!
    const bestLatency = bestCandidate.latencyMs || 0
    const tolerance = Math.max(30, bestLatency * 0.3)
    const topTier = candidates.filter((c) => {
      if (c.pinned !== bestCandidate.pinned) return false
      const lat = c.latencyMs || 0
      return Math.abs(lat - bestLatency) <= tolerance
    })
    const chosen = topTier.length > 1
      ? topTier[(this.#rrIndex++) % topTier.length]!
      : bestCandidate
    this.#sticky.set(session, chosen.id)
    return { exit: chosen, sticky: false }
  }

  /** Break the sticky binding so the next pick for the session rotates. */
  rerouteSession(session: string): void {
    this.#sticky.delete(session)
  }

  /** Clear every sticky binding (used when the default exit changes). */
  clearSticky(): void {
    this.#sticky.clear()
  }

  /**
   * Remove every per-(exit x model) ban for one exit. Used when the exit's
   * egress identity changes (e.g. the 'direct' exit swaps to a new default
   * proxy): a region/model ban learned under the old egress IP is meaningless
   * under the new one and must not keep blocking the model.
   */
  clearModelBans(exitId: string): void {
    for (const key of [...this.#bans.keys()]) {
      if (key.startsWith(exitId + '\x00')) this.#bans.delete(key)
    }
  }

  exitOfSession(session: string): string | null {
    return this.#sticky.get(session) ?? null
  }

  /** Record a failure against an exit; returns whether other exits remain
   *  usable for the model (rotate feasibility). */
  markFailure(exitId: string, model: string, kind: FailureKind): void {
    const health = this.#health.get(exitId)
    if (!health) return
    const now = this.#now()
    switch (kind) {
      case 'limited': {
        health.consecutiveLimited += 1
        // Exponential-ish cooldown capped at 10x base.
        const factor = Math.min(2 ** (health.consecutiveLimited - 1), 10)
        health.cooldownUntil = now + this.#cooldownMs * factor
        break
      }
      case 'transport': {
        // A genuine connectivity failure (connect refused, DNS, tunnel drop)
        // is the exit's fault -> mark dead; the prober revives it later.
        health.deadStrikes += 1
        health.state = 'dead'
        break
      }
      case 'server': {
        // An upstream 5xx is NOT the exit's fault: the same IP routinely serves
        // other models fine (observed: jev-1.13 returns 500 while big-pickle
        // returns 200 through the very same exit). Killing the whole exit on a
        // per-model upstream error strands every other model behind a false
        // "no usable exit". Treat it as a per-(exit x model) soft ban instead,
        // so the exit stays alive and rotation stays possible.
        this.#banModel(exitId, model, false)
        break
      }
      case 'refused':
      case 'region': {
        this.#banModel(exitId, model, kind === 'region')
        break
      }
    }
  }

  markSuccess(exitId: string, model: string): void {
    const health = this.#health.get(exitId)
    if (health) {
      health.state = 'ok'
      health.consecutiveLimited = 0
      health.cooldownUntil = 0
      health.deadStrikes = 0
    }
    const ban = this.#bans.get(this.#banKey(exitId, model))
    if (ban) {
      ban.state = 'ok'
      ban.consecutiveFailures = 0
      ban.bannedAt = 0
      ban.suspectAt = 0
    }
  }

  markModelBanned(exitId: string, model: string): void {
    this.#banModel(exitId, model, true)
  }

  /** Update health after a probe (prober drives this). */
  markProbe(exitId: string, ok: boolean, latencyMs: number, exitIP?: string, location?: string): void {
    const node = this.#exits.get(exitId)
    const health = this.#health.get(exitId)
    if (!node || !health) return
    health.lastProbedAt = this.#now()
    health.inflight = false
    if (ok) {
      health.state = 'ok'
      health.deadStrikes = 0
      node.latencyMs = latencyMs
      if (exitIP) node.exitIP = exitIP
      if (location) node.location = location
    } else {
      // A probe is an auxiliary reachability hint (it fetches the egress IP for
      // display/routing), NOT the source of truth for a user-asserted exit. The
      // egress probe endpoint (ipify) is itself flaky through some tunnels, and
      // a false "dead" on the only manual exit strands the whole gateway. So a
      // probe failure never marks a manual/pinned exit dead — real request
      // outcomes (markFailure 'transport') still can. It only downgrades to
      // 'unknown', which isUsable() still treats as usable.
      health.deadStrikes += 1
      if (node.source === 'manual' || node.pinned) {
        if (health.state === 'ok') health.state = 'unknown'
      } else {
        health.state = 'dead'
      }
    }
  }

  /** Exits that should be re-probed (dead past recheck window, or never
   *  probed). Marks them inflight to serialize per-exit probes. */
  dueForProbe(): ExitNode[] {
    const now = this.#now()
    const due: ExitNode[] = []
    for (const node of this.#exits.values()) {
      if (node.id === 'direct') continue
      const health = this.#health.get(node.id)!
      if (health.inflight) continue
      const overdue = now - health.lastProbedAt > this.#deadRecheckMs
      if (health.state === 'unknown' || (health.state === 'dead' && overdue)) {
        health.inflight = true
        due.push(node)
      }
    }
    return due
  }

  /** Evict free/subscription exits stuck dead beyond the eviction threshold. */
  evictDead(): string[] {
    const evicted: string[] = []
    for (const node of [...this.#exits.values()]) {
      if (node.id === 'direct' || node.pinned) continue
      if (node.source === 'manual') continue
      const health = this.#health.get(node.id)!
      if (health.state === 'dead' && health.deadStrikes >= this.#deadEvictions) {
        this.remove(node.id)
        evicted.push(node.id)
      }
    }
    return evicted
  }

  /** A view for the debug UI: nodes with live health flags. */
  view(): ExitView[] {
    const now = this.#now()
    return [...this.#exits.values()]
      .filter((node) => node.id !== 'direct' || this.#includeDirect)
      .map((node) => {
        const health = this.#health.get(node.id)!
        return {
          ...node,
          state: health.state,
          cooling: health.cooldownUntil > now,
          cooldownRemainingMs: Math.max(0, health.cooldownUntil - now),
        }
      })
  }

  /** Count of exits usable for at least one request right now. */
  usableCount(model: string): number {
    let n = 0
    for (const node of this.#exits.values()) if (this.isUsable(node.id, model)) n += 1
    return n
  }

  #banModel(exitId: string, model: string, immediate: boolean): void {
    const key = this.#banKey(exitId, model)
    const ban = this.#bans.get(key) ?? { state: 'ok' as BanState, bannedAt: 0, suspectAt: 0, consecutiveFailures: 0 }
    ban.consecutiveFailures += 1
    if (immediate || ban.consecutiveFailures >= 2) {
      ban.state = 'banned'
      ban.bannedAt = this.#now()
    } else {
      ban.state = 'suspect'
      ban.suspectAt = this.#now()
    }
    this.#bans.set(key, ban)
  }

  #banKey(exitId: string, model: string): string {
    return `${exitId}\x00${model}`
  }
}
