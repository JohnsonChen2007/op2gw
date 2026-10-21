import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyAtRestKeyProvider,
  WORKBUDDY_ELECTRON_BIN_ENV,
  buildAuthenticatedContextAad,
  classifyDesktopAuthDocument,
  deriveProtectorKey,
  keyIdsOf,
  openAuthField,
  parseAtRestPayload,
  sealAuthFieldForTest,
  unwrapDesktopAuthDocument,
} from '../src/desktop-credential-protection.ts'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { AI_VARIANT, CN_VARIANT, electronProfileFor, type WorkBuddyVariant } from '../src/variants.ts'

/**
 * Issue #39/#40: WorkBuddy 5.6 seals the desktop auth file's token fields in
 * at-rest envelopes. Every fixture here is synthetic — a fixed test secret, a
 * test-derived protector key, fake tokens — so nothing real is ever committed
 * or printed. The AAD builder is additionally pinned against a verbatim
 * transcription of `docs/r3-final.js` (the reference verified live against
 * 5.6.2), because a silent AAD change is undetectable except by decryption
 * failures in the field.
 */

const SECRET = Buffer.alloc(32, 7).toString('base64')
const PAYLOAD_TEXT = JSON.stringify({ version: 1, atRestSecretKey: SECRET })
const KEY = deriveProtectorKey(SECRET)
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

/** Verbatim transcription of the reference AAD builder from r3-final.js. */
function referenceAad(keyId: string, context: { framing: 'file' | 'field', suite: number }): Buffer {
  const PREFIX = Buffer.from('WB-AAD\0', 'ascii')
  const FRAMING_NAME = { file: 'WBEF1', field: 'WBEV1' }
  const FRAMING_TAG = { file: 1, field: 2 }
  const u32 = (n: number): Buffer => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b }
  const lp = (s: string): Buffer => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]) }
  return Buffer.concat([
    PREFIX, Buffer.from([1]),
    lp(FRAMING_NAME[context.framing]),
    lp('sym-v1'),
    u32(context.suite),
    lp(keyId),
    Buffer.from([FRAMING_TAG[context.framing]]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/**
 * Seal a field under the reference `file` framing. Production must REJECT
 * this — 5.6.x credential fields are `field`-framed only, and accepting other
 * framings would be guessing at formats the plugin has never seen.
 */
function sealWithFileFraming(key: Buffer, plaintext: string): { '$wbEncrypted': 1, envelope: string } {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = Buffer.alloc(12, 3)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(referenceAad(keyId, { framing: 'file', suite: 1 }))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/** A full 5.6-shaped desktop document with both token fields sealed. */
function encryptedDocument(key: Buffer = KEY, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth: {
      accessToken: sealAuthFieldForTest(key, 'test-access-token'),
      refreshToken: sealAuthFieldForTest(key, 'test-refresh-token'),
      expiresAt: 1900000000,
      domain: 'www.workbuddy.ai',
      ...overrides,
    },
    account: { uid: 'uid-9', nickname: 'Tester', enterpriseId: 'ent-3' },
  })
}

describe('desktop auth classification', () => {
  it('reads the four formats apart', () => {
    expect(classifyDesktopAuthDocument('')).toEqual({ format: 'absent' })
    expect(classifyDesktopAuthDocument('   \n')).toEqual({ format: 'absent' })
    expect(classifyDesktopAuthDocument('not json')).toEqual({ format: 'unrecognized' })
    expect(classifyDesktopAuthDocument('[1,2]')).toEqual({ format: 'unrecognized' })
    expect(classifyDesktopAuthDocument('{"auth":{"accessToken":"at","refreshToken":"rt"}}'))
      .toEqual({ format: 'plaintext' })
    const encrypted = classifyDesktopAuthDocument(encryptedDocument())
    expect(encrypted.format).toBe('encrypted')
    if (encrypted.format === 'encrypted') {
      expect(keyIdsOf(encrypted.wrapped.fields)).toEqual([KEY_ID])
      expect(encrypted.wrapped.fields.map(field => field.field).sort())
        .toEqual(['accessToken', 'refreshToken'])
    }
  })

  it('treats a wrapper whose envelope will not decode as unrecognized, not encrypted', () => {
    const broken = JSON.stringify({
      auth: { accessToken: { '$wbEncrypted': 1, envelope: '%%%not-base64%%%' } },
    })
    expect(classifyDesktopAuthDocument(broken).format).toBe('unrecognized')
    const truncated = JSON.stringify({
      auth: { refreshToken: { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify({ suite: 1, keyId: KEY_ID, nonce: 'AAAA' }), 'utf8').toString('base64') } },
    })
    expect(classifyDesktopAuthDocument(truncated).format).toBe('unrecognized')
  })

  it('accepts the flat panel shape and a mixed plaintext/encrypted document', () => {
    const flat = JSON.stringify({
      accessToken: sealAuthFieldForTest(KEY, 'test-access-token'),
      refreshToken: 'plaintext-refresh',
    })
    const classified = classifyDesktopAuthDocument(flat)
    expect(classified.format).toBe('encrypted')
    if (classified.format === 'encrypted') {
      expect(classified.wrapped.fields.map(field => field.field)).toEqual(['accessToken'])
    }
  })
})

describe('field decryption', () => {
  it('builds the exact AAD the verified reference script builds for credential fields', () => {
    // `field` framing is the only one 5.6.2 writes for credential fields; the
    // reference builder's other framings belong to other document kinds and
    // are deliberately not produced here.
    expect(buildAuthenticatedContextAad('9127dea1b44020a7', 1))
      .toEqual(referenceAad('9127dea1b44020a7', { framing: 'field', suite: 1 }))
  })

  it('round-trips a sealed field and rejects wrong keys or tampered tags', () => {
    const sealed = sealAuthFieldForTest(KEY, 'round-trip')
    const classified = classifyDesktopAuthDocument(JSON.stringify({ auth: { accessToken: sealed } }))
    if (classified.format !== 'encrypted') throw new Error('fixture misclassified')
    const wrapped = classified.wrapped.fields[0]!
    expect(openAuthField(KEY, wrapped.envelope)).toBe('round-trip')
    const otherKey = Buffer.alloc(32, 9)
    expect(openAuthField(otherKey, wrapped.envelope)).toBeUndefined()
    const tampered = { ...wrapped.envelope, authTag: Buffer.from(wrapped.envelope.authTag) }
    tampered.authTag[0] = (tampered.authTag[0] ?? 0) ^ 0xff
    expect(openAuthField(KEY, tampered)).toBeUndefined()
  })

  it('rejects an envelope sealed under the file framing instead of guessing', () => {
    // Production accepts exactly what 5.6.2 writes (field framing); the
    // file-framed envelope of the same family must fail to open.
    const sealed = sealWithFileFraming(KEY, 'file-framed')
    const classified = classifyDesktopAuthDocument(JSON.stringify({ auth: { refreshToken: sealed } }))
    if (classified.format !== 'encrypted') throw new Error('fixture misclassified')
    expect(openAuthField(KEY, classified.wrapped.fields[0]!.envelope)).toBeUndefined()
  })

  it('classifies a wrapper with an unsupported suite as unrecognized, not encrypted', () => {
    // Suite 1 is the only defined scheme; a future suite must read as a
    // diagnosis, never as an openable envelope.
    const keyId = createHash('sha256').update(KEY).digest('hex').slice(0, 16)
    const inner = JSON.stringify({ suite: 2, keyId, nonce: Buffer.alloc(12, 1).toString('base64'), authTag: Buffer.alloc(16, 1).toString('base64'), ciphertext: Buffer.alloc(8, 1).toString('base64') })
    const document = JSON.stringify({ auth: { accessToken: { '$wbEncrypted': 1, envelope: Buffer.from(inner, 'utf8').toString('base64') } } })
    expect(classifyDesktopAuthDocument(document).format).toBe('unrecognized')
  })

  it('rebuilt plaintext keeps identity and expiry fields and drops the wrappers', () => {
    const classified = classifyDesktopAuthDocument(encryptedDocument())
    if (classified.format !== 'encrypted') throw new Error('fixture misclassified')
    const text = unwrapDesktopAuthDocument(classified, field => `opened-${field.field}`)
    const parsed = JSON.parse(text) as { auth: Record<string, unknown> }
    expect(parsed.auth['accessToken']).toBe('opened-accessToken')
    expect(parsed.auth['refreshToken']).toBe('opened-refreshToken')
    expect(parsed.auth['expiresAt']).toBe(1900000000)
    expect(parsed.auth['domain']).toBe('www.workbuddy.ai')
    expect((parsed.auth['accessToken'] as { $wbEncrypted?: number }).$wbEncrypted).toBeUndefined()
  })
})

describe('at-rest payload validation', () => {
  it('accepts the 5.6 payload shape', () => {
    expect(parseAtRestPayload(PAYLOAD_TEXT)).toEqual({ atRestSecretKey: SECRET })
  })
  it('rejects unparsable, wrong-version, non-canonical, wrong-size, and all-zero secrets', () => {
    expect(parseAtRestPayload('garbage')).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: SECRET }))).toBeUndefined()
    // "short" decodes fine but re-encodes differently: not canonical base64.
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: 'short' }))).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(31, 1).toString('base64') }))).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32, 0).toString('base64') }))).toBeUndefined()
  })
})

describe('at-rest key provider', () => {
  it('caches one source resolution per key id', async () => {
    let calls = 0
    const provider = new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), source: async () => { calls += 1; return PAYLOAD_TEXT } })
    expect(await provider.protectorKeyFor([KEY_ID])).toEqual(KEY)
    expect(await provider.protectorKeyFor([KEY_ID])).toBe(await provider.protectorKeyFor([KEY_ID]))
    expect(calls).toBe(1)
  })

  it('shares one in-flight resolution between concurrent callers', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      source: async () => { calls += 1; await gate; return PAYLOAD_TEXT },
    })
    const first = provider.protectorKeyFor([KEY_ID])
    const second = provider.protectorKeyFor([KEY_ID])
    release()
    const [a, b] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(a).toBe(b)
  })

  it('re-resolves once when an envelope names a different key id', async () => {
    const otherSecret = Buffer.alloc(32, 11).toString('base64')
    const otherPayload = JSON.stringify({ version: 1, atRestSecretKey: otherSecret })
    const otherKey = deriveProtectorKey(otherSecret)
    const otherId = createHash('sha256').update(otherKey).digest('hex').slice(0, 16)
    const answers = [PAYLOAD_TEXT, otherPayload, PAYLOAD_TEXT]
    let calls = 0
    const provider = new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), source: async () => { calls += 1; return answers[calls - 1] ?? '' } })
    expect(await provider.protectorKeyFor([KEY_ID])).toEqual(KEY)
    expect(await provider.protectorKeyFor([otherId])).toEqual(otherKey)
    // The rotated key is now cached: the old id forces the third resolution.
    expect(await provider.protectorKeyFor([KEY_ID])).toEqual(KEY)
    expect(calls).toBe(3)
  })

  it('refuses envelopes sealed by a different installation', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), source: async () => PAYLOAD_TEXT })
    await expect(provider.protectorKeyFor(['ffffffffffffffff']))
      .rejects.toThrow(/does not match/)
  })

  it('reports an unusable payload without echoing its content', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), source: async () => 'not-json-at-all' })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/unusable at-rest payload/)
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.not.toThrow(/not-json/)
  })

  it('fails safely when the spawned binary lacks the WorkBuddy binding', async () => {
    // The default spawn path against a plain Node binary: the private
    // `workbuddyStorage` binding does not exist there, so the helper exits
    // non-zero and the error carries a reason — never payload content.
    const provider = new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), electronPath: process.execPath })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/WorkBuddy key helper/)
  })

  it('fails safely when the configured binary is missing', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), electronPath: '/nonexistent/workbuddy-electron' })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/not available at \/nonexistent\/workbuddy-electron/)
  })

  it('resolves the helper path from env, then the platform default', () => {
    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, '/opt/wb-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBe('/opt/wb-electron')
    // Blank env falls through to the platform default, but only for a provider
    // that was actually configured to look for the app (issue #48 §3.3): the
    // no-arg default is 'none' so a provider that was never told which product
    // it serves cannot reach for another product's binary.
    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, '   ')
    const cn = new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), discovery: 'macos-workbuddy' })
    if (process.platform === 'darwin') {
      expect(cn.helperPath()).toBe('/Applications/WorkBuddy.app/Contents/MacOS/Electron')
    } else {
      expect(cn.helperPath()).toBeUndefined()
    }
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBeUndefined()
  })

  it('keeps externally assembled variants source-compatible (public type)', () => {
    // `WorkBuddyVariant` is exported: callers have been building their own
    // descriptors since before the electron profile existed. Such a variant
    // must keep working — resolution falls back by variant id, and a custom
    // id lands on the CN profile, the store's other legacy default.
    const legacyAi = { id: AI_VARIANT.id } as unknown as WorkBuddyVariant
    const legacyCustom = { id: 'workbuddy-custom' } as unknown as WorkBuddyVariant
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(legacyAi) }).helperPath())
      .toBe(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath())
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(legacyCustom) }).helperPath())
      .toBe(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath())
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(undefined) }).helperPath())
      .toBe(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath())
  })

  it('separates the env variables per product (issue #60)', () => {
    // Only the AI variable set: the AI provider takes it, the CN provider does
    // not see it at all (its own variable is unset, so no explicit path).
    vi.stubEnv(electronProfileFor(AI_VARIANT).envVar, '/opt/ai-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath()).toBe('/opt/ai-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBeUndefined()
    // Only the CN variable set: mirrored.
    vi.unstubAllEnvs()
    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, '/opt/cn-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBe('/opt/cn-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath()).toBeUndefined()
    // A blank value reads as unset for the AI product, and the CN value must
    // not leak through to it.
    vi.stubEnv(electronProfileFor(AI_VARIANT).envVar, '')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath()).toBeUndefined()
  })
})

describe('credential store with an encrypted desktop file', () => {
  let root: string
  const cleanups: (() => Promise<void>)[] = []
  const stubKeyProvider = (key: Buffer | Error) => ({
    protectorKeyFor: async () => { if (key instanceof Error) throw key; return key },
    helperPath: () => '(stub)',
  })

  const makeStore = (desktopPath: string, keyProvider?: ReturnType<typeof stubKeyProvider>): WorkBuddyCredentialStore =>
    new WorkBuddyCredentialStore({
      desktopPath,
      ownPath: join(root, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
      ...(keyProvider === undefined ? {} : { keyProvider }),
    })

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(clean => clean()))
    vi.unstubAllEnvs()
  })

  it('decrypts the desktop credential, keeping identity and expiry', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-encrypted-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const desktopPath = join(root, 'workbuddy-desktop.info')
    await writeFile(desktopPath, encryptedDocument())
    const store = makeStore(desktopPath, stubKeyProvider(KEY))
    const credential = await store.current()
    expect(credential).toMatchObject({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      uid: 'uid-9',
      nickname: 'Tester',
      enterpriseId: 'ent-3',
      domain: 'www.workbuddy.ai',
      source: 'desktop',
    })
    expect(credential?.expiresAtMs).toBe(1900000000 * 1000)
  })

  it('reports a decryption failure as a diagnosis, never as a silent sign-out or a stale fallback', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-encrypted-fail-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const desktopPath = join(root, 'workbuddy-desktop.info')
    await writeFile(desktopPath, encryptedDocument())
    // A stale plugin-owned copy from the previous account: decryption failure
    // must NOT fall back to it.
    await writeFile(join(root, 'own.json'), JSON.stringify({
      version: 1,
      credential: {
        accessToken: 'stale-access', refreshToken: 'stale-refresh',
        expiresAtMs: Date.now() + 3_600_000, domain: 'www.workbuddy.ai',
        uid: 'uid-old', source: 'dsh',
      },
    }))
    const store = makeStore(desktopPath, stubKeyProvider(new Error('the WorkBuddy key helper exited with code 1')))
    await expect(store.current()).rejects.toThrow(/key helper exited with code 1/)
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    expect(status.reason).toContain('key helper exited with code 1')
    await expect(store.resolve()).rejects.toThrow(/key helper/)
  })

  it('reports a key mismatch between envelope and app as its own diagnosis', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-encrypted-mismatch-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const desktopPath = join(root, 'workbuddy-desktop.info')
    await writeFile(desktopPath, encryptedDocument(Buffer.alloc(32, 5)))
    // Envelopes sealed under a key the provider cannot answer (different
    // installation): the open fails with the envelope's key id named.
    const wrongKey = Buffer.alloc(32, 6)
    const store = makeStore(desktopPath, stubKeyProvider(wrongKey))
    await expect(store.current()).rejects.toThrow(/could not be decrypted/)
  })

  it('never falls back to a valid stale own copy when the desktop file is unreadable', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-unrecognized-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const ownDocument = JSON.stringify({
      version: 1,
      credential: {
        accessToken: 'fresh-own-access', refreshToken: 'fresh-own-refresh',
        expiresAtMs: Date.now() + 3_600_000, domain: 'www.workbuddy.ai',
        uid: 'uid-current', nickname: 'Current', source: 'dsh',
      },
    })
    // Case 1: a malformed (unparsable) desktop document.
    const malformedPath = join(root, 'malformed.info')
    await writeFile(malformedPath, '{ not json at all')
    await writeFile(join(root, 'own.json'), ownDocument)
    const malformedStore = makeStore(malformedPath, stubKeyProvider(KEY))
    await expect(malformedStore.current()).rejects.toThrow(/exists but is unreadable/)
    const malformedStatus = await malformedStore.status()
    expect(malformedStatus.state).toBe('signed-out')
    expect(malformedStatus.reason).toContain('exists but is unreadable')

    // Case 2: a 5.6-style encrypted document with an unsupported suite —
    // claimed by the wrapper format but not a format this plugin accepts.
    const keyId = createHash('sha256').update(KEY).digest('hex').slice(0, 16)
    const unsupported = JSON.stringify({
      auth: { accessToken: { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify({ suite: 2, keyId, nonce: Buffer.alloc(12, 1).toString('base64'), authTag: Buffer.alloc(16, 1).toString('base64'), ciphertext: Buffer.alloc(8, 1).toString('base64') }), 'utf8').toString('base64') } },
      account: { uid: 'uid-9' },
    })
    const unsupportedPath = join(root, 'unsupported.info')
    await writeFile(unsupportedPath, unsupported)
    await writeFile(join(root, 'own.json'), ownDocument)
    const unsupportedStore = makeStore(unsupportedPath, stubKeyProvider(KEY))
    await expect(unsupportedStore.current()).rejects.toThrow(/exists but is unreadable/)
    // The stale own credential must never surface through any read path.
    await expect(unsupportedStore.resolve()).rejects.toThrow(/exists but is unreadable/)
  })

  it('lets the desktop file keep identity authority over a newer own copy', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-encrypted-identity-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const desktopPath = join(root, 'workbuddy-desktop.info')
    await writeFile(desktopPath, encryptedDocument())
    await writeFile(join(root, 'own.json'), JSON.stringify({
      version: 1,
      credential: {
        // Same uid as the desktop file, later expiry (the sealed fixture
        // expires in 2030): expiry would win, and that is unchanged by
        // encryption.
        accessToken: 'own-access', refreshToken: 'own-refresh',
        expiresAtMs: 4102444800000, domain: 'www.workbuddy.ai',
        uid: 'uid-9', enterpriseId: 'ent-3', nickname: 'Tester', source: 'dsh',
      },
    }))
    const store = makeStore(desktopPath, stubKeyProvider(KEY))
    expect((await store.current())?.source).toBe('dsh')
    // A different uid in the own copy: the desktop file wins regardless of
    // timestamps — encryption changes nothing here either.
    const switched = JSON.parse(await readFile(join(root, 'own.json'), 'utf8')) as { credential: { uid: string } }
    switched.credential.uid = 'uid-old'
    await writeFile(join(root, 'own.json'), JSON.stringify(switched))
    expect((await store.current())?.source).toBe('desktop')
  })
})
