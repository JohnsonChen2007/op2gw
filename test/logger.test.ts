import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Logger } from '../dist/core/logger.js'

/**
 * Logger unit tests — ring-buffer bounds, level filtering, live subscribers,
 * and request-trace capacity. The debug UI reads all of these over /admin.
 */

function makeLogger() {
  const log = new Logger({ level: 'debug', stdout: false, capacity: 5, traceCapacity: 3 })
  return { log, emit: log.child('t') }
}

test('records are appended newest-last and honor the ring capacity', () => {
  const { log, emit } = makeLogger()
  for (let i = 0; i < 8; i += 1) emit.info(`msg-${i}`, { n: i })
  const records = log.records()
  assert.equal(records.length, 5, 'ring buffer caps at capacity')
  assert.equal(records[0]?.msg, 'msg-3')
  assert.equal(records[4]?.msg, 'msg-7')
})

test('records filter by minimum level and scope', () => {
  const { log } = makeLogger()
  log.child('a').debug('d')
  log.child('a').info('i')
  log.child('b').warn('w')
  log.child('b').error('e')
  assert.equal(log.records({ level: 'warn' }).length, 2, 'warn+error only')
  assert.equal(log.records({ scope: 'a' }).length, 2)
  assert.equal(log.records({ level: 'info', scope: 'b' }).length, 2)
  assert.equal(log.records({ limit: 1 }).length, 1)
})

test('a broken subscriber never breaks logging', () => {
  const { log, emit } = makeLogger()
  log.subscribe(() => {
    throw new Error('listener boom')
  })
  const seen: string[] = []
  log.subscribe((r) => seen.push(r.msg))
  emit.info('still logged')
  assert.deepEqual(seen, ['still logged'])
  assert.equal(log.records().length, 1)
})

test('unsubscribe stops delivery', () => {
  const { log, emit } = makeLogger()
  const seen: string[] = []
  const off = log.subscribe((r) => seen.push(r.msg))
  emit.info('one')
  off()
  emit.info('two')
  assert.deepEqual(seen, ['one'])
})

test('traces are bounded and newest-last', () => {
  const { log } = makeLogger()
  const trace = (id: string) => ({
    id,
    ts: 1,
    model: 'm',
    stream: true,
    status: 200,
    exit: 'direct',
    exitIP: '',
    attempts: 1,
    durationMs: 1,
    outcome: 'ok' as const,
  })
  for (const id of ['a', 'b', 'c', 'd']) log.trace(trace(id))
  assert.deepEqual(
    log.traces().map((t) => t.id),
    ['b', 'c', 'd'],
    'trace buffer caps at traceCapacity',
  )
  assert.deepEqual(
    log.traces(1).map((t) => t.id),
    ['d'],
  )
})

test('setLevel gates emission and nextRequestId is monotonic', () => {
  const { log, emit } = makeLogger()
  log.setLevel('warn')
  assert.equal(log.level, 'warn')
  emit.info('dropped')
  emit.warn('kept')
  assert.deepEqual(log.records().map((r) => r.msg), ['kept'])
  const a = log.nextRequestId()
  const b = log.nextRequestId()
  assert.notEqual(a, b)
  assert.ok(a.startsWith('r') && b.startsWith('r'))
})

test('records carry scope and data only when non-empty', () => {
  const { log } = makeLogger()
  log.child('http').info('plain')
  log.child('http').info('rich', { exit: 'direct' })
  const [plain, rich] = log.records()
  assert.equal(plain?.scope, 'http')
  assert.equal(plain?.data, undefined, 'empty data is omitted')
  assert.deepEqual(rich?.data, { exit: 'direct' })
  assert.ok(typeof plain?.ts === 'number')
})
