#!/usr/bin/env node
/**
 * probe-direct-exit — "what would the pool's 'direct' exit look like upstream?"
 *
 * pool.includeDirect=false keeps the operator's own egress off the wire by
 * design, so there is normally no way to answer that without flipping a config
 * that deliberately exists to refuse leaking the real IP. This sends the exact
 * request a direct exit would send — gateway-built tU ids and disguise headers,
 * plain (no-proxy) dispatcher — and prints the upstream verdict.
 *
 *   node scripts/probe-direct-exit.mjs [url] [model]
 *
 * Defaults: https://opencode.ai/inference/v1/chat/completions  big-pickle
 */
import { request, Agent } from 'undici'

import { deriveRequestIDs, disguiseHeaders } from '../dist/core/ids.js'

const base = process.argv[2] || 'https://opencode.ai/inference/v1/chat/completions'
const model = process.argv[3] || 'big-pickle'
const body = { model, messages: [{ role: 'user', content: 'say ok' }], max_tokens: 50 }
const ids = deriveRequestIDs(body.messages)
const started = Date.now()

try {
  const res = await request(base, {
    method: 'POST',
    // Plain dispatcher = the 'direct' exit: no proxy, whatever the shell has set.
    dispatcher: new Agent({ connect: { timeout: 6_000 } }),
    headers: {
      authorization: 'Bearer public',
      'content-type': 'application/json',
      ...disguiseHeaders(ids, 'chat'),
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    headersTimeout: 45_000,
    bodyTimeout: 45_000,
  })
  const text = await res.body.text()
  process.stdout.write(`status=${res.statusCode} ms=${Date.now() - started}\n`)
  process.stdout.write(`${text.slice(0, 500)}\n`)
} catch (err) {
  process.stdout.write(`ERROR ms=${Date.now() - started}: ${err?.message ?? String(err)}\n`)
}
