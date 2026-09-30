import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defaultConfig,
  loadConfig,
  saveConfig,
  normalizeProxyUri,
  detectEnvProxy,
} from '../dist/core/config.js'
import { parseProxyLine, proxyToExit } from '../dist/pool/sources.js'

/**
 * Config + proxy-line unit tests — the normalization rules the proxy-pool
 * feature depends on (id canonicalization) and the persistence round-trip
 * for pool.manual / pinnedExitId.
 */

const tempDirs: string[] = []
const originalConfigPath = process.env.OP2GW_CONFIG
delete process.env.OP2GW_CONFIG

after(async () => {
  if (originalConfigPath === undefined) delete process.env.OP2GW_CONFIG
  else process.env.OP2GW_CONFIG = originalConfigPath
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'op2gw-test-'))
  tempDirs.push(dir)
  return dir
}

test('normalizeProxyUri canonicalizes common shapes', () => {
  assert.equal(normalizeProxyUri('  '), '')
  assert.equal(normalizeProxyUri('198.51.100.1:10808'), 'http://198.51.100.1:10808')
  assert.equal(normalizeProxyUri('socks5h://h:1'), 'socks5://h:1')
  assert.equal(normalizeProxyUri('http://h:1'), 'http://h:1')
  assert.equal(normalizeProxyUri('HTTP://h:1'), 'HTTP://h:1')
  assert.equal(normalizeProxyUri('http://user:pass@h:10808'), 'http://user:pass@h:10808')
})

test('parseProxyLine parses schemes, bare host:port, and rejects junk', () => {
  assert.equal(parseProxyLine('host:1080'), 'http://host:1080')
  assert.equal(parseProxyLine('socks5://h:1'), 'socks5://h:1')
  assert.equal(parseProxyLine('socks5h://h:1'), 'socks5://h:1')
  assert.equal(parseProxyLine('# comment'), null)
  assert.equal(parseProxyLine(''), null)
  assert.equal(parseProxyLine('not a proxy'), null)
  // socks4 is unsupported by the undici dialer -> rejected, not silently kept.
  assert.equal(parseProxyLine('socks4://h:1'), null)
})

test('parseProxyLine canonicalizes scheme+host but preserves credential case', () => {
  // Scheme and host are lowercased (pool-id canonical form); the userinfo is
  // kept verbatim because passwords are case-sensitive.
  assert.equal(parseProxyLine('HTTP://User:Pass@Host:1080'), 'http://User:Pass@host:1080')
  assert.equal(parseProxyLine('socks5h://H:1'), 'socks5://h:1')
  assert.equal(parseProxyLine('http://u:P%40ss@h:1'), 'http://u:P%40ss@h:1')
})

test('proxyToExit derives kind and source', () => {
  assert.equal(proxyToExit('http://h:1').kind, 'http')
  assert.equal(proxyToExit('socks5://h:1').kind, 'socks5')
  assert.equal(proxyToExit('http://h:1').source, 'free')
})

test('saveConfig/loadConfig round-trips the proxy pool and pinned exit', async () => {
  const dir = await tempDir()
  process.env.OP2GW_CONFIG = join(dir, 'config.json')
  const cfg = defaultConfig()
  cfg.proxy = 'http://op2gw:secret@198.51.100.1:10808'
  cfg.pool.enabled = true
  cfg.pool.manual = ['http://op2gw:secret@198.51.100.1:10808', 'socks5://127.0.0.1:10808']
  cfg.pool.pinnedExitId = 'http://op2gw:secret@198.51.100.1:10808'
  const savedPath = await saveConfig(cfg)
  assert.equal(savedPath, process.env.OP2GW_CONFIG)
  const onDisk = JSON.parse(await readFile(savedPath, 'utf8')) as Record<string, unknown>
  assert.equal(onDisk.proxy, cfg.proxy)
  assert.deepEqual((onDisk.pool as { manual: string[] }).manual, cfg.pool.manual)
  assert.equal((onDisk.pool as { pinnedExitId: string }).pinnedExitId, cfg.pool.pinnedExitId)

  const loaded = await loadConfig([])
  assert.equal(loaded.proxy, cfg.proxy)
  assert.deepEqual(loaded.pool.manual, cfg.pool.manual)
  assert.equal(loaded.pool.pinnedExitId, cfg.pool.pinnedExitId)
  assert.equal(loaded.pool.enabled, true)
})

test('loadConfig accepts bare host:port via normalizeProxyUri', async () => {
  const dir = await tempDir()
  process.env.OP2GW_CONFIG = join(dir, 'config.json')
  const cfg = defaultConfig()
  cfg.proxy = 'proxy.example.com:3128'
  await saveConfig(cfg)
  const loaded = await loadConfig([])
  assert.equal(loaded.proxy, 'http://proxy.example.com:3128')
})

test('detectEnvProxy prefers OP2GW_PROXY over standard vars', () => {
  const saved = { ...process.env }
  try {
    process.env.OP2GW_PROXY = 'socks5h://env:1'
    assert.equal(detectEnvProxy(), 'socks5://env:1')
    delete process.env.OP2GW_PROXY
    process.env.https_proxy = 'http://sys:2'
    assert.equal(detectEnvProxy(), 'http://sys:2')
  } finally {
    process.env = saved
  }
})

test('loadConfig accepts --no-direct flag to disable direct egress', async () => {
  const loaded = await loadConfig(['--no-direct'])
  assert.equal(loaded.pool.includeDirect, false)
})
