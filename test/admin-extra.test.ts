import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleAdmin } from '../dist/admin/api.js'
import { defaultConfig } from '../dist/core/config.js'
import { Runtime } from '../dist/runtime.js'

/**
 * Admin read + pool-control route tests — everything the debug UI talks to
 * beyond the settings surface (covered in admin-api.test.ts).
 *
 * A real Runtime is built against unreachable local endpoints so nothing
 * touches the network; start() is never called, and stop() releases the
 * dispatcher agents.
 */

const tempDirs: string[] = []
after(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function makeRuntime(): Promise<Runtime> {
  const dir = await mkdtemp(join(tmpdir(), 'op2gw-adm-'))
  tempDirs.push(dir)
  const cfg = defaultConfig()
  cfg.dataDir = dir
  cfg.logLevel = 'error'
  cfg.zenBaseUrl = 'http://127.0.0.1:9'
  cfg.metadataUrl = 'http://127.0.0.1:9'
  cfg.proxy = ''
  cfg.pool.enabled = true
  cfg.pool.freeSources = []
  cfg.pool.manual = []
  return new Runtime(cfg)
}

type ReqHandlers = Map<string, Array<() => void>>

function mockReq(body: unknown, method = 'GET'): IncomingMessage & { handlers: ReqHandlers; fire: (ev: string) => void } {
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  const handlers: ReqHandlers = new Map()
  const req = {
    method,
    handlers,
    fire: (ev: string): void => {
      for (const h of handlers.get(ev) ?? []) h()
    },
    [Symbol.asyncIterator]: async function* () {
      yield payload
    },
    on: (ev: string, h: () => void): unknown => {
      const list = handlers.get(ev) ?? []
      list.push(h)
      handlers.set(ev, list)
      return req
    },
  }
  return req as unknown as IncomingMessage & { handlers: ReqHandlers; fire: (ev: string) => void }
}

function mockJsonRes(): {
  res: ServerResponse
  status: () => number
  body: () => unknown
} {
  let statusCode = 0
  let text = ''
  const res = {
    writeHead(s: number, _h: Record<string, string>): unknown {
      statusCode = s
      return res
    },
    end(t?: string): unknown {
      text = t ?? ''
      return res
    },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => statusCode,
    body: () => (text ? JSON.parse(text) : null),
  }
}

function mockSseRes(): {
  res: ServerResponse
  status: () => number
  text: () => string
} {
  let statusCode = 0
  const writes: string[] = []
  const res = {
    writeHead(s: number, _h: Record<string, string>): unknown {
      statusCode = s
      return res
    },
    write(c: string): boolean {
      writes.push(String(c))
      return true
    },
    end(): unknown {
      return res
    },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => statusCode,
    text: () => writes.join(''),
  }
}

async function call(rt: Runtime, path: string, body: unknown = {}, method = 'GET'): Promise<{ status: number; body: unknown }> {
  const out = mockJsonRes()
  await handleAdmin(rt, mockReq(body, method), out.res, new URL(`http://127.0.0.1${path}`))
  return { status: out.status(), body: out.body() }
}

test('GET /admin/status returns runtime, catalog, and pool snapshots', async () => {
  const rt = await makeRuntime()
  try {
    const { status, body } = await call(rt, '/admin/status')
    assert.equal(status, 200)
    const s = body as { version: string; catalog: { exposed: number }; pool: { enabled: boolean; total: number }; logLevel: string; proxy: string }
    assert.equal(s.version, '0.1.0')
    assert.equal(s.pool.enabled, true)
    assert.equal(s.pool.total, 1, 'direct is the only exit')
    assert.equal(s.logLevel, 'error')
    assert.equal(typeof s.proxy, 'string')
    assert.ok(s.catalog.exposed > 0, 'cold start advertises the verified bootstrap list')
  } finally {
    await rt.stop()
  }
})

test('GET /admin/models lists exposed models with decision metadata', async () => {
  const rt = await makeRuntime()
  try {
    const { status, body } = await call(rt, '/admin/models')
    assert.equal(status, 200)
    const data = body as { object: string; total: number; models: Array<{ id: string; decision: { allowed: boolean; source: string } }> }
    assert.equal(data.object, 'list')
    assert.equal(data.total, data.models.length)
    assert.ok(data.models.length > 0, 'cold start advertises the verified bootstrap list')
    for (const m of data.models) {
      assert.equal(typeof m.id, 'string')
      assert.equal(typeof m.decision.source, 'string', 'each model carries its decision provenance')
    }
  } finally {
    await rt.stop()
  }
})

test('GET /admin/logs filters by level and caps by limit', async () => {
  const rt = await makeRuntime()
  try {
    rt.logger.child('t').error('err-one')
    rt.logger.child('t').error('err-two')
    const all = (await call(rt, '/admin/logs')) as { status: number; body: { records: Array<{ msg: string }> } }
    assert.equal(all.status, 200)
    assert.ok(all.body.records.some((r) => r.msg === 'err-one'))
    const capped = (await call(rt, '/admin/logs?limit=1')) as { status: number; body: { records: unknown[] } }
    assert.equal(capped.body.records.length, 1)
    // info is below the error gate, so nothing new appears at level=info... but
    // error records still match a warn floor.
    const warnFloor = (await call(rt, '/admin/logs?level=warn')) as { status: number; body: { records: Array<{ level: string }> } }
    assert.ok(warnFloor.body.records.every((r) => r.level === 'warn' || r.level === 'error'))
  } finally {
    await rt.stop()
  }
})

test('GET /admin/traces returns recent request traces', async () => {
  const rt = await makeRuntime()
  try {
    rt.logger.trace({
      id: 'r1',
      ts: Date.now(),
      model: 'm',
      stream: true,
      status: 200,
      exit: 'direct',
      exitIP: '',
      attempts: 1,
      durationMs: 5,
      outcome: 'ok',
    })
    const { status, body } = await call(rt, '/admin/traces?limit=10')
    assert.equal(status, 200)
    const traces = (body as { traces: Array<{ id: string }> }).traces
    assert.ok(traces.some((t) => t.id === 'r1'))
  } finally {
    await rt.stop()
  }
})

test('GET /admin/logs/stream replays history, follows live, and cleans up on close', async () => {
  const rt = await makeRuntime()
  try {
    rt.logger.child('seed').error('seeded-msg')
    const out = mockSseRes()
    const req = mockReq({}, 'GET')
    await handleAdmin(rt, req, out.res, new URL('http://127.0.0.1/admin/logs/stream'))
    assert.equal(out.status(), 200)
    assert.ok(out.text().includes('seeded-msg'), 'recent history is replayed on subscribe')
    rt.logger.child('live').error('live-msg')
    assert.ok(out.text().includes('live-msg'), 'new records stream live')
    const before = out.text().length
    req.fire('close')
    rt.logger.child('live').error('after-close-msg')
    assert.equal(out.text().length, before, 'no delivery after the client disconnects')
  } finally {
    await rt.stop()
  }
})

test('POST /admin/pool/exits accepts a raw uri and structured parts, 400s junk', async () => {
  const rt = await makeRuntime()
  try {
    const added = await call(rt, '/admin/pool/exits', { uri: 'http://127.0.0.1:8080' }, 'POST')
    assert.equal(added.status, 200)
    assert.equal((added.body as { id: string }).id, 'http://127.0.0.1:8080')
    assert.equal(rt.pool.has('http://127.0.0.1:8080'), true)

    const structured = await call(rt, '/admin/pool/exits', { scheme: 'socks5', host: '127.0.0.1', port: 1080 }, 'POST')
    assert.equal(structured.status, 200)
    assert.equal((structured.body as { id: string }).id, 'socks5://127.0.0.1:1080')

    const bad = await call(rt, '/admin/pool/exits', { uri: 'not a proxy!!' }, 'POST')
    assert.equal(bad.status, 400)
  } finally {
    await rt.stop()
  }
})

test('DELETE /admin/pool/exits removes an exit but refuses direct', async () => {
  const rt = await makeRuntime()
  try {
    await call(rt, '/admin/pool/exits', { uri: 'http://127.0.0.1:8080' }, 'POST')
    const removed = await call(rt, '/admin/pool/exits', { id: 'http://127.0.0.1:8080' }, 'DELETE')
    assert.equal(removed.status, 200)
    assert.equal(rt.pool.has('http://127.0.0.1:8080'), false)
    const direct = await call(rt, '/admin/pool/exits', { id: 'direct' }, 'DELETE')
    assert.equal(direct.status, 400)
  } finally {
    await rt.stop()
  }
})

test('POST /admin/pool/pin pins a known exit and 404s an unknown one', async () => {
  const rt = await makeRuntime()
  try {
    await call(rt, '/admin/pool/exits', { uri: 'http://127.0.0.1:8080' }, 'POST')
    const pinned = await call(rt, '/admin/pool/pin', { id: 'http://127.0.0.1:8080' }, 'POST')
    assert.equal(pinned.status, 200)
    assert.equal((pinned.body as { pinned: string }).pinned, 'http://127.0.0.1:8080')
    const missing = await call(rt, '/admin/pool/pin', { id: 'http://unknown:9' }, 'POST')
    assert.equal(missing.status, 404)
  } finally {
    await rt.stop()
  }
})

test('POST /admin/pool/probe and /admin/pool/refresh report ok offline', async () => {
  const rt = await makeRuntime()
  try {
    const probe = await call(rt, '/admin/pool/probe', {}, 'POST')
    assert.equal(probe.status, 200)
    assert.equal((probe.body as { ok: boolean }).ok, true)
    const refresh = await call(rt, '/admin/pool/refresh', {}, 'POST')
    assert.equal(refresh.status, 200)
    assert.equal((refresh.body as { ok: boolean }).ok, true)
    assert.equal(typeof (refresh.body as { total: number }).total, 'number')
  } finally {
    await rt.stop()
  }
})

test('POST /admin/catalog/refresh returns ok with a snapshot', async () => {
  const rt = await makeRuntime()
  try {
    const { status, body } = await call(rt, '/admin/catalog/refresh', {}, 'POST')
    assert.equal(status, 200)
    assert.equal((body as { ok: boolean }).ok, true)
    assert.equal(typeof (body as { catalog: { exposed: number } }).catalog.exposed, 'number')
  } finally {
    await rt.stop()
  }
})

test('POST /admin/log-level applies a valid level and rejects junk', async () => {
  const rt = await makeRuntime()
  try {
    const ok = await call(rt, '/admin/log-level', { level: 'debug' }, 'POST')
    assert.equal(ok.status, 200)
    assert.equal(rt.logger.level, 'debug')
    const bad = await call(rt, '/admin/log-level', { level: 'verbose' }, 'POST')
    assert.equal(bad.status, 400)
  } finally {
    await rt.stop()
  }
})

test('unknown admin routes 404', async () => {
  const rt = await makeRuntime()
  try {
    const { status } = await call(rt, '/admin/nope', {}, 'GET')
    assert.equal(status, 404)
  } finally {
    await rt.stop()
  }
})
