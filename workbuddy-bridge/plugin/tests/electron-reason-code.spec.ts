import { describe, expect, it } from 'vitest'
import { workBuddyWebStatus, type WorkBuddyStatusRouteOptions } from '../src/web-status.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'

/**
 * Issue #48 §5.5: `reasonCode` must survive the host-side trip from the store
 * to the card.
 *
 * The card decides whether to offer the Agent assist block from this field
 * alone, so a code dropped here — or invented here — silently changes which
 * failures get a way out. These tests pin the pass-through and, just as
 * importantly, that nothing is inferred from the prose.
 */

function depsWith(status: Awaited<ReturnType<WorkBuddyCredentialStore['status']>>): WorkBuddyStatusRouteOptions {
  return {
    store: { status: async () => status } as unknown as WorkBuddyCredentialStore,
    client: { fetchCredits: async () => ({ total: 0, accounts: [] }) },
    models: () => [],
  }
}

describe('#48 status document carries reasonCode', () => {
  it('passes a discovery failure through unchanged', async () => {
    const doc = await workBuddyWebStatus(depsWith({
      state: 'signed-out',
      reason: 'no WorkBuddy application was found',
      reasonCode: 'electron-binary-not-found',
    }))
    expect(doc).toEqual({
      status: 'signed-out',
      reason: 'no WorkBuddy application was found',
      reasonCode: 'electron-binary-not-found',
    })
  })

  it('passes the not-configured code through for the other product', async () => {
    const doc = await workBuddyWebStatus(depsWith({
      state: 'signed-out',
      reason: 'no WorkBuddy Electron binary is configured for this platform',
      reasonCode: 'electron-binary-unavailable',
    }))
    expect(doc.status).toBe('signed-out')
    // Never rewritten into `not-found`: that would claim a search happened.
    expect('reasonCode' in doc && doc.reasonCode).toBe('electron-binary-unavailable')
  })

  it('omits the field entirely when the store reports no code', async () => {
    const doc = await workBuddyWebStatus(depsWith({ state: 'signed-out', reason: 'something old' }))
    // Absent, not `undefined`: the card's presence check is what keeps an
    // older host from rendering the assist block.
    expect('reasonCode' in doc).toBe(false)
    expect(doc).toEqual({ status: 'signed-out', reason: 'something old' })
  })

  it('never derives a code from the reason text', async () => {
    // Prose that mentions every failure shape, with no code supplied.
    const doc = await workBuddyWebStatus(depsWith({
      state: 'signed-out',
      reason: 'the WorkBuddy Electron binary is not available at /Applications/WorkBuddy.app;'
        + ' more than one application was found; the search did not finish',
    }))
    expect('reasonCode' in doc).toBe(false)
  })
})
