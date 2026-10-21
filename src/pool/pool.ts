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
  /** Why the current cooldown was raised: 'limited' (429 quota backoff — must
   *  never be cleared by a reachability probe) vs 'transport' (connectivity —
   *  a successful multi-site probe clears it immediately) vs 'gate' (the lane's
   *  identity gate refused this egress IP — a reachability probe says nothing
   *  about it, so only TTL expiry plus a fresh lane request can revive). */
  cooldownReason: 'limited' | 'transport' | 'gate'
  consecutiveLimited: number
  /** Consecutive identity-gate verdicts on the request path; drives the
   *  escalating 'gate' cooldown (same math as 'limited'). */
  consecutiveGate: number
  deadStrikes: number
  /** True while a probe owns this exit (serializes probe rounds). */
  inflight: boolean
  /** Requests currently being served through this exit, keyed by
   *  `${exitId}\0${model}`. The free lane meters quota per egress IP, so
   *  letting many long streams pile onto one IP burns its budget far faster
   *  than spreading them; pick() consults this to enforce a per-exit cap. */
  inflightByModel: Map<string, number>
  /** Total in-flight over this exit across all models. */
  inflightTotal: number
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
  /**
   * Credit the upstream's `Retry-After` towards the exit's quota cooldown.
   *
   * The free lane meters quota per egress IP and answers an exhausted one with
   * a 429 whose `Retry-After` is the REAL time until the window resets —
   * measured 2026-10-22 at 26843-26851 seconds (~7.4h). Scaling that down to
   * the configured cooldownMs (60s) made the pool re-sample a burned exit every
   * minute for hours: every one of those attempts was a guaranteed 429 plus a
   * connect round-trip on the request path. Default true.
   */
  honorRetryAfter?: boolean
  /** Ceiling on a single Retry-After-derived cooldown (ms), so a hostile or
   *  absurd header cannot park an exit for days. Default 8h. */
  maxCooldownMs?: number
  /**
   * Max concurrent in-flight requests per exit (0 = unlimited). Default 4.
   * Keeps one egress IP's quota from being drained by a burst of long streams.
   */
  maxInflightPerExit?: number
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
  /** Live concurrency (total in flight through this exit). */
  inflight: number
  /** How long ago this exit was last verified, ms (0 = never). */
  lastProbedAgoMs: number
}

/**
 * How much remaining cool-down a starved pool is willing to ignore rather than
 * refuse the request. A short cool-down is precautionary — one blip raises it —
 * so by the time the pool is starved, sampling the least-cooled exit either
 * succeeds or returns a real 429 the client can act on, both strictly better
 * than a flat 503 with no upstream answer. Long quota cool-downs stay excluded:
 * they are a guaranteed 429 plus the connect-timeout tax on top, and waiting
 * them out inside one request would mean tens of seconds of rotation for
 * nothing.
 */
const STARVED_COOLDOWN_BUDGET_MS = 120_000

/**
 * Default ceiling on a single Retry-After-derived cooldown. Zen's quota window
 * resets in hours, so the ceiling must be generous; it only exists so a
 * malformed or hostile header cannot bench an exit for days.
 */
const DEFAULT_MAX_COOLDOWN_MS = 8 * 60 * 60_000

/** How long a cooled-down quota exit is excluded from the starved-pool relief.
 *  Its 429 came with a real reset time; sampling it before that is a guaranteed
 *  failure. Matches STARVED_COOLDOWN_BUDGET_MS so the two rules never disagree. */
const QUOTA_RESET_GRACE_MS = STARVED_COOLDOWN_BUDGET_MS

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
  readonly #honorRetryAfter: boolean
  readonly #maxCooldownMs: number
  readonly #maxInflightPerExit: number
  readonly #now: () => number

  constructor(options: PoolOptions = {}) {
    this.#cooldownMs = options.cooldownMs ?? 60_000
    this.#deadRecheckMs = options.deadRecheckMs ?? 5 * 60_000
    this.#deadEvictions = options.deadEvictions ?? 3
    this.#banTtlMs = options.banTtlMs ?? 10 * 60_000
    this.#honorRetryAfter = options.honorRetryAfter ?? true
    this.#maxCooldownMs = options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS
    this.#maxInflightPerExit = Math.max(0, options.maxInflightPerExit ?? 4)
    this.#now = options.now ?? Date.now
  }

  /** Live concurrency settings (read by the gateway for diagnostics). */
  get maxInflightPerExit(): number {
    return this.#maxInflightPerExit
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
        cooldownReason: 'limited',
        consecutiveLimited: 0,
        consecutiveGate: 0,
        deadStrikes: 0,
        inflight: false,
        inflightByModel: new Map(),
        inflightTotal: 0,
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
    // A FREE exit earns rotation slots only once a probe has proved it can carry
    // traffic. Fresh admissions sit in 'unknown' — sending real requests through
    // them before verification is what cost a full 10s connect timeout on every
    // unlucky pick (measured 2026-10-21: 1-3s completions stretched to 20-80s).
    // Manual exits keep the old behaviour: they are hand-configured, so 'unknown'
    // there only means "not re-verified since boot".
    if (health.state === 'unknown' && node.source === 'free') return false
    if (health.cooldownUntil > this.#now()) return false
    const ban = this.#bans.get(this.#banKey(exitId, model))
    if (ban && this.#banActive(ban)) return false
    return this.#hasCapacity(exitId)
  }

  /** Whether the exit is under its per-exit in-flight cap. */
  #hasCapacity(exitId: string): boolean {
    if (this.#maxInflightPerExit === 0) return true
    const health = this.#health.get(exitId)
    if (!health) return false
    return health.inflightTotal < this.#maxInflightPerExit
  }

  /**
   * Reserve one in-flight slot on an exit for the duration of a request.
   * Returns a release function; it is idempotent so the gateway can safely call
   * it from every exit path (success, failure, client disconnect).
   *
   * Capacity is checked at PICK time, so the reservation itself always
   * succeeds — a request that was already routed must never be dropped because
   * a sibling request filled the last slot in between.
   */
  reserve(exitId: string, model: string): () => void {
    const health = this.#health.get(exitId)
    if (!health) return () => {}
    const key = this.#banKey(exitId, model)
    health.inflightByModel.set(key, (health.inflightByModel.get(key) ?? 0) + 1)
    health.inflightTotal += 1
    let released = false
    return () => {
      if (released) return
      released = true
      const current = health.inflightByModel.get(key) ?? 0
      if (current <= 1) health.inflightByModel.delete(key)
      else health.inflightByModel.set(key, current - 1)
      health.inflightTotal = Math.max(0, health.inflightTotal - 1)
    }
  }

  /** Live in-flight count for one exit (diagnostics / tests). */
  inflightOf(exitId: string): number {
    return this.#health.get(exitId)?.inflightTotal ?? 0
  }

  /**
   * Distinct egress identities among the currently usable exits.
   *
   * The free lane meters quota PER EGRESS IP, so two exit slots that leave
   * through the same IP share ONE budget (measured 2026-10-22: 10808 and 21006
   * both egressed at 47.131.86.109, and both 429'd in the same second once that
   * budget ran out). Counting slots overstates capacity and — worse — makes the
   * rotation budget believe there are more chances than there really are.
   *
   * An exit with no measured `exitIP` yet is identified by its own id: unknown
   * is not the same as shared.
   */
  distinctEgressCount(model: string): number {
    const seen = new Set<string>()
    for (const node of this.#exits.values()) {
      if (!this.isUsable(node.id, model)) continue
      seen.add(this.#egressKey(node))
    }
    return seen.size
  }

  /** Identity of the egress IP behind an exit (its own id until measured). */
  #egressKey(node: ExitNode): string {
    return node.exitIP ? `ip:${node.exitIP}` : `id:${node.id}`
  }

  /**
   * Collapse candidates to ONE representative per egress IP, preferring the
   * pinned exit then the lowest latency. Without this, round-robin spreads
   * fresh sessions across slots that share an IP and burns that single budget
   * several times faster than it would with genuinely distinct exits.
   */
  #dedupeByEgress(candidates: ExitNode[]): ExitNode[] {
    const best = new Map<string, ExitNode>()
    for (const node of candidates) {
      const key = this.#egressKey(node)
      const current = best.get(key)
      if (!current) {
        best.set(key, node)
        continue
      }
      const better =
        (node.pinned && !current.pinned) ||
        (node.pinned === current.pinned &&
          (node.latencyMs || Number.MAX_SAFE_INTEGER) < (current.latencyMs || Number.MAX_SAFE_INTEGER))
      if (better) best.set(key, node)
    }
    return [...best.values()]
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
   * -> pinned (if usable) -> round-robin across every usable candidate (even
   * spread; per-IP quota is the resource being pooled). Accepts an optional
   * `exclude` set of exit IDs to avoid retrying exits that already failed for
   * this request.
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
        if (!health || health.state === 'dead') return false
        // Same gate as isUsable: a free exit that has never been probed must not
        // become the emergency candidate either — that would reintroduce the
        // connect-timeout tax precisely when the pool is already starved.
        if (health.state === 'unknown' && n.source === 'free') return false
        // A quota cool-down means the upstream told us when this egress becomes
        // usable again. Sampling it before that is a guaranteed 429 on every
        // request — the relief tier exists for "maybe a blip", not "known dead
        // until 07:40 tomorrow". Transport and gate cool-downs stay eligible.
        if (health.cooldownReason === 'limited' && health.cooldownUntil > this.#now()) {
          if (health.cooldownUntil - this.#now() > QUOTA_RESET_GRACE_MS) return false
        }
        return health.cooldownUntil <= this.#now()
      })
    }
    if (candidates.length === 0) {
      // Cool-down relief: the tier above only reaches exits that are NOT cooling,
      // so a pool where every exit is inside a cool-down used to return null and
      // the client got a flat refusal. Sample the short-cooled exits instead
      // (STARVED_COOLDOWN_BUDGET_MS) — a refusal is the one outcome that carries
      // no upstream information, and the round-robin below keeps even a starved
      // pool's attempts spread across IPs rather than piled on one.
      const now = this.#now()
      const soon = [...this.#exits.values()].filter((n) => {
        if (exclude && exclude.has(n.id)) return false
        if (!this.#eligible(n.id)) return false
        const health = this.#health.get(n.id)
        if (!health || health.state === 'dead') return false
        if (health.state === 'unknown' && n.source === 'free') return false
        const remaining = health.cooldownUntil - now
        if (remaining <= 0 || remaining > STARVED_COOLDOWN_BUDGET_MS) return false
        // A quota cool-down is NOT a precautionary one: the upstream told us
        // exactly when its window resets (measured 2026-10-22: ~7.4h), so
        // sampling inside that grace window is a guaranteed 429 plus the
        // round-trip. Only genuine blips (transport / gate cooldowns, raised
        // without a reset time) are worth a gamble.
        if (health.cooldownReason === 'limited' && remaining > QUOTA_RESET_GRACE_MS) return false
        // An identity-gate verdict for this exit×model does not expire on its
        // own clock — that class is what the model-ban relief above relieves.
        const ban = this.#bans.get(this.#banKey(n.id, model))
        if (ban && this.#banActive(ban)) return false
        return true
      })
      soon.sort((a, b) => this.#health.get(a.id)!.cooldownUntil - this.#health.get(b.id)!.cooldownUntil)
      candidates = soon
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
    // One slot per egress IP: aliases of the same IP share a single quota, so
    // cycling across them buys nothing but burns that quota faster.
    candidates = this.#dedupeByEgress(candidates)
    // Round-robin across ALL usable candidates, not just a latency top tier.
    // The free lane meters quota per egress IP, so letting every fresh session
    // pile onto the lowest-latency exit (the old behavior) exhausted that one
    // IP's quota while the rest sat idle — the "single-IP 429" failure mode.
    // Cycling the whole usable set spreads fresh conversations evenly; the
    // sticky binding keeps each conversation on its assigned exit afterwards.
    const chosen = candidates[this.#rrIndex++ % candidates.length]!
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
   *  usable for the model (rotate feasibility).
   *
   *  `retryAfterMs` is the upstream's own reset time for this verdict (only
   *  meaningful for a quota 429). Credit it instead of the default cooldown:
   *  the free lane's window resets in HOURS, and re-sampling a burned egress
   *  every 60 seconds is how a "rotation" turns into a stream of guaranteed
   *  429s. The configured cooldownMs remains the floor, and maxCooldownMs the
   *  ceiling, so a missing or absurd header degrades to the old behaviour. */
  markFailure(exitId: string, model: string, kind: FailureKind, retryAfterMs?: number): void {
    const health = this.#health.get(exitId)
    if (!health) return
    const now = this.#now()
    switch (kind) {
      case 'limited': {
        health.consecutiveLimited += 1
        // Exponential-ish cooldown capped at 10x base.
        const factor = Math.min(2 ** (health.consecutiveLimited - 1), 10)
        health.cooldownUntil = now + this.#cooldownMs * factor
        health.cooldownReason = 'limited'
        // The upstream's reset time outranks the local backoff math: it is the
        // only value that actually describes when this egress becomes usable.
        if (this.#honorRetryAfter && retryAfterMs !== undefined && retryAfterMs > 0) {
          const windowMs = Math.min(Math.max(retryAfterMs, this.#cooldownMs), this.#maxCooldownMs)
          health.cooldownUntil = Math.max(health.cooldownUntil, now + windowMs)
        }
        break
      }
      case 'transport': {
        // A transport failure on the request path is NOT a death sentence: it
        // is often a hung keep-alive or a transient tunnel stall while the
        // proxy itself is fine (observed 2026-10-01: two healthy exits marked
        // dead on one 10s connect timeout each, stranding the whole pool).
        // Cool the exit briefly and downgrade to 'unknown' so the prober's
        // multi-site verification (Google/YouTube/egress-IP) owns the dead
        // verdict. A probe that stands up revives the exit immediately.
        health.deadStrikes += 1
        health.cooldownUntil = now + this.#cooldownMs
        health.cooldownReason = 'transport'
        if (health.state === 'ok') health.state = 'unknown'
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

  /** Record a lane identity-gate verdict (FreeTierError).
   *
   *  The 2026-10-18 ablation showed the gate judges the EGRESS IP, not the
   *  request: the byte-identical disguised call 403s on some exits and streams
   *  200 on others (live probe: 10808/21001 403, 21002 200, same second). So
   *  the verdict is an exit problem — cool the exit (escalating, like 429s: a
   *  reachability probe proves the tunnel but not the lane's opinion, so the
   *  cooldown must survive probes) and ban the exit×model pair outright so the
   *  rotation lands on another exit immediately.
   */
  markGate(exitId: string, model: string): void {
    this.#banModel(exitId, model, true)
    const health = this.#health.get(exitId)
    if (!health) return
    const now = this.#now()
    health.consecutiveGate += 1
    const factor = Math.min(2 ** (health.consecutiveGate - 1), 10)
    health.cooldownUntil = now + this.#cooldownMs * factor
    health.cooldownReason = 'gate'
  }

  markSuccess(exitId: string, model: string): void {
    const health = this.#health.get(exitId)
    if (health) {
      health.state = 'ok'
      health.consecutiveLimited = 0
      health.consecutiveGate = 0
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

  /** Update health after a probe (prober drives this).
   *
   *  A probe round is MULTI-SITE reachability verification (Google 204,
   *  YouTube, egress-IP echo): any one site answering proves the tunnel
   *  stands, and a round where every site fails is the sanctioned way to
   *  mark an exit dead. Request-path transport failures never do that on
   *  their own (see markFailure) — they only cool the exit and hand it to
   *  the prober for verification. */
  markProbe(exitId: string, ok: boolean, latencyMs: number, exitIP?: string, location?: string): void {
    const node = this.#exits.get(exitId)
    const health = this.#health.get(exitId)
    if (!node || !health) return
    health.lastProbedAt = this.#now()
    health.inflight = false
    if (ok) {
      health.state = 'ok'
      health.deadStrikes = 0
      // Reachability proven: lift a transport cooldown. A 429 backoff is a
      // quota verdict, not a reachability one, and survives the probe.
      if (health.cooldownReason === 'transport') {
        health.cooldownUntil = 0
        health.consecutiveLimited = 0
      }
      node.latencyMs = latencyMs
      if (exitIP) node.exitIP = exitIP
      if (location) node.location = location
    } else {
      health.deadStrikes += 1
      if (node.pinned) {
        // An operator pinned this exit deliberately; a failed round only
        // downgrades it so requests rotate away while it keeps its place
        // (and revives on the next successful verification).
        if (health.state === 'ok') health.state = 'unknown'
      } else {
        health.state = 'dead'
      }
    }
  }

  /** Exits that should be probed. Normally that is 'unknown' exits plus
   *  'dead' exits past the recheck window. `forceAll` (on-demand recovery
   *  when the pool is starved) verifies every non-direct exit regardless of
   *  schedule so a tunnel that just came back is not held dead for another
   *  recheck window. Marks them inflight to serialize per-exit probes. */
  dueForProbe(forceAll = false): ExitNode[] {
    const now = this.#now()
    const due: ExitNode[] = []
    for (const node of this.#exits.values()) {
      if (node.id === 'direct') continue
      const health = this.#health.get(node.id)!
      if (health.inflight) continue
      const overdue = now - health.lastProbedAt > this.#deadRecheckMs
      if (forceAll || health.state === 'unknown' || (health.state === 'dead' && overdue)) {
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
          inflight: health.inflightTotal,
          lastProbedAgoMs: health.lastProbedAt > 0 ? now - health.lastProbedAt : 0,
        }
      })
  }

  /** Count of exits usable for at least one request right now. */
  usableCount(model: string): number {
    let n = 0
    for (const node of this.#exits.values()) if (this.isUsable(node.id, model)) n += 1
    return n
  }

  /** Milliseconds until the EARLIEST cooling exit becomes usable again, or 0
   *  when nothing is cooling. Used to tell a caller how long a quota-exhausted
   *  pool needs before a retry can possibly succeed. */
  nextCooldownExpiryMs(): number {
    const now = this.#now()
    let soonest = 0
    for (const health of this.#health.values()) {
      const remaining = health.cooldownUntil - now
      if (remaining <= 0) continue
      if (soonest === 0 || remaining < soonest) soonest = remaining
    }
    return soonest
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
