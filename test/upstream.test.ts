import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { classifyStatus, classifyTransport, wrapWatchdog } from '../dist/gateway/upstream.js'

/**
 * Upstream classifier + watchdog tests. The classifiers drive the pool's
 * cooldown/ban/rotate taxonomy, and the watchdog is the only thing standing
 * between a half-open proxy tunnel and a hung request — both deserve locks.
 */

test('classifyStatus maps HTTP codes to the pool taxonomy', () => {
  assert.equal(classifyStatus(429), 'limited')
  assert.equal(classifyStatus(401), 'refused')
  assert.equal(classifyStatus(403), 'refused')
  assert.equal(classifyStatus(500), 'server')
  assert.equal(classifyStatus(502), 'server')
  assert.equal(classifyStatus(400), 'server', 'other 4xx are server-shaped, not exit bans')
})

test('classifyStatus detects a region refusal from the body hint', () => {
  assert.equal(classifyStatus(403, '{"error":"RegionError: not available"}'), 'region')
  assert.equal(classifyStatus(403, 'This model is not available in your country.'), 'region')
  assert.equal(classifyStatus(403, 'plain forbidden'), 'refused')
  assert.equal(classifyStatus(401, 'RegionError'), 'region', 'region hint wins even on 401')
})

test('classifyTransport maps network failures without hanging the pool', () => {
  assert.equal(classifyTransport('upstream transport failure: 429 Too Many Requests'), 'limited')
  assert.equal(classifyTransport('rate limited by upstream'), 'limited')
  assert.equal(classifyTransport('upstream HTTP 403 RegionError'), 'refused')
  assert.equal(classifyTransport('connect ECONNREFUSED 1.2.3.4:8080'), 'transport')
  assert.equal(classifyTransport('socket hang up'), 'transport')
  assert.equal(classifyTransport('upstream HTTP 500 Internal server error'), 'server')
})

function collect(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    stream.on('data', (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))))
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    stream.on('error', reject)
  })
}

function tickingSource(chunks: string[], intervalMs: number): Readable {
  return Readable.from(
    (async function* () {
      for (const chunk of chunks) {
        yield chunk
        await new Promise((r) => setTimeout(r, intervalMs))
      }
    })(),
  )
}

test('wrapWatchdog passes a healthy stream through untouched', async () => {
  const out = wrapWatchdog(Readable.from(['a', 'b', 'c']), 1000, 1000)
  assert.equal(await collect(out), 'abc')
})

test('wrapWatchdog with zero windows returns the source as-is', async () => {
  const source = Readable.from(['x'])
  assert.equal(wrapWatchdog(source, 0, 0), source, 'no watchdog configured -> identity')
})

test('wrapWatchdog fires the first-byte timeout on a silent source', async () => {
  const source = Readable.from(
    (async function* () {
      await new Promise((r) => setTimeout(r, 500))
      yield 'too late'
    })(),
  )
  const out = wrapWatchdog(source, 30, 1000)
  await assert.rejects(collect(out), /first-byte timeout/)
})

test('wrapWatchdog fires the body-idle timeout between chunks', async () => {
  const out = wrapWatchdog(tickingSource(['first', 'second'], 300), 1000, 50)
  await assert.rejects(collect(out), /body idle timeout/)
})

test('wrapWatchdog tolerates chunks inside the idle window', async () => {
  const out = wrapWatchdog(tickingSource(['a', 'b', 'c'], 10), 1000, 500)
  assert.equal(await collect(out), 'abc')
})
