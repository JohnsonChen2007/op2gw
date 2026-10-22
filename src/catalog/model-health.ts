/**
 * Model-level consecutive-failure tracking.
 *
 * The pool already owns per-(exit x model) health: a single bad egress is
 * cooled and rotated away. That is the right scope for *egress* faults. It is
 * the wrong scope for a model that is broken AT THE UPSTREAM for this region:
 * when every exit returns `503 Endpoint is unavailable` for `flint-40b-free`,
 * banning exit x model pairs just marks the whole pool suspect for that id
 * while `GET /v1/models` keeps advertising it. Clients then pick a model that
 * has no chance of working.
 *
 * This tracker is deliberately model-global (not exit-scoped) and answers one
 * question: "has this model failed enough times IN A ROW, across every exit we
 * tried, that we should stop advertising it?"
 *
 * Design constraints:
 *   - SUCCESS WINS. Any clean response clears the streak. A model that works
 *     intermittently must never be hidden (measured 2026-10-22: the same id
 *     503s on one region while passing 3/3 on another, and recovers within
 *     minutes).
 *   - TRANSIENT KINDS DO NOT COUNT. `limited` is quota (per-egress, resets),
 *     `transport` is the tunnel, `region`/`refused` are egress identity. Only a
 *     `server` fault is evidence about the model endpoint itself.
 *   - SELF-HEALING. Hiding expires: after `ttlMs` the model is advertised
 *     again so the upstream gets re-probed. A permanently dead id is the
 *     build-time `disabledModels` list's job, not this one's.
 *   - NO EXIT DIMENSION. Ten bad exits are one broken model, not ten signals,
 *     so consecutive attempts at different exits legitimately accumulate.
 */

/** Only this failure kind is evidence about the model endpoint itself. */
const COUNTED_KINDS = new Set(['server'])

export interface ModelHealthOptions {
  /** Consecutive `server` failures needed before the model is hidden. */
  failThreshold?: number
  /** How long a hidden model stays hidden before it is re-advertised. */
  ttlMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

interface Streak {
  failures: number
  /** When the streak reached the threshold; 0 while still under it. */
  hiddenAt: number
  lastError: string
}

export interface HiddenModelView {
  model: string
  failures: number
  /** ISO-8601, ready for the health payload / debug UI. */
  hiddenAt: string
  /** ISO-8601 of when hiding expires and the model is advertised again. */
  expiresAt: string
  lastError: string
}

export class ModelHealth {
  readonly #failThreshold: number
  readonly #ttlMs: number
  readonly #now: () => number
  #streaks = new Map<string, Streak>()

  constructor(options: ModelHealthOptions = {}) {
    // 0 disables auto-hiding entirely (restores the "always advertise what the
    // upstream sells for free" behaviour). Any positive value is the threshold.
    this.#failThreshold = Math.max(0, options.failThreshold ?? 5)
    this.#ttlMs = Math.max(0, options.ttlMs ?? 5 * 60_000)
    this.#now = options.now ?? Date.now
  }

  /**
   * Record one failed attempt. Non-`server` kinds are ignored entirely (they
   * say nothing about the model). Returns true when this call crossed the
   * threshold and newly hid the model, so the caller can log a transition.
   */
  recordFailure(model: string, kind: string, error = ''): boolean {
    if (!COUNTED_KINDS.has(kind) || this.#failThreshold === 0) return false
    const now = this.#now()
    const current = this.#streaks.get(model)
    // An expired hide is not a live hide: the streak restarts from zero so a
    // model that was hidden, expired and immediately failed again has to earn
    // its way back out rather than being re-hidden on a single failure.
    const base = current && !this.#expired(current, now) ? current.failures : 0
    const failures = base + 1
    const hidden = current !== undefined && current.hiddenAt > 0 && !this.#expired(current, now)
    // Keep the ORIGINAL hiddenAt while the hide is live so the TTL is measured
    // from the moment it was hidden, not from the latest failure.
    const hiddenAt = hidden ? current.hiddenAt : failures >= this.#failThreshold ? now : 0
    this.#streaks.set(model, { failures, hiddenAt, lastError: error.slice(0, 200) })
    return !hidden && hiddenAt > 0
  }

  /** Record a clean response. Clears the streak and any active hide. */
  recordSuccess(model: string): void {
    this.#streaks.delete(model)
  }

  /** True when the model is hidden right now (hide present and unexpired). */
  isHidden(model: string): boolean {
    const streak = this.#streaks.get(model)
    if (!streak || streak.hiddenAt === 0) return false
    return !this.#expired(streak, this.#now())
  }

  /** Every model currently hidden, for the debug UI / health payload. */
  hidden(): HiddenModelView[] {
    const now = this.#now()
    const out: HiddenModelView[] = []
    for (const [model, streak] of this.#streaks) {
      if (streak.hiddenAt === 0 || this.#expired(streak, now)) continue
      out.push({
        model,
        failures: streak.failures,
        hiddenAt: new Date(streak.hiddenAt).toISOString(),
        expiresAt: new Date(streak.hiddenAt + this.#ttlMs).toISOString(),
        lastError: streak.lastError,
      })
    }
    return out.sort((a, b) => a.model.localeCompare(b.model))
  }

  /** Diagnostic view of every tracked model, hidden or not. */
  streaks(): Array<{ model: string; failures: number; hidden: boolean }> {
    return [...this.#streaks].map(([model, s]) => ({
      model,
      failures: s.failures,
      hidden: s.hiddenAt !== 0 && !this.#expired(s, this.#now()),
    }))
  }

  #expired(streak: Streak, now: number): boolean {
    return streak.hiddenAt > 0 && now - streak.hiddenAt >= this.#ttlMs
  }
}
