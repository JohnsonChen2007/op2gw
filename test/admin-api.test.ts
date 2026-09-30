import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleAdmin } from '../dist/admin/api.js'
import { defaultConfig } from '../dist/core/config.js'
import type { Runtime } from '../dist/runtime.js'

/**
 * Admin settings API tests — GET/PUT /admin/settings (proxy pool surface) and
 * POST /admin/settings/default-proxy. A lightweight fake Runtime exercises the
 * route logic without booting the gateway; saveConfig writes to a temp dir.
 */

const tempDirs: string[] = []
const originalConfigPath = process.env.OP2GW_CONFIG
delete process.env.OP2GW_CONFIG

after(async () => {
  if (originalConfigPath === undefined) delete process.env.OP2GW_CONFIG
  else process.env.OP2GW_CONFIG = originalConfigPath
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
})

interface FakeRuntime {
  runtime: Runtime
  config: ReturnType<typeof defaultConfig>
  calls: { setProxy: string[]; applyManualPool: string[][]; setPinned: string[] }
  configDir: string
  hasExit: (id: string) => boolean
}

async function makeFakeRuntime(pool: string[] = []): Promise<FakeRuntime> {
  const dir = await mkdtemp(join(tmpdir(), 'op2gw-api-'))
  tempDirs.push(dir)
  const config = defaultConfig()
  config.dataDir = dir
  config.logLevel = 'error'
  config.pool.enabled = true
  config.pool.manual = [...pool]
  config.pool.pinnedExitId = ''
  const calls = { setProxy: [] as string[], applyManualPool: [] as string[][], setPinned: [] as string[] }
  const entries = new Map(pool.map((u) => [u, {}]))
  let pinned = ''
  const fake = {
    config,
    pool: {
      has: (id: string) => entries.has(id),
      setPinned: (id: string) => {
        pinned = id
        calls.setPinned.push(id)
      },
      clearSticky: () => {},
    },
    setProxy: (uri: string) => {
      config.proxy = uri
      calls.setProxy.push(uri)
    },
    applyManualPool: (list: string[]) => {
      calls.applyManualPool.push(list)
      const prev = [...config.pool.manual]
      config.pool.manual = [...list]
      const removed = prev.filter((u) => !list.includes(u))
      for (const u of removed) entries.delete(u)
      for (const u of list) entries.set(u, {})
      return { added: list.filter((u) => !prev.includes(u)), removed }
    },
    setLogLevel: () => {},
    logger: { child: () => ({ info: () => {}, warn: () => {}, debug: () => {} }) },
    settings: () => ({
      host: config.host,
      port: config.port,
      proxy: config.proxy,
      logLevel: 'error',
      refreshSeconds: config.refreshSeconds,
      poolEnabled: config.pool.enabled,
      hasApiKeys: config.apiKeys.length > 0,
      envProxyDetected: '',
      configPath: join(dir, 'config.json'),
      proxyPool: [...config.pool.manual],
      pinnedExitId: config.pool.pinnedExitId,
    }),
  }
  return {
    runtime: fake as unknown as Runtime,
    config,
    calls,
    configDir: dir,
    hasExit: (id: string) => entries.has(id),
  }
}

function mockReq(body: unknown, method = 'POST'): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  return {
    method,
    [Symbol.asyncIterator]: async function* () {
      yield payload
    },
  } as unknown as IncomingMessage
}

interface MockRes {
  res: ServerResponse
  status: () => number
  body: () => unknown
}

function mockRes(): MockRes {
  let statusCode = 0
  let text = ''
  const res = {
    writeHead(s: number, _h: Record<string, string>) {
      statusCode = s
      return res
    },
    end(t?: string) {
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

async function call(fake: FakeRuntime, path: string, body: unknown, method = 'POST') {
  const out = mockRes()
  await handleAdmin(fake.runtime, mockReq(body, method), out.res, new URL(`http://127.0.0.1${path}`))
  return out
}

test('GET /admin/settings returns proxyPool and pinnedExitId', async () => {
  const fake = await makeFakeRuntime(['http://op2gw:secret@h:10808'])
  fake.config.pool.pinnedExitId = 'http://op2gw:secret@h:10808'
  const out = await call(fake, '/admin/settings', {}, 'GET')
  assert.equal(out.status(), 200)
  const s = out.body() as { proxyPool: string[]; pinnedExitId: string }
  assert.deepEqual(s.proxyPool, ['http://op2gw:secret@h:10808'])
  assert.equal(s.pinnedExitId, 'http://op2gw:secret@h:10808')
})

test('PUT /admin/settings with proxyPool applies and persists the list', async () => {
  const fake = await makeFakeRuntime()
  const list = ['http://u:p@h1:1080', 'socks5://h2:1080']
  const out = await call(fake, '/admin/settings', { proxyPool: list }, 'PUT')
  assert.equal(out.status(), 200)
  const data = out.body() as { ok: boolean; applied: { proxyPool: { total: number } }; savedPath: string }
  assert.equal(data.ok, true)
  assert.equal(data.applied.proxyPool.total, 2)
  assert.ok(data.savedPath.endsWith('config.json'))
  const onDisk = JSON.parse(await readFile(data.savedPath, 'utf8')) as { pool: { manual: string[] } }
  assert.deepEqual(onDisk.pool.manual, list)
})

test('PUT /admin/settings with a first proxy seeds an empty pool', async () => {
  const fake = await makeFakeRuntime()
  const out = await call(fake, '/admin/settings', { proxy: 'http://u:p@h:1080', persist: false }, 'PUT')
  assert.equal(out.status(), 200)
  assert.deepEqual(fake.calls.applyManualPool, [['http://u:p@h:1080']])
  assert.deepEqual(fake.config.pool.manual, ['http://u:p@h:1080'])
  assert.equal(fake.calls.setProxy[0], 'http://u:p@h:1080')
})

test('PUT /admin/settings with a proxy and non-empty pool leaves the pool untouched', async () => {
  const fake = await makeFakeRuntime(['http://existing:1'])
  await call(fake, '/admin/settings', { proxy: 'http://other:2', persist: false }, 'PUT')
  assert.deepEqual(fake.calls.applyManualPool, [], 'no implicit pool mutation once the pool exists')
  assert.deepEqual(fake.config.pool.manual, ['http://existing:1'])
})

test('POST /admin/settings/default-proxy 404s for an unknown exit', async () => {
  const fake = await makeFakeRuntime(['http://known:1'])
  const out = await call(fake, '/admin/settings/default-proxy', { uri: 'http://unknown:9' })
  assert.equal(out.status(), 404)
  assert.deepEqual(fake.calls.setProxy, [])
})

test('POST /admin/settings/default-proxy 400s for an invalid uri', async () => {
  const fake = await makeFakeRuntime(['http://known:1'])
  const out = await call(fake, '/admin/settings/default-proxy', { uri: 'not a proxy!!' })
  assert.equal(out.status(), 400)
})

test('POST /admin/settings/default-proxy sets, pins, and persists a pool exit', async () => {
  const fake = await makeFakeRuntime(['http://u:p@h:1080'])
  // Mixed-case scheme/host canonicalizes to the pool id; credential case is
  // preserved verbatim by parseProxyLine.
  const out = await call(fake, '/admin/settings/default-proxy', { uri: 'HTTP://u:p@H:1080' })
  assert.equal(out.status(), 200)
  const data = out.body() as { ok: boolean; proxy: string; savedPath: string }
  assert.equal(data.ok, true)
  assert.equal(data.proxy, 'http://u:p@h:1080')
  assert.deepEqual(fake.calls.setProxy, ['http://u:p@h:1080'])
  assert.equal(fake.config.pool.pinnedExitId, 'http://u:p@h:1080')
  assert.ok(data.savedPath.endsWith('config.json'))
  const onDisk = JSON.parse(await readFile(data.savedPath, 'utf8')) as {
    proxy: string
    pool: { pinnedExitId: string; manual: string[] }
  }
  assert.equal(onDisk.proxy, 'http://u:p@h:1080')
  assert.equal(onDisk.pool.pinnedExitId, 'http://u:p@h:1080')
  assert.deepEqual(onDisk.pool.manual, ['http://u:p@h:1080'])
})

test('POST /admin/settings/default-proxy direct clears proxy and pin', async () => {
  const fake = await makeFakeRuntime(['http://u:p@h:1080'])
  fake.config.pool.pinnedExitId = 'http://u:p@h:1080'
  const out = await call(fake, '/admin/settings/default-proxy', { uri: 'direct' })
  assert.equal(out.status(), 200)
  assert.deepEqual(fake.calls.setProxy, [''])
  assert.equal(fake.config.pool.pinnedExitId, '')
  assert.deepEqual(fake.calls.setPinned, [''])
  assert.deepEqual(fake.config.pool.manual, ['http://u:p@h:1080'], 'pool membership is unchanged')
})
