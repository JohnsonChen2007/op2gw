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
import {
  chatToMessagesBody,
  chatToMessagesStream,
  messagesToChatBody,
  toAnthropicErrorBody,
} from './gateway/anthropic.js'
import { clientStreamErrorBody, withInBandError, type ClientDialect } from './gateway/clienterror.js'

/**
 * op2gw HTTP server.
 *
 * Routes:
 *   GET  /healthz                    liveness + catalog snapshot
 *   GET  /v1/models                  OpenAI-compatible free-model list
 *   POST /v1/chat/completions        OpenAI Chat Completions (stream or not)
 *   POST /v1/responses               OpenAI Responses (muse-spark-* etc.)
 *   POST /v1/messages                Anthropic Messages — Claude Code (additive)
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
      // 503 when nothing can serve: a monitor must be able to tell "the
      // process is up" from "the process is up but every exit is cooling,
      // dead or banned" — the old always-200 reply hid exactly the outage
      // self-heal exists to detect.
      const health = runtime.health()
      json(res, health.status === 'degraded' ? 503 : 200, health)
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

    // Anthropic Messages surface (Claude Code). Additive: the request is
    // translated to the OpenAI chat dialect and handed to the SAME gateway
    // pipeline as /v1/chat/completions, then the response is translated back.
    if (path === '/v1/messages' && req.method === 'POST') {
      if (authRequired && !checkAuth(req, keySet)) return unauthorizedAnthropic(res)
      await handleAnthropicMessages(req, res)
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
    abortOnClientGone(res, abort)

    const gatewayReq: GatewayRequest = { api, body, clientStream, signal: abort.signal }
    try {
      const result = await runtime.gateway.handle(gatewayReq)
      res.writeHead(result.status, result.headers)
      // The wrapper turns a mid-stream failure into a terminal in-band event.
      // `pipeline` destroys `res` as soon as its source errors, so the catch
      // below would otherwise have nothing left to write to.
      await pipeline(withInBandError(result.body, api), res)
    } catch (err) {
      // The client already left: nothing to answer, and writing to a dead
      // socket only risks a spurious error event.
      if (abort.signal.aborted || res.destroyed) return
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof GatewayHttpError) {
        if (!res.headersSent) {
          res.writeHead(err.status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(err.toOpenAIBody())
        } else {
          endWithStreamFailure(res, api, err.message)
        }
        return
      }
      if (!res.headersSent) {
        json(res, 502, { error: { message, type: 'upstream_error' } })
      } else {
        endWithStreamFailure(res, api, message)
      }
    }
  }

  /**
   * Claude Code's entry point: Anthropic Messages in, Anthropic Messages out.
   *
   * The request is translated to the OpenAI chat dialect and dispatched through
   * the identical gateway path used by /v1/chat/completions, so the exit pool,
   * rotation, free-lane gate and disguise headers all behave exactly as they do
   * for OpenAI clients. Only the response envelope differs, so the translation
   * is applied on the way out:
   *   - streaming  -> chat SSE rewritten as Anthropic SSE events
   *   - non-stream -> chat completion rewritten as an Anthropic message object
   */
  async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = (await readJson(req, 32 << 20)) as Record<string, unknown>
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(toAnthropicErrorBody('invalid JSON body', 'invalid_request_error'))
      return
    }

    const requestedModel = typeof body.model === 'string' ? body.model : ''
    const chatBody = messagesToChatBody(body)
    const clientStream = body.stream === true
    const abort = new AbortController()
    abortOnClientGone(res, abort)

    // `api: 'chat'` — the gateway's client dialect. From here on this is an
    // ordinary OpenAI chat request; the Anthropic shape only reappears on the
    // response below.
    const gatewayReq: GatewayRequest = { api: 'chat', body: chatBody, clientStream, signal: abort.signal }
    try {
      const result = await runtime.gateway.handle(gatewayReq)
      if (clientStream) {
        res.writeHead(result.status, result.headers)
        await pipeline(withInBandError(chatToMessagesStream(result.body, requestedModel), 'anthropic'), res)
        return
      }
      // Non-streaming: the gateway returns a single chat-completion object.
      // Aggregate it into the Anthropic message envelope.
      const chunks: Buffer[] = []
      for await (const chunk of result.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = {}
      }
      // An error object must keep its Anthropic shape, not become a message.
      if (parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)) {
        const err = (parsed as { error: Record<string, unknown> }).error
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          toAnthropicErrorBody(
            typeof err.message === 'string' ? err.message : 'upstream error',
            typeof err.type === 'string' ? err.type : 'api_error',
          ),
        )
        return
      }
      const message = chatToMessagesBody(parsed, requestedModel)
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(message))
    } catch (err) {
      // The client already left: nothing to answer, and writing to a dead
      // socket only risks a spurious error event.
      if (abort.signal.aborted || res.destroyed) return
      if (err instanceof GatewayHttpError) {
        if (!res.headersSent) {
          res.writeHead(err.status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(toAnthropicErrorBody(err.message, err.type))
        } else {
          endWithStreamFailure(res, 'anthropic', err.message)
        }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(toAnthropicErrorBody(message, 'api_error'))
      } else {
        endWithStreamFailure(res, 'anthropic', message)
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

/**
 * Abort the request signal when the CLIENT walks away before the response is
 * finished.
 *
 * Watching `IncomingMessage` here does not work: it emits `close` the moment the
 * request body has been consumed, which is before this listener can be attached
 * (the body is always read first, and `close` is emitted on the next tick). The
 * listener therefore never ran and the abort never fired — a disconnect left the
 * gateway grinding through an upstream call nobody was waiting for. The
 * RESPONSE closes exactly once, and `writableEnded` separates a completed
 * response from a dropped connection, so that is the signal to watch.
 */
function abortOnClientGone(res: ServerResponse, abort: AbortController): void {
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
}

/**
 * Emit a terminal in-band failure on a stream whose headers are already out,
 * then close it. Without this the client sees a stream that stops without any
 * terminator and can mistake a truncated answer for a complete one.
 */
function endWithStreamFailure(res: ServerResponse, dialect: ClientDialect, message: string): void {
  if (res.destroyed || res.writableEnded) return
  try {
    res.write(clientStreamErrorBody(dialect, message))
  } catch {
    // socket went away mid-write; nothing left to do
  }
  try {
    res.end()
  } catch {
    // already closed
  }
}

function unauthorized(res: ServerResponse): void {
  json(res, 401, { error: { message: 'missing or invalid API key', type: 'invalid_request_error' } })
}

function unauthorizedAnthropic(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Bearer' })
  res.end(toAnthropicErrorBody('missing or invalid API key', 'authentication_error'))
}

/**
 * Last-resort process guards.
 *
 * Nothing else in this server installs them, and several subsystems are started
 * fire-and-forget (`void catalog.start()`, `void prober.tick(...)`, `void
 * refreshFreePool()`): one rejection escaping them would take the whole gateway
 * down in the middle of serving requests. Logging and continuing is the right
 * trade here — the call that triggered it fails on its own, the process keeps
 * serving, and the supervisor never has to step in.
 *
 * This is a safety net, not a substitute for supervision: a genuine crash that
 * leaves the process unusable still needs systemd / launchd / a container
 * restart policy to bring it back.
 */
process.on('uncaughtException', (err) => {
  process.stderr.write(`op2gw uncaughtException: ${err.stack ?? err.message}\n`)
})
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  process.stderr.write(`op2gw unhandledRejection: ${err.stack ?? err.message}\n`)
})

main().catch((err) => {
  process.stderr.write(`op2gw fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
