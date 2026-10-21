import { describe, expect, it, vi } from 'vitest'
import type { WorkBuddyUpdateFetch } from '../src/update.ts'
import {
  checkWorkBuddyUpdate,
  compareWorkBuddyVersions,
  parseWorkBuddyUpdateResult,
  parseWorkBuddyVersion,
  releasePageUrl,
  WORKBUDDY_UPDATE_NPM_METADATA_URL,
  WORKBUDDY_UPDATE_RELEASES_API_URL,
} from '../src/update.ts'

/**
 * The update check in three layers, each degrading on its own: the npm
 * judgement, the GitHub enrichment, and the browser-side re-validation of
 * whatever the host route answered.
 */

function jsonResponse(body: unknown, options: { padBytes?: number } = {}): Response {
  let text = JSON.stringify(body)
  if (options.padBytes !== undefined) text = text + ' '.repeat(options.padBytes)
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })
}

function npmFetch(distTags: Record<string, string>, releases: unknown[] | 'fail' = []): WorkBuddyUpdateFetch {
  return async (input: string) => {
    if (input === WORKBUDDY_UPDATE_NPM_METADATA_URL) return jsonResponse({ 'dist-tags': distTags })
    if (input === WORKBUDDY_UPDATE_RELEASES_API_URL) {
      if (releases === 'fail') throw new Error('github unavailable')
      return jsonResponse(releases)
    }
    throw new Error(`unexpected url: ${String(input)}`)
  }
}

function releaseEntry(tag: string, options: { name?: string, body?: string } = {}): Record<string, unknown> {
  return { tag_name: tag, name: options.name ?? `v${tag} summary`, body: options.body ?? 'notes', published_at: '2026-09-26T06:42:04Z' }
}

describe('version comparison', () => {
  it('orders plain SemVer numerically, never lexically', () => {
    expect(compareWorkBuddyVersions('0.6.10', '0.6.2')).toBeGreaterThan(0)
    expect(compareWorkBuddyVersions('0.6.3', 'v0.6.3')).toBe(0)
    expect(compareWorkBuddyVersions('0.7.0-alpha.1', '0.7.0')).toBeLessThan(0)
    expect(parseWorkBuddyVersion('not-a-version')).toBeUndefined()
    expect(parseWorkBuddyVersion('01.2.3')).toBeUndefined()
  })
})

describe('the npm judgement', () => {
  it('reads only the latest dist-tag', async () => {
    const fetchImpl = npmFetch({ latest: '0.6.3', beta: '0.7.0-beta.1' }, 'fail')
    // The beta tag is newer but is not this plugin's release line; up-to-date
    // must hold without GitHub ever being asked.
    const result = await checkWorkBuddyUpdate({ currentVersion: '0.6.3', fetchImpl })
    expect(result).toEqual({ status: 'up-to-date', currentVersion: '0.6.3', latestVersion: '0.6.3' })
  })

  it('fails closed on an unparseable current version without any request', async () => {
    const fetchImpl = vi.fn()
    const result = await checkWorkBuddyUpdate({ currentVersion: 'dev', fetchImpl })
    expect(result).toEqual({ status: 'unavailable', currentVersion: 'dev', reason: 'invalid-current-version' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['a registry error', async () => new Response('nope', { status: 500 }), 'registry-unavailable'],
    ['a malformed document', async () => jsonResponse('not-json'.repeat(1) as unknown), 'invalid-registry-response'],
    ['a dist-tag that does not parse', async () => jsonResponse({ 'dist-tags': { latest: 'x.y.z' } }), 'invalid-registry-response'],
  ])('reports unavailable for %s', async (_label, respond, reason) => {
    const result = await checkWorkBuddyUpdate({ currentVersion: '0.6.3', fetchImpl: respond as WorkBuddyUpdateFetch })
    expect(result).toMatchObject({ status: 'unavailable', reason })
  })

  it('rejects an oversized registry body while streaming', async () => {
    // The padding is real body text, not a header claim: the reader must hit
    // the cap while consuming the stream.
    const result = await checkWorkBuddyUpdate({
      currentVersion: '0.6.3',
      fetchImpl: async () => jsonResponse({ 'dist-tags': { latest: '0.6.4' } }, { padBytes: 65 * 1024 }),
    })
    expect(result).toEqual({ status: 'unavailable', currentVersion: '0.6.3', reason: 'invalid-registry-response' })
  })
})

describe('the GitHub enrichment', () => {
  it('keeps only releases in (current, latest], newest first, and counts them', async () => {
    const fetchImpl = npmFetch(
      { latest: '0.6.4' },
      [
        releaseEntry('v0.6.2'),
        releaseEntry('v0.6.4', { name: 'v0.6.4：归因修复', body: '- fix one\n- fix two' }),
        releaseEntry('v0.6.3'),
        releaseEntry('v0.5.9'),
        releaseEntry('v0.7.0-alpha.1'),
        { tag_name: 7 },
      ],
    )
    const result = await checkWorkBuddyUpdate({ currentVersion: '0.6.1', fetchImpl })
    expect(result).toMatchObject({ status: 'update-available', latestVersion: '0.6.4', versionsBehind: 3 })
    if (result.status !== 'update-available') throw new Error('unreachable')
    expect(result.releases.map(release => release.version)).toEqual(['v0.6.4', 'v0.6.3', 'v0.6.2'])
    expect(result.releaseUrl).toBe(releasePageUrl('0.6.4'))
    expect(result.releases[0]).toMatchObject({ name: 'v0.6.4：归因修复', notes: '- fix one\n- fix two', publishedAt: '2026-09-26T06:42:04Z' })
  })

  it('keeps the judgement when GitHub fails, dropping only the enrichment', async () => {
    const result = await checkWorkBuddyUpdate({ currentVersion: '0.6.3', fetchImpl: npmFetch({ latest: '0.6.4' }, 'fail') })
    expect(result).toMatchObject({ status: 'update-available', latestVersion: '0.6.4', releases: [] })
    expect(result).not.toHaveProperty('versionsBehind')
  })

  it('never contacts GitHub when the dist-tags say up-to-date', async () => {
    const github = vi.fn()
    const result = await checkWorkBuddyUpdate({
      currentVersion: '0.6.3',
      fetchImpl: async input => input === WORKBUDDY_UPDATE_NPM_METADATA_URL
        ? jsonResponse({ 'dist-tags': { latest: '0.6.3' } })
        : (github(), jsonResponse([])),
    })
    expect(result).toMatchObject({ status: 'up-to-date' })
    expect(github).not.toHaveBeenCalled()
  })
})

describe('release dedupe by SemVer value', () => {
  it('folds duplicate spellings of one version into a single release', async () => {
    const fetchImpl = npmFetch(
      { latest: '0.6.4' },
      [
        releaseEntry('v0.6.4'),
        releaseEntry('0.6.4'),
        releaseEntry('v0.6.3'),
      ],
    )
    const result = await checkWorkBuddyUpdate({ currentVersion: '0.6.2', fetchImpl })
    expect(result).toMatchObject({ status: 'update-available', versionsBehind: 2 })
    if (result.status !== 'update-available') throw new Error('unreachable')
    // First spelling wins; the second `0.6.4` folded away, and `v0.6.3` counts.
    expect(result.releases.map(release => release.version)).toEqual(['v0.6.4', 'v0.6.3'])
  })

  it('rejects a route answer listing one version under two spellings', () => {
    const forged = {
      status: 'update-available',
      currentVersion: '0.6.2',
      latestVersion: '0.6.4',
      releaseUrl: releasePageUrl('0.6.4'),
      releases: [{ version: 'v0.6.4' }, { version: '0.6.4' }, { version: 'v0.6.3' }],
      versionsBehind: 3,
    }
    expect(parseWorkBuddyUpdateResult(forged)).toBeUndefined()
  })
})

describe('the browser-side re-validation', () => {
  const goodResult = {
    status: 'update-available',
    currentVersion: '0.6.1',
    latestVersion: '0.6.4',
    releaseUrl: releasePageUrl('0.6.4'),
    releases: [
      { version: 'v0.6.4', name: 'summary', notes: 'notes', publishedAt: '2026-09-26T06:42:04Z' },
      { version: 'v0.6.3' },
    ],
    versionsBehind: 2,
  }

  it('accepts a well-formed result', () => {
    expect(parseWorkBuddyUpdateResult(goodResult)).toEqual(goodResult)
  })

  it('rejects a release URL the version does not spell', () => {
    expect(parseWorkBuddyUpdateResult({ ...goodResult, releaseUrl: 'https://evil.example/x' })).toBeUndefined()
  })

  it('rejects releases outside (current, latest] and duplicate versions', () => {
    expect(parseWorkBuddyUpdateResult({ ...goodResult, releases: [{ version: 'v0.5.9' }] })).toBeUndefined()
    expect(parseWorkBuddyUpdateResult({ ...goodResult, releases: [{ version: 'v0.9.9' }] })).toBeUndefined()
    expect(parseWorkBuddyUpdateResult({ ...goodResult, releases: [{ version: 'v0.6.4' }, { version: 'v0.6.4' }] })).toBeUndefined()
  })

  it('rejects a versionsBehind that disagrees with the list', () => {
    expect(parseWorkBuddyUpdateResult({ ...goodResult, versionsBehind: 5 })).toBeUndefined()
    expect(parseWorkBuddyUpdateResult({ ...goodResult, versionsBehind: '2' })).toBeUndefined()
  })

  it('rejects an update-available whose latest does not exceed current', () => {
    expect(parseWorkBuddyUpdateResult({ ...goodResult, latestVersion: '0.6.1' })).toBeUndefined()
  })

  it('carries the unavailable reasons through', () => {
    expect(parseWorkBuddyUpdateResult({ status: 'unavailable', currentVersion: '0.6.3', reason: 'registry-unavailable' }))
      .toEqual({ status: 'unavailable', currentVersion: '0.6.3', reason: 'registry-unavailable' })
    expect(parseWorkBuddyUpdateResult({ status: 'unavailable', currentVersion: '0.6.3', reason: 'something-else' })).toBeUndefined()
    expect(parseWorkBuddyUpdateResult('junk')).toBeUndefined()
  })
})
