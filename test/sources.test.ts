import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildProxyUri, splitProxyUri, parseProxyLine, proxyToExit, FreeSources } from '../dist/pool/sources.js'
import type { ScopedLogger } from '../dist/core/logger.js'

/**
 * Proxy-line builder/splitter and FreeSources tests — the structured-parts
 * helpers the admin API accepts and the free-source fetcher's parsing,
 * dedupe, limit, and circuit-breaker behavior.
 */

function silentLogger(): ScopedLogger {
  const noop = (): void => {}
  const logger: Record<string, unknown> = { debug: noop, info: noop, warn: noop, error: noop }
  logger.child = () => logger
  return logger as unknown as ScopedLogger
}

test('buildProxyUri assembles structured parts with percent-encoded credentials', () => {
  assert.equal(buildProxyUri({ host: 'h', port: 1080 }), 'http://h:1080', 'scheme defaults to http')
  assert.equal(
    buildProxyUri({ scheme: 'socks5h', host: 'h', port: 1, username: 'u', password: 'p' }),
    'socks5://u:p@h:1',
    'socks5h canonicalizes to socks5',
  )
  assert.equal(
    buildProxyUri({ scheme: 'http', host: 'h', port: 1, username: 'u@me', password: 'p:ss/w' }),
    'http://u%40me:p%3Ass%2Fw@h:1',
    'special characters in credentials are percent-encoded',
  )
  assert.equal(buildProxyUri({ scheme: 'http', host: 'h', port: 1, password: 'onlypass' }), 'http://:onlypass@h:1')
})

test('buildProxyUri rejects invalid parts', () => {
  assert.equal(buildProxyUri({ scheme: 'ftp', host: 'h', port: 1 }), null, 'unsupported scheme')
  assert.equal(buildProxyUri({ scheme: 'vmess', host: 'h', port: 1 }), null, 'encrypted transports are out of scope')
  assert.equal(buildProxyUri({ scheme: 'http', host: '', port: 1 }), null, 'missing host')
  assert.equal(buildProxyUri({ scheme: 'http', host: 'h o', port: 1 }), null, 'host with whitespace')
  assert.equal(buildProxyUri({ scheme: 'http', host: 'h', port: 0 }), null, 'port below range')
  assert.equal(buildProxyUri({ scheme: 'http', host: 'h', port: 70000 }), null, 'port above range')
  assert.equal(buildProxyUri({ scheme: 'http', host: 'h' }), null, 'missing port')
})

test('splitProxyUri decodes credentials for the UI round-trip', () => {
  const parts = splitProxyUri('http://u%40me:p%3Ass@h:1080')
  assert.deepEqual(parts, { scheme: 'http', username: 'u@me', password: 'p:ss', host: 'h', port: 1080 })
  const bare = splitProxyUri('socks5://h:1080')
  assert.deepEqual(bare, { scheme: 'socks5', username: '', password: '', host: 'h', port: 1080 })
  assert.equal(splitProxyUri('garbage'), null)
})

test('buildProxyUri / splitProxyUri / parseProxyLine agree on canonical ids', () => {
  const uri = buildProxyUri({ scheme: 'HTTP', host: 'HOST.Example', port: 1080, username: 'U', password: 'P' })!
  assert.equal(uri, 'http://U:P@host.example:1080')
  assert.equal(parseProxyLine(uri), uri, 'parseProxyLine is idempotent on canonical ids')
  assert.equal(proxyToExit(uri).id, uri)
})

test('FreeSources parses, dedupes, and respects the limit', async () => {
  const list = [
    '# comment',
    '',
    'http://a:1',
    'socks5://b:2',
    'socks4://c:3',
    'http://a:1',
    'garbage line',
    'http://d:4',
  ].join('\n')
  const seenUrls: string[] = []
  const fetchImpl = (async (url: unknown) => {
    seenUrls.push(String(url))
    return new Response(list)
  }) as unknown as typeof fetch
  const sources = new FreeSources(['http://list.example/p'], silentLogger(), { fetchImpl })
  const out = await sources.fetchAll(10)
  assert.deepEqual(seenUrls, ['http://list.example/p'])
  assert.deepEqual(
    out.map((e) => e.id),
    ['http://a:1', 'socks5://b:2', 'http://d:4'],
    'comments, blanks, socks4, junk, and duplicates are dropped',
  )
  assert.equal(sources.states()[0]?.yielded, 3)
  // Limit caps how many candidates are returned.
  const capped = await sources.fetchAll(1)
  assert.equal(capped.length, 1)
})

test('FreeSources circuit-breaker disables a source after repeated failures', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    throw new Error('boom')
  }) as unknown as typeof fetch
  const sources = new FreeSources(['http://dead.example/p'], silentLogger(), { fetchImpl, maxFailures: 2, cooldownMs: 60_000 })
  await sources.fetchAll(10)
  await sources.fetchAll(10)
  assert.equal(calls, 2)
  assert.ok((sources.states()[0]?.disabledUntil ?? 0) > Date.now())
  // Next round skips the tripped source entirely.
  await sources.fetchAll(10)
  assert.equal(calls, 2)
  assert.equal(sources.states()[0]?.consecutiveFailures, 2)
})

test('FreeSources records lastError on failures', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  const sources = new FreeSources(['http://err.example/p'], silentLogger(), { fetchImpl, maxFailures: 5 })
  await sources.fetchAll(10)
  assert.equal(sources.states()[0]?.lastError, 'HTTP 500')
  assert.deepEqual(await sources.fetchAll(10).then((o) => o), [])
})
