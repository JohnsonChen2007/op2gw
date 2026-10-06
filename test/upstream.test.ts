import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  classifyStatus,
  classifyTransport,
  parseRetryAfter,
  wrapDeadline,
  wrapWatchdog,
} from '../dist/gateway/upstream.js'

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

test('parseRetryAfter reads delta-seconds and HTTP-dates, and caps both', () => {
  assert.equal(parseRetryAfter('5'), 5000)
  assert.equal(parseRetryAfter('0'), undefined, 'zero means retry now')
  assert.equal(parseRetryAfter('-30'), undefined, 'negative is meaningless')
  assert.equal(parseRetryAfter(undefined), undefined)
  assert.equal(parseRetryAfter('not-a-date'), undefined)

  const now = Date.UTC(2026, 9, 6, 0, 0, 0)
  const at = new Date(now + 30_000).toUTCString()
  assert.equal(parseRetryAfter(at, now), 30_000, 'HTTP-date form')

  // A hostile value must not park an exit in cooldown for hours.
  assert.equal(parseRetryAfter('999999'), 5 * 60_000)
})

test('wrapDeadline returns the source untouched when the budget is disabled', () => {
  const source = Readable.from(['x'])
  assert.equal(wrapDeadline(source, 0), source)
})

test('wrapDeadline passes a stream that finishes inside the budget', async () => {
  const out = wrapDeadline(tickingSource(['a', 'b', 'c'], 10), 2000)
  assert.equal(await collect(out), 'abc')
})

test('wrapDeadline bounds a non-streaming body that never ends', async () => {
  // The non-streaming path deliberately has NO idle watchdog (a slow reasoning
  // model may go quiet for minutes), so this total budget is the only thing
  // between a half-open upstream and a request that never returns.
  const source = Readable.from(
    (async function* () {
      yield 'head'
      await new Promise((r) => setTimeout(r, 5000))
      yield 'never reached'
    })(),
  )
  const out = wrapDeadline(source, 60)
  await assert.rejects(collect(out), /budget/)
})

test('wrapDeadline releases the upstream when its consumer walks away', async () => {
  let released = false
  const source = new Readable({
    read() {},
  })
  source.on('close', () => {
    released = true
  })
  const out = wrapDeadline(source, 60_000)
  source.push('chunk')
  // A plain destroy — no error — because nothing is consuming `out` here.
  // Passing an error would trip Node's "destroyed without error listener"
  // guard and fail the test for the wrong reason; the behaviour under test is
  // that dropping the consumer releases the upstream, not what `out` throws.
  out.destroy()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(released, true, 'an abandoned read must not keep the upstream pinned open')
})
