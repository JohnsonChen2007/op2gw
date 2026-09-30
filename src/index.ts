#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize } from 'node:path'
import { existsSync } from 'node:fs'

import { loadConfig } from './core/config.js'
import { Runtime, VERSION } from './runtime.js'
import { GatewayHttpError, type GatewayRequest } from './gateway/gateway.js'
import { handleAdmin, json, readJson } from './admin/api.js'

/**
 * op2gw HTTP server.
 *
 * Routes:
 *   GET  /healthz                    liveness + catalog snapshot
 *   GET  /v1/models                  OpenAI-compatible free-model list
 *   POST /v1/chat/completions        OpenAI Chat Completions (stream or not)
 *   POST /v1/responses               OpenAI Responses (muse-spark-* etc.)
 *   /admin/*                         debug backend (see admin/api.ts)
 *   /*                               static debug UI from public/
 *
 * Any OpenAI-compatible tool points its baseURL at http://host:port/v1 and
 * uses any configured gateway key (or none, on loopback). The gateway disguises
 * the request as the OpenCode CLI and forwards it to the Zen anonymous lane
 * over the rotating exit pool.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
// public/ sits next to src/ in dev and next to dist/ after build.
const PUBLIC_DIRS = [join(__dirname, '..', 'public'), join(__dirname, 'public')]

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

async function main(): Promise<void> {
  const config = await loadConfig()
  const runtime = new Runtime(config)
  await runtime.start()
  const log = runtime.logger.child('http')

  const keySet = new Set(config.apiKeys)
  const authRequired = keySet.size > 0

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      log.error('unhandled request error', { error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) json(res, 500, { error: { message: 'internal error', type: 'internal_error' } })
      else res.end()
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // CORS for the debug UI / cross-origin tools.
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (path === '/healthz') {
      json(res, 200, { status: 'ok', version: VERSION, catalog: runtime.catalog.snapshot() })
      return
    }

    // Admin backend (debug UI). Not gated by the OpenAI key — it's loopback
    // tooling; gate behind the same key only when keys are configured.
    if (path.startsWith('/admin')) {
      if (authRequired && !checkAuth(req, keySet)) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleAdmin(runtime, req, res, url)
      return
    }

    // OpenAI v1 surface.
    if (path === '/v1/models' && req.method === 'GET') {
      if (authRequired && !checkAuth(req, keySet)) return unauthorized(res)
      const created = Math.floor(Date.now() / 1000)
      const data = runtime.gateway.listModels().map((id) => ({ id, object: 'model', created, owned_by: 'opencode-zen' }))
      json(res, 200, { object: 'list', data })
      return
    }

    if ((path === '/v1/chat/completions' || path === '/v1/responses') && req.method === 'POST') {
      if (authRequired && !checkAuth(req, keySet)) return unauthorized(res)
      await handleInference(req, res, path === '/v1/responses' ? 'responses' : 'chat')
      return
    }

    // Static debug UI.
    await serveStatic(path, res)
  }

  async function handleInference(req: IncomingMessage, res: ServerResponse, api: 'chat' | 'responses'): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = (await readJson(req, 32 << 20)) as Record<string, unknown>
    } catch {
      json(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } })
      return
    }
    const clientStream = body.stream === true
    const abort = new AbortController()
    req.on('close', () => abort.abort())

    const gatewayReq: GatewayRequest = { api, body, clientStream, signal: abort.signal }
    try {
      const result = await runtime.gateway.handle(gatewayReq)
      res.writeHead(result.status, result.headers)
      await pipeline(result.body, res)
    } catch (err) {
      if (err instanceof GatewayHttpError) {
        if (!res.headersSent) {
          res.writeHead(err.status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(err.toOpenAIBody())
        } else {
          res.end()
        }
        return
      }
      // Client aborted mid-stream, or a stream error after headers.
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) {
        json(res, 502, { error: { message, type: 'upstream_error' } })
      } else {
        res.end()
      }
    }
  }

  async function serveStatic(path: string, res: ServerResponse): Promise<void> {
    let rel = path === '/' ? '/index.html' : path
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '')
    for (const dir of PUBLIC_DIRS) {
      const full = join(dir, rel)
      if (!full.startsWith(dir)) continue
      if (existsSync(full)) {
        try {
          const content = await readFile(full)
          res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' })
          res.end(content)
          return
        } catch {
          // fall through
        }
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }

  server.listen(config.port, config.host, () => {
    const base = `http://${config.host}:${config.port}`
    log.info('op2gw listening', { url: base, poolEnabled: config.pool.enabled, authRequired })
    process.stdout.write(
      `\nop2gw ${VERSION} ready\n` +
        `  OpenAI base URL : ${base}/v1\n` +
        `  Debug UI        : ${base}/\n` +
        `  Health          : ${base}/healthz\n` +
        `  Pool            : ${config.pool.enabled ? 'enabled' : 'disabled (direct)'}\n` +
        `  Auth            : ${authRequired ? 'required (bearer key)' : 'open (loopback)'}\n\n`,
    )
  })

  const shutdown = async (): Promise<void> => {
    log.info('shutting down')
    server.close()
    await runtime.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

function checkAuth(req: IncomingMessage, keys: Set<string>): boolean {
  const header = req.headers['authorization']
  if (typeof header !== 'string') {
    const apiKey = req.headers['x-api-key']
    return typeof apiKey === 'string' && keys.has(apiKey)
  }
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? keys.has(match[1]!.trim()) : false
}

function unauthorized(res: ServerResponse): void {
  json(res, 401, { error: { message: 'missing or invalid API key', type: 'invalid_request_error' } })
}

main().catch((err) => {
  process.stderr.write(`op2gw fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
