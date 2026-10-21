import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyAtRestKeyProvider,
  WORKBUDDY_ELECTRON_BIN_ENV,
  atRestKeyProviderFor,
  deriveProtectorKey,
  reasonCodeOf,
} from '../src/desktop-credential-protection.ts'
import type { WorkBuddyDiscoveryTools } from '../src/desktop-credential-protection.ts'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { CN_VARIANT, AI_VARIANT , electronProfileFor} from '../src/variants.ts'

/**
 * Issue #48: the macOS Electron binary is no longer assumed to live at
 * `/Applications/WorkBuddy.app`.
 *
 * Every test here drives the discovery flow through injected tools, so no test
 * spawns `mdfind` or `plutil` — and so a test can force the fallback branch
 * without moving the real application. The contracts under test: explicit
 * config is
 * authoritative, discovery runs only after the default path fails, identity is
 * proved before execution, and an unfinished check is never mistaken for an
 * absent app.
 */

const CN_BUNDLE_ID = electronProfileFor(CN_VARIANT).macOS.bundleId
const AI_BUNDLE_ID = electronProfileFor(AI_VARIANT).macOS.bundleId

const SECRET = Buffer.alloc(32, 9).toString('base64')
const PAYLOAD_TEXT = JSON.stringify({ version: 1, atRestSecretKey: SECRET })
const KEY = deriveProtectorKey(SECRET)
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

/** A discovery-tool stand-in that records every call. */
function fakeTools(overrides: Partial<WorkBuddyDiscoveryTools> = {}): WorkBuddyDiscoveryTools & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    findApps: async () => [],
    bundleIdentifier: async () => CN_BUNDLE_ID,
    bundleVersion: async () => '5.6.2',
    ...overrides,
  }
}

/** Count how many times a tool was entered, without changing its behaviour. */
function counting<T extends (...args: never[]) => unknown>(fn: T, calls: string[], label: string): T {
  return ((...args: never[]) => {
    calls.push(label)
    return fn(...args)
  }) as T
}

let root: string
const cleanups: (() => Promise<void>)[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-electron-discovery-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
})

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

/** Create a real, executable file so `accessSync(X_OK)` succeeds. */
async function executableAt(...segments: string[]): Promise<string> {
  const path = join(root, ...segments)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '#!/bin/sh\n', { mode: 0o755 })
  return path
}

/** A `.app` bundle whose Electron is executable. */
async function fakeApp(name: string): Promise<{ bundlePath: string, electronPath: string }> {
  const bundlePath = join(root, name)
  const electronPath = join(bundlePath, 'Contents', 'MacOS', 'Electron')
  await mkdir(join(bundlePath, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(electronPath, '#!/bin/sh\n', { mode: 0o755 })
  return { bundlePath, electronPath }
}

describe('#48 explicit configuration is authoritative', () => {
  it('never falls back when an explicit option points at a missing binary', async () => {
    const tools = fakeTools()
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      // The default path exists and discovery would find an app: neither may
      // be consulted, because the caller named a binary and it is unusable.
      electronPath: '/nonexistent/workbuddy-electron',
      discovery: 'macos-workbuddy',
      defaultElectronPath: await executableAt('default-Electron'),
      tools,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/not available at \/nonexistent/)
    expect(tools.calls).toEqual([])
    expect(reasonCodeOf(new Error('x'))).toBeUndefined()
  })

  it('never falls back when WORKBUDDY_ELECTRON_BIN points at a missing binary', async () => {
    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, '/nonexistent/from-env')
    const tools = fakeTools()
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: await executableAt('default-Electron'),
      tools,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/not available at \/nonexistent\/from-env/)
    expect(tools.calls).toEqual([])
  })

  it('classifies an unusable explicit path as electron-path-invalid', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      electronPath: '/nonexistent/workbuddy-electron',
      discovery: 'macos-workbuddy',
      tools: fakeTools(),
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-path-invalid')
  })
})

describe('#48 discovery runs only after the default path fails', () => {
  it('does not call the discovery tools when the default path works', async () => {
    const tools = fakeTools()
    const defaultPath = await executableAt('default-Electron')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: defaultPath,
      tools,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await provider.protectorKeyFor([KEY_ID])
    // §3.0 low-intrusion: the ordinary installation pays no subprocess cost.
    expect(tools.calls).toEqual([])
  })

  it('falls back to discovery when the default path is missing', async () => {
    const app = await fakeApp('WorkBuddy.app')
    const calls: string[] = []
    const tools = fakeTools({
      findApps: counting(async () => [app.bundlePath], calls, 'mdfind'),
      bundleIdentifier: counting(async () => CN_BUNDLE_ID, calls, 'plutil-id'),
    })
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
    expect(calls).toContain('mdfind')
    expect(calls).toContain('plutil-id')
  })

  it('performs no discovery during construction (§3.0: the constructor is synchronous)', async () => {
    const tools = fakeTools()
    // Constructing must not spawn anything: discovery lives in the async
    // payload path, so a plugin load never pays for it.
    new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), discovery: 'macos-workbuddy', tools })
    expect(tools.calls).toEqual([])
  })
})

describe('#48 identity is proved before execution', () => {
  it('rejects a candidate whose bundle id is another product', async () => {
    const app = await fakeApp('NotWorkBuddy.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({
        findApps: async () => [app.bundlePath],
        bundleIdentifier: async () => 'com.example.something-else',
      }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-binary-not-found')
  })

  it('rejects a matching bundle whose Electron is not executable', async () => {
    const bundlePath = join(root, 'WorkBuddy.app')
    // Present but not executable: identity alone is not enough to execute it.
    await mkdir(join(bundlePath, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(join(bundlePath, 'Contents', 'MacOS', 'Electron'), '#!/bin/sh\n', { mode: 0o644 })
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [bundlePath] }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-binary-not-found')
  })
})

describe('#48 candidate counting', () => {
  it('uses the only candidate found', async () => {
    const app = await fakeApp('WorkBuddy.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [app.bundlePath] }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
  })

  it('reports not-found when the search completes with no candidate', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [] }),
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-binary-not-found')
  })

  it('refuses to choose between two distinct apps, and lists them', async () => {
    const first = await fakeApp('WorkBuddy.app')
    const second = await fakeApp('WorkBuddy 2.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [first.bundlePath, second.bundlePath] }),
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-binary-ambiguous')
    // The user has to know which two, or they cannot act on the message.
    expect((error as Error).message).toContain(first.bundlePath)
    expect((error as Error).message).toContain(second.bundlePath)
  })

  it('collapses path aliases of one app instead of calling it ambiguous', async () => {
    const app = await fakeApp('WorkBuddy.app')
    // Spotlight can list one bundle several times; the same real path twice
    // must not read as two installations.
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [app.bundlePath, app.bundlePath] }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
  })
})

describe('#48 an unfinished check is not an absent app', () => {
  it('reports incomplete when the search tool cannot run', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => { throw new Error('mdfind is unavailable') } }),
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-discovery-incomplete')
    // The wording must not claim the app is missing.
    expect((error as Error).message).toMatch(/did not finish|not proof/i)
  })

  it('reports incomplete when one candidate could not be identified', async () => {
    const good = await fakeApp('WorkBuddy.app')
    // The bundle exists — so it is *not* a deleted-app exclusion — but its
    // identity cannot be read. That is "we could not check this one", which
    // must not be silently dropped.
    const unreadable = await fakeApp('Broken.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({
        findApps: async () => [good.bundlePath, unreadable.bundlePath],
        // The plutil seam answers `undefined` for "could not read", which is
        // not the same as "this one is a different product".
        bundleIdentifier: async path => path === unreadable.bundlePath ? undefined : CN_BUNDLE_ID,
      }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    // One good candidate exists, but pretending it is the only one would be a
    // guess: the unfinished candidate may be a second copy.
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-discovery-incomplete')
  })

  it('still resolves the live app when a stale index row points at a deleted one', async () => {
    // Spotlight keeps rows for apps deleted since its last sweep. A row whose
    // bundle is gone is *decidable* — the app is not there — so it must be
    // excluded rather than left unresolved, or one dead row would sink the
    // live app standing next to it (issue #48 §3.7).
    const good = await fakeApp('WorkBuddy.app')
    const deleted = join(root, 'Deleted', 'WorkBuddy.app')
    const tools = fakeTools({
      findApps: async () => [deleted, good.bundlePath],
      // Reading plutil for the deleted row would mean we failed to notice it
      // was gone; throw so the regression is unambiguous.
      bundleIdentifier: async path => {
        if (path === deleted) throw new Error('plutil must not run for a deleted bundle')
        return CN_BUNDLE_ID
      },
    })
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    expect(await provider.protectorKeyFor([KEY_ID])).toBeInstanceOf(Buffer)
    expect(provider.helperPath()).toBe(good.electronPath)
  })

  it('never treats an uninspectable candidate as absent, even beside a usable app', async () => {
    // A candidate the process may not stat is *not* a deleted one. Reading
    // only ENOENT as "gone" is what keeps a live app from being chosen over a
    // candidate we merely could not inspect: `existsSync` answers `false` for
    // EACCES/EPERM too and would silently drop it, which is the bug this pins
    // (issue #48 review).
    //
    // The EACCES is real rather than mocked: mode 000 on the parent directory
    // blocks traversal into it, so stat on the bundle below fails even for its
    // owner. That keeps the test honest about the syscall's actual behaviour.
    const good = await fakeApp('WorkBuddy.app')
    const deniedParent = join(root, 'NoAccess')
    const unreadable = join(deniedParent, 'WorkBuddy.app')
    await mkdir(unreadable, { recursive: true })
    await chmod(deniedParent, 0o000)
    try {
      const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
        discovery: 'macos-workbuddy',
        defaultElectronPath: join(root, 'absent', 'Electron'),
        tools: fakeTools({
          findApps: async () => [good.bundlePath, unreadable],
          bundleIdentifier: async () => CN_BUNDLE_ID,
        }),
        spawnHelper: async () => PAYLOAD_TEXT,
      })
      const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
      // The usable app must NOT be selected: the other candidate might be a
      // second copy, so this is an unfinished check.
      expect(reasonCodeOf(error)).toBe('electron-discovery-incomplete')
    } finally {
      // Restore the mode so cleanup can remove the tree.
      await chmod(deniedParent, 0o755)
    }
  })

  it('gives up on the whole search once the discovery budget is spent', async () => {
    // A hang must not extend the wait forever: the shared budget covers the
    // search and every candidate check, and exhausting it is an unfinished
    // check rather than a missing app.
    const app = await fakeApp('WorkBuddy.app')
    const tools = fakeTools({
      findApps: async signal => {
        // Never resolves on its own; only the budget's abort ends it.
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return [app.bundlePath]
      },
    })
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools,
      discoveryBudgetMs: 30,
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-discovery-incomplete')
  })

  it('does not treat an unusable helper payload as a path failure', async () => {
    // The app was found and ran; "go look for the app" is not the fix, so the
    // code must not be one of the electron-binary-* ones.
    const app = await fakeApp('WorkBuddy.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [app.bundlePath] }),
      spawnHelper: async () => 'not a payload',
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('encrypted-credential-unreadable')
  })

  it('classifies a key-id mismatch as a decryption failure, not a path failure', async () => {
    const app = await fakeApp('WorkBuddy.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [app.bundlePath] }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    // An envelope sealed by a different install names a key we cannot derive.
    const error = await provider.protectorKeyFor(['ffffffffffffffff']).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('encrypted-credential-unreadable')
  })
})

describe('#48 discoverability is a per-variant setting', () => {
  it('never discovers, and never takes the CN default, for a none-discovery provider', async () => {
    const tools = fakeTools({ findApps: async () => { throw new Error('must not be called') } })
    const defaultPath = await executableAt('default-Electron')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'none',
      defaultElectronPath: defaultPath,
      tools,
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    // Global is isolated: no CN default, no Spotlight, and the failure says
    // "not configured" rather than "searched and not found".
    expect(reasonCodeOf(error)).toBe('electron-binary-unavailable')
    expect(tools.calls).toEqual([])
    expect(provider.helperPath()).toBeUndefined()
  })

  it('still honours an explicit env path for a none-discovery provider', async () => {
    const binary = await executableAt('user-supplied-Electron')
    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, binary)
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'none',
      tools: fakeTools({ findApps: async () => { throw new Error('must not be called') } }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    // The env var is a deliberate user choice, so it stays available even
    // where the plugin will not search on its own.
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
  })
})

describe('#48 a failed discovery is retried, a successful one is cached', () => {
  it('re-runs discovery on the next attempt after a failure', async () => {
    let found = false
    const app = await fakeApp('WorkBuddy.app')
    const calls: string[] = []
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({
        findApps: async () => {
          calls.push('findApps')
          return found ? [app.bundlePath] : []
        },
      }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    const first = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(first)).toBe('electron-binary-not-found')
    // The app appears (installed, or moved into an indexed place) without a
    // DSH restart.
    found = true
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
    expect(calls.filter(call => call === 'findApps')).toHaveLength(2)
  })

  it('re-checks a cached discovery path and re-discovers when it went away', async () => {
    const app = await fakeApp('WorkBuddy.app')
    let searches = 0
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({
        findApps: async () => { searches += 1; return [app.bundlePath] },
      }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await provider.protectorKeyFor([KEY_ID])
    expect(searches).toBe(1)
    // The app is moved away, and an envelope naming a key this process has not
    // resolved forces the helper path again (a cached key would short-circuit
    // before resolution, which is its own, correct, behaviour).
    await rm(join(app.bundlePath, 'Contents', 'MacOS', 'Electron'), { force: true })
    const second = await provider.protectorKeyFor(['0123456789abcdef']).catch((caught: unknown) => caught)
    expect(reasonCodeOf(second)).toBe('electron-binary-not-found')
    expect(searches).toBe(2)
  })
})

describe('#48 discovery failures reach the status document as reasonCode', () => {
  it('carries electron-binary-not-found through store.status()', async () => {
    const store = new WorkBuddyCredentialStore({
      variant: CN_VARIANT,
      desktopPath: join(root, 'workbuddy-desktop.info'),
      ownPath: join(root, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
      keyProvider: new WorkBuddyAtRestKeyProvider({
        product: electronProfileFor(CN_VARIANT),
        discovery: 'macos-workbuddy',
        defaultElectronPath: join(root, 'absent', 'Electron'),
        tools: fakeTools({ findApps: async () => [] }),
      }),
    })
    await writeFile(join(root, 'workbuddy-desktop.info'), encryptedEnvelopeFixture())
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    expect(status.reasonCode).toBe('electron-binary-not-found')
  })

  it('carries electron-binary-unavailable for the international variant', async () => {
    const store = new WorkBuddyCredentialStore({
      variant: AI_VARIANT,
      desktopPath: join(root, 'workbuddy-desktop-ai.info'),
      ownPath: join(root, 'own-ai.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
      keyProvider: new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT), discovery: 'none' }),
    })
    await writeFile(join(root, 'workbuddy-desktop-ai.info'), encryptedEnvelopeFixture())
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    // Not `not-found`: nothing was searched, and claiming otherwise would send
    // the user looking for a problem that does not exist.
    expect(status.reasonCode).toBe('electron-binary-unavailable')
  })

  it('reports no-credential when there is simply no sign-in', async () => {
    const store = new WorkBuddyCredentialStore({
      variant: CN_VARIANT,
      desktopPath: join(root, 'missing.info'),
      ownPath: join(root, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    expect(await store.status()).toEqual({ state: 'signed-out', reasonCode: 'no-credential' })
  })
})

describe('#59/#60 the international app on macOS', () => {
  function aiTools(overrides: Partial<WorkBuddyDiscoveryTools> = {}): WorkBuddyDiscoveryTools {
    return fakeTools({
      bundleIdentifier: async () => AI_BUNDLE_ID,
      ...overrides,
    })
  }

  it('uses its own default path, distinct from the CN one', async () => {
    // Both default paths exist side by side (this machine's real layout); the
    // AI provider must resolve the AI default without any discovery at all.
    const cnDefault = await fakeApp('WorkBuddy.app')
    const aiDefault = await fakeApp('WorkBuddy AI.app')
    const ai = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: aiDefault.electronPath,
      tools: aiTools({ findApps: async () => { throw new Error('must not be called') } }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(ai.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
    expect(ai.helperPath()).toBe(aiDefault.electronPath)
    expect(ai.helperPath()).not.toBe(cnDefault.electronPath)
  })

  it('runs its own binary beside an installed CN app, with different keys per app', async () => {
    // Distinct payloads per binary keep an accidental CN spawn from being
    // masked by the identical at-rest key both apps currently share.
    const aiSecret = Buffer.alloc(32, 3).toString('base64')
    const aiKey = deriveProtectorKey(aiSecret)
    const aiKeyId = createHash('sha256').update(aiKey).digest('hex').slice(0, 16)
    const ai = await fakeApp('WorkBuddy AI.app')
    const cn = await fakeApp('WorkBuddy.app')
    const spawn = async (path: string): Promise<string> =>
      JSON.stringify({ version: 1, atRestSecretKey: path === ai.electronPath ? aiSecret : SECRET })
    const aiProvider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      // The identity seam answers per bundle: the AI app carries the AI id and
      // the CN app beside it the CN id — only the first is this product's.
      tools: aiTools({
        findApps: async () => [ai.bundlePath, cn.bundlePath],
        bundleIdentifier: async path => path === ai.bundlePath ? AI_BUNDLE_ID : CN_BUNDLE_ID,
      }),
      spawnHelper: spawn,
    })
    await expect(aiProvider.protectorKeyFor([aiKeyId])).resolves.toEqual(aiKey)
    expect(aiProvider.helperPath()).toBe(ai.electronPath)
    const cnProvider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({
        findApps: async () => [ai.bundlePath, cn.bundlePath],
        bundleIdentifier: async path => path === ai.bundlePath ? AI_BUNDLE_ID : CN_BUNDLE_ID,
      }),
      spawnHelper: spawn,
    })
    await expect(cnProvider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
    expect(cnProvider.helperPath()).toBe(cn.electronPath)
  })

  it('rejects the CN bundle when searching for the AI app', async () => {
    const cn = await fakeApp('WorkBuddy.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      // The identity seam answers for whatever bundle it is handed; a CN id
      // beside an AI search is a decidable non-match, never a candidate.
      tools: aiTools({ findApps: async () => [cn.bundlePath], bundleIdentifier: async () => CN_BUNDLE_ID }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-binary-not-found')
  })

  it('points its diagnostics at the AI variable', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: aiTools({ findApps: async () => [] }),
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect((error as Error).message).toContain('WorkBuddy AI')
    expect((error as Error).message).toContain('WORKBUDDY_AI_ELECTRON_BIN')
    expect((error as Error).message).not.toContain('WORKBUDDY_ELECTRON_BIN')
  })
})

describe('#59/#60 the shared construction helper both entries use', () => {
  it('gives each variant its product default and never the other one', () => {
    const cn = atRestKeyProviderFor(CN_VARIANT)
    const ai = atRestKeyProviderFor(AI_VARIANT)
    if (process.platform === 'darwin') {
      expect(cn.helperPath()).toBe(electronProfileFor(CN_VARIANT).macOS.defaultPath)
      expect(ai.helperPath()).toBe(electronProfileFor(AI_VARIANT).macOS.defaultPath)
      expect(cn.helperPath()).not.toBe(ai.helperPath())
      return
    }
    if (process.platform === 'win32') {
      // A default is a location to try, not a file that must exist, so a
      // normal Windows environment answers with the CN install path.
      const localAppData = process.env.LOCALAPPDATA?.trim()
      if (localAppData === undefined || localAppData === '') {
        expect(cn.helperPath()).toBeUndefined()
      } else {
        expect(cn.helperPath()).toBe(join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'))
      }
      // The international app has no verified Windows default at all.
      expect(ai.helperPath()).toBeUndefined()
      return
    }
    // Platforms without a verified layout answer "not configured yet" for both.
    expect(cn.helperPath()).toBeUndefined()
    expect(ai.helperPath()).toBeUndefined()
  })
})

/** A minimal 5.6-style encrypted document; the key is never reachable here. */
function encryptedEnvelopeFixture(): string {
  return JSON.stringify({
    auth: {
      accessToken: {
        $wbEncrypted: 1,
        envelope: Buffer.from(JSON.stringify({
          suite: 1,
          keyId: KEY_ID,
          nonce: Buffer.alloc(12, 1).toString('base64'),
          authTag: Buffer.alloc(16, 2).toString('base64'),
          ciphertext: Buffer.alloc(24, 3).toString('base64'),
        }), 'utf8').toString('base64'),
      },
      refreshToken: 'refresh-token-value',
      uid: 'uid-1',
      domain: 'www.workbuddy.cn',
    },
  })
}
