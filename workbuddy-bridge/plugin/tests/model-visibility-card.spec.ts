import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_CARD_VARIANT, CN_CARD_VARIANT, WorkBuddyPluginCard } from '../src/client/WorkBuddyPluginCard.tsx'
import { en } from '../src/client/locales.ts'

/**
 * Issue #36 card wiring, post-merge: the visibility checkboxes live inside the
 * context-window table — one row per catalog model, checkbox and capacity on
 * the same line — so the context tab no longer renders two model lists. Both
 * DSH surfaces (0.1.5 settings cards and the 0.1.6+ bundle configuration page)
 * mount this one component; the seam dispatch itself is pinned by
 * `slot-registration.spec.ts`. Host-side semantics (store, filter boundary,
 * routes) live in `tests/model-visibility.spec.ts`.
 */

/**
 * Badges shaped like the status document's. GLM-5.3 declares a default and a
 * larger maximum so the international preference can render; No Context
 * declares no window at all and must still be toggleable.
 */
const MODELS = [
  { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79', contextWindow: 1_000_000, defaultContextWindow: 300_000, maxContextWindow: 1_000_000 },
  { id: 'hy3', name: 'Hy3', credits: 'x0.00', contextWindow: 192_000 },
  { id: 'no-context', name: 'No Context', credits: 'x0.25' },
] as const

describe('model visibility card controls', () => {
  let view: ReactTestRenderer | undefined
  /** The mutable status body every GET answers with (the simulated host truth). */
  let statusBody: Record<string, unknown>
  /** The response every POST answers with; `{ state: 'updated' }` saves. */
  let postResponse: Record<string, unknown>
  /** When set, POSTs wait in `held` until the test releases them. */
  let holdPosts: boolean
  const held: (() => void)[] = []
  const posts: { body: Record<string, unknown>; headers: unknown }[] = []
  const request = vi.fn()

  const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
    Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key] as string)

  function signedIn(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      nickname: '昵称',
      probeKey: 'test-key',
      // Verbatim badges: the merged table reads context and rate from the same
      // rows the checkboxes live in.
      models: MODELS.map(model => ({ ...model })),
      visibility: { account: 'u1:', disabled: ['hy3'] },
      catalog: { source: 'live', fetchedAt: Date.now() },
      ...overrides,
    }
  }

  /** Apply one toggle to the simulated host truth, as the host would on success. */
  function applyToggle(body: Record<string, unknown>): void {
    if (body['action'] !== 'set-model-visibility') return
    const visibility = statusBody['visibility'] as { disabled: string[] } | undefined
    if (visibility === undefined) return
    const id = String(body['model'])
    visibility.disabled = body['visible'] === true
      ? visibility.disabled.filter(entry => entry !== id)
      : [...new Set([...visibility.disabled, id])]
  }

  /** The visibility checkboxes' checked states, in row order. */
  function checkboxStates(): boolean[] {
    return view!.root.findAll(node => {
      if (node.type !== 'input') return false
      return (node.props as Record<string, unknown>)['type'] === 'checkbox'
    }).map(node => (node.props as Record<string, unknown>)['checked'] === true)
  }

  /** Same order as {@link checkboxStates}: whether each checkbox is disabled. */
  function checkboxDisabled(): boolean[] {
    return view!.root.findAll(node => {
      if (node.type !== 'input') return false
      return (node.props as Record<string, unknown>)['type'] === 'checkbox'
    }).map(node => (node.props as Record<string, unknown>)['disabled'] === true)
  }

  /**
   * Plain text of one rendered subtree. Written by hand rather than
   * `JSON.stringify(children)`: react-test-renderer instances hold fiber
   * back-references, and stringifying them throws on the cycle.
   */
  function nodeText(node: { children: unknown[] }): string {
    return node.children.map(child => {
      if (typeof child === 'string' || typeof child === 'number') return String(child)
      if (typeof child === 'object' && child !== null && Array.isArray((child as { children?: unknown[] }).children)) {
        return nodeText(child as { children: unknown[] })
      }
      return ''
    }).join('')
  }

  /**
   * The merged model rows, as plain text: every <label> that renders a
   * checkbox inside it (for the AI card the whole-list preference label counts
   * too and comes first, rendered above the rows). One entry per row, so a
   * duplicated list (the pre-merge bug) shows up as an extra entry.
   */
  function rowTexts(): string[] {
    return view!.root.findAll(node => node.type === 'label' && nodeHasInput(node)).map(node => nodeText(node))
  }

  /** Whether a subtree renders an <input> anywhere inside it. */
  function nodeHasInput(node: { children: unknown[] }): boolean {
    for (const child of node.children) {
      if (typeof child === 'object' && child !== null) {
        const candidate = child as { type?: unknown; children?: unknown[] }
        if (candidate.type === 'input') return true
        if (Array.isArray(candidate.children) && nodeHasInput(candidate as { children: unknown[] })) return true
      }
    }
    return false
  }

  /** Every button label currently rendered, for label-state assertions. */
  function buttonLabels(): string[] {
    return view!.root.findAllByType('button').map(node => node.children.join(''))
  }

  /** Mount, expand, and switch to the context tab where the controls live. */
  async function mount(variant = CN_CARD_VARIANT): Promise<void> {
    const props = { t, variant } as unknown as Parameters<typeof WorkBuddyPluginCard>[0]
    await act(async () => { view = create(createElement(WorkBuddyPluginCard, props)) })
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
    const tab = view!.root.findAllByType('button').find(node => node.children.join('') === en.tabContext)
    if (tab === undefined) throw new Error('context tab not found')
    await act(async () => { tab.props.onClick() })
  }

  /** Toggle the checkbox at one index and let the POST + follow-up read settle. */
  async function toggle(index: number, checked: boolean): Promise<void> {
    const boxes = view!.root.findAll(node => node.type === 'input'
      && (node.props as Record<string, unknown>)['type'] === 'checkbox')
    const node = boxes[index]
    if (node === undefined) throw new Error(`no checkbox #${index}`)
    const onChange = (node.props as Record<string, unknown>)['onChange'] as (event: unknown) => void
    await act(async () => { onChange({ currentTarget: { checked } }) })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
  }

  beforeEach(() => {
    signedIn()
    postResponse = { state: 'updated' }
    holdPosts = false
    held.length = 0
    posts.length = 0
    request.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        // A fresh document each read, like the real host: later mutations of
        // the simulated truth must not leak into state already on screen.
        return { ok: true, json: async () => JSON.parse(JSON.stringify(statusBody)) }
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ body, headers: init.headers })
      if (holdPosts) await new Promise<void>(resolve => { held.push(resolve) })
      // A save the host confirms rewrites its truth before the card re-reads;
      // a refused one (state !== 'updated') leaves the truth untouched.
      if (postResponse['state'] === 'updated') applyToggle(body)
      return { ok: true, json: async () => postResponse }
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  it('renders each model exactly once — no duplicated model list', async () => {
    await mount()
    const tree = JSON.stringify(view!.toJSON())
    for (const name of ['GLM-5.3', 'Hy3', 'No Context']) {
      // Split-count, not regex: the names contain dots and spaces.
      expect(tree.split(name).length - 1).toBe(1)
    }
  })

  it('carries the checkbox, name, and context value on one row', async () => {
    await mount()
    const rows = rowTexts()
    expect(rows).toHaveLength(3)
    // Largest window first, no-window model trailing (catalog order within groups).
    expect(rows[0]).toContain('GLM-5.3')
    expect(rows[0]).toContain('1M')
    expect(rows[1]).toContain('Hy3')
    expect(rows[1]).toContain('192K')
    // No declared window: still a row, still a checkbox, an em dash for capacity.
    expect(rows[2]).toContain('No Context')
    expect(rows[2]).toContain('—')
  })

  it('renders the checked state of the current account hidden list', async () => {
    await mount()
    expect(checkboxStates()).toEqual([true, false, true])
  })

  it('a model without a context window is still toggleable', async () => {
    await mount()
    await toggle(2, false)
    expect(posts[0]!.body).toEqual({ action: 'set-model-visibility', model: 'no-context', visible: false, account: 'u1:' })
    expect(checkboxStates()).toEqual([true, false, false])
  })

  it('unchecking sends the hide action and flips the box once the host confirms', async () => {
    await mount()
    await toggle(0, false)
    expect(posts[0]!.body).toEqual({ action: 'set-model-visibility', model: 'glm-5.3', visible: false, account: 'u1:' })
    // The write is authorized the same way every control action is.
    expect((posts[0]!.headers as Record<string, string>)['X-Workbuddy-Probe-Key']).toBe('test-key')
    expect(checkboxStates()).toEqual([false, false, true])
  })

  it('re-checking sends the show action and restores the box', async () => {
    await mount()
    await toggle(1, true)
    expect(posts[0]!.body).toEqual({ action: 'set-model-visibility', model: 'hy3', visible: true, account: 'u1:' })
    expect(checkboxStates()).toEqual([true, true, true])
  })

  it('a refused save neither flips the box nor claims success', async () => {
    postResponse = { state: 'failed', reason: 'model visibility needs a signed-in account with a stable user id' }
    await mount()
    await toggle(1, true)
    // The action was sent…
    expect(posts[0]!.body['model']).toBe('hy3')
    // …but the box still reports the host's truth, and the reason is on screen.
    expect(checkboxStates()).toEqual([true, false, true])
    expect(JSON.stringify(view!.toJSON())).toContain('stable user id')
  })

  it('renders no checkboxes when the account has no stable uid', async () => {
    signedIn({ visibility: undefined })
    await mount()
    expect(checkboxStates()).toEqual([])
    // The capacity list itself still renders, with the dash for the windowless.
    const rows = rowTexts()
    expect(rows).toHaveLength(0)
    expect(JSON.stringify(view!.toJSON())).toContain('1M')
    expect(JSON.stringify(view!.toJSON())).toContain('—')
    expect(JSON.stringify(view!.toJSON())).not.toContain(en.visibilityIntro)
  })

  it('a toggle in flight locks only its own row; the Refresh buttons stay idle', async () => {
    // Regression 1: the visibility write used the card-wide `busy` flag, so
    // every click relabelled 刷新/刷新模型列表 to "refreshing…". Regression 2: it
    // then locked the whole checkbox list for one row's write, making every
    // row blink grey. Writes are per-model and commutative, so only the row
    // being written locks.
    holdPosts = true
    await mount()
    const boxes = view!.root.findAll(node => node.type === 'input'
      && (node.props as Record<string, unknown>)['type'] === 'checkbox')
    const onChange = (index: number) =>
      (boxes[index]!.props as Record<string, unknown>)['onChange'] as (event: unknown) => void
    await act(async () => { onChange(0)({ currentTarget: { checked: false } }) })
    // The write is held open: the buttons keep their idle labels, the context
    // column stays rendered, and only the clicked row locks.
    expect(buttonLabels()).toContain(en.refresh)
    expect(buttonLabels()).toContain(en.refreshModels)
    expect(buttonLabels()).not.toContain(en.refreshing)
    expect(JSON.stringify(view!.toJSON())).toContain('1M')
    expect(checkboxDisabled()).toEqual([true, false, false])
    // The untouched rows stay usable: a second write queues beside the first.
    await act(async () => { onChange(2)({ currentTarget: { checked: false } }) })
    expect(checkboxDisabled()).toEqual([true, false, true])
    // Release both writes; the boxes settle per the host's confirmation.
    await act(async () => { for (const release of held.splice(0)) release() })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
    expect(checkboxDisabled()).toEqual([false, false, false])
    expect(checkboxStates()).toEqual([false, false, false])
    expect(posts.map(post => post.body['model'])).toEqual(['glm-5.3', 'no-context'])
  })

  it('refreshing re-reads the section, so an account switch swaps the whole list', async () => {
    await mount()
    expect(checkboxStates()).toEqual([true, false, true])
    signedIn({ visibility: { account: 'u2:', disabled: [] } })
    const refresh = view!.root.findAllByType('button').find(node => node.children.join('') === en.refresh)
    if (refresh === undefined) throw new Error('refresh button not found')
    await act(async () => { refresh.props.onClick() })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
    expect(checkboxStates()).toEqual([true, true, true])
  })

  it('a stale write after an account switch is refused, explained, and the list converges', async () => {
    await mount()
    expect(checkboxStates()).toEqual([true, false, true])
    // The host switches accounts after the card's last read: the GET now
    // answers u2's section, and the write is refused.
    postResponse = { state: 'stale-account' }
    statusBody['visibility'] = { account: 'u2:', disabled: [] }
    await toggle(1, true)
    // The write named the account it was rendered from, not the new one.
    expect(posts[0]!.body['account']).toBe('u1:')
    // Refused in the user's language…
    expect(JSON.stringify(view!.toJSON())).toContain(en.visibilityStaleAccount)
    // …and the follow-up read converged the checkboxes onto u2's section.
    expect(checkboxStates()).toEqual([true, true, true])
  })

  it('the international card keeps the maximum-context preference beside the model checkboxes', async () => {
    // The AI card renders both checkbox kinds: the whole-list preference on
    // top, then one per model row. They must not collapse into one group.
    // The fixture carries the field because this host CAN persist the
    // preference — its presence is what the card keys the control on.
    signedIn({ useMaximumContextWindow: false })
    await mount(AI_CARD_VARIANT)
    const boxes = view!.root.findAll(node => node.type === 'input'
      && (node.props as Record<string, unknown>)['type'] === 'checkbox')
    // Preference first (rendered above the rows), then the three model rows.
    expect(boxes).toHaveLength(4)
    const rows = rowTexts()
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain(en.useMaximumContextWindow)
    // The model checkboxes still answer their own list, and a model toggle
    // sends the visibility action — never the preference action.
    expect(checkboxStates()).toEqual([false, true, false, true])
    await toggle(2, true)
    expect(posts[0]!.body['action']).toBe('set-model-visibility')
  })

  it('a host that cannot persist the preference renders the rows but no maximum-context control', async () => {
    // DSH 0.1.7 has no settings section API, so the status document carries no
    // `useMaximumContextWindow` field. The card must degrade to NOT rendering
    // the preference — not render one whose click can only report failure —
    // while the context rows and visibility checkboxes keep working.
    await mount(AI_CARD_VARIANT)
    expect(checkboxStates()).toHaveLength(3)
    expect(rowTexts().some(row => row.includes(en.useMaximumContextWindow))).toBe(false)
    expect(rowTexts()).toHaveLength(3)
  })

  it('context rows carry promo badges and the free chip beside the name', async () => {
    signedIn({
      models: [
        { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79', contextWindow: 1_000_000, defaultContextWindow: 300_000, maxContextWindow: 1_000_000, badges: ['夜间折扣'] },
        { id: 'hy3', name: 'Hy3', credits: 'x0.00', contextWindow: 192_000, free: true },
      ],
    })
    await mount()
    const rows = rowTexts()
    expect(rows[0]).toContain('GLM-5.3')
    expect(rows[0]).toContain(en.badgeNightDiscount)
    expect(rows[1]).toContain('Hy3')
    expect(rows[1]).toContain(en.freeModel)
  })
})
