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

test('transport failure cools the exit for probe verification; it is never marked dead on the request path', () => {
  let now = 1_000_000
  const pool = new ExitPool({ cooldownMs: 60_000, now: () => now })
  pool.add(node('http://a:1'))
  pool.markFailure('http://a:1', 'm1', 'transport')
  assert.equal(pool.isUsable('http://a:1', 'm1'), false, 'transport failure cools the whole exit')
  assert.equal(pool.isUsable('http://a:1', 'm2'), false, 'cooling is exit-wide')
  const view = pool.view().find((e) => e.id === 'http://a:1')
  assert.equal(view?.state, 'unknown', 'dead verdict belongs to the multi-site prober, not a request-path failure')
  now += 60_001
  assert.equal(pool.isUsable('http://a:1', 'm1'), true, 'after the cooldown the exit is retryable (unknown is usable)')
})

test('a successful probe lifts a transport cooldown but never a 429 backoff', () => {
  let now = 1_000_000
  const pool = new ExitPool({ cooldownMs: 60_000, now: () => now })
  pool.add(node('http://t:1'))
  pool.add(node('http://l:1'))
  pool.markFailure('http://t:1', 'm', 'transport')
  pool.markProbe('http://t:1', true, 50, '1.2.3.4')
  assert.equal(pool.isUsable('http://t:1', 'm'), true, 'reachability proven lifts the connectivity cooldown')
  pool.markFailure('http://l:1', 'm', 'limited')
  pool.markProbe('http://l:1', true, 50, '5.6.7.8')
  assert.equal(pool.isUsable('http://l:1', 'm'), false, 'a 429 backoff survives a reachability probe')
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

test('a failed multi-site probe round kills exits; pinned exits only degrade to unknown', () => {
  const pool = new ExitPool()
  pool.add(node('http://manual:1', { source: 'manual' }))
  pool.add(node('http://free:1', { source: 'free' }))
  pool.add(node('http://pinned:1', { source: 'manual', pinned: true }))
  pool.setPinned('http://pinned:1')
  for (const id of ['http://manual:1', 'http://free:1', 'http://pinned:1']) {
    pool.markProbe(id, true, 50, '1.2.3.4')
  }
  for (const id of ['http://manual:1', 'http://free:1', 'http://pinned:1']) {
    pool.markProbe(id, false, 0)
  }
  // A dead verdict now requires every probe site (Google/YouTube/egress-IP)
  // to be unreachable, so it is trusted for operator-added exits too.
  assert.equal(pool.isUsable('http://manual:1', 'm'), false, 'manual exit marked dead')
  assert.equal(pool.isUsable('http://free:1', 'm'), false, 'free exit marked dead')
  assert.equal(pool.isUsable('http://pinned:1', 'm'), true, 'pinned stays usable (unknown)')
  // A later successful round revives them.
  pool.markProbe('http://manual:1', true, 55, '1.2.3.4')
  assert.equal(pool.isUsable('http://manual:1', 'm'), true, 'verification success revives the exit')
})

test('evictDead spares manual and pinned exits', () => {
  const pool = new ExitPool({ deadEvictions: 2 })
  pool.add(node('http://manual:1', { source: 'manual' }))
  pool.add(node('http://pinned:1', { source: 'manual', pinned: true }))
  pool.add(node('http://free:1', { source: 'free' }))
  pool.setPinned('http://pinned:1')
  // Dead via the sanctioned path: failed verification rounds.
  pool.markProbe('http://manual:1', false, 0)
  pool.markProbe('http://manual:1', false, 0)
  pool.markProbe('http://pinned:1', false, 0)
  pool.markProbe('http://free:1', false, 0)
  pool.markProbe('http://free:1', false, 0)
  const evicted = pool.evictDead()
  assert.deepEqual(evicted, ['http://free:1'])
  assert.equal(pool.has('http://manual:1'), true)
  assert.equal(pool.has('http://pinned:1'), true)
})

test('dueForProbe(forceAll) verifies every non-direct exit regardless of schedule', () => {
  let now = 1_000_000
  const pool = new ExitPool({ deadRecheckMs: 5 * 60_000, now: () => now })
  pool.add(node('http://ok:1'))
  pool.add(node('http://dead:1'))
  pool.markProbe('http://ok:1', true, 40, '1.1.1.1')
  pool.markProbe('http://dead:1', true, 40, '2.2.2.2')
  pool.markProbe('http://dead:1', false, 0) // failed verification round -> dead
  // 'ok' is never due; 'dead' only past the recheck window.
  assert.equal(pool.dueForProbe().length, 0, 'nothing is due on schedule')
  const forced = pool.dueForProbe(true)
  assert.deepEqual(forced.map((n) => n.id).sort(), ['http://dead:1', 'http://ok:1'])
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

test('pick excludes exits specified in exclude set during retry rotation', () => {
  const pool = new ExitPool()
  pool.add(node('http://exit-1:1', { latencyMs: 50 }))
  pool.add(node('http://exit-2:1', { latencyMs: 60 }))
  // Normal pick chooses exit-1
  const p1 = pool.pick('m', 'sess-a')
  assert.equal(p1?.exit.id, 'http://exit-1:1')
  // Retrying with exclude={exit-1} guarantees routing to exit-2
  const p2 = pool.pick('m', 'sess-a', new Set(['http://exit-1:1']))
  assert.equal(p2?.exit.id, 'http://exit-2:1')
  // If all usable exits are excluded, returns null
  const p3 = pool.pick('m', 'sess-a', new Set(['http://exit-1:1', 'http://exit-2:1']))
  assert.equal(p3, null)
})

test('pick round-robins across exits with comparable latency', () => {
  const pool = new ExitPool()
  pool.add(node('http://peer-a:1', { latencyMs: 650 }))
  pool.add(node('http://peer-b:1', { latencyMs: 660 }))
  // Latencies are within tolerance, successive picks for fresh sessions alternate
  const p1 = pool.pick('m', 'fresh-1')
  const p2 = pool.pick('m', 'fresh-2')
  const p3 = pool.pick('m', 'fresh-3')
  const p4 = pool.pick('m', 'fresh-4')
  assert.notEqual(p1?.exit.id, p2?.exit.id, 'consecutive fresh sessions alternate between peers')
  assert.equal(p1?.exit.id, p3?.exit.id)
  assert.equal(p2?.exit.id, p4?.exit.id)
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


test('markGate: cools the exit, bans the pair, survives probes, escalates', () => {
  let now = 1_000_000
  const pool = new ExitPool({ cooldownMs: 60_000, now: () => now })
  pool.add(node('http://a:1'))
  pool.markGate('http://a:1', 'm')
  assert.equal(pool.isUsable('http://a:1', 'm'), false, 'exit×model pair banned immediately')
  assert.equal(pool.isUsable('http://a:1', 'other'), false, 'exit-level cooldown covers other models too')

  // A reachability probe proves the tunnel, not the lane's opinion: the 'gate'
  // cooldown must survive it (only 'transport' is lifted on a good probe).
  pool.markProbe('http://a:1', true, 10, '1.2.3.4')
  assert.equal(pool.isUsable('http://a:1', 'other'), false, 'gate cooldown survives a healthy probe')

  // Past the first window, a second gate verdict escalates to 2x the cooldown.
  now += 60_000
  pool.markGate('http://a:1', 'm')
  const view = pool.view().find((v) => v.id === 'http://a:1')!
  assert.equal(view.cooling, true)
  assert.equal(view.cooldownRemainingMs, 120_000, 'second consecutive gate doubles the cooldown')

  // A real success through the lane resets everything.
  pool.markSuccess('http://a:1', 'm')
  assert.equal(pool.isUsable('http://a:1', 'm'), true)
  const v2 = pool.view().find((v) => v.id === 'http://a:1')!
  assert.equal(v2.cooling, false)
})

test('a free exit earns rotation slots only after a probe passes', () => {
  const pool = new ExitPool()
  pool.add(node('http://lottery:1', { source: 'free' }))
  assert.equal(
    pool.isUsable('http://lottery:1', 'm'),
    false,
    'an unproven free exit stays out of rotation — serving it costs a connect timeout',
  )
  // The model-ban relief path must not sneak one in either.
  assert.equal(
    pool.pick('m', 'sess-1'),
    null,
    'with only an unproven free exit available the pool reports no candidate',
  )

  pool.markProbe('http://lottery:1', true, 900, '203.0.113.7')
  assert.equal(pool.isUsable('http://lottery:1', 'm'), true, 'a passed probe earns the slot')
  assert.equal(pool.pick('m', 'sess-1')?.exit.id, 'http://lottery:1')
})

test('a manual exit stays usable while unprobed (restart must not starve)', () => {
  let now = 1_000
  const pool = new ExitPool({ cooldownMs: 60_000, now: () => now })
  pool.add(node('http://manual:1'))
  assert.equal(
    pool.isUsable('http://manual:1', 'm'),
    true,
    "manual 'unknown' means not-yet-reverified, and hand-configured exits are trusted",
  )
  pool.markFailure('http://manual:1', 'm', 'transport')
  assert.equal(pool.isUsable('http://manual:1', 'm'), false, 'the transport cooldown itself still applies')
  now += 60_001
  assert.equal(pool.isUsable('http://manual:1', 'm'), true, 'manual unknown after the cooldown is retryable')
})

test('a starved pool samples short cool-downs instead of refusing', () => {
  let now = 1_000
  const pool = new ExitPool({ cooldownMs: 60_000, now: () => now })
  pool.add(node('http://a:1'))
  pool.add(node('http://b:1'))
  pool.add(node('http://long:1'))
  pool.markFailure('http://a:1', 'm', 'limited')
  pool.markFailure('http://b:1', 'm', 'limited')
  // Escalate the third to a full quota back-off (60s x 10) — that one stays out.
  for (let i = 0; i < 5; i += 1) pool.markFailure('http://long:1', 'm', 'limited')

  assert.equal(pool.isUsable('http://a:1', 'm'), false, 'every exit is cooling, so tier 1 is empty')
  const picked = pool.pick('m', 'starved-sess')
  assert.ok(picked, 'a short-cooled exit is sampled rather than the client being refused')
  assert.ok(
    picked && (picked.exit.id === 'http://a:1' || picked.exit.id === 'http://b:1'),
    `short cool-downs qualify, got ${picked?.exit.id}`,
  )

  const strict = new ExitPool({ cooldownMs: 60_000, now: () => now })
  strict.add(node('http://only-long:1'))
  for (let i = 0; i < 5; i += 1) strict.markFailure('http://only-long:1', 'm', 'limited')
  assert.equal(strict.pick('m', 'sess-2'), null, 'a long quota cool-down is still refused — probing it is futile')
})

test('the cool-down relief never overrides an identity-gate ban', () => {
  let now = 5_000
  const pool = new ExitPool({ cooldownMs: 60_000, now: () => now })
  pool.add(node('http://g:1'))
  pool.markGate('http://g:1', 'm')
  assert.equal(
    pool.pick('m', 'sess-1'),
    null,
    'the gate verdict is a model×exit ban; the cool-down tier must not route around it',
  )
  assert.ok(
    pool.pick('other-model', 'sess-2'),
    'the same exit is still worth sampling for a model the gate never judged',
  )
})

// ---------------------------------------------------------------------------
// Quota alignment (2026-10-22): the free lane meters per egress IP and answers
// an exhausted one with a 429 whose Retry-After is the real window reset.
// ---------------------------------------------------------------------------

test('a quota 429 credits the upstream Retry-After instead of the local backoff', () => {
  let now = 1_000_000
  const pool = new ExitPool({ cooldownMs: 60_000, now: () => now })
  pool.add(node('http://q:1'))
  // Measured upstream value: 26851s ~ 7.46h.
  const retryAfterMs = 26_851_000
  pool.markFailure('http://q:1', 'm', 'limited', retryAfterMs)
  assert.equal(pool.isUsable('http://q:1', 'm'), false)

  // A minute later it must STILL be unusable — the whole point: the old code
  // re-sampled it every 60s for the entire 7-hour window.
  now += 61_000
  assert.equal(pool.isUsable('http://q:1', 'm'), false, 'a 60s local cooldown must not expire a 7h quota window')

  // And it comes back only after the announced reset.
  now += retryAfterMs
  assert.equal(pool.isUsable('http://q:1', 'm'), true)
})

test('the Retry-After floor is cooldownMs and the ceiling is maxCooldownMs', () => {
  let now = 0
  const pool = new ExitPool({ cooldownMs: 60_000, maxCooldownMs: 120_000, now: () => now })
  pool.add(node('http://tiny:1'))
  // A nonsense 1s header must not shorten the precautionary cooldown.
  pool.markFailure('http://tiny:1', 'm', 'limited', 1_000)
  now = 60_000 - 1
  assert.equal(pool.isUsable('http://tiny:1', 'm'), false, 'the configured cooldown is the floor')
  now = 60_001
  assert.equal(pool.isUsable('http://tiny:1', 'm'), true)

  const capped = new ExitPool({ cooldownMs: 1_000, maxCooldownMs: 120_000, now: () => now })
  capped.add(node('http://huge:1'))
  // An absurd header must not bench the exit for days.
  capped.markFailure('http://huge:1', 'm', 'limited', 86_400_000)
  now += 120_000 - 1
  assert.equal(capped.isUsable('http://huge:1', 'm'), false, 'capped cooldown still applies')
  now += 2
  assert.equal(capped.isUsable('http://huge:1', 'm'), true, 'the ceiling bounds even a hostile header')
})

test('honorRetryAfter=false restores the plain exponential backoff', () => {
  let now = 0
  const pool = new ExitPool({ cooldownMs: 60_000, honorRetryAfter: false, now: () => now })
  pool.add(node('http://old:1'))
  pool.markFailure('http://old:1', 'm', 'limited', 26_851_000)
  now += 60_001
  assert.equal(pool.isUsable('http://old:1', 'm'), true, 'opt-out keeps the legacy 60s behaviour')
})

test('a long quota cool-down is never sampled, while a transport blip still is', () => {
  // Real clock base: a 0-based fake clock cannot tell "no cooldown" (0) from
  // "cooled until epoch" (0), which is a test artefact, not pool behaviour.
  let now = 1_000_000
  const pool = new ExitPool({ cooldownMs: 60_000, now: () => now })
  pool.add(node('http://burnt:1'))
  // The measured upstream reset (~7.4h) must survive the starved relief.
  pool.markFailure('http://burnt:1', 'm', 'limited', 26_851_000)
  assert.equal(pool.isUsable('http://burnt:1', 'm'), false)
  assert.equal(pool.pick('m', 'sess-1'), null, 'a known quota reset must not be gambled against')

  // A transport blip is a different verdict: reachability is unknown, not
  // refused, so a starved pool may still spend one attempt on it.
  const blip = new ExitPool({ cooldownMs: 120_000, now: () => now })
  blip.add(node('http://blip:1'))
  blip.markFailure('http://blip:1', 'm', 'transport')
  assert.equal(blip.isUsable('http://blip:1', 'm'), false)
  assert.ok(blip.pick('m', 'sess-2'), 'a short transport cool-down is worth one gamble')

  // Once the announced quota window passes, the exit is selectable again.
  now += 26_851_000 + 1
  assert.equal(pool.pick('m', 'sess-3')?.exit.id, 'http://burnt:1')
})

test('distinctEgressCount collapses exits that share an egress IP', () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1'))
  pool.add(node('http://b:1'))
  pool.add(node('socks5://c:1'))
  // Measured 2026-10-22: 10808 and 21006 both exited at 47.131.86.109.
  pool.markProbe('http://a:1', true, 100, '47.131.86.109')
  pool.markProbe('http://b:1', true, 120, '47.131.86.109')
  pool.markProbe('socks5://c:1', true, 140, '3.70.46.36')
  assert.equal(pool.usableCount('m'), 3, 'three slots are usable')
  assert.equal(pool.distinctEgressCount('m'), 2, 'but only two of them buy a distinct quota')
})

test('pick spreads sessions across distinct egress IPs, not aliases of one', () => {
  const pool = new ExitPool()
  pool.add(node('http://a:1', { latencyMs: 50 }))
  pool.add(node('http://b:1', { latencyMs: 60 }))
  pool.add(node('socks5://c:1', { latencyMs: 90 }))
  // a and b are the same physical egress.
  pool.markProbe('http://a:1', true, 50, '47.131.86.109')
  pool.markProbe('http://b:1', true, 60, '47.131.86.109')
  pool.markProbe('socks5://c:1', true, 90, '3.70.46.36')

  const seen = new Set<string>()
  for (let i = 0; i < 8; i += 1) {
    const picked = pool.pick('m', `sess-${i}`)
    assert.ok(picked)
    seen.add(picked!.exit.exitIP)
  }
  assert.deepEqual([...seen].sort(), ['3.70.46.36', '47.131.86.109'], 'a session never lands on an alias of the same IP')
})

test('per-exit in-flight cap keeps new requests off a saturated egress', () => {
  const pool = new ExitPool({ maxInflightPerExit: 2 })
  pool.add(node('http://a:1'))
  pool.add(node('http://b:1'))

  const releaseA1 = pool.reserve('http://a:1', 'm')
  const releaseA2 = pool.reserve('http://a:1', 'm')
  assert.equal(pool.inflightOf('http://a:1'), 2)
  assert.equal(pool.isUsable('http://a:1', 'm'), false, 'a full exit is not a candidate')
  const picked = pool.pick('m', 'sess-1')
  assert.equal(picked?.exit.id, 'http://b:1', 'traffic moves to the exit with headroom')

  releaseA1()
  releaseA1() // idempotent
  assert.equal(pool.inflightOf('http://a:1'), 1, 'a double release must not under-count')
  assert.equal(pool.isUsable('http://a:1', 'm'), true)
  releaseA2()
  assert.equal(pool.inflightOf('http://a:1'), 0)
})

test('reserve never rejects a request that was already routed', () => {
  const pool = new ExitPool({ maxInflightPerExit: 1 })
  pool.add(node('http://a:1'))
  pool.reserve('http://a:1', 'm')
  // The pool may fill up between pick() and reserve(); the reservation must
  // still succeed or the request would be dropped after being routed.
  const release = pool.reserve('http://a:1', 'm')
  assert.equal(pool.inflightOf('http://a:1'), 2)
  release()
  assert.equal(pool.inflightOf('http://a:1'), 1)
})
