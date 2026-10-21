/**
 * Browser-owned cache and observable state for the update reminder.
 *
 * One reminder for the whole bundle — the check compares this npm package's
 * own version, so both provider cards share it. The cache is localStorage
 * with a 7-day TTL and the current version embedded, so an upgrade
 * invalidates it by itself. `unavailable` answers are never cached: the next
 * mount retries, and one in-page retry is scheduled after five minutes while
 * the page stays open.
 */

import { parseWorkBuddyUpdateResult } from '../update.ts'
import type { WorkBuddyUpdateRelease, WorkBuddyUpdateResult } from '../update.ts'
import { WORKBUDDY_UPDATE_PATH } from '../status-paths.ts'

export const WORKBUDDY_UPDATE_CACHE_KEY = 'dsh-workbuddy-connect:update-check'
export const WORKBUDDY_UPDATE_DISMISSED_KEY = 'dsh-workbuddy-connect:update-dismissed'
/** One reminder per week is plenty at this plugin's release cadence. */
export const WORKBUDDY_UPDATE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000
/** Retry transient update-check failures while the page remains open. */
export const WORKBUDDY_UPDATE_RECHECK_MS = 5 * 60 * 1_000
/** The reminder's own fetch deadline, independent of the host's upstream one. */
const ROUTE_TIMEOUT_MS = 30_000

export type WorkBuddyUpdateSnapshot = {
  status: 'idle' | 'checking' | WorkBuddyUpdateResult['status']
  currentVersion: string
  checkedAt?: number
  latestVersion?: string
  releases?: readonly WorkBuddyUpdateRelease[]
  releaseUrl?: string
  versionsBehind?: number
  dismissedNotice?: string
}

interface CachedUpdate {
  checkedAt: number
  result: unknown
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function resultSnapshot(result: WorkBuddyUpdateResult, dismissedNotice?: string): WorkBuddyUpdateSnapshot {
  return {
    status: result.status,
    currentVersion: result.currentVersion,
    ...result.status === 'up-to-date' || result.status === 'update-available'
      ? { latestVersion: result.latestVersion }
      : {},
    ...result.status === 'update-available'
      ? {
        releaseUrl: result.releaseUrl,
        releases: result.releases,
        ...result.versionsBehind === undefined ? {} : { versionsBehind: result.versionsBehind },
      }
      : {},
    ...dismissedNotice === undefined ? {} : { dismissedNotice },
  }
}

/** Observable browser state behind the bottom-right reminder. */
export class WorkBuddyUpdateStore {
  private snapshot: WorkBuddyUpdateSnapshot
  private readonly listeners = new Set<() => void>()
  private request: AbortController | undefined
  private disposed = false
  private recheckTimer: ReturnType<typeof setTimeout> | undefined

  constructor(readonly currentVersion: string) {
    this.snapshot = { status: 'idle', currentVersion }
  }

  getSnapshot = (): WorkBuddyUpdateSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private setSnapshot(next: WorkBuddyUpdateSnapshot): void {
    if (this.disposed) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private dismissedNotice(): string | undefined {
    try {
      const value = storage()?.getItem(WORKBUDDY_UPDATE_DISMISSED_KEY)
      return value === null || value === '' ? undefined : value
    } catch {
      return undefined
    }
  }

  private readCached(): { result: WorkBuddyUpdateResult, checkedAt: number } | undefined {
    try {
      const raw = storage()?.getItem(WORKBUDDY_UPDATE_CACHE_KEY)
      if (raw === null || raw === undefined) return undefined
      const cached = JSON.parse(raw) as CachedUpdate
      if (!Number.isSafeInteger(cached.checkedAt) || cached.checkedAt > Date.now() || Date.now() - cached.checkedAt > WORKBUDDY_UPDATE_CACHE_TTL_MS) return undefined
      const result = parseWorkBuddyUpdateResult(cached.result)
      if (result === undefined || result.status === 'unavailable') return undefined
      return { result, checkedAt: cached.checkedAt }
    } catch {
      return undefined
    }
  }

  private writeCached(result: WorkBuddyUpdateResult, checkedAt: number): void {
    try {
      if (result.status === 'unavailable') storage()?.removeItem(WORKBUDDY_UPDATE_CACHE_KEY)
      else storage()?.setItem(WORKBUDDY_UPDATE_CACHE_KEY, JSON.stringify({ checkedAt, result }))
    } catch {
      // A blocked or full browser storage should not disable the reminder.
    }
  }

  private acceptResult(result: WorkBuddyUpdateResult): void {
    if (this.disposed) return
    const checkedAt = Date.now()
    this.writeCached(result, checkedAt)
    const next = resultSnapshot(result, this.dismissedNotice())
    // A failed recheck must not erase the version pair the panel is showing:
    // "don't remind me again" clicked during the failure still dismisses
    // that pair, and the in-page retry answering update-available again
    // stays covered by the stored dismissal. The pair is never cached with
    // the failure, so a later mount without an answer starts clean.
    if (result.status === 'unavailable' && this.snapshot.latestVersion !== undefined) {
      next.latestVersion = this.snapshot.latestVersion
    }
    this.setSnapshot({ ...next, checkedAt })
    if (result.status === 'unavailable') {
      this.recheckTimer = setTimeout(() => { void this.refresh(true) }, WORKBUDDY_UPDATE_RECHECK_MS)
    }
  }

  /** Reuse a result for a week; force bypasses the cache. */
  async refresh(force = false): Promise<void> {
    if (this.disposed || this.request !== undefined) return
    clearTimeout(this.recheckTimer)
    this.recheckTimer = undefined
    const controller = new AbortController()
    this.request = controller
    const timer = setTimeout(() => { controller.abort(new Error('update route timed out')) }, ROUTE_TIMEOUT_MS)
    // `latestVersion` survives the checking transition: the dismissal key is
    // derived from it, and a recheck must not blank the target mid-flight —
    // otherwise "don't remind me again" clicked while rechecking would write
    // nothing and the panel would return with the very same version pair.
    this.setSnapshot({
      status: 'checking',
      currentVersion: this.currentVersion,
      ...this.snapshot.latestVersion === undefined ? {} : { latestVersion: this.snapshot.latestVersion },
      ...this.snapshot.dismissedNotice === undefined ? {} : { dismissedNotice: this.snapshot.dismissedNotice },
    })
    try {
      if (!force) {
        const cached = this.readCached()
        if (cached !== undefined && cached.result.currentVersion === this.currentVersion) {
          this.setSnapshot({ ...resultSnapshot(cached.result, this.dismissedNotice()), checkedAt: cached.checkedAt })
          return
        }
      }
      const response = await fetch(WORKBUDDY_UPDATE_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      })
      const value: unknown = await response.json().catch(() => undefined)
      const result = response.ok ? parseWorkBuddyUpdateResult(value) : undefined
      this.acceptResult(result ?? {
        status: 'unavailable',
        currentVersion: this.currentVersion,
        reason: 'registry-unavailable',
      })
    } catch {
      // Only the dispose path cancels the request on purpose; every other
      // abort — this refresh's own timeout included — and every transport
      // error must land in `unavailable` (which schedules the in-page retry),
      // or the snapshot would sit in `checking` forever.
      if (!this.disposed) {
        this.acceptResult({ status: 'unavailable', currentVersion: this.currentVersion, reason: 'registry-unavailable' })
      }
    } finally {
      clearTimeout(timer)
      if (this.request === controller) this.request = undefined
    }
  }

  dismiss(notice: string): void {
    try {
      storage()?.setItem(WORKBUDDY_UPDATE_DISMISSED_KEY, notice)
    } catch {
      // Dismissal remains effective for this mounted store even if storage is blocked.
    }
    this.setSnapshot({ ...this.snapshot, dismissedNotice: notice })
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.recheckTimer)
    this.request?.abort()
    this.request = undefined
    this.listeners.clear()
  }
}
