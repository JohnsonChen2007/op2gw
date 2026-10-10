import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface UpstreamHit {
  path: string
  authorization: string | undefined
}

const tempDirs: string[] = []
const closers: Array<() => Promise<void>> = []

after(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {})
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startFakeUpstream(): Promise<{ url: string; hits: UpstreamHit[]; close: () => Promise<void> }> {
  const hits: UpstreamHit[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      json(res, 200, { data: [{ id: 'test-chat-model' }] })
      return
    }
    if (req.method === 'GET' && req.url === '/models.dev') {
      json(res, 200, {
        opencode: { models: { 'test-chat-model': { cost: { input: 0, output: 0 } } } },
      })
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const hit: UpstreamHit = { path: req.url, authorization: req.headers.authorization }
      hits.push(hit)
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: [DONE]\n\n')
      })
      return
    }
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  closers.push(close)
  return { url: `http://127.0.0.1:${address.port}`, hits, close }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function startGateway(zenBaseUrl: string): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'op2gw-http-open-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'config.json')
  const port = await freePort()
  await writeFile(
    configPath,
    JSON.stringify({
      host: '127.0.0.1',
      port,
      apiKeys: ['legacy-json-key'],
      zenBaseUrl,
      metadataUrl: `${zenBaseUrl}/models.dev`,
      refreshSeconds: 3600,
      pool: { enabled: false },
    }),
    'utf8',
  )

  const child = spawn(process.execPath, ['dist/index.js', '--config', configPath, '--port', String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OP2GW_CONFIG: configPath,
      OP2GW_API_KEYS: 'legacy-env-key',
      OP2GW_DATA_DIR: dir,
      OP2GW_HOST: '127.0.0.1',
      OP2GW_LOG_LEVEL: 'error',
      OP2GW_POOL_ENABLED: 'false',
      OP2GW_PROXY: '',
    },
    stdio: 'pipe',
  })

  let output = ''
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway startup timed out\n${output}`)), 10_000)
    const onOutput = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /OpenAI base URL\s+: (http:\/\/127\.0\.0\.1:\d+)\/v1/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(match[1]!)
      }
    }
    child.stdout.on('data', onOutput)
    child.stderr.on('data', onOutput)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code, signal) => {
      if (code !== null || signal !== null) {
        clearTimeout(timer)
        reject(new Error(`gateway exited before ready: ${code ?? signal}\n${output}`))
      }
    })
  })
  const baseUrl = await ready

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
  closers.push(stop)
  return { baseUrl, stop }
}

async function waitForModels(baseUrl: string): Promise<string> {
  const deadline = Date.now() + 5000
  for (;;) {
    const response = await fetch(`${baseUrl}/v1/models`)
    const text = await response.text()
    if (response.ok && text.includes('test-chat-model')) return text
    if (Date.now() >= deadline) throw new Error(`catalog did not become ready: ${response.status} ${text}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('HTTP gateway accepts missing, empty, arbitrary, and x-api-key credentials', async () => {
  const upstream = await startFakeUpstream()
  const gateway = await startGateway(upstream.url)
  const expected = await waitForModels(gateway.baseUrl)

  const requests: RequestInit[] = [
    {},
    { headers: { authorization: '' } },
    { headers: { authorization: 'Bearer ' } },
    { headers: { authorization: 'Bearer arbitrary-key' } },
    { headers: { 'x-api-key': 'arbitrary-key' } },
  ]
  for (const init of requests) {
    const response = await fetch(`${gateway.baseUrl}/v1/models`, init)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), expected)
  }

  const settings = await fetch(`${gateway.baseUrl}/admin/settings`)
  assert.equal(settings.status, 200)
  const settingsBody = (await settings.json()) as Record<string, unknown>
  assert.equal('hasApiKeys' in settingsBody, false)

  const page = await fetch(`${gateway.baseUrl}/`, { headers: { 'x-api-key': 'arbitrary-key' } })
  assert.equal(page.status, 200)
  assert.equal((await page.text()).includes('setApiKeys'), false)

  const preflight = await fetch(`${gateway.baseUrl}/v1/models`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-api-key',
    },
  })
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('access-control-allow-origin') ?? '', /^\*$/)
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /(?:^|, )x-api-key(?:,|$)/)

  const crossOrigin = await fetch(`${gateway.baseUrl}/v1/models`, {
    headers: { origin: 'http://localhost:3000', 'x-api-key': 'arbitrary-key' },
  })
  assert.equal(crossOrigin.status, 200)
  assert.equal(await crossOrigin.text(), expected)

  const options = await fetch(`${gateway.baseUrl}/v1/models`, { method: 'OPTIONS' })
  assert.equal(options.status, 204)
  assert.equal((await fetch(`${gateway.baseUrl}/unknown`)).status, 404)

  const invalidJson = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer arbitrary-key' },
    body: '{',
  })
  assert.equal(invalidJson.status, 400)

  await gateway.stop()
  await upstream.close()
})

test('HTTP gateway keeps the anonymous upstream authorization unchanged', async () => {
  const upstream = await startFakeUpstream()
  const gateway = await startGateway(upstream.url)
  await waitForModels(gateway.baseUrl)

  const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-value' },
    body: JSON.stringify({ model: 'test-chat-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  assert.equal(response.status, 200)
  await response.text()
  assert.equal(upstream.hits.length, 1)
  assert.equal(upstream.hits[0]?.path, '/v1/chat/completions')
  assert.equal(upstream.hits[0]?.authorization, 'Bearer public')

  await gateway.stop()
  await upstream.close()
})
