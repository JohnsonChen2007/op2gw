import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ModelHealth } from '../dist/catalog/model-health.js'
import { ModelCatalog } from '../dist/catalog/catalog.js'
import type { ScopedLogger } from '../dist/core/logger.js'

/**
 * ModelHealth / auto-hide tests.
 *
 * The property under test: a model the upstream keeps failing with a *server*
 * fault disappears from `GET /v1/models`, but only after enough CONSECUTIVE
 * failures, only for that model, and only temporarily. That last word matters
 * most — some ids work in one region and 503 in another (measured 2026-10-22),
 * so hiding must never become permanent or it takes down the good region too.
 */

function silentLogger(): ScopedLogger {
  const noop = (): void => {}
  const logger: Record<string, unknown> = { debug: noop, info: noop, warn: noop, error: noop }
  logger.child = () => logger
  return logger as unknown as ScopedLogger
}

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

test('hides only after the threshold of consecutive server failures', () => {
  const h = new ModelHealth({ failThreshold: 3, ttlMs: 60_000 })
  assert.equal(h.recordFailure('m', 'server'), false)
  assert.equal(h.isHidden('m'), false)
  assert.equal(h.recordFailure('m', 'server'), false)
  assert.equal(h.isHidden('m'), false, 'must stay visible below the threshold')
  assert.equal(h.recordFailure('m', 'server'), true, 'crossing the threshold reports a transition')
  assert.equal(h.isHidden('m'), true)
})

test('one success clears the streak, so an intermittent model is never hidden', () => {
  const h = new ModelHealth({ failThreshold: 3, ttlMs: 60_000 })
  h.recordFailure('m', 'server')
  h.recordFailure('m', 'server')
  h.recordSuccess('m')
  h.recordFailure('m', 'server')
  h.recordFailure('m', 'server')
  assert.equal(h.isHidden('m'), false, 'streak reset means two failures do not reach 3')
  h.recordFailure('m', 'server')
  assert.equal(h.isHidden('m'), true)
})

test('a success un-hides an already hidden model immediately', () => {
  const h = new ModelHealth({ failThreshold: 2, ttlMs: 60_000 })
  h.recordFailure('m', 'server')
  h.recordFailure('m', 'server')
  assert.equal(h.isHidden('m'), true)
  h.recordSuccess('m')
  assert.equal(h.isHidden('m'), false)
})

test('non-server kinds never count — they are about egress, not the model', () => {
  const h = new ModelHealth({ failThreshold: 2, ttlMs: 60_000 })
  for (const kind of ['limited', 'transport', 'region', 'refused']) {
    assert.equal(h.recordFailure('m', kind), false)
  }
  assert.equal(h.isHidden('m'), false)
})

test('hiding is per model and does not leak to siblings', () => {
  const h = new ModelHealth({ failThreshold: 2, ttlMs: 60_000 })
  h.recordFailure('bad', 'server')
  h.recordFailure('bad', 'server')
  assert.equal(h.isHidden('bad'), true)
  assert.equal(h.isHidden('good'), false)
  h.recordFailure('good', 'server')
  assert.equal(h.isHidden('good'), false, 'a different model has its own streak')
})

test('hiding expires on its own so the model is re-advertised', () => {
  const c = clock()
  const h = new ModelHealth({ failThreshold: 2, ttlMs: 60_000, now: c.now })
  h.recordFailure('m', 'server')
  h.recordFailure('m', 'server')
  assert.equal(h.isHidden('m'), true)
  c.advance(59_999)
  assert.equal(h.isHidden('m'), true)
  c.advance(2)
  assert.equal(h.isHidden('m'), false, 'the TTL must release the model')
})

test('after expiry the streak restarts rather than re-hiding on one failure', () => {
  const c = clock()
  const h = new ModelHealth({ failThreshold: 3, ttlMs: 60_000, now: c.now })
  for (let i = 0; i < 3; i += 1) h.recordFailure('m', 'server')
  assert.equal(h.isHidden('m'), true)
  c.advance(61_000)
  assert.equal(h.isHidden('m'), false)
  // One failure after expiry must not immediately hide it again.
  h.recordFailure('m', 'server')
  assert.equal(h.isHidden('m'), false)
})

test('threshold 0 disables auto-hiding entirely', () => {
  const h = new ModelHealth({ failThreshold: 0, ttlMs: 60_000 })
  for (let i = 0; i < 100; i += 1) h.recordFailure('m', 'server')
  assert.equal(h.isHidden('m'), false)
})

test('hidden() reports the active hides with timestamps and the last error', () => {
  const c = clock(Date.parse('2026-10-22T00:00:00Z'))
  const h = new ModelHealth({ failThreshold: 1, ttlMs: 60_000, now: c.now })
  h.recordFailure('m', 'server', 'upstream HTTP 503: Endpoint is unavailable.')
  const view = h.hidden()
  assert.equal(view.length, 1)
  assert.equal(view[0].model, 'm')
  assert.equal(view[0].failures, 1)
  assert.match(view[0].lastError, /Endpoint is unavailable/)
  assert.equal(view[0].hiddenAt, '2026-10-22T00:00:00.000Z')
  assert.equal(view[0].expiresAt, '2026-10-22T00:01:00.000Z')
})

test('the catalog drops an auto-hidden model from list() and restores it', () => {
  const c = clock()
  const catalog = new ModelCatalog({
    zenBaseUrl: 'https://example.invalid/inference',
    metadataUrl: 'https://example.invalid/api.json',
    refreshSeconds: 300,
    cachePath: '/tmp/op2gw-model-health-test-cache.json',
    logger: silentLogger(),
    now: c.now,
    hideAfterFailures: 2,
    hideForMs: 60_000,
  })
  // Seed the catalog without the network: list() falls back to the verified
  // bootstrap ids while S1 has never produced a list.
  const before = catalog.list()
  assert.ok(before.length > 0, 'bootstrap list must be non-empty')
  const victim = before[0]

  catalog.health.recordFailure(victim, 'server')
  assert.ok(catalog.list().includes(victim), 'one failure must not hide it')
  catalog.health.recordFailure(victim, 'server')
  assert.ok(!catalog.list().includes(victim), 'hidden model must leave /v1/models')
  assert.ok(catalog.list().length === before.length - 1, 'only that one entry is removed')

  c.advance(61_000)
  assert.ok(catalog.list().includes(victim), 'the model returns after the hide expires')
})

test('non-server failures leave the catalog list untouched', () => {
  const catalog = new ModelCatalog({
    zenBaseUrl: 'https://example.invalid/inference',
    metadataUrl: 'https://example.invalid/api.json',
    refreshSeconds: 300,
    cachePath: '/tmp/op2gw-model-health-test-cache-2.json',
    logger: silentLogger(),
    hideAfterFailures: 1,
    hideForMs: 60_000,
  })
  const before = catalog.list()
  for (let i = 0; i < 10; i += 1) catalog.health.recordFailure(before[0], 'limited')
  assert.deepEqual(catalog.list(), before, 'quota limits are not model defects')
})
