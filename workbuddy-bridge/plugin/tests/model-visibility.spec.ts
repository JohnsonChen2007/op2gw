import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyVisibilityStore } from '../src/visibility-store.ts'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCatalog, type WorkBuddyModelInfo } from '../src/catalog.ts'
import { visibilityAccountOf } from '../src/index.ts'
import { workBuddyWebStatus, type WorkBuddyStatusRouteOptions } from '../src/web-status.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import { createProbeKey, workBuddyProbeHandler, type WorkBuddyProbeRouteOptions } from '../src/probe-route.ts'
import type { WorkBuddyVariant } from '../src/variants.ts'
import { WORKBUDDY_VARIANTS } from '../src/variants.ts'

/**
 * Issue #36: per-account model visibility. The suite pins the three-way
 * boundary (catalog keeps everything, listModels hides, resolveModel resolves),
 * the per-account/per-variant isolation of the store, persistence, the
 * signed-out and uid-less degradations, and the control-route contract. The
 * card's checkboxes live in `tests/model-visibility-card.spec.ts` (client
 * project); the dual-DSH-ui aspect needs no feature tests of its own — the
 * controls live in the shared `WorkBuddyPluginCard`, which the existing 0.1.5
 * (`slot-registration.spec.ts`) and 0.1.6+ seam tests already exercise for
 * both surfaces.
 */

const CLEANUP: (() => void)[] = []

afterEach(() => {
  for (const clean of CLEANUP.splice(0)) clean()
})

/** Fresh throwaway directory registered for afterEach removal. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  CLEANUP.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000, maxTokens: 32_000, supportsImages: true, billing: { free: false } },
  { id: 'hy3', name: 'Hy3', contextWindow: 1_000, maxTokens: 32_000, supportsImages: true, billing: { free: false } },
  { id: 'auto', name: 'Auto', contextWindow: 1_000, maxTokens: 32_000, supportsImages: true, billing: { free: false } },
]

/** The fake shim from `adapter.spec.ts`: never listens, only answers strings. */
const SHIM = {
  ready: Promise.resolve(),
  baseUrl: () => 'http://127.0.0.1:1',
  token: () => 'test-token',
  close: async () => {},
} as unknown as WorkBuddyShim

describe('A. disabled-list semantics (visibility store)', () => {
  it('hides nothing for an account that never toggled anything', () => {
    const store = new WorkBuddyVisibilityStore(join(tempDir('wb-vis-'), 'v.json'))
    expect(store.disabled('uid-a:')).toEqual([])
  })

  it('disable removes the model from selectable listings; re-enable restores it', async () => {
    const store = new WorkBuddyVisibilityStore(join(tempDir('wb-vis-'), 'v.json'))
    const catalog = new WorkBuddyCatalog([...MODELS])
    let hidden: readonly string[] = []
    const { adapter } = createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: SHIM,
      hidden: () => hidden,
    })

    expect((await adapter.listModels(WORKBUDDY_PROVIDER)).map(m => m.id)).toEqual(['glm-5.3', 'hy3', 'auto'])

    store.setVisible('uid-a:', 'glm-5.3', false)
    hidden = store.disabled('uid-a:')
    expect((await adapter.listModels(WORKBUDDY_PROVIDER)).map(m => m.id)).toEqual(['hy3', 'auto'])

    store.setVisible('uid-a:', 'glm-5.3', true)
    hidden = store.disabled('uid-a:')
    expect((await adapter.listModels(WORKBUDDY_PROVIDER)).map(m => m.id)).toEqual(['glm-5.3', 'hy3', 'auto'])
  })

  it('a model newly added to the catalog is visible by default', () => {
    const store = new WorkBuddyVisibilityStore(join(tempDir('wb-vis-'), 'v.json'))
    store.setVisible('uid-a:', 'hy3', false)
    // 'new-super-model' was never named by this account: not in the list.
    expect(store.disabled('uid-a:')).toEqual(['hy3'])
    expect(store.disabled('uid-a:').includes('new-super-model')).toBe(false)
  })

  it('keeps a disabled id whose model temporarily left the catalog', () => {
    const store = new WorkBuddyVisibilityStore(join(tempDir('wb-vis-'), 'v.json'))
    store.setVisible('uid-a:', 'glm-5.3', false)
    // The catalog drops the row (upstream refresh without it); the stored list
    // is untouched, so the model stays hidden when it returns.
    expect(store.disabled('uid-a:')).toEqual(['glm-5.3'])
    store.setVisible('uid-a:', 'hy3', false)
    expect(store.disabled('uid-a:')).toEqual(['glm-5.3', 'hy3'])
  })

  it('removes the account bucket once nothing is hidden', () => {
    const dir = tempDir('wb-vis-')
    const path = join(dir, 'v.json')
    const store = new WorkBuddyVisibilityStore(path)
    store.setVisible('uid-a:', 'hy3', false)
    store.setVisible('uid-a:', 'hy3', true)
    expect(store.disabled('uid-a:')).toEqual([])
    expect(JSON.parse(readFileSync(path, 'utf8')).accounts).toEqual({})
  })

  it('a malformed file reads as nothing hidden and can be replaced', () => {
    const path = join(tempDir('wb-vis-'), 'v.json')
    writeFileSync(path, '{not json', { mode: 0o600 })
    const store = new WorkBuddyVisibilityStore(path)
    expect(store.disabled('uid-a:')).toEqual([])
    store.setVisible('uid-a:', 'hy3', false)
    expect(new WorkBuddyVisibilityStore(path).disabled('uid-a:')).toEqual(['hy3'])
  })

  it('writes the file with owner-only permissions', () => {
    const path = join(tempDir('wb-vis-'), 'v.json')
    new WorkBuddyVisibilityStore(path).setVisible('uid-a:', 'hy3', false)
    // Owner read/write only, matching the credential/catalog stores.
    expect((statSync(path).mode & 0o777) & 0o077).toBe(0)
  })
})

describe('B. resolve compatibility (hidden but resolvable)', () => {
  it('listModels hides the model while resolveModel keeps resolving it', async () => {
    const catalog = new WorkBuddyCatalog([...MODELS])
    const { adapter } = createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: SHIM,
      hidden: () => ['glm-5.3'],
    })
    expect((await adapter.listModels(WORKBUDDY_PROVIDER)).map(m => m.id)).not.toContain('glm-5.3')
    // The session still on glm-5.3 resolves as before — same snapshot, unfiltered.
    const resolved = await adapter.resolveModel(WORKBUDDY_PROVIDER, 'glm-5.3')
    expect(resolved.id).toBe('glm-5.3')
  })

  it('an account switch re-lists through the new hidden set without a rebuild', async () => {
    const catalog = new WorkBuddyCatalog([...MODELS])
    const store = new WorkBuddyVisibilityStore(join(tempDir('wb-vis-'), 'v.json'))
    let account: string | undefined = 'uid-a:'
    store.setVisible('uid-a:', 'hy3', false)
    store.setVisible('uid-b:', 'auto', false)
    const { adapter } = createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: SHIM,
      hidden: () => (account === undefined ? [] : store.disabled(account)),
    })
    expect((await adapter.listModels(WORKBUDDY_PROVIDER)).map(m => m.id)).toEqual(['glm-5.3', 'auto'])
    account = 'uid-b:'
    expect((await adapter.listModels(WORKBUDDY_PROVIDER)).map(m => m.id)).toEqual(['glm-5.3', 'hy3'])
    account = undefined
    expect((await adapter.listModels(WORKBUDDY_PROVIDER)).map(m => m.id)).toEqual(['glm-5.3', 'hy3', 'auto'])
  })
})

describe('C/D. per-account and per-variant isolation', () => {
  it('each account hides only its own models', () => {
    const store = new WorkBuddyVisibilityStore(join(tempDir('wb-vis-'), 'v.json'))
    store.setVisible('uid-a:', 'model-a', false)
    store.setVisible('uid-b:', 'model-b', false)
    expect(store.disabled('uid-a:')).toEqual(['model-a'])
    expect(store.disabled('uid-b:')).toEqual(['model-b'])
    // A disables what B hid: A's own list gains it, B's is untouched.
    store.setVisible('uid-a:', 'model-b', false)
    expect(store.disabled('uid-a:')).toEqual(['model-a', 'model-b'])
    expect(store.disabled('uid-b:')).toEqual(['model-b'])
  })

  it('the same account key under two variants never shares a file', () => {
    const dir = tempDir('wb-vis-')
    const [cn, ai] = WORKBUDDY_VARIANTS
    if (cn === undefined || ai === undefined) throw new Error('variants missing')
    const cnStore = new WorkBuddyVisibilityStore(join(dir, cn.visibilityFilename))
    const aiStore = new WorkBuddyVisibilityStore(join(dir, ai.visibilityFilename))
    cnStore.setVisible('uid-1:', 'glm-5.3', false)
    expect(cnStore.disabled('uid-1:')).toEqual(['glm-5.3'])
    expect(aiStore.disabled('uid-1:')).toEqual([])
    aiStore.setVisible('uid-1:', 'hy3', false)
    expect(cnStore.disabled('uid-1:')).toEqual(['glm-5.3'])
    expect(aiStore.disabled('uid-1:')).toEqual(['hy3'])
  })

  it('each variant descriptor names its own visibility file', () => {
    for (const variant of WORKBUDDY_VARIANTS as readonly WorkBuddyVariant[]) {
      expect(variant.visibilityFilename).toMatch(/^\.workbuddy(-ai)?-model-visibility\.json$/)
    }
    expect(WORKBUDDY_VARIANTS[0]!.visibilityFilename).not.toBe(WORKBUDDY_VARIANTS[1]!.visibilityFilename)
  })
})

describe('E. persistence', () => {
  it('a preference survives a dispose/restart (fresh store instance)', () => {
    const path = join(tempDir('wb-vis-'), 'v.json')
    const first = new WorkBuddyVisibilityStore(path)
    first.setVisible('uid-a:', 'glm-5.3', false)
    first.setVisible('uid-a:', 'hy3', false)
    // New process, same file: A finds its list, B starts clean.
    const second = new WorkBuddyVisibilityStore(path)
    expect(second.disabled('uid-a:')).toEqual(['glm-5.3', 'hy3'])
    expect(second.disabled('uid-b:')).toEqual([])
  })

  it('preferences are kept across a sign-out (restored on return)', () => {
    const path = join(tempDir('wb-vis-'), 'v.json')
    const store = new WorkBuddyVisibilityStore(path)
    store.setVisible('uid-a:', 'glm-5.3', false)
    // Sign-out deletes the saved *catalog* in index.ts, never this file.
    const reopened = new WorkBuddyVisibilityStore(path)
    expect(reopened.disabled('uid-a:')).toEqual(['glm-5.3'])
  })

  it('a failed write propagates instead of reporting success', () => {
    const dir = tempDir('wb-vis-')
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'file where a directory is needed', { mode: 0o600 })
    const store = new WorkBuddyVisibilityStore(join(blocker, 'sub', 'v.json'))
    expect(() => store.setVisible('uid-a:', 'hy3', false)).toThrow()
    // In-memory state stayed untouched: a re-read cannot claim it persisted.
    expect(store.disabled('uid-a:')).toEqual([])
  })
})

describe('F. signed-out and uid-less degradation', () => {
  it('an empty uid yields no account key — no shared anonymous bucket', () => {
    expect(visibilityAccountOf({ uid: '' })).toBeUndefined()
    expect(visibilityAccountOf({ uid: '', enterpriseId: 'ent-1' })).toBeUndefined()
    expect(visibilityAccountOf({ uid: 'u1' })).toBe('u1:')
    expect(visibilityAccountOf({ uid: 'u1', enterpriseId: 'ent-1' })).toBe('u1:ent-1')
  })

  it('the status document carries no visibility section when none is in effect', async () => {
    const deps: WorkBuddyStatusRouteOptions = {
      store: { status: async () => ({ state: 'signed-out' }) } as unknown as WorkBuddyCredentialStore,
      client: { fetchCredits: async () => ({ total: 0, accounts: [] }) },
      models: () => [],
      visibility: () => ({ account: 'u1:', disabled: ['hy3'] }),
    }
    expect(await workBuddyWebStatus(deps)).toEqual({ status: 'signed-out' })
  })

  it('a signed-in account-without-uid omits the section rather than sharing a bucket', async () => {
    const deps: WorkBuddyStatusRouteOptions = {
      store: {
        status: async () => ({ state: 'signed-in', nickname: 'n' }),
        current: async () => undefined,
      } as unknown as WorkBuddyCredentialStore,
      client: { fetchCredits: async () => ({ total: 0, accounts: [] }) },
      models: () => [...MODELS],
      // The runtime wires exactly this shape for a uid-less credential.
      visibility: () => undefined,
    }
    const doc = await workBuddyWebStatus(deps)
    expect(doc.status).toBe('signed-in')
    expect('visibility' in doc && doc.visibility !== undefined).toBe(false)
  })

  it('a signed-in account-with-uid carries its full hidden list, stale ids included', async () => {
    const deps: WorkBuddyStatusRouteOptions = {
      store: {
        status: async () => ({ state: 'signed-in', nickname: 'n' }),
        current: async () => undefined,
      } as unknown as WorkBuddyCredentialStore,
      client: { fetchCredits: async () => ({ total: 0, accounts: [] }) },
      models: () => [...MODELS],
      visibility: () => ({ account: 'u1:ent', disabled: ['hy3', 'gone-upstream'] }),
    }
    const doc = await workBuddyWebStatus(deps)
    expect(doc.status === 'signed-in' && doc.visibility).toEqual({ account: 'u1:ent', disabled: ['hy3', 'gone-upstream'] })
  })
})

describe('control route: set-model-visibility', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>(resolve => server?.close(() => resolve()))
      server = undefined
    }
  })

  /** Mount the handler on an ephemeral port; probe/clear are inert stubs. */
  async function mount(deps?: Partial<WorkBuddyProbeRouteOptions>): Promise<{ origin: string; key: string }> {
    const key = createProbeKey()
    const handler = workBuddyProbeHandler({
      probe: async () => ({ state: 'ok' }),
      clear: () => {},
      ...deps,
    }, key)
    const created = createServer((req, res) => { void handler(req, res) })
    server = created
    await new Promise<void>(resolve => created.listen(0, '127.0.0.1', () => resolve()))
    const address = created.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return { origin: `http://127.0.0.1:${address.port}`, key }
  }

  async function post(origin: string, key: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workbuddy-Probe-Key': key },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }

  it('persists a hide through the wired handler and reports updated', async () => {
    const store = new WorkBuddyVisibilityStore(join(tempDir('wb-vis-'), 'v.json'))
    let seen: string | undefined
    const { origin, key } = await mount({
      setModelVisibility: async (modelId, visible, expectedAccount) => {
        seen = expectedAccount
        store.setVisible(expectedAccount, modelId, visible)
        return { state: 'updated' }
      },
    })
    const { status, body } = await post(origin, key, { action: 'set-model-visibility', model: 'hy3', visible: false, account: 'u1:' })
    expect(status).toBe(200)
    expect(body['state']).toBe('updated')
    // The expected account travels with the write; nothing is bucketed by guess.
    expect(seen).toBe('u1:')
    expect(store.disabled('u1:')).toEqual(['hy3'])
  })

  it('an expected-account mismatch is the host guard\'s stale-account refusal', async () => {
    // The exact guard index.ts wires: compare the expected account against the
    // account now in effect, refuse on mismatch. A stale card from before an
    // account switch must not write into the new account's bucket.
    const current = 'uid-b:'
    const { origin, key } = await mount({
      setModelVisibility: async (modelId, _visible, expectedAccount) => {
        if (expectedAccount !== current) return { state: 'stale-account', reason: 'the signed-in account changed' }
        return { state: 'updated' }
      },
    })
    const { body } = await post(origin, key, { action: 'set-model-visibility', model: 'hy3', visible: false, account: 'uid-a:' })
    expect(body['state']).toBe('stale-account')
  })

  it('reports the handler failure reason instead of pretending it saved', async () => {
    const { origin, key } = await mount({
      setModelVisibility: async () => ({ state: 'failed', reason: 'model visibility needs a signed-in account with a stable user id' }),
    })
    const { status, body } = await post(origin, key, { action: 'set-model-visibility', model: 'hy3', visible: false, account: 'u1:' })
    expect(status).toBe(200)
    expect(body['state']).toBe('failed')
    expect(String(body['reason'])).toContain('stable user id')
  })

  it('rejects malformed actions and unsupported variants', async () => {
    const { origin, key } = await mount()
    expect((await post(origin, key, { action: 'set-model-visibility', model: 'hy3' })).status).toBe(400)
    expect((await post(origin, key, { action: 'set-model-visibility', model: '', visible: true, account: 'u1:' })).status).toBe(400)
    expect((await post(origin, key, { action: 'set-model-visibility', model: 'hy3', visible: 'yes', account: 'u1:' })).status).toBe(400)
    // Without an expected account there is nothing to guard, so there is no
    // write at all — required, not defaulted.
    expect((await post(origin, key, { action: 'set-model-visibility', model: 'hy3', visible: true })).status).toBe(400)
    expect((await post(origin, key, { action: 'set-model-visibility', model: 'hy3', visible: true, account: '' })).status).toBe(400)
    // Deps without the action answer 404, matching set-maximum-context-window.
    expect((await post(origin, key, { action: 'set-model-visibility', model: 'hy3', visible: true, account: 'u1:' })).status).toBe(404)
  })
})
