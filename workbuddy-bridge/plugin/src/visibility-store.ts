/**
 * Per-account model-visibility preferences: which models the signed-in account
 * has hidden from the DSH model picker (issue #36).
 *
 * A disabled *list*, deliberately not an enabled whitelist: a new account and a
 * model the upstream adds both start visible, and an id that temporarily
 * disappears from the catalog is kept — when the model returns it stays hidden
 * until this account says otherwise. Entries are also kept across sign-outs, so
 * returning to an account restores exactly what it left.
 *
 * One file per variant (the two endpoints share model ids but never
 * preferences), keyed by the same `uid:enterpriseId` identity the saved
 * catalogs and probe records use. Not a place for secrets: model-id strings
 * only, never a token, and never written into the desktop auth file or the
 * plugin-owned credential copy — hiding a model is a picker preference, not
 * credential state.
 *
 * Why a plugin-owned file rather than a settings section: the settings sections
 * are statically-typed schemastery objects, and `settings.yaml` is account-global
 * — a per-uid dynamic map fits neither without weakening the schema or mixing
 * one account's preferences into another's config. The saved-catalog and probe
 * stores already persist per-account data this way, so this store follows them:
 * version-tagged document, atomic write with `0o600`, and a malformed file that
 * reads as "nothing saved" rather than throwing.
 *
 * @module dsh-workbuddy-connect/visibility-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** On-disk format this reader accepts; other versions are discarded. */
const VISIBILITY_FORMAT_VERSION = 1

/** Basename of the CN variant's visibility file inside the Harness home. */
export const WORKBUDDY_VISIBILITY_FILENAME = '.workbuddy-model-visibility.json'

/** One account's saved preferences: the account they belong to and its hidden ids. */
interface SavedVisibility {
  /** `uid:enterpriseId` the preferences belong to. */
  account: string
  /** Model ids hidden from this account's picker; never auto-pruned. */
  disabled: readonly string[]
  /** When this account's list last changed, epoch milliseconds. */
  updatedAtMs: number
}

interface VisibilityDocument {
  version: typeof VISIBILITY_FORMAT_VERSION
  accounts: Record<string, SavedVisibility>
}

/** Plugin-owned visibility-file path inside the Harness home. */
export function workbuddyVisibilityPath(filename: string = WORKBUDDY_VISIBILITY_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/** Whether a parsed value is a saved preference entry this reader can trust. */
function isSaved(value: unknown): value is SavedVisibility {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry['account'] !== 'string' || entry['account'] === '') return false
  if (typeof entry['updatedAtMs'] !== 'number' || !Number.isFinite(entry['updatedAtMs'])) return false
  const disabled = entry['disabled']
  if (!Array.isArray(disabled)) return false
  return disabled.every(id => typeof id === 'string' && id !== '')
}

/** Options for {@link WorkBuddyVisibilityStore}. */
export interface WorkBuddyVisibilityStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string
}

/**
 * The per-account hidden-model lists, read once and written atomically.
 *
 * Unlike the saved-catalog store, a failed *write* propagates: the caller
 * reports it to the user rather than answering "hidden" for a preference that
 * did not persist. Reads stay forgiving — a corrupt or unreadable file is
 * "nothing hidden", which only ever shows models the account can still pick.
 */
export class WorkBuddyVisibilityStore {
  private readonly path: string
  private accounts: Record<string, SavedVisibility> | undefined

  constructor(options: WorkBuddyVisibilityStoreOptions | string = {}) {
    this.path = typeof options === 'string'
      ? options
      : options.path ?? workbuddyVisibilityPath()
  }

  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string {
    return this.path
  }

  private load(): Record<string, SavedVisibility> {
    if (this.accounts !== undefined) return this.accounts
    const accounts: Record<string, SavedVisibility> = {}
    if (existsSync(this.path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const document = parsed as Record<string, unknown>
          const raw = document['version'] === VISIBILITY_FORMAT_VERSION ? document['accounts'] : undefined
          if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
            for (const [key, value] of Object.entries(raw)) {
              if (isSaved(value)) accounts[key] = value
            }
          }
        }
      } catch {
        // Corrupt or unreadable: treated as nothing hidden.
      }
    }
    this.accounts = accounts
    return accounts
  }

  /** The model ids one account has hidden; empty when it never hid any. */
  disabled(account: string): readonly string[] {
    return this.load()[account]?.disabled ?? []
  }

  /**
   * Show or hide one model for one account, persisting before committing.
   *
   * Re-enabling (showing) the last hidden model removes the account's entry
   * entirely — an absent entry and an empty list mean the same thing
   * (everything visible), and the file should not accumulate empty buckets.
   * Throws when the write fails, leaving the in-memory state untouched so a
   * re-read cannot lie about what was persisted.
   */
  setVisible(account: string, model: string, visible: boolean): void {
    const current = this.load()[account]?.disabled ?? []
    const next = visible ? current.filter(id => id !== model) : [...new Set([...current, model])]
    const accounts = { ...this.load() }
    if (next.length === 0) delete accounts[account]
    else accounts[account] = { account, disabled: next, updatedAtMs: Date.now() }
    this.persist(accounts)
    this.accounts = accounts
  }

  private persist(accounts: Record<string, SavedVisibility>): void {
    const directory = dirname(this.path)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    const document: VisibilityDocument = { version: VISIBILITY_FORMAT_VERSION, accounts }
    const temporary = resolve(`${this.path}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
