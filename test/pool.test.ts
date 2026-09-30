import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool } from '../dist/pool/pool.js'
import type { ExitNode } from '../dist/core/types.js'

/**
 * ExitPool unit tests — health tiers, cooldowns, model bans, stickiness,
 * pinning, eviction, and the proxy-switch resets (clearSticky/clearModelBans)
 * the settings-page proxy-pool feature relies on.
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

test('clearSticky drops every session binding', () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1'))
  pool.pick('m', 'sess-1')
  assert.equal(pool.exitOfSession('sess-1'), 'http://a:1')
  pool.clearSticky()
  assert.equal(pool.exitOfSession('sess-1'), null)
})

test('clearModelBans removes only the target exit bans', () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1'))
  pool.add(node('http://b:1'))
  // 'region' bans immediately; 'refused' needs two strikes (suspect -> banned).
  pool.markFailure('http://a:1', 'm', 'region')
  pool.markFailure('http://b:1', 'm', 'region')
  assert.equal(pool.isUsable('http://a:1', 'm'), false)
  assert.equal(pool.isUsable('http://b:1', 'm'), false)
  pool.clearModelBans('http://a:1')
  assert.equal(pool.isUsable('http://a:1', 'm'), true)
  assert.equal(pool.isUsable('http://b:1', 'm'), false, 'other exits keep their bans')
})

test('limited failure cools the exit; cooldown escalates and markSuccess clears it', () => {
  let now = 1_000
  const pool = new ExitPool({ cooldownMs: 60_000, now: () => now })
  pool.add(node('http://a:1'))
  pool.markFailure('http://a:1', 'm', 'limited')
  assert.equal(pool.isUsable('http://a:1', 'm'), false)
  now += 60_001
  assert.equal(pool.isUsable('http://a:1', 'm'), true)
  // Second consecutive 429 doubles the cooldown window (2 x 60s).
  pool.markFailure('http://a:1', 'm', 'limited')
  now += 60_001
  assert.equal(pool.isUsable('http://a:1', 'm'), false, 'escalated cooldown still active')
  now += 60_001
  assert.equal(pool.isUsable('http://a:1', 'm'), true)
  // markSuccess clears an active cooldown immediately.
  pool.markFailure('http://a:1', 'm', 'limited')
  assert.equal(pool.isUsable('http://a:1', 'm'), false)
  pool.markSuccess('http://a:1', 'm')
  assert.equal(pool.isUsable('http://a:1', 'm'), true)
})

test('transport failure kills the exit; other models are unaffected', () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1'))
  pool.markFailure('http://a:1', 'm1', 'transport')
  assert.equal(pool.isUsable('http://a:1', 'm1'), false)
  assert.equal(pool.isUsable('http://a:1', 'm2'), false, 'dead is exit-wide')
})

test('server error soft-bans the model pairing only after two strikes', () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1'))
  pool.markFailure('http://a:1', 'm', 'server')
  assert.equal(pool.isUsable('http://a:1', 'm'), true, 'first 5xx is only suspect')
  pool.markFailure('http://a:1', 'm', 'server')
  assert.equal(pool.isUsable('http://a:1', 'm'), false, 'second 5xx bans the pairing')
  assert.equal(pool.isUsable('http://a:1', 'other'), true, 'exit stays alive for other models')
})

test('region refusal bans the pairing immediately; refused debounces via suspect', () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1'))
  pool.add(node('http://b:1'))
  // region: deterministic -> immediate ban.
  pool.markFailure('http://a:1', 'm', 'region')
  assert.equal(pool.isUsable('http://a:1', 'm'), false)
  assert.equal(pool.isUsable('http://a:1', 'other'), true)
  // refused (plain 401/403): first strike is suspect, second bans.
  pool.markFailure('http://b:1', 'm', 'refused')
  assert.equal(pool.isUsable('http://b:1', 'm'), true, 'first refused is only suspect')
  pool.markFailure('http://b:1', 'm', 'refused')
  assert.equal(pool.isUsable('http://b:1', 'm'), false, 'second refused bans the pairing')
  assert.equal(pool.isUsable('http://b:1', 'other'), true)
})

test('a model ban expires after banTtlMs so a transient refusal is not permanent', () => {
  let now = 1_000_000
  const pool = new ExitPool({ banTtlMs: 60_000, now: () => now })
  pool.add(node('http://a:1'))
  pool.markFailure('http://a:1', 'm', 'region')
  assert.equal(pool.isUsable('http://a:1', 'm'), false, 'banned immediately')
  now += 59_000
  assert.equal(pool.isUsable('http://a:1', 'm'), false, 'still banned inside the TTL')
  now += 2_000
  assert.equal(pool.isUsable('http://a:1', 'm'), true, 'ban aged out and the pairing is usable again')
})

test('a suspect strike ages out instead of accumulating forever', () => {
  let now = 1_000_000
  const pool = new ExitPool({ banTtlMs: 30_000, now: () => now })
  pool.add(node('http://a:1'))
  pool.markFailure('http://a:1', 'm', 'refused')
  // The first strike is only a suspect, so the pairing stays usable.
  assert.equal(pool.isUsable('http://a:1', 'm'), true, 'one refused strike is not a block')
  // Inside the TTL, a second strike escalates to a ban.
  pool.markFailure('http://a:1', 'm', 'refused')
  assert.equal(pool.isUsable('http://a:1', 'm'), false, 'two strikes inside the TTL ban the pairing')
  // After the TTL the ban ages out and the counter resets, so a single later
  // strike does not immediately re-ban on the strength of a stale sample.
  now += 31_000
  assert.equal(pool.isUsable('http://a:1', 'm'), true, 'the ban aged out')
  pool.markFailure('http://a:1', 'm', 'refused')
  assert.equal(pool.isUsable('http://a:1', 'm'), true, 'a fresh strike starts the count over')
})

test('probe failure degrades manual exits to unknown but kills free exits', () => {
  const pool = new ExitPool()
  pool.add(node('http://manual:1', { source: 'manual' }))
  pool.add(node('http://free:1', { source: 'free' }))
  pool.markProbe('http://manual:1', true, 50, '1.2.3.4')
  pool.markProbe('http://free:1', true, 60, '5.6.7.8')
  pool.markProbe('http://manual:1', false, 0)
  pool.markProbe('http://free:1', false, 0)
  assert.equal(pool.isUsable('http://manual:1', 'm'), true, 'manual stays usable (unknown)')
  assert.equal(pool.isUsable('http://free:1', 'm'), false, 'free exit marked dead')
})

test('evictDead spares manual and pinned exits', () => {
  const pool = new ExitPool({ deadEvictions: 2 })
  pool.add(node('http://manual:1', { source: 'manual' }))
  pool.add(node('http://pinned:1', { source: 'manual', pinned: true }))
  pool.add(node('http://free:1', { source: 'free' }))
  pool.setPinned('http://pinned:1')
  for (const id of ['http://manual:1', 'http://pinned:1', 'http://free:1']) {
    pool.markFailure(id, 'm', 'transport')
    pool.markFailure(id, 'm', 'transport')
  }
  const evicted = pool.evictDead()
  assert.deepEqual(evicted, ['http://free:1'])
  assert.equal(pool.has('http://manual:1'), true)
  assert.equal(pool.has('http://pinned:1'), true)
})

test('pick prefers sticky, then pinned, then lowest latency', () => {
  const pool = new ExitPool()
  pool.add(node('http://slow:1', { latencyMs: 100 }))
  pool.add(node('http://fast:1', { latencyMs: 50 }))
  // No sticky, no pin -> lowest latency wins.
  const p1 = pool.pick('m', 's1')
  assert.equal(p1?.exit.id, 'http://fast:1')
  assert.equal(p1?.sticky, false)
  // Sticky binding holds the session on the same exit.
  const p2 = pool.pick('m', 's1')
  assert.equal(p2?.exit.id, 'http://fast:1')
  assert.equal(p2?.sticky, true)
  // A fresh session with a pinned exit prefers the pin over latency.
  pool.setPinned('http://slow:1')
  const p3 = pool.pick('m', 's2')
  assert.equal(p3?.exit.id, 'http://slow:1')
  // A cooling pinned exit falls through to the best usable candidate.
  pool.markFailure('http://slow:1', 'm', 'limited')
  const p4 = pool.pick('m', 's3')
  assert.equal(p4?.exit.id, 'http://fast:1')
})

test('remove clears bans and sticky bindings for the exit', () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1'))
  pool.markFailure('http://a:1', 'm', 'refused')
  // Sticky-bind the session on a model that is not banned for this exit.
  pool.pick('m2', 'sess')
  assert.equal(pool.exitOfSession('sess'), 'http://a:1')
  pool.remove('http://a:1')
  assert.equal(pool.has('http://a:1'), false)
  assert.equal(pool.exitOfSession('sess'), null)
  // Re-adding starts clean.
  pool.add(node('http://a:1'))
  assert.equal(pool.isUsable('http://a:1', 'm'), true)
})

test('setIncludeDirect(false) removes direct and ensures pick never returns it', () => {
  const pool = new ExitPool()
  pool.ensureDirect()
  assert.equal(pool.has('direct'), true)
  assert.equal(pool.size(), 1)
  assert.equal(pool.view().length, 1)

  pool.setIncludeDirect(false)
  assert.equal(pool.has('direct'), false)
  assert.equal(pool.size(), 0)
  assert.equal(pool.view().length, 0)
  assert.equal(pool.pick('m', 'sess'), null)

  // ensureDirect is a no-op when includeDirect is false
  pool.ensureDirect()
  assert.equal(pool.has('direct'), false)

  // Re-enabling restores direct
  pool.setIncludeDirect(true)
  assert.equal(pool.has('direct'), true)
  assert.equal(pool.pick('m', 'sess')?.exit.id, 'direct')
})

