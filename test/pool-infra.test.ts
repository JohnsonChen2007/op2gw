import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DispatcherCache } from '../dist/pool/dispatchers.js'
import { Prober } from '../dist/pool/prober.js'
import { ExitPool } from '../dist/pool/pool.js'
import { Logger } from '../dist/core/logger.js'
import type { ExitNode } from '../dist/core/types.js'

/**
 * DispatcherCache + Prober tests.
 *
 * The dispatcher cache is the per-exit connection-pool ownership (LRU cap,
 * default-proxy swap); the prober is the background admission check. Both are
 * exercised offline: the prober gets an injected fetchIp so no network moves.
 */

function node(id: string, over: Partial<ExitNode> = {}): Omit<ExitNode, 'addedAt'> {
  return {
    id,
    kind: id.startsWith('socks5') ? 'socks5' : 'http',
    source: 'manual',
    pinned: false,
    exitIP: '',
    location: '',
    latencyMs: 0,
    ...over,
  }
}

function quietLogger() {
  const logger = new Logger({ level: 'error', stdout: false, capacity: 10, traceCapacity: 10 })
  return logger.child('test')
}

test('forExit caches per exit id and evicts LRU past the cap', async () => {
  const cache = new DispatcherCache({ cap: 2 })
  try {
    const a1 = cache.forExit({ ...node('http://a:1'), addedAt: 0 })
    assert.equal(cache.forExit({ ...node('http://a:1'), addedAt: 0 }), a1, 'same exit id returns the cached dispatcher')
    const b1 = cache.forExit({ ...node('http://b:1'), addedAt: 0 })
    assert.notEqual(a1, b1)
    // Touch a so b becomes LRU, then add c: b (not a) must be evicted.
    cache.forExit({ ...node('http://a:1'), addedAt: 0 })
    const c1 = cache.forExit({ ...node('http://c:1'), addedAt: 0 })
    assert.notEqual(c1, a1)
    assert.equal(cache.forExit({ ...node('http://a:1'), addedAt: 0 }), a1, 'recently used entry survives eviction')
    // b was the LRU victim: resolving it again builds a fresh dispatcher
    // (this evicts c, which is fine — the test ends here).
    assert.notEqual(cache.forExit({ ...node('http://b:1'), addedAt: 0 }), b1, 'evicted entry is rebuilt fresh')
  } finally {
    await cache.destroy()
  }
})

test('setDefaultProxy swaps the direct dispatcher and reports the uri', async () => {
  const cache = new DispatcherCache()
  try {
    const plain = cache.directDispatcher()
    cache.setDefaultProxy('http://127.0.0.1:9')
    assert.equal(cache.defaultProxy, 'http://127.0.0.1:9')
    const proxied = cache.directDispatcher()
    assert.notEqual(plain, proxied, 'direct egress now dials through the proxy')
    cache.setDefaultProxy('http://127.0.0.1:9')
    assert.equal(cache.directDispatcher(), proxied, 'same uri is a no-op')
    cache.setDefaultProxy('')
    assert.equal(cache.defaultProxy, '')
    assert.equal(cache.directDispatcher(), plain, 'clearing restores the plain agent')
  } finally {
    await cache.destroy()
  }
})

test('drop removes one exit dispatcher', async () => {
  const cache = new DispatcherCache()
  try {
    const a = cache.forExit({ ...node('http://a:1'), addedAt: 0 })
    cache.drop('http://a:1')
    assert.notEqual(cache.forExit({ ...node('http://a:1'), addedAt: 0 }), a, 'a fresh dispatcher is built after drop')
    cache.drop('http://missing:1')
  } finally {
    await cache.destroy()
  }
})

test('direct exits resolve through the default proxy', async () => {
  const cache = new DispatcherCache({ defaultProxy: 'http://127.0.0.1:9' })
  try {
    assert.equal(cache.defaultProxy, 'http://127.0.0.1:9')
    const direct = cache.forExit({ id: 'direct', kind: 'direct', source: 'direct', pinned: false, exitIP: '', location: '', latencyMs: 0, addedAt: 0 })
    assert.equal(direct, cache.directDispatcher())
  } finally {
    await cache.destroy()
  }
})

test('prober tick admits a healthy exit and records its egress IP', async () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1', { source: 'free' }))
  const cache = new DispatcherCache()
  const prober = new Prober(pool, cache, quietLogger(), {
    fetchIp: async () => ({ ip: '9.9.9.9', latencyMs: 42 }),
  })
  try {
    await prober.tick()
    const view = pool.view().find((e) => e.id === 'http://a:1')
    assert.equal(view?.state, 'ok')
    assert.equal(pool.get('http://a:1')?.exitIP, '9.9.9.9')
    assert.equal(pool.get('http://a:1')?.latencyMs, 42)
  } finally {
    prober.stop()
    await cache.destroy()
  }
})

test('prober tick marks an unreachable free exit dead and evicts it past the threshold', async () => {
  const pool = new ExitPool({ deadRecheckMs: 0, deadEvictions: 1 })
  pool.add(node('http://flaky:1', { source: 'free' }))
  const cache = new DispatcherCache()
  const prober = new Prober(pool, cache, quietLogger(), { maxConcurrent: 2, fetchIp: async () => null })
  try {
    await prober.tick()
    assert.equal(pool.has('http://flaky:1'), false, 'dead free exit evicted after deadEvictions strikes')
  } finally {
    prober.stop()
    await cache.destroy()
  }
})

test('prober never evicts a failing manual exit (probe is advisory for user exits)', async () => {
  const pool = new ExitPool({ deadRecheckMs: 0, deadEvictions: 1 })
  pool.add(node('http://manual:1', { source: 'manual' }))
  const cache = new DispatcherCache()
  const prober = new Prober(pool, cache, quietLogger(), { fetchIp: async () => null })
  try {
    await prober.tick()
    assert.equal(pool.has('http://manual:1'), true, 'user-asserted exits survive probe failures')
    assert.equal(pool.isUsable('http://manual:1', 'm'), true, 'still usable (unknown, not dead)')
  } finally {
    prober.stop()
    await cache.destroy()
  }
})

test('prober skips a second overlapping tick', async () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1', { source: 'free' }))
  let calls = 0
  const cache = new DispatcherCache()
  const prober = new Prober(pool, cache, quietLogger(), {
    fetchIp: async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 50))
      return { ip: '1.1.1.1', latencyMs: 1 }
    },
  })
  try {
    await Promise.all([prober.tick(), prober.tick()])
    assert.equal(calls, 1, 'concurrent ticks collapse into one round')
  } finally {
    prober.stop()
    await cache.destroy()
  }
})
