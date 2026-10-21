import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { workBuddyUpdateHandler } from '../src/update-route.ts'
import type { WorkBuddyUpdateRouteOptions } from '../src/update-route.ts'
import { WORKBUDDY_UPDATE_PATH } from '../src/status-paths.ts'
import { WORKBUDDY_UPDATE_NPM_METADATA_URL, WORKBUDDY_UPDATE_RELEASES_API_URL } from '../src/update.ts'

/** The update route answers loopback GETs only and fails closed upstream. */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

async function startServer(): Promise<number> {
  const server = createServer(workBuddyUpdateHandler({
    currentVersion: '0.6.3',
    fetchImpl: async (input: string) => {
      if (input === WORKBUDDY_UPDATE_NPM_METADATA_URL) {
        return new Response(JSON.stringify({ 'dist-tags': { latest: '0.6.3' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (input === WORKBUDDY_UPDATE_RELEASES_API_URL) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected url ${String(input)}`)
    },
  }))
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  CLEANUP.push(async () => { await new Promise<void>(resolve => { server.close(() => resolve()) }) })
  return (server.address() as AddressInfo).port
}

function requestOnce(port: number, options: { method?: string, headers?: Record<string, string> }): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: WORKBUDDY_UPDATE_PATH,
      headers: options.headers ?? {},
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

describe('the update route', () => {
  it('answers a loopback GET with the check result', async () => {
    const port = await startServer()
    const { status, body } = await requestOnce(port, { headers: { host: '127.0.0.1:PORT'.replace('PORT', String(port)) } })
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ status: 'up-to-date', currentVersion: '0.6.3', latestVersion: '0.6.3' })
  })

  it('rejects non-GET methods', async () => {
    const port = await startServer()
    const { status } = await requestOnce(port, { method: 'POST', headers: { host: `127.0.0.1:${String(port)}` } })
    expect(status).toBe(405)
  })

  it('rejects a non-loopback Host (DNS-rebinding page)', async () => {
    const port = await startServer()
    const { status } = await requestOnce(port, { headers: { host: 'evil.example' } })
    expect(status).toBe(403)
  })

  it('rejects a non-loopback Origin beside a loopback Host', async () => {
    const port = await startServer()
    const { status } = await requestOnce(port, { headers: { host: `127.0.0.1:${String(port)}`, origin: 'https://evil.example' } })
    expect(status).toBe(403)
  })

  it('answers a well-formed unavailable document when the upstream throws past the checker', async () => {
    const server = createServer(workBuddyUpdateHandler({
      currentVersion: '0.6.3',
      // A fetch seam that rejects in a way even the checker's own catch
      // cannot shape: the route must still answer JSON, never an empty 500.
      fetchImpl: (() => { throw new Error('sync explosion') }) as unknown as NonNullable<WorkBuddyUpdateRouteOptions['fetchImpl']>,
    }))
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    CLEANUP.push(async () => { await new Promise<void>(resolve => { server.close(() => resolve()) }) })
    const port = (server.address() as AddressInfo).port
    const { status, body } = await requestOnce(port, { headers: { host: `127.0.0.1:${String(port)}` } })
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ status: 'unavailable', currentVersion: '0.6.3', reason: 'registry-unavailable' })
  })
})
