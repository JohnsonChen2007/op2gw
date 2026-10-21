/**
 * WorkBuddy credential resolution. The primary source is the WorkBuddy
 * desktop app's own auth file, read-only; a plugin-owned copy under
 * `$DSH_HOME` holds token refreshes so the desktop file is never written.
 * The effective credential is whichever of the two expires later, so a
 * refresh by either side wins.
 *
 * @module dsh-workbuddy-connect/auth
 */

import { readFile, rm } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { regionOf } from './upstream.ts'
import {
  WorkBuddyAtRestKeyProvider,
  WorkBuddyElectronPathError,
  classifyDesktopAuthDocument,
  keyIdsOf,
  openAuthField,
  reasonCodeOf,
  unwrapDesktopAuthDocument,
} from './desktop-credential-protection.ts'
import type { DesktopAuthClassification, DesktopAuthFormat } from './desktop-credential-protection.ts'
import type { WorkBuddySignedOutReasonCode } from './status-paths.ts'
import { CN_VARIANT, electronProfileFor, type WorkBuddyVariant } from './variants.ts'
import type { WorkBuddyRefreshOutcome } from './upstream.ts'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh'
}

/** Read-only sign-in summary for status and doctor output. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  source?: 'desktop' | 'dsh'
  /**
   * Why no credential is usable, when the reason is diagnosable rather than
   * "nobody is signed in" — a region mismatch being the case that matters.
   * Present only on `signed-out`, and never a substitute for fixing the file.
   */
  reason?: string
  /**
   * Machine-readable companion to {@link reason}, for callers that must branch
   * on the cause. Never derived by matching `reason` text.
   */
  reasonCode?: WorkBuddySignedOutReasonCode
}

/** Constructor options; only {@link refresh} is required. */
export interface WorkBuddyStoreOptions {
  variant?: WorkBuddyVariant
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
  /**
   * Resolver for WorkBuddy 5.6's at-rest protector key, needed when the
   * desktop file stores encrypted token fields. Defaults to the real
   * provider, which spawns the WorkBuddy Electron binary; tests stand in a
   * stub. Structural so a store never depends on how the key is reached.
   */
  keyProvider?: Pick<WorkBuddyAtRestKeyProvider, 'protectorKeyFor' | 'helperPath'>
}

/** Basename of the plugin-owned credential copy inside the Harness home. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  credential: WorkBuddyCredential
}

/** Plugin-owned copy path inside the Harness home. */
export function workbuddyOwnAuthPath(): string {
  return join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME)
}

const DESKTOP_AUTH_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'] as const

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE'])
    ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA'])
    ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA'])
    ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
    join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
  ]
}

/**
 * Platform-default candidates for the WorkBuddy desktop app's auth file, in
 * probe order. Windows probes both AppData roots: current builds write under
 * `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). Linux
 * probes both XDG bases — most distributions write under the config home,
 * but UOS/deepin builds write under the data home (issue #43), and probing
 * only one silently reads a signed-in app as signed out. WSL probes those
 * same Windows locations through its mounted Windows profile before the
 * native Linux locations.
 */
export function defaultDesktopAuthCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
      join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    ]
  }
  if (process.platform === 'linux') {
    // An XDG override is adopted only as a non-empty absolute path; an
    // invalid value falls back to the platform default rather than joining a
    // relative path onto it.
    const configHome = xdgBase('XDG_CONFIG_HOME', join(home, '.config'))
    const dataHome = xdgBase('XDG_DATA_HOME', join(home, '.local', 'share'))
    // Config home first, keeping the probe order existing installs hit.
    const linux = dedupeCandidates([
      join(configHome, ...DESKTOP_AUTH_RELATIVE_PATH),
      join(dataHome, ...DESKTOP_AUTH_RELATIVE_PATH),
    ])
    return isWsl() ? dedupeCandidates([...wslDesktopAuthCandidates(home), ...linux]) : linux
  }
  return []
}

/** The XDG base directory for one env variable, or its platform default. */
function xdgBase(envName: string, fallback: string): string {
  const value = process.env[envName]?.trim()
  if (value !== undefined && value !== '' && value.startsWith('/')) return value
  return fallback
}

/** Drop duplicate candidates while keeping probe order. */
function dedupeCandidates(candidates: readonly string[]): string[] {
  return [...new Set(candidates)]
}

/**
 * The platform-default candidates for one variant, in probe order.
 *
 * Both apps write into the *same* shared `CodeBuddyExtension` auth directory
 * and differ only in the file's basename, so the per-platform ordering above
 * is reused verbatim and just the filename is swapped.
 */
export function desktopAuthCandidatesFor(variant: WorkBuddyVariant): string[] {
  return dedupeCandidates(defaultDesktopAuthCandidates().map(path => join(dirname(path), variant.desktopFilename)))
}

/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
export function defaultDesktopAuthPath(variant?: WorkBuddyVariant): string | undefined {
  const candidates = variant === undefined ? defaultDesktopAuthCandidates() : desktopAuthCandidatesFor(variant)
  return candidates[0]
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const credential: WorkBuddyCredential = {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'desktop',
  }
  return credential
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: WorkBuddyCredential): OwnDocument {
  return { version: OWN_FORMAT_VERSION, credential }
}

/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  // The owned copy stores the normalized credential itself (camelCase
  // `expiresAtMs`, identity fields at the top level), not the desktop
  // document shape. Round-tripping through parseWorkBuddyAuth reads
  // `expiresAt` and an `account` object, finds neither, zeroes the expiry,
  // and drops uid/enterprise/nickname — so a surviving copy refreshed on
  // every request and lost its identity headers.
  const stored = document['credential'] as Record<string, unknown>
  const accessToken = typeof stored['accessToken'] === 'string' ? stored['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
  const enterpriseId = optionalString(stored['enterpriseId'])
  const nickname = optionalString(stored['nickname'])
  return {
    accessToken,
    refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
    expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(stored['domain']) ?? '',
    uid: optionalString(stored['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'dsh',
  }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin
 * (or already expired), keep the refreshed credential in the plugin-owned
 * copy, and never write the desktop app's file. A failed refresh still
 * returns a not-yet-expired token so an unreachable refresh endpoint does
 * not take down a working session.
 */
export class WorkBuddyCredentialStore {
  private readonly variant: WorkBuddyVariant | undefined
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private readonly keyProvider: NonNullable<WorkBuddyStoreOptions['keyProvider']>
  private desktopPathOverride: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: WorkBuddyStoreOptions) {
    this.variant = options.variant
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath ?? (options.variant ? join(resolveDshHome(), options.variant.ownFilename) : workbuddyOwnAuthPath())
    // Legacy stores without a variant stay on the CN product the store's other
    // defaults already assume (own-copy filename, auth env var); a variant
    // without an electron profile falls back by id, keeping externally
    // assembled descriptors source-compatible.
    this.keyProvider = options.keyProvider
      ?? new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(options.variant) })
    this.desktopPathOverride = options.desktopPath
  }

  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[this.variant?.env ?? WORKBUDDY_AUTH_FILE_ENV]
    const explicit = this.desktopPathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return this.variant === undefined
      ? defaultDesktopAuthCandidates()
      : desktopAuthCandidatesFor(this.variant)
  }

  private resolveDesktopPath(): string | undefined {
    return this.resolveDesktopCandidates()[0]
  }

  /**
   * Repoint the desktop file; a settings change applies on the next read.
   */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined {
    return this.resolveDesktopPath()
  }

  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /** Read the freshest stored credential without refreshing anything. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    // A credential belonging to the other product is refused rather than used:
    // the two apps share one auth directory and differ only by filename, so a
    // misconfigured `authFile` / env var is a realistic mistake, and sending one
    // region's token to the other's endpoint would leak it across products.
    // Naming the file and the expected region is what makes it fixable.
    if (this.variant !== undefined) {
      for (const [label, credential] of [['desktop file', desktop], ['plugin copy', own]] as const) {
        if (credential === undefined) continue
        const region = regionOf(credential.domain)
        if (region !== this.variant.region) {
          throw new WorkBuddyElectronPathError(
            'credential-region-mismatch',
            `${this.variant.displayName} received a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
            + ` in its ${label} (domain ${JSON.stringify(credential.domain)});`
            + ` point ${this.variant.env} at the ${this.variant.appName} sign-in, or remove the mismatched file`,
          )
        }
      }
    }
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    // Identity beats expiry. The plugin's own copy is written by its own
    // refreshes, so after the user switches accounts in the desktop app the copy
    // still belongs to the *previous* account — and may well expire later,
    // because the plugin refreshed it. Preferring it by expiry would send the old
    // account's uid in `X-User-Id` and answer as the wrong user. The desktop
    // file is the authority on who is signed in now; a differing identity means
    // the copy is stale regardless of its timestamp.
    if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      const app = this.variant?.appName ?? 'WorkBuddy'
      throw new Error(
        `workbuddy: no signed-in ${app} account found; sign in once in the ${app} desktop app`
        + ` (expected ${desktop} or ${this.variant?.env ?? WORKBUDDY_AUTH_FILE_ENV}), or refresh an existing session`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<WorkBuddyAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out', reasonCode: 'no-credential' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch (error: unknown) {
      // A region mismatch (or an unreadable file, or an unusable key helper) is
      // a *diagnosable* signed-out state, not a silent one: the user needs the
      // path to the file that is wrong, and which provider it actually belongs
      // to. Reported as a status rather than thrown, because `status()` is
      // documented never to throw and the card renders `reason` verbatim.
      //
      // The code travels beside the prose so the card can branch on the cause
      // without ever matching the message text.
      return {
        state: 'signed-out',
        reason: error instanceof Error ? error.message : String(error),
        ...reasonCodeOf(error) === undefined
          ? {}
          : { reasonCode: reasonCodeOf(error) as WorkBuddySignedOutReasonCode },
      }
    }
  }

  /** Remove the plugin-owned copy; the desktop file is untouched. */
  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: 'dsh',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    await withFileLock(this.ownPath, async () => {
      await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  /**
   * Read the first desktop candidate that exists. Only an absent file
   * (ENOENT) falls through to the next candidate; a file that is present
   * but unparsable is authoritative for its slot, so a stale older-version
   * file never silently wins over a broken newer one.
   *
   * Since WorkBuddy 5.6 the token fields may arrive in at-rest envelopes, so
   * the text is classified before the regular parser sees it. An encrypted
   * document must be *opened*, never skipped; an unrecognized one must fail
   * loudly. The desktop file, as long as it exists, is the identity
   * authority — a document this plugin cannot read must surface as a
   * diagnosis rather than be papered over by the plugin-owned copy, which
   * belongs to whatever account was signed in when it was last refreshed.
   * Only an absent (or empty) file lets the probe continue.
   */
  private async readDesktop(): Promise<WorkBuddyCredential | undefined> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        continue
      }
      const classification = classifyDesktopAuthDocument(text)
      if (classification.format === 'plaintext') return parseWorkBuddyAuth(text)
      if (classification.format === 'absent') continue
      if (classification.format === 'unrecognized') {
        throw new Error(
          `the desktop auth file at ${desktopPath} exists but is unreadable`
          + ' (neither a plaintext credential nor a decodable WorkBuddy 5.6 envelope);'
          + ' fix or remove the file — it outranks the plugin-owned credential copy',
        )
      }
      return await this.openEncryptedDesktop(classification)
    }
    return undefined
  }

  /** Open a 5.6 encrypted desktop document into the regular credential shape. */
  private async openEncryptedDesktop(
    classification: Extract<DesktopAuthClassification, { format: 'encrypted' }>,
  ): Promise<WorkBuddyCredential | undefined> {
    const wrapped = classification.wrapped
    const key = await this.keyProvider.protectorKeyFor(keyIdsOf(wrapped.fields))
    const text = unwrapDesktopAuthDocument(classification, field => {
      const plaintext = openAuthField(key, field.envelope)
      if (plaintext === undefined) {
        throw new WorkBuddyElectronPathError(
          'encrypted-credential-unreadable',
          `the encrypted desktop credential's ${field.field} could not be decrypted`
          + ` (envelope key id ${field.envelope.keyId});`
          + ' the WorkBuddy app may hold a different at-rest key — open it once to reseal the sign-in',
        )
      }
      return plaintext
    })
    return parseWorkBuddyAuth(text)
  }

  /**
   * Classify the first desktop candidate that exists and carries content;
   * `absent` when none does. An empty first file is skipped so it cannot mask
   * a real document on the next candidate. Diagnostics only — it never spawns
   * the key helper and never decrypts, so doctor can describe the file
   * without attempting the unlock.
   */
  async desktopAuthFormat(): Promise<DesktopAuthFormat> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        continue
      }
      const format = classifyDesktopAuthDocument(text).format
      if (format !== 'absent') return format
    }
    return 'absent'
  }

  private async readOwn(): Promise<WorkBuddyCredential | undefined> {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      return undefined
    }
  }

  /**
   * The first desktop candidate the probe would actually read from; `undefined`
   * when none qualifies. Semantics deliberately match the probe: empty files
   * are skipped (the probe classifies them as absent and moves on), so on an
   * XDG layout where the config-home file is empty but the data-home file
   * holds the credential, diagnostics name the *data-home* file — the one
   * authentication really uses. Like the probe it never parses or decrypts.
   */
  async resolvedDesktopAuthPath(): Promise<string | undefined> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        continue
      }
      if (text.trim() === '') continue
      return desktopPath
    }
    return undefined
  }

  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  async desktopFilePresent(): Promise<boolean> {
    return await this.resolvedDesktopAuthPath() !== undefined
  }
}
