import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { DispatcherCache } from '../dist/pool/dispatchers.js'
import { Prober, defaultFetchIp } from '../dist/pool/prober.js'
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

test('a failed multi-site probe round kills a manual exit but never evicts it', async () => {
  const pool = new ExitPool({ deadRecheckMs: 0, deadEvictions: 1 })
  pool.add(node('http://manual:1', { source: 'manual' }))
  const cache = new DispatcherCache()
  const prober = new Prober(pool, cache, quietLogger(), { fetchIp: async () => null })
  try {
    await prober.tick()
    assert.equal(pool.has('http://manual:1'), true, 'user-asserted exits are never evicted')
    assert.equal(pool.isUsable('http://manual:1', 'm'), false, 'the dead verdict comes from the verified probe round')
    // On-demand recovery (pool starved): a forced round re-verifies dead
    // exits regardless of the recheck schedule and revives them on success.
    const okProber = new Prober(pool, cache, quietLogger(), { fetchIp: async () => ({ ip: '1.2.3.4', latencyMs: 10 }) })
    await okProber.tick(true)
    okProber.stop()
    assert.equal(pool.isUsable('http://manual:1', 'm'), true, 'forced verification revives a healthy exit')
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

// --- defaultFetchIp semantics -------------------------------------------------
//
// The probe verifies REACHABILITY, not endpoint semantics: any HTTP response
// (404/429/5xx included) proves the tunnel stands, because the proxy lines
// this gateway rides sometimes hard-reset the generic connectivity sites
// while the upstream itself works fine (observed 2026-10-02). Targets are
// injected so these tests stay fully offline.

function localExit(): ExitNode {
  // kind 'direct' + a non-'direct' id resolves to the plain agent (no proxy),
  // while dueForProbe still considers it a probeable exit.
  return { id: 'local-exit', kind: 'direct', source: 'manual', pinned: false, exitIP: '', location: '', latencyMs: 0, addedAt: 0 }
}

async function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}` }
}

test('defaultFetchIp: any HTTP status proves the tunnel (404 still counts)', async () => {
  const cache = new DispatcherCache()
  const { server, url } = await listen((_req, res) => {
    res.statusCode = 404
    res.end('not found')
  })
  try {
    const result = await defaultFetchIp(localExit(), cache, undefined, [{ url, identity: false }])
    assert.notEqual(result, null, 'a 404 response still proves TCP+TLS+HTTP through the tunnel')
    assert.equal(result!.ip, '', 'a non-identity target yields no egress IP')
    assert.ok(result!.latencyMs >= 0)
  } finally {
    server.close()
    await cache.destroy()
  }
})

test('defaultFetchIp: identity target returns the egress IP from JSON', async () => {
  const cache = new DispatcherCache()
  const { server, url } = await listen((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ip: '9.9.9.9' }))
  })
  try {
    const result = await defaultFetchIp(localExit(), cache, undefined, [{ url, identity: true }])
    assert.notEqual(result, null)
    assert.equal(result!.ip, '9.9.9.9')
  } finally {
    server.close()
    await cache.destroy()
  }
})

test('defaultFetchIp: a transport error on every target fails the round', async () => {
  const cache = new DispatcherCache()
  // Grab a port and close the server: connecting to it is refused instantly.
  const { server, url } = await listen(() => {})
  await new Promise<void>((resolve) => server.close(() => resolve()))
  try {
    const result = await defaultFetchIp(localExit(), cache, undefined, [{ url, identity: false }])
    assert.equal(result, null, 'connection refused on every target means no proof of reachability')
  } finally {
    await cache.destroy()
  }
})

test('defaultFetchIp: upstream target is probed first and alone decides the round', async () => {
  const cache = new DispatcherCache()
  // Upstream answers 429; the (injected) generic target refuses connections.
  // The round must pass on the upstream response alone.
  const { server, url } = await listen((_req, res) => {
    res.statusCode = 429
    res.end('limited')
  })
  const closed = await listen(() => {})
  await new Promise<void>((resolve) => closed.server.close(() => resolve()))
  try {
    const result = await defaultFetchIp(localExit(), cache, `${url}/v1/models`, [{ url: closed.url, identity: false }])
    assert.notEqual(result, null, 'a 429 from the upstream endpoint proves the exit can carry gateway traffic')
  } finally {
    server.close()
    await cache.destroy()
  }
})

test('prober with the default fetchIp admits an exit whose upstream answers', async () => {
  const pool = new ExitPool()
  pool.add(localExit())
  const cache = new DispatcherCache()
  const { server, url } = await listen((_req, res) => {
    // Deliberately a non-2xx status: reachability, not endpoint health.
    res.statusCode = 404
    res.end()
  })
  const prober = new Prober(pool, cache, quietLogger(), {
    upstreamUrl: `${url}/v1/models`,
    // Restrict to the local target only so the test never touches the network.
    fetchIp: (exit, dispatchers, upstream) => defaultFetchIp(exit, dispatchers, upstream, []),
  })
  try {
    await prober.tick()
    const view = pool.view().find((e) => e.id === 'local-exit')
    assert.equal(view?.state, 'ok', 'the exit is admitted on the strength of the upstream answer')
  } finally {
    prober.stop()
    server.close()
    await cache.destroy()
  }
})
