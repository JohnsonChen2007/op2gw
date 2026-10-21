import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_CARD_VARIANT,
  CN_CARD_VARIANT,
  WorkBuddyPluginCard,
  type WorkBuddyCardVariant,
  type WorkBuddyPluginCardProps,
} from '../src/client/WorkBuddyPluginCard.tsx'
import { en, zh, type WorkBuddySettingsKey } from '../src/client/locales.ts'
import { isWorkBuddyWebStatus } from '../src/client/status-document.ts'
import { isWorkBuddySignedOutReasonCode } from '../src/status-paths.ts'

/**
 * Issue #48 A+: the card's Agent assist block.
 *
 * The block exists so a user whose app is somewhere the plugin did not look
 * gets a way out without knowing what an environment variable is. These tests
 * pin the two contracts that make it correct rather than merely present: it is
 * shown for exactly the failure codes it can fix, and its prompt never claims
 * a search that did not happen.
 */

const t = (key: WorkBuddySettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

/** The five codes §5.5 lists as "no usable decryption program". */
const ASSIST_CODES = [
  'electron-binary-not-found',
  'electron-binary-ambiguous',
  'electron-binary-unavailable',
  'electron-path-invalid',
  'electron-discovery-incomplete',
] as const

describe('#48 card assist block', () => {
  let view: ReactTestRenderer | undefined
  let statusBody: Record<string, unknown>
  const request = vi.fn()

  beforeEach(() => {
    statusBody = { status: 'signed-out' }
    request.mockReset().mockImplementation(async () => ({ ok: true, json: async () => statusBody }))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => {} } })
  })

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  async function mount(variant?: WorkBuddyCardVariant): Promise<string> {
    await act(async () => {
      const props = {
        t: t as WorkBuddyPluginCardProps['t'],
        ...variant === undefined ? {} : { variant },
      } as unknown as Parameters<typeof WorkBuddyPluginCard>[0]
      view = create(createElement(WorkBuddyPluginCard, props))
    })
    // Expand the card; the body is where the block lives.
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
    return JSON.stringify(view!.toJSON())
  }

  /** The single rendered button whose label is exactly `label`. */
  function findButton(label: string): { props: { onClick: () => void } } {
    const found = view!.root.findAllByType('button').filter(button => {
      const children = button.props.children
      return typeof children === 'string' ? children === label : false
    })
    expect(found).toHaveLength(1)
    return found[0] as unknown as { props: { onClick: () => void } }
  }

  it.each(ASSIST_CODES)('shows the assist block for %s', async code => {
    statusBody = { status: 'signed-out', reason: 'a diagnosis', reasonCode: code }
    const rendered = await mount(CN_CARD_VARIANT)
    expect(rendered).toContain(en.assistantHeading)
    expect(rendered).toContain(en.assistantCopy)
    expect(rendered).toContain(en.assistantRecheck)
    // The short diagnosis is still shown: the block adds a way out rather than
    // replacing the explanation.
    expect(rendered).toContain('a diagnosis')
  })

  it('does not show the block for a plain sign-out', async () => {
    statusBody = { status: 'signed-out', reasonCode: 'no-credential' }
    const rendered = await mount(CN_CARD_VARIANT)
    expect(rendered).not.toContain(en.assistantHeading)
    expect(rendered).toContain(en.signedOutHint)
  })

  it('does not show the block when the encrypted credential could not be opened', async () => {
    // The app was found and ran; "go look for the app" is not the fix, so
    // offering it here would send the user down a dead end.
    statusBody = { status: 'signed-out', reason: 'key mismatch', reasonCode: 'encrypted-credential-unreadable' }
    const rendered = await mount(CN_CARD_VARIANT)
    expect(rendered).not.toContain(en.assistantHeading)
    expect(rendered).toContain('key mismatch')
  })

  it('does not show the block for a legacy host that sends no reasonCode', async () => {
    // Backward compatible: an older host renders its reason and nothing else.
    statusBody = { status: 'signed-out', reason: 'the WorkBuddy Electron binary is not available at /Applications/...' }
    const rendered = await mount(CN_CARD_VARIANT)
    expect(rendered).not.toContain(en.assistantHeading)
    expect(rendered).toContain('is not available at')
  })

  it('ignores an out-of-enum reasonCode rather than branching on it', async () => {
    statusBody = { status: 'signed-out', reason: 'from the future', reasonCode: 'electron-something-new' }
    const rendered = await mount(CN_CARD_VARIANT)
    expect(rendered).not.toContain(en.assistantHeading)
    expect(rendered).toContain('from the future')
  })

  it('shows the block for the international card too, naming WorkBuddy AI', async () => {
    // Auto-discovery is product/platform-specific, but the prompt is offered
    // for Global as well:
    // whether we search and whether we help are independent decisions.
    statusBody = { status: 'signed-out', reason: 'not configured', reasonCode: 'electron-binary-unavailable' }
    const rendered = await mount(AI_CARD_VARIANT)
    expect(rendered).toContain(en.assistantHeading)
    expect(rendered).toContain('WorkBuddy AI')
    expect(rendered).toContain(en.assistUnavailableAI)
  })

  it('names the CN product and its own summary on the CN card', async () => {
    statusBody = { status: 'signed-out', reason: 'gone', reasonCode: 'electron-binary-not-found' }
    const rendered = await mount(CN_CARD_VARIANT)
    expect(rendered).toContain('WorkBuddy')
    expect(rendered).toContain(en.assistNotFound)
  })

  it('never claims a search happened when nothing was searched', async () => {
    // `unavailable` means no discovery was configured for this product or
    // platform. Saying "we looked and did not find it" would be false.
    statusBody = { status: 'signed-out', reason: 'not configured', reasonCode: 'electron-binary-unavailable' }
    const rendered = await mount(CN_CARD_VARIANT)
    const summary = en.assistUnavailableCN.toLowerCase()
    for (const claim of ['search', 'searched', 'looked', 'found']) {
      expect(summary).not.toContain(claim)
      expect(rendered.toLowerCase()).not.toContain(`no usable decryption program was found`)
    }
    // And the summaries genuinely differ, so the two failures are not conflated.
    expect(en.assistUnavailableCN).not.toBe(en.assistNotFound)
    expect(en.assistUnavailableCN).not.toBe(en.assistIncomplete)
  })

  it('carries the temporary-shell warning in both languages', async () => {
    // The whole point of the prompt: an `export` in the Agent's own shell does
    // not reach the process that already launched DSH.
    expect(en.assistantPrompt).toContain('do not only set an environment variable temporarily')
    expect(zh.assistantPrompt).toContain('不要只在当前 shell 临时设置环境变量')
    // And it must not name one specific env var: the right fix depends on how
    // DSH was launched, which the Agent is being asked to work out.
    expect(en.assistantPrompt).not.toContain('WORKBUDDY_ELECTRON_BIN')
    expect(zh.assistantPrompt).not.toContain('WORKBUDDY_ELECTRON_BIN')
  })

  it('copies the prompt and reports success without sending anything', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    statusBody = { status: 'signed-out', reason: 'gone', reasonCode: 'electron-binary-not-found' }
    await mount(CN_CARD_VARIANT)
    await act(async () => { findButton(en.assistantCopy).props.onClick() })
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0]?.[0]
    expect(String(copied)).toContain('WorkBuddy')
    // Copying puts text on the clipboard; it must not reach the network.
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reports a clipboard failure and keeps the text selectable', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied') } } })
    statusBody = { status: 'signed-out', reason: 'gone', reasonCode: 'electron-binary-not-found' }
    const rendered = await mount(CN_CARD_VARIANT)
    await act(async () => { findButton(en.assistantCopy).props.onClick() })
    const after = JSON.stringify(view!.toJSON())
    expect(after).toContain(en.assistantCopyFailed)
    // The prompt itself is still on screen to select by hand.
    expect(rendered).toContain('WorkBuddy')
  })

  it('drops the block and shows the account once the recheck succeeds', async () => {
    // Every fetch answers with the current body, so flipping `statusBody`
    // before the click models the host recovering while the card is open.
    statusBody = { status: 'signed-out', reason: 'gone', reasonCode: 'electron-binary-not-found' }
    await mount(CN_CARD_VARIANT)
    statusBody = { status: 'signed-in', nickname: 'Recovered', source: 'desktop' }
    await act(async () => { findButton(en.assistantRecheck).props.onClick() })
    await act(async () => {})
    const after = JSON.stringify(view!.toJSON())
    expect(after).not.toContain(en.assistantHeading)
    expect(after).toContain('Recovered')
  })

  it('keeps the block and its prompt when the recheck still fails', async () => {
    // A click is not a fix: still-broken must keep showing the way out.
    statusBody = { status: 'signed-out', reason: 'still gone', reasonCode: 'electron-binary-not-found' }
    await mount(CN_CARD_VARIANT)
    await act(async () => { findButton(en.assistantRecheck).props.onClick() })
    await act(async () => {})
    const after = JSON.stringify(view!.toJSON())
    expect(after).toContain(en.assistantHeading)
    expect(after).toContain(en.assistantCopy)
    expect(after).toContain('still gone')
  })

  it('keeps the prompt and shows a read failure when the host is unreachable', async () => {
    statusBody = { status: 'signed-out', reason: 'gone', reasonCode: 'electron-binary-not-found' }
    await mount(CN_CARD_VARIANT)
    request.mockImplementation(async () => { throw new Error('offline') })
    await act(async () => { findButton(en.assistantRecheck).props.onClick() })
    await act(async () => {})
    const after = JSON.stringify(view!.toJSON())
    // A transient network error must not cost the user the only way out.
    expect(after).toContain(en.assistantHeading)
    expect(after).toContain(en.assistantCopy)
  })
})

describe('#48 reasonCode reaches the card as a closed enum', () => {
  it('accepts every code in the enum', () => {
    for (const code of ASSIST_CODES) expect(isWorkBuddySignedOutReasonCode(code)).toBe(true)
    expect(isWorkBuddySignedOutReasonCode('no-credential')).toBe(true)
    expect(isWorkBuddySignedOutReasonCode('encrypted-credential-unreadable')).toBe(true)
  })

  it('rejects anything else', () => {
    for (const value of ['', 'electron-binary-gone', 7, null, undefined, {}]) {
      expect(isWorkBuddySignedOutReasonCode(value)).toBe(false)
    }
  })

  it('still accepts a signed-out document whose reasonCode is unknown', () => {
    // A newer host must not brick an older card: the document is valid, the
    // card simply falls back to rendering `reason`.
    expect(isWorkBuddyWebStatus({ status: 'signed-out', reason: 'x', reasonCode: 'from-the-future' })).toBe(true)
    expect(isWorkBuddyWebStatus({ status: 'signed-out', reason: 'x', reasonCode: 'electron-binary-not-found' })).toBe(true)
  })
})
