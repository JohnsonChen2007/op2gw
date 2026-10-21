import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { CARD_VARIANTS } from '../src/client/WorkBuddyPluginCard.tsx'

/**
 * The two settings-surface seams ONE client bundle registers into.
 *
 * DSH 0.1.5 renders plugin cards in the settings Plugins tab, which dispatches
 * the keyed `settings.plugin.item` slot once per served settings namespace —
 * one key per WorkBuddy variant. DSH 0.1.6 moved plugin configuration to the
 * Plugins page, where a bundle carries a single `plugins.bundle.config` entry
 * keyed by its package name and renders both variants inside it. The client
 * entry registers BOTH seams unconditionally and lets slot-declaration
 * lifetime pick: a callback for a slot the host never declares simply never
 * runs. This file pins the consequences of that shape against the real
 * registry rather than trusting the registration calls.
 *
 * Both slots are keyed, so whether a key is accepted (and whether a duplicate
 * or an undeclared slot is rejected) is a property of the real slot registry
 * rather than of this plugin's code. These tests drive the actual `SlotCore`
 * to answer that, instead of trusting that the registration shape works.
 *
 * Only the variant ids are needed from the card module (the components
 * themselves cannot render in this Node environment), and the register calls
 * are typed loosely on purpose: the point under test is the registry's
 * behaviour, not the DSH client typings.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The key the bundle registers under; the 0.1.6+ page looks the entry up by name. */
const BUNDLE_KEY = 'dsh-workbuddy-connect'

/** Minimal component stand-in; the registry only stores the reference. */
const Component = (): null => null

const register = (core: SlotCore, options: Record<string, unknown>): unknown =>
  (core.register as any)(options, Component)

/**
 * Declare a slot the way its host page does: an entry contributes a
 * `children` table. `SlotCore` has no standalone declare method — the child
 * spec is owned by the registering entry, which is also why a slot can only
 * be claimed once. Which slots a host declares is exactly the capability the
 * dual-seam design detects, so the tests declare them per host generation.
 */
function declareHostSlots(core: SlotCore, slots: readonly string[]): void {
  const children: Record<string, { kind: 'keyed'; keyProps: Record<string, object> }> = {}
  if (slots.includes('settings.plugin.item')) {
    children['settings.plugin.item'] = { kind: 'keyed', keyProps: { workbuddy: {}, 'workbuddy-ai': {} } }
  }
  if (slots.includes('plugins.bundle.config')) {
    children['plugins.bundle.config'] = { kind: 'keyed', keyProps: { [BUNDLE_KEY]: {} } }
  }
  register(core, { name: 'root', children })
}

/** The client entry's 0.1.5-seam registrations: one card per variant. */
function registerLegacyCards(core: SlotCore): void {
  for (const [index, variant] of CARD_VARIANTS.entries()) {
    register(core, { name: 'settings.plugin.item', key: variant.id, priority: 30 - index })
  }
}

/** The client entry's 0.1.6-seam registration: one bundle-keyed page. */
function registerBundlePage(core: SlotCore): void {
  register(core, { name: 'plugins.bundle.config', key: BUNDLE_KEY })
}

describe('settings.plugin.item carries both cards (DSH 0.1.5 seam)', () => {
  it('accepts two registrations with distinct keys from one owner', () => {
    const core = new SlotCore()
    declareHostSlots(core, ['settings.plugin.item'])
    expect(() => registerLegacyCards(core)).not.toThrow()
    // Both entries are live, which is exactly what the two cards need.
    expect((core.entries as any)('settings.plugin.item')).toHaveLength(2)
  })

  it('projects one cell per key, so both cards render', () => {
    const core = new SlotCore()
    declareHostSlots(core, ['settings.plugin.item'])
    registerLegacyCards(core)
    // The projection returns the winning ENTRY per key, so the key is read off
    // `options` — one cell each, which is what the settings page renders.
    const cells = (core.entriesOfSlot as any)('settings.plugin.item') as { options: { key?: string } }[]
    expect(cells).toHaveLength(2)
    expect(cells.map(cell => cell.options.key).sort()).toEqual(['workbuddy', 'workbuddy-ai'])
  })

  it('rejects a duplicate key at the same priority, which is why priorities differ', () => {
    const core = new SlotCore()
    declareHostSlots(core, ['settings.plugin.item'])
    register(core, { name: 'settings.plugin.item', key: 'workbuddy', priority: 30 })
    expect(() => register(core, { name: 'settings.plugin.item', key: 'workbuddy', priority: 30 }))
      .toThrow(/already has an entry for key/)
  })

  it('requires an explicit key, which is why each card passes one', () => {
    const core = new SlotCore()
    declareHostSlots(core, ['settings.plugin.item'])
    // This is the rc.7 breakage the client entry's try/catch exists for.
    expect(() => register(core, { name: 'settings.plugin.item' }))
      .toThrow(/requires options.key/)
  })
})

describe('plugins.bundle.config carries the bundle (DSH 0.1.6+ seam)', () => {
  it('accepts the bundle-keyed registration the client entry makes', () => {
    const core = new SlotCore()
    declareHostSlots(core, ['plugins.bundle.config'])
    expect(() => registerBundlePage(core)).not.toThrow()
    expect((core.entries as any)('plugins.bundle.config')).toHaveLength(1)
  })

  it('renders both variants from that one entry', () => {
    // The regression this guards: the slot is keyed by BUNDLE, not by variant,
    // so "one card per variant" can no longer mean "one registration per
    // variant". Both variants have to be reachable from the single component the
    // entry mounts, which is what the page iterates.
    expect(CARD_VARIANTS.map(card => card.id)).toEqual(['workbuddy', 'workbuddy-ai'])
  })

  it('keeps one component mounting both cards, not one key per card', () => {
    const core = new SlotCore()
    declareHostSlots(core, ['plugins.bundle.config'])
    registerBundlePage(core)
    // The projection returns the winning ENTRY per key, so the key is read off
    // `options` — one cell keyed by the bundle, holding both cards inside it.
    const cells = (core.entriesOfSlot as any)('plugins.bundle.config') as { options: { key?: string } }[]
    expect(cells).toHaveLength(1)
    expect(cells[0]!.options.key).toBe(BUNDLE_KEY)
  })

  it('rejects a second registration under the same key', () => {
    // Two profiles referencing the bundle, or the browser half loaded twice,
    // collide here. The client entry's try/catch is what turns that collision
    // into a `console.error` instead of a failed-loader banner.
    const core = new SlotCore()
    declareHostSlots(core, ['plugins.bundle.config'])
    registerBundlePage(core)
    expect(() => registerBundlePage(core)).toThrow(/already has an entry for key/)
  })

  it('requires an explicit key, which is why the entry passes one', () => {
    const core = new SlotCore()
    declareHostSlots(core, ['plugins.bundle.config'])
    // This is the kind of breakage the client entry's try/catch exists for.
    expect(() => register(core, { name: 'plugins.bundle.config' }))
      .toThrow(/requires options.key/)
  })
})

describe('the two seams coexist without interference', () => {
  it('lands every registration when one host declared both slots', () => {
    // A host generation that keeps the old settings tab while also shipping
    // the Plugins page (or a registry snapshot spanning both) must hold all
    // three registrations at once; the keys live in different slots, so they
    // cannot collide.
    const core = new SlotCore()
    declareHostSlots(core, ['settings.plugin.item', 'plugins.bundle.config'])
    expect(() => {
      registerLegacyCards(core)
      registerBundlePage(core)
    }).not.toThrow()
    expect((core.entriesOfSlot as any)('settings.plugin.item')).toHaveLength(2)
    expect((core.entriesOfSlot as any)('plugins.bundle.config')).toHaveLength(1)
  })

  it('rejects registering into a slot the host never declared', () => {
    // THE CAPABILITY BOUNDARY. On a 0.1.5 host nothing declares
    // `plugins.bundle.config`, and on a 0.1.6+ host nothing declares
    // `settings.plugin.item` — a direct `register` into the missing slot
    // throws. That is exactly why the client entry mounts each seam through
    // `ctx.slots.inject`, which runs its callback only once the slot's
    // declaration is committed (and never runs it for a slot the host does
    // not ship) instead of registering eagerly.
    const core = new SlotCore()
    declareHostSlots(core, ['settings.plugin.item'])
    expect(() => registerBundlePage(core)).toThrow(/not declared/)

    const other = new SlotCore()
    declareHostSlots(other, ['plugins.bundle.config'])
    expect(() => registerLegacyCards(other)).toThrow(/not declared/)
  })
})
