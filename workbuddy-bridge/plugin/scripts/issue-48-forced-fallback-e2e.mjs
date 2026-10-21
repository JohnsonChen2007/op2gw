/**
 * §9.2-A forced-fallback end-to-end check (issue #48).
 *
 * What this proves, and what it does not:
 *
 * - It runs the REAL discovery chain — real `/usr/bin/mdfind`, real
 *   `/usr/bin/plutil`, real `accessSync`, real helper spawn — by forcing only
 *   the *default path* to fail, which is the branch a user hits when the app
 *   is somewhere other than `/Applications/WorkBuddy.app`. Nothing else is
 *   faked, so a green run exercises the code the reporter's case will hit.
 * - It does NOT prove the non-standard-install case itself: this machine's app
 *   is at the standard location, and the path that discovery finds is that
 *   same app. The reporter's regression on a real `/Applications/IDE/...`
 *   install remains the closure for that scenario (plan §9.3).
 *
 * Run: node scripts/issue-48-forced-fallback-e2e.mjs
 */
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const {
  WorkBuddyAtRestKeyProvider,
  defaultWorkBuddyElectronPath,
  reasonCodeOf,
} = await import('../src/desktop-credential-protection.ts')
const { WorkBuddyCredentialStore } = await import('../src/auth.ts')
const { CN_VARIANT } = await import('../src/variants.ts')

const AUTH_FILE = join(
  homedir(),
  'Library', 'Application Support',
  'CodeBuddyExtension', 'Data', 'Public', 'auth',
  'workbuddy-desktop.info',
)

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log('=== #48 §9.2-A forced-fallback end-to-end ===\n')

// 1. The real default path exists on this machine, so the ordinary flow never
//    reaches discovery. Confirm that premise before forcing the fallback.
const realDefault = defaultWorkBuddyElectronPath()
let defaultExists = false
try {
  accessSync(realDefault, constants.X_OK)
  defaultExists = true
} catch { /* absent */ }
record('premise: the real default path exists (so discovery is otherwise unreachable)', defaultExists, realDefault)

// 2. Read the real credential's envelope key ids, so the helper is asked for a
//    key that can actually be produced.
const document = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
const auth = document.auth ?? document
const envelopeKeyId = JSON.parse(
  Buffer.from(auth.accessToken.envelope, 'base64').toString('utf8'),
).keyId
record('premise: a real encrypted CN credential is present', typeof envelopeKeyId === 'string', `envelope keyId ${envelopeKeyId}`)

// 3. Every discovery step, with a default path that cannot exist. This is the
//    only thing forced: mdfind, plutil, X_OK and the helper are all real.
const realToolCalls = []
const provider = new WorkBuddyAtRestKeyProvider({
  discovery: 'macos-workbuddy',
  defaultElectronPath: join('/nonexistent-for-e2e', 'WorkBuddy.app', 'Contents', 'MacOS', 'Electron'),
})

let key = null
let discoveryError = null
try {
  key = await provider.protectorKeyFor([envelopeKeyId])
} catch (error) {
  discoveryError = error
}

if (key !== null) {
  const derivedId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  record('discovery reached a binary, spawned the helper, and returned a key', true, `derived keyId ${derivedId}`)
  record('the returned key matches the real credential envelope', derivedId === envelopeKeyId,
    derivedId === envelopeKeyId ? 'key id matches' : `derived ${derivedId} vs envelope ${envelopeKeyId}`)
  // Asserting `!== realDefault` alone would pass for the wrong reason: the
  // default was forced to a nonexistent path, so anything differs from it. Pin
  // the *actual* binary instead — it must be the real app found by Spotlight,
  // proving the executable path came from discovery.
  const used = provider.helperPath()
  record('the binary actually used is the Spotlight-discovered real app',
    used === realDefault,
    `helperPath after discovery: ${used ?? '(none)'} (expected the discovered ${realDefault})`)
} else {
  record('discovery reached a binary, spawned the helper, and returned a key', false,
    `${reasonCodeOf(discoveryError) ?? 'unknown'}: ${discoveryError?.message ?? String(discoveryError)}`)
}

// 4. The same chain through the store, which is what the card and doctor read.
try {
  const store = new WorkBuddyCredentialStore({
    variant: CN_VARIANT,
    desktopPath: AUTH_FILE,
    ownPath: join(homedir(), '.dsh', '.workbuddy-e2e-check.json'),
    refresh: async credential => ({ accessToken: credential.accessToken }),
    keyProvider: new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join('/nonexistent-for-e2e', 'WorkBuddy.app', 'Contents', 'MacOS', 'Electron'),
    }),
  })
  const status = await store.status()
  record('store.status() reports signed-in through the discovered binary',
    status.state === 'signed-in',
    status.state === 'signed-in' ? `account ${status.nickname ?? '(no nickname)'}` : `signed-out: ${status.reasonCode ?? '(no code)'}`)
} catch (error) {
  record('store.status() reports signed-in through the discovered binary', false, String(error))
}

// 5. Low-intrusion reverse assertion: with the real default present, the
//    ordinary provider must not touch discovery at all.
const ordinary = new WorkBuddyAtRestKeyProvider({ discovery: 'macos-workbuddy' })
record('with the real default present, the resolved helper path is the default',
  ordinary.helperPath() === realDefault, ordinary.helperPath() ?? '(none)')

console.log(`\n=== ${results.filter(r => r.ok).length}/${results.length} checks passed ===`)
if (results.some(r => !r.ok)) process.exitCode = 1
