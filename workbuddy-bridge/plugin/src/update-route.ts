/**
 * Same-origin update route for the WorkBuddy browser reminder: public version
 * metadata only (npm dist-tags + GitHub release list), loopback-gated exactly
 * like the status route, GET-only, never carrying credentials.
 *
 * @module dsh-workbuddy-connect/update-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { WORKBUDDY_UPDATE_PATH } from './status-paths.ts'
import { checkWorkBuddyUpdate, WORKBUDDY_UPDATE_TIMEOUT_MS } from './update.ts'
import type { WorkBuddyUpdateFetch, WorkBuddyUpdateResult } from './update.ts'

export { WORKBUDDY_UPDATE_PATH } from './status-paths.ts'

/** Constructor dependencies. */
export interface WorkBuddyUpdateRouteOptions {
  currentVersion: string
  fetchImpl?: WorkBuddyUpdateFetch
  timeoutMs?: number
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

/** The same browser-origin gate the status route uses: DNS-rebinding pages die here. */
function browserRequestAllowed(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/** Build the route handler; the caller owns registration and disposal. */
export function workBuddyUpdateHandler(options: WorkBuddyUpdateRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!browserRequestAllowed(req)) {
      json(res, 403, { error: 'forbidden' })
      return
    }
    let result: WorkBuddyUpdateResult
    try {
      result = await checkWorkBuddyUpdate({
        currentVersion: options.currentVersion,
        ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
        timeoutMs: options.timeoutMs ?? WORKBUDDY_UPDATE_TIMEOUT_MS,
      })
    } catch {
      // The checker itself fails closed, but a thrown seam must still answer
      // a well-formed document rather than an empty 500.
      result = { status: 'unavailable', currentVersion: options.currentVersion, reason: 'registry-unavailable' }
    }
    json(res, 200, result)
  }
}

/** Register the update route on the optional host web server. */
export function registerWorkBuddyUpdateRoute(ctx: Context, options: WorkBuddyUpdateRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_UPDATE_PATH,
      handler: workBuddyUpdateHandler(options),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-connect: update route')
}
