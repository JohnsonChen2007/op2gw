import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decide, decodeModelsDev, isFreeByName, ModelCatalog } from '../dist/catalog/catalog.js'
import type { ModelPrice } from '../dist/catalog/catalog.js'
import { fallbackFreeModels, verifiedFreeModels } from '../dist/catalog/static-models.js'
import type { ScopedLogger } from '../dist/core/logger.js'

/**
 * Catalog tests — the free-model decision rules and the live "expose every free
 * model" list. The key property under test is that coverage is driven by
 * upstream (S1 x S2) rather than by a hand-maintained array, while the compile
 * time lists stay strictly advisory.
 */

function silentLogger(): ScopedLogger {
  const noop = (): void => {}
  const logger: Record<string, unknown> = { debug: noop, info: noop, warn: noop, error: noop }
  logger.child = () => logger
  return logger as unknown as ScopedLogger
}

function price(partial: Partial<ModelPrice>): ModelPrice {
  return { input: 0, output: 0, deprecated: false, ...partial }
}

test('decide exposes zero-cost models and rejects paid ones', () => {
  const prices = new Map<string, ModelPrice>([
    ['free-by-cost', price({})],
    ['paid', price({ input: 1, output: 2 })],
    ['deprecated-free', price({ deprecated: true })],
    ['unknown-cost', price({ input: undefined, output: undefined })],
  ])
  assert.equal(decide('free-by-cost', prices, true).allowed, true)
  assert.equal(decide('paid', prices, true).allowed, false)
  assert.equal(decide('paid', prices, true).source, 'metadata_paid')
  assert.equal(decide('deprecated-free', prices, true).allowed, false)
  assert.equal(decide('deprecated-free', prices, true).source, 'metadata_deprecated')
  assert.equal(decide('unknown-cost', prices, true).allowed, false)
})

test('decide falls back to the name heuristic only when metadata cannot speak', () => {
  const pending = new Map<string, ModelPrice>()
  assert.equal(decide('something-free', pending, false).allowed, true, 'name heuristic while pending')
  assert.equal(decide('something-free', pending, false).source, 'name_free')
  // A missing row in ready metadata still lets the name heuristic through.
  const prices = new Map<string, ModelPrice>([['other', price({})]])
  assert.equal(decide('new-thing-free', prices, true).allowed, true)
  assert.equal(decide('new-thing-free', prices, true).source, 'name_free')
  assert.equal(decide('not-marked', prices, true).allowed, false)
})

test('a ready paid verdict beats the name heuristic (no false positives)', () => {
  const prices = new Map<string, ModelPrice>([['tricky-free', price({ input: 3, output: 9 })]])
  const verdict = decide('tricky-free', prices, true)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.source, 'metadata_paid')
})

test('isFreeByName is case-insensitive and substring-based', () => {
  assert.equal(isFreeByName('MIMO-V2.5-FREE'), true)
  assert.equal(isFreeByName('free-something'), true)
  assert.equal(isFreeByName('big-pickle'), false)
})

test('decodeModelsDev prefers the opencode provider and reads zero cost', () => {
  const data = {
    'some-other-provider': { models: { 'should-be-ignored': { cost: { input: 0, output: 0 } } } },
    opencode: {
      models: {
        'free-model': { cost: { input: 0, output: 0 }, limit: { context: 128000, output: 8192 } },
        'paid-model': { cost: { input: 1.5, output: 6 } },
        'retired-model': { cost: { input: 0, output: 0 }, status: 'deprecated' },
        'reasoning-model': { cost: { input: 0, output: 0 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
      },
    },
  }
  const prices = decodeModelsDev(data)
  assert.equal(prices.get('free-model')?.input, 0)
  assert.equal(prices.get('free-model')?.contextWindow, 128000)
  assert.equal(prices.get('paid-model')?.input, 1.5)
  assert.equal(prices.get('retired-model')?.deprecated, true)
  assert.equal(prices.get('reasoning-model')?.reasoning, true)
  assert.deepEqual(prices.get('reasoning-model')?.effortValues, ['low', 'high'])
  assert.equal(prices.has('should-be-ignored'), false, 'only opencode metadata is read')
})

test('an id missing from metadata is vouched for only when it is a known free id', () => {
  const prices = new Map<string, ModelPrice>([['known', price({})]])
  // 'hev-...' style unknown ids are not auto-admitted...
  assert.equal(decide('mystery-model', prices, true).allowed, false)
  // ...but a name-marked free id is, and a curated fallback id is too.
  assert.equal(decide('mystery-model-free', prices, true).allowed, true)
  assert.ok(fallbackFreeModels.length > 0, 'the curated fallback list is non-empty')
})

/**
 * The end-to-end property that matters: every zero-cost in-sale model is
 * exposed, whether or not it is listed in any compile-time array. This is what
 * makes "support all free models" automatic instead of a code change per model.
 */
test('list() exposes every zero-cost in-sale model without a static list entry', async () => {
  const zenIds = ['brand-new-free-model', 'another-new-free', 'a-paid-model']
  const modelsDev = {
    opencode: {
      models: {
        'brand-new-free-model': { cost: { input: 0, output: 0 } },
        'another-new-free': { cost: { input: 0, output: 0 } },
        'a-paid-model': { cost: { input: 2, output: 8 } },
      },
    },
  }
  const fetchImpl = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/v1/models')) {
      return new Response(JSON.stringify({ object: 'list', data: zenIds.map((id) => ({ id })) }), { status: 200 })
    }
    return new Response(JSON.stringify(modelsDev), { status: 200 })
  }) as unknown as typeof fetch

  const catalog = new ModelCatalog({
    zenBaseUrl: 'https://zen.example',
    metadataUrl: 'https://metadata.example/api.json',
    refreshSeconds: 300,
    cachePath: '/tmp/op2gw-test-cache-does-not-write.json',
    logger: silentLogger(),
    fetchImpl,
  })
  await catalog.refreshOnce()
  const list = catalog.list()
  assert.ok(list.includes('brand-new-free-model'), 'a brand-new free model is exposed with no code change')
  assert.ok(list.includes('another-new-free'))
  assert.equal(list.includes('a-paid-model'), false, 'paid models stay hidden')
})

test('list() falls back to the verified bootstrap list before S1 lands', () => {
  const catalog = new ModelCatalog({
    zenBaseUrl: 'https://zen.example',
    metadataUrl: 'https://metadata.example/api.json',
    refreshSeconds: 300,
    cachePath: '/tmp/op2gw-test-cache-does-not-write.json',
    logger: silentLogger(),
  })
  assert.deepEqual(catalog.list(), [...verifiedFreeModels], 'cold start advertises the verified subset')
})
