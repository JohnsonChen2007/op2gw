import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decide, decodeModelsDev, isFreeByName, ModelCatalog } from '../dist/catalog/catalog.js'
import type { ModelPrice } from '../dist/catalog/catalog.js'
import { fallbackFreeModels, verifiedFreeModels, disabledModels, contextWindowOverrides, maxOutputOverride } from '../dist/catalog/static-models.js'
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
  // ...but a name-marked free id is
  assert.equal(decide('mystery-model-free', prices, true).allowed, true)
  assert.ok(disabledModels.length > 0, 'disabled models list contains broken upstream models')
})

test('disabledModels are filtered out from catalog decision and list', () => {
  const catalog = new ModelCatalog({
    zenBaseUrl: 'https://zen.example',
    metadataUrl: 'https://metadata.example/api.json',
    refreshSeconds: 300,
    cachePath: '/tmp/op2gw-test-cache-disabled.json',
    logger: silentLogger(),
  })
  for (const m of disabledModels) {
    assert.equal(catalog.decision(m).allowed, false, `${m} is disallowed`)
    assert.equal(catalog.decision(m).source, 'model_disabled')
  }
  const list = catalog.list()
  for (const m of disabledModels) {
    assert.equal(list.includes(m), false, `${m} is not in list()`)
  }
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

/**
 * Regression guard: the S1/S2 deadline has to reach the request.
 *
 * `#withTimeout` used to wrap an already-created promise, so its
 * `controller.abort()` fired into the void — nothing was ever cancelled and a
 * source that hung rather than failed fast stalled the whole refresh cycle. The
 * stub below only settles when the signal it was handed actually aborts, so this
 * test hangs (and fails on the suite deadline) if the signal is dropped again.
 */
test('a hung catalog source is cut off by the fetch deadline', async () => {
  const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch

  const catalog = new ModelCatalog({
    zenBaseUrl: 'https://zen.example',
    metadataUrl: 'https://metadata.example/api.json',
    refreshSeconds: 300,
    cachePath: '/tmp/op2gw-test-cache-timeout.json',
    logger: silentLogger(),
    fetchImpl,
    fetchTimeoutMs: 50,
  })

  await catalog.refreshOnce()

  const snap = catalog.snapshot()
  assert.equal(snap.total, 0, 'neither source produced a list')
  assert.equal(snap.status, 'pending', 'a timed-out first fetch is pending, not ready')
  assert.notEqual(snap.lastError, '', 'the timeout is recorded instead of being swallowed')
  assert.equal(catalog.ageMs(), Infinity, 'a timed-out S1 does not count as a refresh')
})

/**
 * The catalog parses `limit.context`/`limit.output` for every model it serves;
 * `/v1/models` must surface them instead of a bare id, so a client can size its
 * own prompt against the window it will actually be truncated and billed against.
 *
 * `contextWindow` is asserted straight from metadata because no override names
 * these ids. `maxOutput` is asserted against `maxOutputOverride` instead: that
 * cap is unconditional, so it also reaches models that declare no limits at all
 * — which is why `free-without-limits` reports the cap instead of `undefined`.
 */
test('limits() surfaces metadata limits, with maxOutput subject to the uniform cap', async () => {
  const zenIds = ['free-with-limits', 'free-without-limits']
  const modelsDev = {
    opencode: {
      models: {
        'free-with-limits': { cost: { input: 0, output: 0 }, limit: { context: 262144, output: 32768 } },
        'free-without-limits': { cost: { input: 0, output: 0 } },
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
    cachePath: '/tmp/op2gw-test-cache-limits.json',
    logger: silentLogger(),
    fetchImpl,
  })
  await catalog.refreshOnce()

  const withLimits = catalog.limits('free-with-limits')
  assert.equal(withLimits?.contextWindow, 262144, 'context window is exposed')
  assert.equal(
    withLimits?.maxOutput,
    maxOutputOverride,
    'max output is the uniform cap, not the metadata value',
  )
  assert.deepEqual(
    catalog.limits('free-without-limits'),
    maxOutputOverride === undefined
      ? undefined
      : { maxOutput: maxOutputOverride },
    'a model with no declared limits still gets the unconditional cap',
  )
})

/**
 * The two advertised-limit overrides are deliberately different shapes.
 *
 * `contextWindowOverrides` is per-id: it raises ONLY the ids it names, so a
 * model already at 1M keeps its live value and an unlisted model is never
 * inflated. `maxOutputOverride` is a single unconditional cap applied to every
 * model — it lowers a generous model and raises a stingy one alike, which is
 * the point of a uniform number.
 */
test('context overrides raise only named ids, while maxOutputOverride caps every model', async () => {
  const zenIds = ['big-pickle', 'some-large-model', 'unlisted-model', 'no-limit-model']
  const modelsDev = {
    opencode: {
      models: {
        'big-pickle': { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } },
        'some-large-model': { cost: { input: 0, output: 0 }, limit: { context: 1048576, output: 524288 } },
        'unlisted-model': { cost: { input: 0, output: 0 }, limit: { context: 262144, output: 262144 } },
        'no-limit-model': { cost: { input: 0, output: 0 } },
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
    cachePath: '/tmp/op2gw-test-cache-ctx-override.json',
    logger: silentLogger(),
    fetchImpl,
  })
  await catalog.refreshOnce()

  // contextWindowOverrides: per-id, raising only what it names.
  assert.equal(
    catalog.limits('big-pickle')?.contextWindow,
    contextWindowOverrides['big-pickle'],
    'a named id is raised to the operator floor',
  )
  assert.equal(
    catalog.limits('some-large-model')?.contextWindow,
    1048576,
    'a model already at 1M keeps its live value',
  )
  assert.equal(
    catalog.limits('unlisted-model')?.contextWindow,
    262144,
    'an id outside the table is not inflated',
  )

  // maxOutputOverride: uniform, in both directions.
  for (const id of ['big-pickle', 'some-large-model', 'unlisted-model', 'no-limit-model']) {
    assert.equal(
      catalog.limits(id)?.maxOutput,
      maxOutputOverride,
      `${id} reports the uniform max-output cap`,
    )
  }
  assert.equal(
    catalog.limits('big-pickle')?.maxOutput! > 32000,
    true,
    'the cap raises a model whose live value was below it',
  )
  assert.equal(
    catalog.limits('some-large-model')?.maxOutput! < 524288,
    true,
    'the cap also lowers a model whose live value was above it',
  )
})
