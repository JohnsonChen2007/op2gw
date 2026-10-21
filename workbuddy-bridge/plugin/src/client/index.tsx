/**
 * Browser half: the WorkBuddy account cards, on whichever settings surface the
 * host provides.
 *
 * One bundle serves two DSH generations. DSH 0.1.5 renders plugin cards in the
 * settings Plugins tab, which dispatches the keyed `settings.plugin.item` slot
 * once per served settings namespace (one card per WorkBuddy variant). DSH
 * 0.1.6 moved plugin configuration to the Plugins page, whose
 * `plugins.bundle.config` slot carries one bundle-keyed entry that renders both
 * variants itself. `ctx.slots.inject` follows the slot's declaration lifetime —
 * the callback runs where the slot is declared and simply never runs where it
 * is not — so registering BOTH seams needs no host-version check: each host
 * materializes exactly the seam it ships.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the two slot declarations this bundle registers into. The 0.1.5
// settings tab declares `settings.plugin.item`; the 0.1.6+ Plugins page
// declares `plugins.bundle.config`. Cross-plugin collaboration goes through
// cordis services, so value imports would fail the client bundle-purity gate;
// at runtime each host declares only the slot it ships.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { WorkBuddyProbeControl } from './WorkBuddyProbeControl.tsx'
import { WorkBuddyUpdateOverlay } from './WorkBuddyUpdateNotice.tsx'
import { WorkBuddyUpdateStore } from './update-store.ts'
import { WORKBUDDY_CONNECT_VERSION } from '../version.ts'
import { WorkBuddyConfigPage } from './WorkBuddyConfigPage.tsx'
import { CARD_VARIANTS, WorkBuddyPluginCard } from './WorkBuddyPluginCard.tsx'
import type { WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
  interface SlotMap {
    /**
     * Compile-time mirror of the shell's overlay seat (declared at runtime by
     * the ui-layout AppFrame, which this bundle does not depend on): a list
     * slot the shell renders over the whole app, click-through until an entry
     * opts into pointer events. Hosts without the seat simply never fire the
     * inject below. If a future dependency ships the real declaration, drop
     * this mirror in its favour.
     */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
      owner: WorkBuddyShellOverlayOwnerProps
    }
  }
}

/** Owner share of the overlay seat: the frame supplies nothing to entries. */
interface WorkBuddyShellOverlayOwnerProps {
  children?: never
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-connect-client'

/**
 * The bundle's package name, which is also this half's configuration key.
 *
 * The Plugins page dispatches `plugins.bundle.config` by the bundle's package
 * name, so the key has to spell exactly what the profile installs.
 */
export const BUNDLE_NAME = 'dsh-workbuddy-connect'

/**
 * Client services required by this browser half.
 *
 * DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
 * hold the browser `ClientContext` alias and the `slots` service), so the
 * services come from narrower packages: the `slots` registry lives in
 * `@deepseek-ai/dsh-client-ui-renderer` and `locale` in
 * `@deepseek-ai/dsh-client-locale`. Neither slot owner is named here on
 * purpose: `settings.plugin.item`'s declarer (`…-ui-settings-plugins`) is
 * absent from 0.1.6+ hosts and `plugins.bundle.config`'s declarer
 * (`…-ui-plugin-manager`) is absent from 0.1.5 hosts, and the seam choice is
 * made by slot-declaration lifetime, not by activation order — `ctx.slots.inject`
 * fires whenever the declaring package commits the slot, before or after this
 * fiber starts.
 */
// `modelDirectories` reads the active session through `remote.session`.
// Declaring that dependency at the client entry is required by the Desktop
// renderer; without it Cordis rejects `directoryFor()` before this bundle can
// finish registering its contributions.
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/** Prefix every guarded client contribution's degradation logs with this. */
const CLIENT_CONTRIBUTION_FAILED = '[dsh-workbuddy-connect] client contribution failed to load (host provider unaffected):'

/** Disposer handed back when a deferred registration degraded: nothing to undo. */
const NOOP_DISPOSER = (): void => {}

/**
 * Run ONE browser-side contribution, degrading its failure to a `console.error`
 * instead of throwing into the DSH loader. Returns the contribution's own
 * value on success, or `undefined` when it degraded — the deferred slot
 * callbacks below substitute `NOOP_DISPOSER` for that, because the slot
 * runtime always expects a disposer back.
 *
 * Every contribution is guarded at BOTH boundaries where it can throw:
 *
 * 1. the eager `ctx.slots.inject(...)` / `ctx.inject(...)` call itself, which
 *    runs synchronously inside `apply()` — e.g. a slot-API shape break such as
 *    the rc.6→rc.7 `id`→`key` rename;
 * 2. the deferred callback, which the slot runtime invokes later — when the
 *    owner commits the slot's declaration, or when the injected services
 *    arrive — long after `apply()` has returned, where no enclosing try/catch
 *    could still catch it.
 *
 * The pair is what makes the contributions independent: a failure in one
 * settings seam, or in the probe control, leaves every other registration
 * intact. Guards are for THIS browser half only; the host half reports its own
 * errors through `ctx.logger`.
 */
function guardClientContribution<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (error: unknown) {
    console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error)
    return undefined
  }
}

/**
 * Register the card copy and both settings-surface seams, one guarded
 * contribution at a time.
 *
 * A DSH slot-API breaking change degrades to a `console.error` per
 * contribution instead of throwing into the DSH loader and raising the red
 * "Failed to load plugins" banner; because each contribution carries its own
 * guard, one failing registration never takes the others with it (the old
 * settings cards survive a broken Plugins-page seam, and the probe control
 * survives either). The host provider keeps working throughout: the
 * `workbuddy` model channel is unaffected, and `dsh-workbuddy-connect status`
 * reports host health via the heartbeat file.
 *
 * The tests import this function directly (`tests/client-fallback.spec.ts`),
 * so its isolation semantics are pinned against the real entry — keep any
 * change to the guarded structure in sync with that spec.
 */
export function apply(ctx: ClientContext): void {
  // The locale copy feeds every contribution below through `t`. Its guard
  // exists only so a broken locale service cannot reach the loader; if it
  // degrades, `t` still binds and renders the key names as fallback copy.
  const namespace = 'settings.workbuddy'
  guardClientContribution('settings copy', () => {
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-connect: settings copy')
  })
  const t = ctx.locale.bind(namespace) as WorkBuddyPluginCardInjected['t']
  // The update reminder: one store for the whole bundle (the check compares
  // this npm package's own version, so both provider cards share it). It
  // refreshes once on mount through a 7-day localStorage cache and never
  // blocks a contribution — a failed check simply renders nothing.
  const updater = new WorkBuddyUpdateStore(WORKBUDDY_CONNECT_VERSION)
  guardClientContribution('update reminder lifecycle', () => {
    ctx.effect(() => {
      void updater.refresh()
      return () => { updater.dispose() }
    }, 'dsh-workbuddy-connect: update checker')
  })
  // The floating seat. Hosts whose shell declares no `shell.overlay` seat
  // never fire this callback — the reminder is simply absent there, the same
  // degradation the two settings seams rely on.
  guardClientContribution('update reminder overlay', () => {
    ctx.slots.inject('shell.overlay', () => (
      guardClientContribution('update reminder overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'workbuddy-update',
        order: 40,
        locale: namespace,
        inject: () => ({ t, updater }),
      }, WorkBuddyUpdateOverlay)) ?? NOOP_DISPOSER
    ))
  })
  // SEAM ONE — DSH 0.1.5's settings Plugins tab. One card per variant: they
  // show different accounts, balances, and model sets, so a single merged
  // card could not say which account a number belongs to. The slot is
  // key-dispatched (two keys, one component), and on 0.1.6+ hosts nothing
  // declares it, so these registrations simply never run there. Each variant
  // is its own contribution: one card's failure cannot hide the other's.
  for (const [index, variant] of CARD_VARIANTS.entries()) {
    const label = `settings.plugin.item card "${variant.id}"`
    guardClientContribution(label, () => {
      ctx.slots.inject('settings.plugin.item', () => (
        guardClientContribution(label, () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: variant.id,
          priority: 30 - index,
          inject: (): WorkBuddyPluginCardInjected => ({ t, variant }),
        }, WorkBuddyPluginCard)) ?? NOOP_DISPOSER
      ))
    })
  }
  // SEAM TWO — DSH 0.1.6+'s Plugins page. One configuration entry for the
  // whole bundle, keyed by its package name as the page dispatches it; the
  // entry mounts both variants' cards itself. On 0.1.5 hosts nothing
  // declares this slot, so it never runs there.
  guardClientContribution('plugins.bundle.config page', () => {
    ctx.slots.inject('plugins.bundle.config', () => (
      guardClientContribution('plugins.bundle.config page', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_NAME,
        locale: namespace,
      }, WorkBuddyConfigPage)) ?? NOOP_DISPOSER
    ))
  })
  // The reasoning-probe seat in the conversation composer. `modelDirectories`
  // may arrive after this fiber starts, so the scoped callback — and the slot
  // callback inside it — are guarded at their own boundaries too.
  guardClientContribution('conversation probe control', () => {
    ctx.inject(['modelDirectories'], scope => {
      guardClientContribution('conversation probe control', () => {
        scope.slots.inject('conversation.input.right', () => (
          guardClientContribution('conversation probe control', () => scope.slots.register({
            name: 'conversation.input.right',
            id: 'workbuddy-probe',
            order: 10,
            inject: sessionId => ({
              directory: scope.modelDirectories.directoryFor(
                sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
              ).store,
              t,
            }),
          }, WorkBuddyProbeControl)) ?? NOOP_DISPOSER
        ))
      })
    })
  })
}
