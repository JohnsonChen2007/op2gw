import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Runtime } from '../runtime.js'
import { parseProxyLine, buildProxyUri, type ProxyParts } from '../pool/sources.js'
import { normalizeProxyUri, saveConfig } from '../core/config.js'
import type { LogLevel } from '../core/logger.js'

/**
 * Admin API — the debug backend the web UI talks to. All routes live under
 * /admin and return JSON (except the SSE log stream). No secrets are exposed;
 * the anonymous lane's "key" is the literal `public`.
 *
 *   GET  /admin/status         runtime + catalog + pool snapshot
 *   GET  /admin/models         exposed free models with metadata
 *   GET  /admin/logs           recent log records (?level=&scope=&limit=)
 *   GET  /admin/logs/stream    SSE live log stream
 *   GET  /admin/traces         recent request traces
 *   POST /admin/pool/exits     add a manual proxy {uri}
 *   DELETE /admin/pool/exits   remove an exit {id}
 *   POST /admin/pool/pin       pin/unpin an exit {id}
 *   POST /admin/pool/probe     trigger an immediate probe round
 *   POST /admin/pool/refresh   refresh the free pool from sources
 *   POST /admin/catalog/refresh force a catalog refresh
 *   POST /admin/log-level      set log level {level}
 */

export async function handleAdmin(
  runtime: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname
  if (!path.startsWith('/admin')) return false

  const method = req.method ?? 'GET'

  // --- reads ---
  if (path === '/admin/status' && method === 'GET') {
    return json(res, 200, runtime.status())
  }

  if (path === '/admin/models' && method === 'GET') {
    const ids = runtime.catalog.list()
    const models = ids.map((id) => ({
      id,
      decision: runtime.catalog.decision(id),
      limits: runtime.catalog.limits(id) ?? null,
      reasoning: runtime.catalog.reasoningCapability(id) ?? null,
    }))
    return json(res, 200, { object: 'list', total: models.length, models })
  }

  if (path === '/admin/logs' && method === 'GET') {
    const level = (url.searchParams.get('level') as LogLevel | null) ?? undefined
    const scope = url.searchParams.get('scope') ?? undefined
    const limit = Number(url.searchParams.get('limit') ?? '300') || 300
    return json(res, 200, { records: runtime.logger.records({ level, scope, limit }) })
  }

  if (path === '/admin/logs/stream' && method === 'GET') {
    return streamLogs(runtime, req, res)
  }

  if (path === '/admin/traces' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '200') || 200
    return json(res, 200, { traces: runtime.logger.traces(limit) })
  }

  // --- writes ---
  if (path === '/admin/pool/exits' && method === 'POST') {
    const body = (await readJson(req)) as Record<string, unknown>
    // Two accepted shapes: structured form {scheme,host,port,username,password}
    // (the debug UI's add-exit form) or legacy raw {uri}.
    const uri =
      typeof body.uri === 'string' && body.uri.trim()
        ? parseProxyLine(body.uri)
        : buildProxyUri(body as ProxyParts)
    if (!uri) return json(res, 400, { error: '无效代理：需要主机 + 端口（1-65535），协议 http/socks5' })
    runtime.pool.add({
      id: uri,
      kind: uri.startsWith('socks5') ? 'socks5' : 'http',
      source: 'manual',
      pinned: false,
      exitIP: '',
      location: '',
      latencyMs: 0,
    })
    runtime.logger.child('admin').info('manual exit added', { uri })
    return json(res, 200, { ok: true, id: uri })
  }

  if (path === '/admin/pool/exits' && method === 'DELETE') {
    const body = await readJson(req)
    const id = String((body as { id?: unknown }).id ?? '')
    if (!id || id === 'direct') return json(res, 400, { error: 'cannot remove this exit' })
    runtime.pool.remove(id)
    runtime.dispatchers.drop(id)
    runtime.logger.child('admin').info('exit removed', { id })
    return json(res, 200, { ok: true })
  }

  if (path === '/admin/pool/pin' && method === 'POST') {
    const body = await readJson(req)
    const id = String((body as { id?: unknown }).id ?? '').trim()
    if (id && id !== 'none' && !runtime.pool.has(id)) return json(res, 404, { error: 'unknown exit' })
    const target = (!id || id === 'none') ? '' : id
    runtime.pool.setPinned(target)
    runtime.config.pool.pinnedExitId = target
    runtime.pool.clearSticky()
    runtime.logger.child('admin').info('exit pinned updated', { id: target || '(unpinned)' })
    return json(res, 200, { ok: true, pinned: target })
  }

  if (path === '/admin/pool/probe' && method === 'POST') {
    void runtime.refreshFreePool()
    runtime.logger.child('admin').info('manual probe/refresh triggered')
    return json(res, 200, { ok: true })
  }

  if (path === '/admin/pool/refresh' && method === 'POST') {
    await runtime.refreshFreePool()
    return json(res, 200, { ok: true, total: runtime.pool.size() })
  }

  if (path === '/admin/catalog/refresh' && method === 'POST') {
    await runtime.catalog.refreshOnce()
    return json(res, 200, { ok: true, catalog: runtime.catalog.snapshot() })
  }

  if (path === '/admin/log-level' && method === 'POST') {
    const body = await readJson(req)
    const level = String((body as { level?: unknown }).level ?? '') as LogLevel
    if (!['debug', 'info', 'warn', 'error'].includes(level)) return json(res, 400, { error: 'invalid level' })
    runtime.setLogLevel(level)
    return json(res, 200, { ok: true, level })
  }

  // --- settings page (omniroute-style config surface) ---
  if (path === '/admin/settings' && method === 'GET') {
    return json(res, 200, runtime.settings())
  }

  // Set one pool entry as the default egress proxy (persisted, live-applied).
  if (path === '/admin/settings/default-proxy' && method === 'POST') {
    const body = (await readJson(req)) as Record<string, unknown>
    const raw = String(body.uri ?? '').trim()
    // Pool ids are stored lowercased (parseProxyLine lowercases), so normalize
    // the same way here or a mixed-case URI would 404 against a valid entry.
    const uri = raw === 'direct' ? 'direct' : parseProxyLine(normalizeProxyUri(raw))
    if (raw !== 'direct' && !uri) return json(res, 400, { error: 'invalid proxy uri' })
    if (uri && uri !== 'direct' && !runtime.pool.has(uri)) {
      return json(res, 404, { error: 'unknown proxy (not in the pool)' })
    }
    // The pool list itself is unchanged; only the default egress moves.
    const isDirect = !uri || uri === 'direct'
    runtime.setProxy(isDirect ? '' : uri!)
    if (!isDirect) {
      runtime.config.pool.pinnedExitId = uri!
      runtime.pool.setPinned(uri!)
    } else {
      // Direct egress is the default again — a stale pin would keep forcing
      // traffic to a pool exit, so clear it too.
      runtime.config.pool.pinnedExitId = ''
      runtime.pool.setPinned('')
    }
    runtime.pool.clearSticky()
    runtime.logger.child('admin').info('default proxy set from pool', { proxy: isDirect ? '(direct)' : uri })
    let savedPath = ''
    try {
      savedPath = await saveConfig(runtime.config)
    } catch (err) {
      return json(res, 500, { error: 'apply ok but save failed: ' + (err instanceof Error ? err.message : String(err)) })
    }
    return json(res, 200, { ok: true, proxy: isDirect ? '' : uri, savedPath, settings: runtime.settings() })
  }

  if (path === '/admin/settings' && method === 'PUT') {
    const body = (await readJson(req)) as Record<string, unknown>
    const applied: Record<string, unknown> = {}
    const notes: string[] = []

    // Proxy — live-applied, no restart.
    if (typeof body.proxy === 'string') {
      const normalized = normalizeProxyUri(body.proxy)
      runtime.setProxy(normalized)
      applied.proxy = normalized || '(direct)'
    }
    // Proxy pool — the persisted manual list (auth-aware http/socks5 URIs).
    // When `proxy` is also being set and the proxy value matches (or the pool
    // is empty and proxy is non-empty), keep the entry discoverable in the pool.
    if (Array.isArray(body.proxyPool)) {
      const { added, removed } = runtime.applyManualPool(body.proxyPool.map((u) => String(u)))
      applied.proxyPool = { total: runtime.config.pool.manual.length, added, removed }
    } else if (typeof body.proxy === 'string' && normalizeProxyUri(body.proxy) && runtime.config.pool.manual.length === 0) {
      // First proxy ever saved: seed the pool so it shows on the settings page.
      runtime.applyManualPool([normalizeProxyUri(body.proxy)])
    }
    // Direct egress toggle — live-applied.
    if (typeof body.includeDirect === 'boolean') {
      runtime.config.pool.includeDirect = body.includeDirect
      runtime.pool.setIncludeDirect(body.includeDirect)
      applied.includeDirect = body.includeDirect
    }
    // Log level — live-applied.
    if (typeof body.logLevel === 'string' && ['debug', 'info', 'warn', 'error'].includes(body.logLevel)) {
      runtime.setLogLevel(body.logLevel as LogLevel)
      applied.logLevel = body.logLevel
    }
    // Refresh cadence — live-applied to config; picked up on next cycle.
    if (typeof body.refreshSeconds === 'number' && body.refreshSeconds >= 1) {
      runtime.config.refreshSeconds = Math.floor(body.refreshSeconds)
      applied.refreshSeconds = runtime.config.refreshSeconds
    }
    // API keys — live-applied (server reads runtime.config on each request).
    if (Array.isArray(body.apiKeys)) {
      runtime.config.apiKeys = body.apiKeys.map((k) => String(k)).filter((k) => k.length > 0)
      applied.apiKeys = runtime.config.apiKeys.length
    }
    // Port — persisted only; requires restart.
    if (typeof body.port === 'number' && body.port >= 1 && body.port <= 65535) {
      const port = Math.floor(body.port)
      if (port !== runtime.config.port) {
        runtime.config.port = port
        applied.port = port
        notes.push(`端口已保存为 ${port}，重启后生效`)
      }
    }
    // Host — persisted only; requires restart.
    if (typeof body.host === 'string' && body.host.trim()) {
      const host = body.host.trim()
      if (host !== runtime.config.host) {
        runtime.config.host = host
        applied.host = host
        notes.push(`监听地址已保存为 ${host}，重启后生效`)
      }
    }

    // Persist unless the caller asked for a session-only apply.
    let savedPath = ''
    if (body.persist !== false) {
      try {
        savedPath = await saveConfig(runtime.config)
      } catch (err) {
        return json(res, 500, { error: 'apply ok but save failed: ' + (err instanceof Error ? err.message : String(err)) })
      }
    }
    runtime.logger.child('admin').info('settings updated', { applied })
    return json(res, 200, { ok: true, applied, notes, savedPath, settings: runtime.settings() })
  }

  return json(res, 404, { error: 'unknown admin route' })
}

function streamLogs(runtime: Runtime, req: IncomingMessage, res: ServerResponse): boolean {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  // Replay the last few records so the UI has immediate context.
  for (const record of runtime.logger.records({ limit: 50 })) {
    res.write(`data: ${JSON.stringify(record)}\n\n`)
  }
  const unsubscribe = runtime.logger.subscribe((record) => {
    res.write(`data: ${JSON.stringify(record)}\n\n`)
  })
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000)
  keepAlive.unref?.()
  const cleanup = (): void => {
    clearInterval(keepAlive)
    unsubscribe()
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
  return true
}

export function json(res: ServerResponse, status: number, body: unknown): boolean {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
  return true
}

export async function readJson(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}
