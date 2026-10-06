import { PassThrough, type Readable } from 'node:stream'

import type { UpstreamApi } from '../core/types.js'
import { toAnthropicErrorBody } from './anthropic.js'

/**
 * In-band failure signaling for streams that broke AFTER their headers went out.
 *
 * Once `res.writeHead(200)` has been sent there is no status code left to
 * report a failure with, and `stream.pipeline` destroys the destination the
 * moment the source errors — so the HTTP layer's catch block can write nothing
 * and the client is left with a stream that simply stops: no terminal marker,
 * no error. An agent that reads "no error" as "complete answer" will happily
 * keep reasoning over a truncated response.
 *
 * The fix lives on the SOURCE side (`withInBandError`): turn the failure into
 * ordinary bytes that end the stream cleanly, so `pipeline` finishes normally
 * and the client reads a well-formed error it can surface and retry.
 */

/** The dialect the CLIENT speaks — which decides the shape of the failure. */
export type ClientDialect = UpstreamApi | 'anthropic'

/**
 * Build the terminal SSE payload for a broken stream, in the shape each
 * dialect's own parser looks for:
 *
 *   chat       -> an `error` object, then the `data: [DONE]` terminator
 *   responses  -> an `error` event, then a terminal `response.failed`
 *   anthropic  -> an `event: error` carrying Anthropic's error envelope
 */
export function clientStreamErrorBody(dialect: ClientDialect, message: string): string {
  if (dialect === 'anthropic') {
    return `event: error\ndata: ${toAnthropicErrorBody(message, 'api_error')}\n\n`
  }
  if (dialect === 'responses') {
    const code = 'upstream_error'
    const error = { code, message, type: 'upstream_error' }
    const response = {
      id: 'resp_interrupted',
      object: 'response',
      status: 'failed',
      error: { code, message },
    }
    return (
      `event: error\ndata: ${JSON.stringify({ type: 'error', code, message, param: null })}\n\n` +
      `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response })}\n\n`
    )
  }
  return (
    `data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: null } })}\n\n` +
    'data: [DONE]\n\n'
  )
}

/**
 * Wrap a response stream so a mid-stream failure becomes an in-band terminal
 * event instead of a socket reset.
 *
 * Also releases the upstream when ITS consumer disappears (client disconnect,
 * pipeline error): without that, a generation nobody is waiting for keeps being
 * pulled to the end and burned against the free lane's per-IP quota.
 */
export function withInBandError(source: Readable, dialect: ClientDialect): Readable {
  const out = new PassThrough()
  let finished = false

  const finishWith = (message: string): void => {
    if (finished) return
    finished = true
    if (out.destroyed) return
    out.write(clientStreamErrorBody(dialect, message))
    out.end()
  }

  source.on('data', (chunk) => {
    if (out.destroyed) return
    // Honour backpressure: a slow client must not make us buffer the whole
    // response in memory while the upstream keeps streaming into it.
    if (!out.write(chunk)) source.pause()
  })
  out.on('drain', () => source.resume())
  source.on('end', () => {
    if (finished) return
    finished = true
    if (!out.destroyed) out.end()
  })
  source.on('error', (err) => finishWith(err instanceof Error ? err.message : String(err)))
  const release = (): void => {
    if (!source.readableEnded && !source.destroyed) source.destroy()
  }
  out.on('close', release)
  out.on('error', release)
  return out
}
