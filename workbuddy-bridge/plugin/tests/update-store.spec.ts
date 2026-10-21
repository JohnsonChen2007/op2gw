import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyUpdateStore,
  WORKBUDDY_UPDATE_CACHE_KEY,
  WORKBUDDY_UPDATE_CACHE_TTL_MS,
  WORKBUDDY_UPDATE_DISMISSED_KEY,
  WORKBUDDY_UPDATE_RECHECK_MS,
} from '../src/client/update-store.ts'
import { WORKBUDDY_UPDATE_PATH } from '../src/status-paths.ts'
import { releasePageUrl } from '../src/update.ts'

/**
 * The reminder's browser-side state: a 7-day cache keyed to the running
 * version, no caching of failures, one in-page retry, and a dismiss that a
 * newer release clears by itself.
 */

const UPDATE_AVAILABLE = {
  status: 'update-available',
  currentVersion: '0.6.3',
  latestVersion: '0.6.4',
  releaseUrl: releasePageUrl('0.6.4'),
  releases: [{ version: 'v0.6.4', name: 'v0.6.4：新版本摘要' }],
  versionsBehind: 1,
}

/** A minimal synchronous Storage stand-in; node has none. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => { map.clear() },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  }
}

function routeFetch(answer: unknown = UPDATE_AVAILABLE, calls: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

let storage: Storage

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
  storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('fetch', routeFetch())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the update store cache', () => {
  it('serves a fresh same-version result from the cache without fetching', async () => {
    const first = new WorkBuddyUpdateStore('0.6.3')
    const calls: string[] = []
    vi.stubGlobal('fetch', routeFetch(UPDATE_AVAILABLE, calls))
    await first.refresh()
    first.dispose()
    expect(calls).toHaveLength(1)

    // A second store on the same version (another page load) hits the cache.
    const second = new WorkBuddyUpdateStore('0.6.3')
    await second.refresh()
    second.dispose()
    expect(calls).toHaveLength(1)
    expect(second.getSnapshot()).toMatchObject({ status: 'update-available', latestVersion: '0.6.4' })
  })

  it('invalidates the cache when the running version moves on', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', routeFetch(UPDATE_AVAILABLE, calls))
    const old = new WorkBuddyUpdateStore('0.6.3')
    await old.refresh()
    old.dispose()
    const upgraded = new WorkBuddyUpdateStore('0.6.4')
    await upgraded.refresh()
    upgraded.dispose()
    expect(calls).toHaveLength(2)
  })

  it('expires the cache after the TTL', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', routeFetch(UPDATE_AVAILABLE, calls))
    const first = new WorkBuddyUpdateStore('0.6.3')
    await first.refresh()
    first.dispose()
    vi.setSystemTime(new Date(Date.now() + WORKBUDDY_UPDATE_CACHE_TTL_MS + 1))
    const second = new WorkBuddyUpdateStore('0.6.3')
    await second.refresh()
    second.dispose()
    expect(calls).toHaveLength(2)
  })

  it('never caches an unavailable answer and retries once in-page', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', routeFetch({ status: 'unavailable', currentVersion: '0.6.3', reason: 'registry-unavailable' }, calls))
    const store = new WorkBuddyUpdateStore('0.6.3')
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable' })
    expect(storage.getItem(WORKBUDDY_UPDATE_CACHE_KEY)).toBeNull()
    expect(calls).toHaveLength(1)
    // The in-page retry fires while the page stays open.
    await vi.advanceTimersByTimeAsync(WORKBUDDY_UPDATE_RECHECK_MS)
    expect(calls).toHaveLength(2)
    store.dispose()
    // And disposal stops any further retry.
    await vi.advanceTimersByTimeAsync(WORKBUDDY_UPDATE_RECHECK_MS * 3)
    expect(calls).toHaveLength(2)
  })
})

describe('recheck keeps the dismissal target (review P2)', () => {
  it('carries latestVersion through the checking transition and honours a mid-recheck dismissal', async () => {
    let release!: (value: void) => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const respond = () => new Response(JSON.stringify(UPDATE_AVAILABLE), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', (async () => {
      calls += 1
      // Only the forced recheck hangs; the first, cache-filling refresh answers.
      if (calls > 1) await gate
      return respond()
    }) as typeof fetch)
    const store = new WorkBuddyUpdateStore('0.6.3')
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'update-available', latestVersion: '0.6.4' })

    // Force a recheck whose route hangs: the snapshot flips to checking, but
    // the version pair behind the dismissal key must survive it.
    const rechecking = store.refresh(true)
    expect(store.getSnapshot().status).toBe('checking')
    expect(store.getSnapshot().latestVersion).toBe('0.6.4')

    // "Don't remind me again" clicked mid-recheck writes the pair.
    store.dismiss('0.6.3:0.6.4')
    expect(storage.getItem(WORKBUDDY_UPDATE_DISMISSED_KEY)).toBe('0.6.3:0.6.4')

    // The recheck answers update-available again: the stored dismissal now
    // covers it, so a panel keyed to this pair stays hidden.
    release()
    await rechecking
    expect(store.getSnapshot()).toMatchObject({ status: 'update-available', dismissedNotice: '0.6.3:0.6.4' })
    store.dispose()
  })
})

describe('a failed recheck keeps the dismissal target (review follow-up)', () => {
  it('carries the version pair into unavailable state and honours a dismissal made there', async () => {
    let fail = false
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', (async () => fail
      ? new Response('nope', { status: 500 })
      : respond(UPDATE_AVAILABLE)) as typeof fetch)
    const store = new WorkBuddyUpdateStore('0.6.3')
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'update-available', latestVersion: '0.6.4' })

    // The recheck fails: the panel stays (pending recheck), and the version
    // pair behind the dismissal key must survive the failure state too.
    fail = true
    await store.refresh(true)
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable' })
    expect(store.getSnapshot().latestVersion).toBe('0.6.4')

    // "Don't remind me again" clicked during the failure writes the pair.
    store.dismiss('0.6.3:0.6.4')
    expect(storage.getItem(WORKBUDDY_UPDATE_DISMISSED_KEY)).toBe('0.6.3:0.6.4')

    // The in-page retry succeeds with the same pair: the stored dismissal
    // now covers it, so a panel keyed to this pair stays hidden.
    fail = false
    await vi.advanceTimersByTimeAsync(WORKBUDDY_UPDATE_RECHECK_MS)
    expect(store.getSnapshot()).toMatchObject({ status: 'update-available', dismissedNotice: '0.6.3:0.6.4' })
    // And the failure never cached its shape of the answer.
    const cached = JSON.parse(String(storage.getItem(WORKBUDDY_UPDATE_CACHE_KEY))) as { result: { status: string } }
    expect(cached.result.status).toBe('update-available')
    store.dispose()
  })
})

describe('dismissal', () => {
  it('keys the dismissal to the version pair, so a newer release clears it', async () => {
    const store = new WorkBuddyUpdateStore('0.6.3')
    await store.refresh()
    expect(store.getSnapshot().dismissedNotice).toBeUndefined()
    store.dismiss('0.6.3:0.6.4')
    expect(storage.getItem(WORKBUDDY_UPDATE_DISMISSED_KEY)).toBe('0.6.3:0.6.4')
    // A later store sees the dismissal with the cached result.
    const reloaded = new WorkBuddyUpdateStore('0.6.3')
    await reloaded.refresh()
    expect(reloaded.getSnapshot()).toMatchObject({ status: 'update-available', dismissedNotice: '0.6.3:0.6.4' })
    reloaded.dispose()
    store.dispose()
  })
})

describe('refresh timeouts', () => {
  it('lands in unavailable after the route timeout, then retries in-page', async () => {
    // A route that never answers: only the refresh's own 30s abort ends the
    // request, and that abort must count as a failure — not silently vanish
    // and leave the snapshot stuck on `checking`.
    vi.stubGlobal('fetch', ((_input: string | URL, init?: RequestInit) => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true })
    })) as typeof fetch)
    const store = new WorkBuddyUpdateStore('0.6.3')
    const pending = store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().status).toBe('checking')
    await vi.advanceTimersByTimeAsync(30_001)
    await pending
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable' })
    // The in-page retry is scheduled like any other failure.
    await vi.advanceTimersByTimeAsync(WORKBUDDY_UPDATE_RECHECK_MS)
    expect(store.getSnapshot().status).toBe('checking')
    store.dispose()
  })
})

describe('route transport', () => {
  it('degrades a non-OK or unparseable route answer to unavailable', async () => {
    vi.stubGlobal('fetch', (async () => new Response('nope', { status: 500 })) as typeof fetch)
    const store = new WorkBuddyUpdateStore('0.6.3')
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable' })
    store.dispose()
  })

  it('degrades a route answer the browser validator rejects', async () => {
    const forged = { ...UPDATE_AVAILABLE, releaseUrl: 'https://evil.example/x' }
    vi.stubGlobal('fetch', routeFetch(forged))
    const store = new WorkBuddyUpdateStore('0.6.3')
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable' })
    store.dispose()
  })

  it('asks the same-origin update path', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', routeFetch(UPDATE_AVAILABLE, calls))
    const store = new WorkBuddyUpdateStore('0.6.3')
    await store.refresh()
    store.dispose()
    expect(calls).toEqual([WORKBUDDY_UPDATE_PATH])
  })
})
