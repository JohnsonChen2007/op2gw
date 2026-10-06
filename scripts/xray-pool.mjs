#!/usr/bin/env node
/**
 * xray-pool.mjs — turn the local v2rayN node library into an op2gw exit pool.
 *
 * The OpenCode Zen free lane meters its quota PER EGRESS IP, so one local proxy
 * port (v2rayN's single 10808 inbound) means one shared quota that a busy
 * gateway exhausts within hours. This script reads v2rayN's SQLite node library,
 * picks a diverse set of nodes (direct-IP nodes first — each has its own egress;
 * CF-worker nodes last — they share Cloudflare egress), and generates an xray
 * "sidecar" config with one SOCKS inbound per node on 127.0.0.1:21001+. op2gw
 * then treats each port as an independent exit and rotates across them, giving
 * the pool N distinct free-lane quotas.
 *
 *   gen    read the DB, write the sidecar config, print the mapping + URIs
 *   verify curl each inbound through an IP echo and print port -> exit IP
 *
 * Both modes are offline-safe: `gen` only reads the DB, and the sidecar itself
 * is run by launchd (com.op2gw.xraypool), not by this script.
 *
 * Examples:
 *   node scripts/xray-pool.mjs gen --count 12 --base-port 21001
 *   node scripts/xray-pool.mjs gen --addresses 54.179.116.70,47.131.86.109   # manual pick
 *   node scripts/xray-pool.mjs gen --exclude 54.179.116.70,3.70.46.36        # rotate past burned exits
 *   node scripts/xray-pool.mjs verify --count 12
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_DB = join(homedir(), 'Library/Application Support/v2rayN/guiConfigs/guiNDB.db')
const DEFAULT_GUI = join(homedir(), 'Library/Application Support/v2rayN/guiConfigs/guiNConfig.json')
const DEFAULT_XRAY = join(homedir(), 'Library/Application Support/v2rayN/bin/xray/xray')
const DEFAULT_OUT_DIR = join(homedir(), '.op2gw/xray-pool')

/** Cloudflare edge ranges: nodes addressed here are worker/pages frontends
 *  whose egress is Cloudflare's shared pool — many nodes, few real IPs. */
const CF_PREFIXES = [
  '104.16.', '104.17.', '104.18.', '104.19.', '104.20.', '104.21.', '104.22.', '104.23.',
  '104.24.', '104.25.', '104.26.', '104.27.', '104.28.',
  '108.162.', '141.101.', '162.158.', '162.159.', '172.64.', '172.65.', '172.66.', '172.67.',
  '172.68.', '172.69.', '172.70.', '172.71.', '173.245.', '188.114.', '190.93.', '197.234.',
  '198.41.', '103.21.244.', '103.22.200.', '103.31.4.', '5.101.78.',
]

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    else args._.push(a)
  }
  return args
}

/** Read a SQLite table through the system sqlite3 CLI (no lock contention with
 *  the running v2rayN app; node:sqlite would contend with its write lock). */
function sqliteJson(db, sql) {
  const out = execFileSync('sqlite3', ['-json', db, sql], { maxBuffer: 64 * 1024 * 1024 }).toString()
  return out.trim() ? JSON.parse(out) : []
}

const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
const isCf = (addr) => CF_PREFIXES.some((p) => addr.startsWith(p))

/** xray outbound for one node row (vmess configType=1, vless configType=5). */
function nodeOutbound(tag, row) {
  const address = row.address
  const port = Number(row.port)
  const stream = { network: row.network === 'tcp' ? 'raw' : (row.network || 'raw'), security: '' }
  const sec = (row.streamSecurity || '').toLowerCase()
  if (sec === 'tls') {
    stream.security = 'tls'
    stream.tlsSettings = {
      serverName: row.sni || row.requestHost || address,
      fingerprint: row.fingerprint || 'chrome',
      allowInsecure: row.allowInsecure === 'true',
      ...(row.alpn ? { alpn: String(row.alpn).split(',').filter(Boolean) } : {}),
    }
  } else if (sec === 'reality') {
    stream.security = 'reality'
    stream.realitySettings = {
      serverName: row.sni || address,
      fingerprint: row.fingerprint || 'chrome',
      publicKey: row.publicKey || '',
      shortId: row.shortId || '',
      ...(row.spiderX ? { spiderX: row.spiderX } : {}),
    }
  } else {
    stream.security = 'none'
  }
  if (stream.network === 'ws') {
    stream.wsSettings = {
      path: row.path || '/',
      ...(row.requestHost ? { headers: { Host: row.requestHost } } : {}),
    }
  } else if (stream.network === 'grpc') {
    stream.grpcSettings = { serviceName: row.path || '' }
  } else {
    stream.rawSettings = {}
  }

  if (Number(row.configType) === 1) {
    return {
      tag, protocol: 'vmess',
      settings: { vnext: [{ address, port, users: [{ id: row.id, security: row.security || 'auto', level: 0 }] }] },
      streamSettings: stream, mux: { enabled: false },
    }
  }
  return {
    tag, protocol: 'vless',
    settings: {
      vnext: [{
        address, port,
        users: [{ id: row.id, encryption: 'none', level: 0, ...(row.flow ? { flow: row.flow } : {}) }],
      }],
    },
    streamSettings: stream, mux: { enabled: false },
  }
}

/** Collapse rows to one per address (same address = same egress regardless of
 *  port), preferring rows whose transport config is most complete. */
function dedupeByAddress(rows) {
  const byAddr = new Map()
  for (const r of rows) {
    if (!r.address || !r.port || !r.id) continue
    const prev = byAddr.get(r.address)
    const score = (r.streamSecurity === 'reality' ? 4 : r.streamSecurity === 'tls' ? 2 : 0) + (r.sni ? 1 : 0) + (r.path ? 1 : 0)
    if (!prev || score > prev._score) byAddr.set(r.address, { ...r, _score: score })
  }
  return [...byAddr.values()]
}

/** Worker-backend key for CF-fronted nodes: all edges of one worker share the
 *  worker's egress, so only one edge per backend is worth a slot. */
function backendKey(row) {
  const host = row.sni || row.requestHost || (row.path || '').split('/')[0]
  return host || row.address
}

function selectNodes(db, guiCfg, count, onlyAddresses, excludeAddresses) {
  const exclude = new Set((excludeAddresses ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  const rows = sqliteJson(db, `SELECT ConfigType AS configType, Remarks AS remarks, Address AS address, Port AS port, Id AS id, Security AS security, Network AS network, HeaderType AS headerType, RequestHost AS requestHost, Path AS path, StreamSecurity AS streamSecurity, Sni AS sni, Flow AS flow, Fingerprint AS fingerprint, PublicKey AS publicKey, ShortId AS shortId, SpiderX AS spiderX, Alpn AS alpn, AllowInsecure AS allowInsecure, Subid AS subid FROM ProfileItem WHERE ConfigType IN (1,5)`)
    .filter((r) => r.address && r.port && r.id && !exclude.has(r.address))

  let activeAddress = ''
  if (existsSync(guiCfg)) {
    try {
      const gui = JSON.parse(execFileSync('cat', [guiCfg]).toString())
      const activeId = String(gui.IndexId ?? '').replaceAll("'", "''")
      const active = activeId ? sqliteJson(db, `SELECT Address AS address FROM ProfileItem WHERE IndexId = '${activeId}'`) : []
      activeAddress = active[0]?.address ?? ''
    } catch { /* active node is best-effort only */ }
  }

  const deduped = dedupeByAddress(rows)
  const direct = deduped.filter((r) => isIp(r.address) && !isCf(r.address))
  const workers = deduped.filter((r) => !isIp(r.address) || isCf(r.address))

  // Direct-IP nodes first, spread across /16 prefixes so a provider that owns a
  // contiguous block does not fill the whole pool; one worker per backend after.
  const byPrefix = new Map()
  for (const r of direct) {
    const p = r.address.split('.').slice(0, 2).join('.')
    if (!byPrefix.has(p)) byPrefix.set(p, [])
    byPrefix.get(p).push(r)
  }
  const spread = []
  let added = true
  while (spread.length < direct.length && added) {
    added = false
    for (const list of byPrefix.values()) {
      if (list.length) { spread.push(list.shift()); added = true }
    }
  }

  const seenBackend = new Set()
  const workerPicks = []
  for (const r of workers) {
    const k = backendKey(r)
    if (seenBackend.has(k)) continue
    seenBackend.add(k)
    workerPicks.push(r)
  }

  let picked = [...spread, ...workerPicks]
  if (onlyAddresses) {
    const allow = new Set(onlyAddresses.split(',').map((s) => s.trim()).filter(Boolean))
    picked = picked.filter((r) => allow.has(r.address))
  }
  // The active node is a known-good egress: hoist it to the front.
  picked.sort((a, b) => (a.address === activeAddress ? -1 : b.address === activeAddress ? 1 : 0))
  return picked.slice(0, count)
}

function generateConfig(nodes, basePort) {
  const inbounds = []
  const outbounds = []
  const rules = []
  nodes.forEach((row, i) => {
    const inTag = `in-${basePort + i}`
    const outTag = `out-${basePort + i}`
    inbounds.push({ tag: inTag, listen: '127.0.0.1', port: basePort + i, protocol: 'socks', settings: { udp: false } })
    outbounds.push(nodeOutbound(outTag, row))
    rules.push({ type: 'field', inboundTag: [inTag], outboundTag: outTag })
  })
  return { log: { loglevel: 'warning' }, inbounds, outbounds, routing: { domainStrategy: 'AsIs', rules } }
}

async function verify(basePort, count, timeoutMs) {
  const results = []
  for (let i = 0; i < count; i += 1) {
    const port = basePort + i
    const started = Date.now()
    let ip = ''
    try {
      ip = execFileSync('curl', ['-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)),
        '--socks5-hostname', `127.0.0.1:${port}`, 'https://api.ipify.org'], { timeout: timeoutMs + 2000 }).toString().trim()
    } catch { /* dead port */ }
    results.push({ port, ip, ms: Date.now() - started })
    const label = ip ? `exit=${ip}` : 'DEAD'
    process.stdout.write(`  127.0.0.1:${port}  ${label}  (${results.at(-1).ms}ms)\n`)
  }
  const live = results.filter((r) => r.ip)
  const ips = new Map()
  for (const r of live) ips.set(r.ip, (ips.get(r.ip) ?? 0) + 1)
  const dupes = [...ips.entries()].filter(([, n]) => n > 1)
  process.stdout.write(`\n  live ${live.length}/${count}; distinct exit IPs ${ips.size}`)
  if (dupes.length) process.stdout.write(`  (shared: ${dupes.map(([ip, n]) => `${ip} x${n}`).join(', ')})`)
  process.stdout.write('\n')
  return results
}

const args = parseArgs(process.argv.slice(2))
const mode = args._[0] ?? 'gen'
const db = args.db ?? DEFAULT_DB
const count = Number(args.count ?? 12)
const basePort = Number(args['base-port'] ?? 21001)
const outDir = args.out ? join(args.out, '..') : DEFAULT_OUT_DIR

if (mode === 'verify') {
  await verify(basePort, count, Number(args.timeout ?? 15000))
  process.exit(0)
}

if (mode !== 'gen') {
  process.stdout.write('usage: xray-pool.mjs gen|verify [--count N] [--base-port P] [--addresses a,b] [--db path] [--out file]\n')
  process.exit(1)
}

const nodes = selectNodes(
  db,
  DEFAULT_GUI,
  count,
  typeof args.addresses === 'string' ? args.addresses : undefined,
  typeof args.exclude === 'string' ? args.exclude : undefined,
)
if (nodes.length === 0) {
  console.error('xray-pool: no usable nodes found in the v2rayN database')
  process.exit(1)
}

const config = generateConfig(nodes, basePort)
mkdirSync(outDir, { recursive: true })
const outPath = args.out ?? join(DEFAULT_OUT_DIR, 'config.json')
writeFileSync(outPath, JSON.stringify(config, null, 2))

process.stdout.write(`xray-pool: wrote ${outPath} (${nodes.length} exits, ports ${basePort}-${basePort + nodes.length - 1})\n\n`)
process.stdout.write('  PORT     EXIT(NODE)                      PROTOCOL\n')
nodes.forEach((row, i) => {
  const label = `${row.address}:${row.port}`
  const name = (row.remarks || '(unnamed)').slice(0, 28)
  const proto = `${Number(row.configType) === 1 ? 'vmess' : 'vless'}/${row.network || 'raw'}/${row.streamSecurity || 'none'}`
  process.stdout.write(`  ${basePort + i}  ${label.padEnd(30)}  ${proto}  ${name}\n`)
})
process.stdout.write(`\n  op2gw pool URIs:\n`)
nodes.forEach((_, i) => process.stdout.write(`    socks5://127.0.0.1:${basePort + i}\n`))
copyFileSync(db, join(outDir, 'v2rayn-db.snapshot.sqlite'))
