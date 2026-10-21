/**
 * The two WorkBuddy desktop apps this one plugin serves.
 *
 * Both products are the same client framework in different regions, and both
 * write their sign-in into the *same* shared `CodeBuddyExtension` auth
 * directory — they differ by file basename, base URL, catalog endpoint, and
 * display identity. Everything that varies between them is collected here as
 * one descriptor, so no module has to carry its own `if (international)`
 * branch and a third variant would be a data change rather than a refactor.
 *
 * This module is host-side (it names files and env vars). The browser half
 * takes the same ids and routes from the Node-free `status-paths.ts`, which
 * stays the single source shared by both halves.
 *
 * @module dsh-workbuddy-connect/variants
 */

import { WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH } from './status-paths.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** One WorkBuddy product variant. */
export interface WorkBuddyVariant {
  /** Provider id registered with DSH, e.g. `workbuddy-ai`. */
  id: string
  /** Model-group heading and card title stem, e.g. `WorkBuddy AI`. */
  displayName: string
  /** Desktop app name as users know it, for diagnostics and error copy. */
  appName: string
  /** Which upstream region this variant's credentials must belong to. */
  region: WorkBuddyRegion
  /** Env var overriding the desktop auth-file location. */
  env: string
  /**
   * How this product's Electron helper is identified and located.
   *
   * Optional for source compatibility: `WorkBuddyVariant` is a public type and
   * existing callers construct their own descriptors without it. Resolution
   * falls back to {@link electronProfileFor}, keyed by variant id — an
   * unknown id stays on the CN profile, the store's other legacy default.
   */
  electron?: WorkBuddyElectronProduct
  /** Basename of the desktop app's own auth file in the shared auth directory. */
  desktopFilename: string
  /** Basename of the plugin-owned credential copy under `$DSH_HOME`. */
  ownFilename: string
  /** Basename of the plugin-owned probe-record file under `$DSH_HOME`. */
  probeFilename: string
  /**
   * Basename of the plugin-owned saved-catalog file under `$DSH_HOME`.
   *
   * One per variant, like the probe records: the two endpoints disagree about
   * rates, windows, and even which models exist for a shared id, so a catalog
   * saved from one must never be served as the other's.
   */
  catalogFilename: string
  /**
   * Basename of the plugin-owned per-account model-visibility file under
   * `$DSH_HOME`.
   *
   * One per variant, for the same reason as the catalogs and probe records:
   * the two endpoints share model ids, so one variant's hidden list must never
   * answer for the other's picker.
   */
  visibilityFilename: string
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string
}

/**
 * How one product's Electron key helper is identified on each platform, and
 * which env var names an explicit binary for it (issues #59/#60).
 *
 * The profile is the *only* place product identity enters helper resolution —
 * never the discovery setting, which only says whether a platform may be
 * searched at all: two products on the same platform differ by bundle id /
 * registry name / exe basename, so a discovery that matches one can never
 * legitimately execute the other's binary.
 */
export interface WorkBuddyElectronProduct {
  /** Product name for helper diagnostics and error copy, e.g. `WorkBuddy AI`. */
  productName: string
  /** Env var naming an explicit Electron binary for this product alone. */
  envVar: string
  /** macOS identity and default install layout, verified per product. */
  macOS: {
    bundleId: string
    defaultPath: string
  }
  /**
   * Windows identity from the uninstall registry and the exe it names.
   * `defaultPathSegments` exists only where the default install location has
   * been measured (CN); the international app has only been seen in
   * user-chosen locations, so it stays registry-only — an unverified default
   * is a guess, and guessing is how the wrong app gets executed.
   */
  windows: {
    displayNamePattern: RegExp
    exeBasename: string
    defaultPathSegments?: readonly string[]
  }
}

/** CN WorkBuddy first: the existing provider keeps its id, paths, and copy. */
export const WORKBUDDY_VARIANTS: readonly WorkBuddyVariant[] = [
  {
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    appName: 'WorkBuddy',
    region: 'cn',
    env: 'WORKBUDDY_AUTH_FILE',
    electron: {
      productName: 'WorkBuddy',
      envVar: 'WORKBUDDY_ELECTRON_BIN',
      macOS: {
        bundleId: 'com.tencent.workbuddy.mac',
        defaultPath: '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
      },
      windows: {
        displayNamePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
        exeBasename: 'workbuddy.exe',
        defaultPathSegments: ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
      },
    },
    desktopFilename: 'workbuddy-desktop.info',
    ownFilename: '.workbuddy-auth.json',
    probeFilename: '.workbuddy-probe.json',
    catalogFilename: '.workbuddy-catalog.json',
    visibilityFilename: '.workbuddy-model-visibility.json',
    statusPath: WORKBUDDY_STATUS_PATH,
    probePath: WORKBUDDY_PROBE_PATH,
  },
  {
    id: 'workbuddy-ai',
    displayName: 'WorkBuddy AI',
    appName: 'WorkBuddy AI',
    region: 'global',
    env: 'WORKBUDDY_AI_AUTH_FILE',
    electron: {
      productName: 'WorkBuddy AI',
      envVar: 'WORKBUDDY_AI_ELECTRON_BIN',
      macOS: {
        bundleId: 'com.workbuddy.workbuddy-ai',
        defaultPath: '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron',
      },
      windows: {
        // Measured in #60: `WorkBuddy AI 5.6.2`. The CN pattern cannot match
        // this value ("AI" is not a version) and this pattern cannot match
        // `WorkBuddy 5.6.2` (missing the literal " AI"), so the two records
        // never feed each other's discovery.
        displayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
        exeBasename: 'workbuddyai.exe',
      },
    },
    desktopFilename: 'workbuddy-desktop-ai.info',
    ownFilename: '.workbuddy-ai-auth.json',
    probeFilename: '.workbuddy-ai-probe.json',
    catalogFilename: '.workbuddy-ai-catalog.json',
    visibilityFilename: '.workbuddy-ai-model-visibility.json',
    statusPath: WORKBUDDY_AI_STATUS_PATH,
    probePath: WORKBUDDY_AI_PROBE_PATH,
  },
]

/** The CN variant; the plugin's long-standing default and compatibility anchor. */
export const CN_VARIANT = WORKBUDDY_VARIANTS[0]! satisfies WorkBuddyVariant

/** The international variant. */
export const AI_VARIANT = WORKBUDDY_VARIANTS[1]! satisfies WorkBuddyVariant

/** Look up a variant by provider id. */
export function variantFor(id: string): WorkBuddyVariant | undefined {
  return WORKBUDDY_VARIANTS.find(variant => variant.id === id)
}

/**
 * The Electron profile a variant resolves with.
 *
 * Callers inside the plugin pass their known-complete variants; descriptors
 * assembled outside (the type is public and predates the profile) fall back
 * by variant id, so an id-less or unknown custom variant stays on the CN
 * product — the same default the store's other legacy fields assume.
 */
export function electronProfileFor(variant: Pick<WorkBuddyVariant, 'id' | 'electron'> | undefined): WorkBuddyElectronProduct {
  // Both shipped variants always carry their profile; the optional marker
  // exists only for externally assembled descriptors, hence the assertion.
  return variant?.electron ?? (variant?.id === AI_VARIANT.id ? AI_VARIANT : CN_VARIANT).electron!
}
