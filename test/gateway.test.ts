import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Agent } from 'undici'

import { Logger } from '../dist/core/logger.js'
import { ExitPool } from '../dist/pool/pool.js'
import { DispatcherCache } from '../dist/pool/dispatchers.js'
import { Gateway, GatewayHttpError } from '../dist/gateway/gateway.js'

/**
 * Gateway orchestration tests — model gating, rotation across exits,
 * pre-content error inspection, and non-streaming aggregation.
 *
 * A local HTTP server stands in for the Zen anonymous lane. Every pool exit
 * is routed to it (the shared Agent ignores the exit's proxy URI), so rotation
 * is observable as successive server hits with pool health changing between
 * them. Nothing touches the real network.
 */

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const CHAT_MODEL = 'test-chat-model'
const SPARK_MODEL = 'muse-spark-1.3-contributor-free'

interface Seen {
  method?: string
  url?: string
  headers: Record<string, string | undefined>
  body: unknown
}

const closers: Array<() => Promise<unknown>> = []
after(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {})
})

async function startZen(
  handler: (seen: Seen, res: ServerResponse) => void,
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const entry: Seen = { method: req.method, url: req.url, headers: {}, body: null }
    for (const [k, v] of Object.entries(req.headers)) entry.headers[k] = Array.isArray(v) ? v.join(', ') : v
    let raw = ''
    req.on('data', (c) => {
      raw += String(c)
    })
    req.on('end', () => {
      try {
        entry.body = raw ? JSON.parse(raw) : null
      } catch {
        entry.body = raw
      }
      seen.push(entry)
      try {
        handler(entry, res)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(err))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  closers.push(close)
  return { url: `http://127.0.0.1:${port}`, seen, close }
}

function sse(status: number, body: string, res: ServerResponse): void {
  res.writeHead(status, { 'content-type': 'text/event-stream; charset=utf-8' })
  res.end(body)
}

function json(status: number, body: unknown, res: ServerResponse): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function chatSse(model: string, text: string): string {
  const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model }
  const chunk = (delta: unknown, finish: string | null): string =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  return chunk({ role: 'assistant', content: '' }, null) + chunk({ content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'
}

function responsesSse(text: string): string {
  const ev = (type: string, extra: unknown): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`
  return (
    ev('response.created', { response: { id: 'resp_t', model: SPARK_MODEL, created_at: 100 } }) +
    ev('response.output_text.delta', { delta: text }) +
    ev('response.completed', {
      response: { id: 'resp_t', model: SPARK_MODEL, status: 'completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
    })
  )
}

function collect(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    stream.on('data', (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))))
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    stream.on('error', reject)
  })
}

function chatToolNames(body: unknown): string[] {
  const tools = (body as { tools?: Array<{ function?: { name?: string }; name?: string }> }).tools ?? []
  return tools.map((t) => t.function?.name ?? t.name ?? '')
}

interface GatewayHarness {
  gateway: Gateway
  pool: ExitPool
  cleanup: () => Promise<void>
}

function makeGateway(
  zenBaseUrl: string,
  opts: {
    poolEnabled: boolean
    exits?: string[]
    maxRotateAttempts?: number
    freeModels?: string[]
    onPoolStarved?: () => void
    bodyBudgetMs?: number
  } = { poolEnabled: false },
): GatewayHarness {
  const logger = new Logger({ level: 'error', stdout: false, capacity: 50, traceCapacity: 50 })
  const pool = new ExitPool()
  for (const id of opts.exits ?? []) {
    pool.add({
      id,
      kind: id.startsWith('socks5') ? 'socks5' : 'http',
      source: 'manual',
      pinned: false,
      exitIP: '',
      location: '',
      latencyMs: 0,
    })
  }
  const dispatchers = new DispatcherCache()
  // Route every exit at the local fake lane: the exit URI is only a pool id
  // here, not a real proxy.
  const shared = new Agent()
  ;(dispatchers as unknown as { forExit: () => Agent }).forExit = () => shared
  const free = new Set(opts.freeModels ?? [CHAT_MODEL, SPARK_MODEL])
  const catalog = {
    list: () => [...free],
    decision: (m: string) =>
      free.has(m) ? { allowed: true, source: 'test', known: true } : { allowed: false, source: 'test_blocked', known: true },
  }
  const gateway = new Gateway({
    logger,
    scoped: logger.child('gateway'),
    catalog: catalog as never,
    pool,
    dispatchers,
    zenBaseUrl,
    maxRotateAttempts: opts.maxRotateAttempts ?? 3,
    poolEnabled: opts.poolEnabled,
    onPoolStarved: opts.onPoolStarved,
    bodyBudgetMs: opts.bodyBudgetMs,
  })
  const cleanup = async (): Promise<void> => {
    await dispatchers.destroy().catch(() => {})
    await shared.close().catch(() => {})
  }
  closers.push(cleanup)
  return { gateway, pool, cleanup }
}

test('rejects a missing model with 400', async () => {
  const { url } = await startZen((_seen, res) => sse(200, chatSse(CHAT_MODEL, 'x'), res))
  const { gateway } = makeGateway(url)
  await assert.rejects(
    gateway.handle({ api: 'chat', body: { messages: [{ role: 'user', content: 'hi' }] }, clientStream: true }),
    (err: unknown) => err instanceof GatewayHttpError && err.status === 400,
  )
})

test('rejects a non-free model with 400', async () => {
  const { url } = await startZen((_seen, res) => sse(200, chatSse(CHAT_MODEL, 'x'), res))
  const { gateway } = makeGateway(url)
  await assert.rejects(
    gateway.handle({ api: 'chat', body: { model: 'paid-model', messages: [{ role: 'user', content: 'hi' }] }, clientStream: true }),
    (err: unknown) => err instanceof GatewayHttpError && err.status === 400 && /not an available free model/.test(err.message),
  )
})

test('forwards a chat stream with CLI disguise and gate tools', async () => {
  const { url, seen } = await startZen((_seen, res) => sse(200, chatSse(CHAT_MODEL, 'Hello'), res))
  const { gateway } = makeGateway(url)
  const result = await gateway.handle({
    api: 'chat',
    body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    clientStream: true,
  })
  const text = await collect(result.body)
  assert.equal(result.status, 200)
  assert.ok(text.includes('"content":"Hello"'), 'delta passes through')
  assert.ok(text.includes('data: [DONE]'), 'chat stream is terminated')
  assert.equal(result.trace.outcome, 'ok')
  assert.equal(result.trace.attempts, 1)
  assert.equal(result.trace.exit, 'direct')

  assert.equal(seen.length, 1)
  const hit = seen[0]!
  assert.equal(hit.url, '/v1/chat/completions')
  assert.equal(hit.headers.authorization, 'Bearer public')
  assert.equal(hit.headers['x-opencode-client'], 'cli')
  assert.match(hit.headers['x-opencode-session'] ?? '', SESSION_RE)
  assert.match(hit.headers['user-agent'] ?? '', /^opencode\//)
  const wire = hit.body as Record<string, unknown>
  assert.equal(wire.stream, true, 'the free lane requires wire streaming')
  const names = chatToolNames(wire)
  assert.ok(names.includes('bash') && names.includes('read'), 'gate tools injected')
  assert.equal(wire.tool_choice, 'none', 'injected stubs are never callable')
})

test('aggregates a non-streaming chat response into one JSON body', async () => {
  const { url } = await startZen((_seen, res) => sse(200, chatSse(CHAT_MODEL, 'Hello agg'), res))
  const { gateway } = makeGateway(url)
  const result = await gateway.handle({
    api: 'chat',
    body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    clientStream: false,
  })
  assert.equal(result.status, 200)
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8')
  const payload = JSON.parse(await collect(result.body)) as {
    object: string
    choices: Array<{ message: { content: string }; finish_reason: string }>
  }
  assert.equal(payload.object, 'chat.completion')
  assert.equal(payload.choices[0]?.message.content, 'Hello agg')
  assert.equal(payload.choices[0]?.finish_reason, 'stop')
})

test('rotates to a fresh exit after a 429 and succeeds', async () => {
  let hits = 0
  const { url, seen } = await startZen((_seen, res) => {
    hits += 1
    if (hits === 1) return json(429, { error: { message: 'rate limited' } }, res)
    return sse(200, chatSse(CHAT_MODEL, 'after rotate'), res)
  })
  const { gateway, pool } = makeGateway(url, { poolEnabled: true, exits: ['http://exit-a:1', 'http://exit-b:1'] })
  const result = await gateway.handle({
    api: 'chat',
    body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    clientStream: true,
  })
  const text = await collect(result.body)
  assert.ok(text.includes('after rotate'))
  assert.equal(result.trace.attempts, 2)
  assert.equal(seen.length, 2)
  assert.equal(pool.usableCount(CHAT_MODEL), 1, 'the 429 exit cools while the other serves')
})

test('rotates on the vague Console 400 and succeeds on a fresh exit', async () => {
  // The Console provider intermittently rejects valid bodies with a field-less
  // `invalid request` — the same wire body passes on replay (2026-10-03), so it
  // must rotate like an exit-shaped failure instead of killing the turn.
  let hits = 0
  const { url, seen } = await startZen((_seen, res) => {
    hits += 1
    if (hits === 1) {
      return json(400, {
        error: {
          type: 'invalid_request_error',
          message: 'Error from provider (Console): Upstream request failed: [invalid_request_error] invalid request',
        },
      }, res)
    }
    return sse(200, chatSse(CHAT_MODEL, 'after vague 400'), res)
  })
  const { gateway } = makeGateway(url, { poolEnabled: true, exits: ['http://exit-a:1', 'http://exit-b:1'] })
  const result = await gateway.handle({
    api: 'chat',
    body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    clientStream: true,
  })
  const text = await collect(result.body)
  assert.ok(text.includes('after vague 400'))
  assert.equal(result.trace.attempts, 2)
  assert.equal(seen.length, 2)
})

test('surfaces a named 400 immediately without rotating', async () => {
  // A 400 that names the offending shape is a real validation error: rotating
  // cannot fix it, so the first failure surfaces to the client as-is.
  const { url, seen } = await startZen((_seen, res) => {
    return json(400, {
      error: {
        type: 'invalid_request_error',
        message:
          'Error from provider (Console): Upstream request failed: [airlock_error] invalid request: unknown variant `developer`, expected one of `system`, `user`, `assistant`, `tool` at line 1 column 55',
      },
    }, res)
  })
  const { gateway } = makeGateway(url, { poolEnabled: true, exits: ['http://exit-a:1', 'http://exit-b:1'] })
  await assert.rejects(
    gateway.handle({
      api: 'chat',
      body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      clientStream: true,
    }),
    (err: unknown) => err instanceof GatewayHttpError && err.status === 400 && /unknown variant/.test(err.message),
  )
  assert.equal(seen.length, 1)
})

test('rotates on a region refusal', async () => {
  let hits = 0
  const { url, seen } = await startZen((_seen, res) => {
    hits += 1
    if (hits === 1) return json(403, { error: { message: 'RegionError: not available in your country' } }, res)
    return sse(200, chatSse(CHAT_MODEL, 'via second exit'), res)
  })
  const { gateway } = makeGateway(url, { poolEnabled: true, exits: ['http://exit-a:1', 'http://exit-b:1'] })
  const result = await gateway.handle({
    api: 'chat',
    body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    clientStream: true,
  })
  assert.ok((await collect(result.body)).includes('via second exit'))
  assert.equal(result.trace.attempts, 2)
  assert.equal(seen.length, 2)
})

test('rotates when a 200 body carries a pre-content rate-limit error', async () => {
  let hits = 0
  const { url, seen } = await startZen((_seen, res) => {
    hits += 1
    if (hits === 1) return sse(200, 'data: {"error":{"message":"upstream 429 rate limit exceeded, retry later"}}\n\n', res)
    return sse(200, chatSse(CHAT_MODEL, 'recovered'), res)
  })
  const { gateway, pool } = makeGateway(url, { poolEnabled: true, exits: ['http://exit-a:1', 'http://exit-b:1'] })
  const result = await gateway.handle({
    api: 'chat',
    body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    clientStream: true,
  })
  assert.ok((await collect(result.body)).includes('recovered'))
  assert.equal(result.trace.attempts, 2)
  assert.equal(seen.length, 2)
  assert.equal(pool.usableCount(CHAT_MODEL), 1, 'in-body rate limit cools the exit like a real 429')
})

test('surfaces the rotation story after exhausting the budget', async () => {
  const { url, seen } = await startZen((_seen, res) => json(429, { error: { message: 'slow down' } }, res))
  const { gateway } = makeGateway(url, { poolEnabled: true, exits: ['http://exit-a:1', 'http://exit-b:1'], maxRotateAttempts: 2 })
  await assert.rejects(
    gateway.handle({ api: 'chat', body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] }, clientStream: true }),
    (err: unknown) => err instanceof GatewayHttpError && err.status === 429 && /rotated 1x/.test(err.message),
  )
  assert.equal(seen.length, 2, 'one shot per distinct exit')
})

test('serves a chat client from a responses-wire model via transcode', async () => {
  const { url, seen } = await startZen((_seen, res) => sse(200, responsesSse('Hello spark'), res))
  const { gateway } = makeGateway(url)
  const result = await gateway.handle({
    api: 'chat',
    body: { model: SPARK_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    clientStream: false,
  })
  assert.equal(result.status, 200)
  const payload = JSON.parse(await collect(result.body)) as {
    object: string
    model: string
    choices: Array<{ message: { content: string } }>
  }
  assert.equal(payload.object, 'chat.completion')
  assert.equal(payload.choices[0]?.message.content, 'Hello spark')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.url, '/v1/responses', 'wire dialect follows the model, not the client')
  const wire = seen[0]?.body as { input?: unknown[]; tools?: Array<{ name?: string }>; tool_choice?: string }
  assert.ok(Array.isArray(wire.input), 'responses input is an array')
  const names = (wire.tools ?? []).map((t) => t.name)
  assert.ok(names.includes('bash') && names.includes('read'), 'responses gate tools injected')
  assert.equal(wire.tool_choice, 'auto')
})

test('a responses client echoing prior-turn reasoning never carries it to the wire', async () => {
  const { url, seen } = await startZen((_seen, res) => sse(200, responsesSse('Hello spark'), res))
  const { gateway } = makeGateway(url)
  const result = await gateway.handle({
    api: 'responses',
    body: {
      model: SPARK_MODEL,
      instructions: 'codex base instructions',
      input: [
        { role: 'user', content: 'list files' },
        { type: 'reasoning', summary: [], encrypted_content: 'gAAAAA minted-by-previous-exit' },
        { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      ],
      include: ['reasoning.encrypted_content'],
      store: false,
      stream: true,
    },
    clientStream: true,
  })
  assert.equal(result.status, 200)
  await collect(result.body)
  assert.equal(seen.length, 1)
  const wire = seen[0]?.body as { input?: Array<Record<string, unknown>>; include?: unknown }
  const types = (wire.input ?? []).map((item) => item.type ?? item.role)
  assert.ok(!types.includes('reasoning'), 'the encrypted reasoning echo must never reach the wire')
  assert.deepEqual(types, ['user', 'function_call', 'function_call_output'])
  assert.equal(wire.include, undefined, 'no include entry asking upstream for new encrypted blobs')
})

test('backfills a missing tool_call_id before forwarding on the chat wire', async () => {
  const { url, seen } = await startZen((_seen, res) => sse(200, chatSse(CHAT_MODEL, 'Hello'), res))
  const { gateway } = makeGateway(url)
  const result = await gateway.handle({
    api: 'chat',
    body: {
      model: CHAT_MODEL,
      messages: [
        { role: 'user', content: 'ls' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_x1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', call_id: 'call_x1', content: 'file1' },
      ],
    },
    clientStream: true,
  })
  assert.equal(result.status, 200)
  await collect(result.body)
  assert.equal(seen.length, 1)
  const wire = seen[0]?.body as { messages: Array<Record<string, unknown>> }
  assert.equal(wire.messages[2]?.tool_call_id, 'call_x1', 'call_id spelling normalized to tool_call_id')
})

test('starved pool fires the on-demand verification kick and refuses with 503', async () => {
  const { url } = await startZen((_seen, res) => sse(200, chatSse(CHAT_MODEL, 'x'), res))
  let kicks = 0
  const { gateway, pool } = makeGateway(url, {
    poolEnabled: true,
    exits: ['http://exit-a:1', 'http://exit-b:1'],
    onPoolStarved: () => {
      kicks += 1
    },
  })
  // Both exits dead (verified unreachable): the pick starves immediately.
  pool.markProbe('http://exit-a:1', false, 0)
  pool.markProbe('http://exit-b:1', false, 0)
  await assert.rejects(
    gateway.handle({ api: 'chat', body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] }, clientStream: true }),
    (err: unknown) => err instanceof GatewayHttpError && err.status === 503,
  )
  assert.ok(kicks >= 1, 'pool starvation triggers an immediate re-verification round')
})

test('a non-streaming 200 carrying an error object rotates instead of answering', async () => {
  // A non-streaming client must never receive HTTP 200 wrapping an error
  // object: SDKs read that as a malformed reply. The aggregator THROWS, so the
  // turn re-enters rotation exactly like a real 429.
  let hits = 0
  const { url, seen } = await startZen((_seen, res) => {
    hits += 1
    if (hits === 1) {
      return sse(200, 'data: {"error":{"message":"upstream 429 rate limit exceeded, retry later"}}\n\n', res)
    }
    return sse(200, chatSse(CHAT_MODEL, 'aggregated after rotate'), res)
  })
  const { gateway, pool } = makeGateway(url, { poolEnabled: true, exits: ['http://exit-a:1', 'http://exit-b:1'] })
  const result = await gateway.handle({
    api: 'chat',
    body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    clientStream: false,
  })
  assert.equal(result.status, 200)
  assert.equal(result.trace.attempts, 2, 'the in-body failure rotated once')
  const payload = JSON.parse(await collect(result.body)) as { choices: Array<{ message: { content: string } }> }
  assert.equal(payload.choices[0]?.message.content, 'aggregated after rotate')
  assert.equal(seen.length, 2)
  assert.equal(pool.usableCount(CHAT_MODEL), 1, 'the in-body 429 cooled the offending exit')
})

test('a non-streaming turn that only ever carries in-body errors surfaces a real status', async () => {
  // The old behaviour answered 200 with the error blob; the client then had to
  // parse an error out of a "successful" completion.
  const { url } = await startZen((_seen, res) => sse(200, 'data: {"error":{"message":"upstream 500 internal error"}}\n\n', res))
  const { gateway } = makeGateway(url, {
    poolEnabled: true,
    exits: ['http://exit-a:1', 'http://exit-b:1'],
    maxRotateAttempts: 2,
  })
  await assert.rejects(
    gateway.handle({
      api: 'chat',
      body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      clientStream: false,
    }),
    (err: unknown) =>
      err instanceof GatewayHttpError && err.status === 502 && /error in response body/.test(err.message),
  )
})

test('a non-streaming body that never ends is bounded by the total budget', async () => {
  // The non-streaming path skips the idle watchdog on purpose (a reasoning
  // model may legitimately go quiet for minutes), so a half-open upstream is
  // bounded only by this wall-clock budget. Without it the request hangs until
  // the client or a proxy gives up.
  const { url } = await startZen((_seen, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"partial":true')
    // deliberately never end()
  })
  const { gateway } = makeGateway(url, { bodyBudgetMs: 120 })
  await assert.rejects(
    gateway.handle({
      api: 'chat',
      body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      clientStream: false,
    }),
    (err: unknown) => err instanceof GatewayHttpError && err.status === 502 && /budget/.test(err.message),
  )
})

test('a client disconnect mid-flight ends as 499 without punishing the exit', async () => {
  // A disconnect is not an exit failure: rotating would burn the budget on a
  // request nobody is waiting for, and marking failure would cool a perfectly
  // healthy tunnel. The gateway must absorb it and report 499.
  const { url } = await startZen(() => {
    // never write anything: the request stays pending until the client leaves
  })
  const { gateway, pool } = makeGateway(url, { poolEnabled: true, exits: ['http://exit-a:1', 'http://exit-b:1'] })
  const before = pool.usableCount(CHAT_MODEL)
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 50)
  await assert.rejects(
    gateway.handle({
      api: 'chat',
      body: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      clientStream: true,
      signal: abort.signal,
    }),
    (err: unknown) => err instanceof GatewayHttpError && err.status === 499 && err.type === 'client_closed_request',
  )
  assert.equal(pool.usableCount(CHAT_MODEL), before, 'the exit is untouched after a client disconnect')
})
