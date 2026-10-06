import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../dist/core/config.js'
import { Runtime, VERSION } from '../dist/runtime.js'

/**
 * Runtime unit tests — applyManualPool reconciliation (settings-page proxy
 * pool edits) and setProxy health/ban/sticky resets. The Runtime is built
 * against unreachable local endpoints so nothing touches the network; start()
 * is never called, and stop() releases the dispatcher agents.
 */

const tempDirs: string[] = []
after(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function makeRuntime(manual: string[] = [], pinned = ''): Promise<Runtime> {
  const dir = await mkdtemp(join(tmpdir(), 'op2gw-rt-'))
  tempDirs.push(dir)
  const cfg = defaultConfig()
  cfg.dataDir = dir
  cfg.logLevel = 'error'
  // Offline endpoints: catalog refresh (fired by setProxy) fails fast.
  cfg.zenBaseUrl = 'http://127.0.0.1:9'
  cfg.metadataUrl = 'http://127.0.0.1:9'
  cfg.proxy = ''
  cfg.pool.enabled = true
  cfg.pool.freeSources = []
  cfg.pool.manual = [...manual]
  cfg.pool.pinnedExitId = pinned
  return new Runtime(cfg)
}

test('applyManualPool adds, dedupes, and normalizes new entries', async () => {
  const rt = await makeRuntime(['http://a:1'])
  try {
    const { added, removed } = rt.applyManualPool(['http://a:1', 'HTTP://B:2', 'http://b:2'])
    assert.deepEqual(added, ['http://b:2'], 'mixed-case input canonicalizes to lowercase')
    assert.deepEqual(removed, [])
    assert.deepEqual(rt.config.pool.manual, ['http://a:1', 'http://b:2'])
    assert.equal(rt.pool.has('http://a:1'), true)
    assert.equal(rt.pool.has('http://b:2'), true)
  } finally {
    await rt.stop()
  }
})

test('applyManualPool removes dropped entries and clears a stale pin', async () => {
  const rt = await makeRuntime(['http://a:1', 'http://b:1'], 'http://b:1')
  try {
    rt.pool.setPinned('http://b:1')
    const { added, removed } = rt.applyManualPool(['http://c:1'])
    assert.deepEqual(added, ['http://c:1'])
    assert.deepEqual(removed, ['http://a:1', 'http://b:1'])
    assert.equal(rt.pool.has('http://a:1'), false)
    assert.equal(rt.pool.has('http://b:1'), false)
    assert.equal(rt.pool.has('http://c:1'), true)
    assert.equal(rt.config.pool.pinnedExitId, '', 'pin pointing at a removed exit is cleared')
    assert.equal(rt.config.pool.manual.length, 1)
  } finally {
    await rt.stop()
  }
})

test('applyManualPool keeps the pin when the exit stays in the list', async () => {
  const rt = await makeRuntime(['http://a:1', 'http://b:1'], 'http://b:1')
  try {
    rt.pool.setPinned('http://b:1')
    rt.applyManualPool(['http://b:1', 'http://c:1'])
    assert.equal(rt.config.pool.pinnedExitId, 'http://b:1')
  } finally {
    await rt.stop()
  }
})

test('applyManualPool drops invalid entries instead of adding them', async () => {
  const rt = await makeRuntime([])
  try {
    const { added } = rt.applyManualPool(['socks4://h:1', 'garbage', 'http://ok:1'])
    assert.deepEqual(added, ['http://ok:1'])
    assert.deepEqual(rt.config.pool.manual, ['http://ok:1'])
  } finally {
    await rt.stop()
  }
})

test('setProxy resets direct-exit cooldown, model bans, and sticky bindings', async () => {
  // Empty manual pool: direct is the only exit, so picks land on it.
  const rt = await makeRuntime([])
  try {
    rt.pool.pick('m', 'sess')
    assert.equal(rt.pool.exitOfSession('sess'), 'direct')
    // Poison the direct exit the way real failures would.
    rt.pool.markFailure('direct', 'm', 'limited')
    assert.equal(rt.pool.isUsable('direct', 'm'), false)
    rt.pool.markFailure('direct', 'm2', 'region')
    assert.equal(rt.pool.isUsable('direct', 'm2'), false)

    rt.setProxy('http://127.0.0.1:9/')
    assert.equal(rt.pool.isUsable('direct', 'm'), true, 'cooldown reset after proxy change')
    assert.equal(rt.pool.isUsable('direct', 'm2'), true, 'model ban cleared after proxy change')
    assert.equal(rt.pool.exitOfSession('sess'), null, 'sticky bindings cleared')
    assert.equal(rt.dispatchers.defaultProxy, 'http://127.0.0.1:9/')
    assert.equal(rt.config.proxy, 'http://127.0.0.1:9/')
  } finally {
    await rt.stop()
  }
})

test('setProxy to empty clears the default proxy', async () => {
  const rt = await makeRuntime([])
  try {
    rt.setProxy('http://127.0.0.1:9/')
    rt.setProxy('')
    assert.equal(rt.config.proxy, '')
    assert.equal(rt.dispatchers.defaultProxy, '')
    assert.equal(rt.pool.isUsable('direct', 'm'), true)
  } finally {
    await rt.stop()
  }
})

test('settings() exposes the proxy pool and pinned exit', async () => {
  const rt = await makeRuntime(['http://a:1'], 'http://a:1')
  try {
    const s = rt.settings()
    assert.deepEqual(s.proxyPool, ['http://a:1'])
    assert.equal(s.pinnedExitId, 'http://a:1')
    assert.equal(s.poolEnabled, true)
    assert.equal(s.includeDirect, true)
    assert.equal(typeof s.configPath, 'string')
  } finally {
    await rt.stop()
  }
})

test('Runtime with includeDirect: false excludes direct from pool and routes strictly through proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'op2gw-rt-nodir-'))
  tempDirs.push(dir)
  const cfg = defaultConfig()
  cfg.dataDir = dir
  cfg.logLevel = 'error'
  cfg.zenBaseUrl = 'http://127.0.0.1:9'
  cfg.metadataUrl = 'http://127.0.0.1:9'
  cfg.proxy = ''
  cfg.pool.enabled = true
  cfg.pool.includeDirect = false
  cfg.pool.manual = ['http://proxy.example:8080']

  const rt = new Runtime(cfg)
  try {
    assert.equal(rt.pool.has('direct'), false, 'direct exit is not in pool')
    assert.equal(rt.pool.size(), 1, 'pool size reflects only proxy exits')
    assert.equal(rt.pool.view().length, 1)
    assert.equal(rt.pool.view()[0]?.id, 'http://proxy.example:8080')
    assert.equal(rt.pool.pick('m', 'sess')?.exit.id, 'http://proxy.example:8080')

    // If manual proxy fails, it does NOT fall back to direct
    rt.pool.markFailure('http://proxy.example:8080', 'm', 'transport')
    assert.equal(rt.pool.pick('m', 'sess'), null, 'no fallback to direct when proxy-only')

    // Gateway handle refuses direct egress with 503
    await assert.rejects(
      async () => {
        await rt.gateway.handle({
          api: 'chat',
          body: { model: 'mimo-v2.5-free', messages: [{ role: 'user', content: 'hi' }] },
          clientStream: true,
        })
      },
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /direct egress is disallowed/i)
        return true
      },
    )
  } finally {
    await rt.stop()
  }
})


test('health reports ok while an exit is usable and degraded once none is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'op2gw-rt-'))
  tempDirs.push(dir)
  const cfg = defaultConfig()
  cfg.dataDir = dir
  cfg.logLevel = 'error'
  cfg.zenBaseUrl = 'http://127.0.0.1:9'
  cfg.metadataUrl = 'http://127.0.0.1:9'
  cfg.proxy = ''
  cfg.pool.enabled = true
  cfg.pool.includeDirect = false
  cfg.pool.freeSources = []
  cfg.pool.manual = ['http://proxy.example:8080']
  const rt = new Runtime(cfg)
  try {
    // A monitor must be able to tell "the process is up" from "the process is
    // up but every exit is cooling/dead/banned" — the old /healthz always said
    // 200, which hid exactly the outage self-heal exists to detect.
    assert.equal(rt.health().status, 'ok')
    assert.equal(rt.health().pool.usable, 1)
    rt.pool.markProbe('http://proxy.example:8080', false, 0)
    assert.equal(rt.health().status, 'degraded')
    assert.equal(rt.health().pool.usable, 0)
    assert.equal(rt.health().version, VERSION)
  } finally {
    await rt.stop()
  }
})
