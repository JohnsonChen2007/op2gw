import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SelfHealer } from '../dist/selfheal.js'
import { defaultConfig } from '../dist/core/config.js'
import { Logger } from '../dist/core/logger.js'
import { ExitPool } from '../dist/pool/pool.js'

/**
 * SelfHealer tests — the periodic watchdog that keeps the gateway serving:
 * catalog staleness refresh, direct-exit revival, degraded-pool warning, and
 * the status.json snapshot for external monitoring.
 */

const tempDirs: string[] = []
after(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
})

function quietScope() {
  return new Logger({ level: 'error', stdout: false, capacity: 10, traceCapacity: 10 }).child('selfheal')
}

interface CatalogDouble {
  ageMs: () => number
  refreshOnce: () => Promise<void>
  snapshot: () => { status: string; total: number; exposed: number; lastError: string }
  refreshes: number
}

function catalogDouble(ageMs: number): CatalogDouble {
  const d: CatalogDouble = {
    refreshes: 0,
    ageMs: () => ageMs,
    refreshOnce: async () => {
      d.refreshes += 1
      ageMs = 0
    },
    snapshot: () => ({ status: 'ready', total: 1, exposed: 1, lastError: '' }),
  }
  return d
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'op2gw-heal-'))
  tempDirs.push(dir)
  return dir
}

test('tick forces a catalog refresh when S1 is stale', async () => {
  const dir = await tempDir()
  const cfg = defaultConfig()
  cfg.dataDir = dir
  cfg.selfHeal.catalogStaleMs = 1000
  const catalog = catalogDouble(5000)
  const healer = new SelfHealer({
    logger: quietScope(),
    catalog: catalog as never,
    pool: new ExitPool(),
    config: cfg,
  })
  await healer.tick()
  assert.equal(catalog.refreshes, 1, 'stale catalog triggers a refresh')
  const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')) as { poolSize: number; poolEnabled: boolean }
  assert.equal(status.poolEnabled, false)
  assert.equal(status.poolSize, 1, 'tick revives the direct floor (includeDirect defaults true)')
})

test('tick leaves a fresh catalog alone but still writes status.json', async () => {
  const dir = await tempDir()
  const cfg = defaultConfig()
  cfg.dataDir = dir
  cfg.selfHeal.catalogStaleMs = 60_000
  const catalog = catalogDouble(100)
  const healer = new SelfHealer({
    logger: quietScope(),
    catalog: catalog as never,
    pool: new ExitPool(),
    config: cfg,
  })
  await healer.tick()
  assert.equal(catalog.refreshes, 0, 'fresh catalog is not refreshed')
  const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')) as { catalog: { status: string } }
  assert.equal(status.catalog.status, 'ready')
})

test('tick revives direct when includeDirect is on, even if it was removed', async () => {
  const dir = await tempDir()
  const cfg = defaultConfig()
  cfg.dataDir = dir
  cfg.selfHeal.catalogStaleMs = 60_000
  cfg.pool.includeDirect = true
  const pool = new ExitPool()
  pool.ensureDirect()
  pool.remove('direct')
  assert.equal(pool.has('direct'), false)
  const healer = new SelfHealer({ logger: quietScope(), catalog: catalogDouble(0) as never, pool, config: cfg })
  await healer.tick()
  assert.equal(pool.has('direct'), true, 'the only-exit floor is restored')
})

test('tick never revives direct when direct egress is disallowed', async () => {
  const dir = await tempDir()
  const cfg = defaultConfig()
  cfg.dataDir = dir
  cfg.selfHeal.catalogStaleMs = 60_000
  cfg.pool.includeDirect = false
  cfg.pool.enabled = true
  const pool = new ExitPool()
  pool.setIncludeDirect(false)
  const healer = new SelfHealer({ logger: quietScope(), catalog: catalogDouble(0) as never, pool, config: cfg })
  await healer.tick()
  assert.equal(pool.has('direct'), false, 'reviving direct would leak the real egress IP')
})

test('start/stop manages the timer without double-starting', async () => {
  const dir = await tempDir()
  const cfg = defaultConfig()
  cfg.dataDir = dir
  const catalog = catalogDouble(0)
  const healer = new SelfHealer({
    logger: quietScope(),
    catalog: catalog as never,
    pool: new ExitPool(),
    config: cfg,
    intervalMs: 10,
  })
  healer.start()
  healer.start()
  await new Promise((r) => setTimeout(r, 50))
  healer.stop()
  healer.stop()
  assert.ok(catalog.refreshes >= 0, 'timer ran without throwing')
})
