import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  stableID,
  randomID,
  canonicalSessionID,
  conversationSeed,
  deriveRequestIDs,
  opencodeUserAgent,
  disguiseHeaders,
} from '../dist/core/ids.js'

/**
 * CLI-disguise id tests — the exact session shape the Zen free lane gates on.
 * A regression here is a fleet-wide 403, so the canonical shape, the
 * first-user-message stability, and the header set are all locked in.
 */

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

test('canonicalSessionID passes through an already-canonical id unchanged', () => {
  const canonical = `ses_${'a'.repeat(12)}${'B'.repeat(14)}`
  assert.match(canonical, SESSION_RE)
  assert.equal(canonicalSessionID(canonical), canonical)
})

test('canonicalSessionID hashes any other signal into the canonical shape', () => {
  const out = canonicalSessionID('hello world')
  assert.match(out, SESSION_RE)
  assert.equal(canonicalSessionID('hello world'), out, 'deterministic for the same signal')
  assert.notEqual(canonicalSessionID('hello world'), canonicalSessionID('hello world!'), 'distinct signals separate')
})

test('stableID is deterministic and namespaced by prefix', () => {
  assert.equal(stableID('prj', 'x'), stableID('prj', 'x'))
  assert.notEqual(stableID('prj', 'x'), stableID('req', 'x'), 'prefix namespaces the hash')
  assert.notEqual(stableID('prj', 'x'), stableID('prj', 'y'))
  assert.match(stableID('prj', 'x'), /^prj_[0-9a-f]{24}$/)
})

test('randomID carries the prefix and fresh entropy', () => {
  assert.match(randomID('req', 16), /^req_[0-9a-f]{32}$/)
  assert.notEqual(randomID('req', 16), randomID('req', 16))
})

test('conversationSeed uses the first user turn and ignores system/assistant', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'first question' },
    { role: 'user', content: 'second question' },
  ]
  assert.equal(conversationSeed(messages), JSON.stringify('first question'))
  assert.equal(conversationSeed([{ role: 'system', content: 'only' }]), '', 'no user turn -> empty signal')
  assert.equal(conversationSeed([]), '')
})

test('deriveRequestIDs keeps a growing conversation stable but separates conversations', () => {
  const convoA1 = [
    { role: 'user', content: 'write a parser' },
    { role: 'assistant', content: 'ok' },
  ]
  const convoA2 = [...convoA1, { role: 'user', content: 'follow-up' }]
  const convoB = [{ role: 'user', content: 'something else entirely' }]
  const idsA1 = deriveRequestIDs(convoA1)
  const idsA2 = deriveRequestIDs(convoA2)
  const idsB = deriveRequestIDs(convoB)
  assert.equal(idsA1.session, idsA2.session, 'growing history keeps the session (prompt-cache affinity)')
  assert.notEqual(idsA1.session, idsB.session, 'different conversations separate')
  assert.match(idsA1.session, SESSION_RE)
  assert.notEqual(idsA1.request, idsA2.request, 'every request gets a fresh request id')
  assert.equal(idsA1.project, idsA2.project, 'project id is stable')
})

test('deriveRequestIDs falls back to random on an empty conversation', () => {
  const a = deriveRequestIDs([])
  const b = deriveRequestIDs([])
  assert.match(a.session, SESSION_RE)
  assert.notEqual(a.session, b.session)
})

test('opencodeUserAgent looks like the official CLI', () => {
  const ua = opencodeUserAgent()
  assert.match(ua, /^opencode\/\d+\.\d+\.\d+ \(/)
  assert.ok(ua.includes(process.platform))
})

test('disguiseHeaders carries the full CLI correlation set', () => {
  const ids = { session: 'ses_abcdef012345ABCDEFGHIJKLMN', request: 'req_1', project: 'prj_2' }
  const headers = disguiseHeaders(ids)
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-session'], ids.session)
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['X-Session-Id'], ids.session)
  assert.equal(headers['x-opencode-request'], ids.request)
  assert.equal(headers['x-opencode-project'], ids.project)
  assert.ok(typeof headers['user-agent'] === 'string' && headers['user-agent'].startsWith('opencode/'))
})
