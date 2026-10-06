import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { clientStreamErrorBody, withInBandError } from '../dist/gateway/clienterror.js'

/**
 * In-band stream-failure tests.
 *
 * Once `res.writeHead(200)` has gone out there is no status code left to report
 * a failure with, and `stream.pipeline` destroys the destination the instant its
 * source errors — so the HTTP layer can write nothing and the client is left
 * with a stream that simply stops. An agent reading "no error" as "complete
 * answer" then keeps reasoning over a truncated response. These tests lock the
 * terminal bytes that make the failure visible, and the source release that
 * keeps an abandoned generation from burning free-lane quota.
 */

interface Collected {
  text: string
  error: Error | null
}

function collect(stream: Readable): Promise<Collected> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    let error: Error | null = null
    stream.on('data', (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))))
    stream.on('error', (err: Error) => {
      error = err
    })
    stream.on('close', () => resolve({ text: Buffer.concat(parts).toString('utf8'), error }))
  })
}

test('the chat dialect gets an error object followed by [DONE]', () => {
  const body = clientStreamErrorBody('chat', 'upstream died')
  assert.match(body, /"error"/)
  assert.match(body, /upstream died/)
  assert.ok(body.trimEnd().endsWith('data: [DONE]'), 'the terminator is what tells an SDK the stream is complete')
})

test('the responses dialect gets an error event and a terminal response.failed', () => {
  const body = clientStreamErrorBody('responses', 'upstream died')
  assert.match(body, /event: error/)
  assert.match(body, /event: response\.failed/)
  assert.match(body, /"status":"failed"/)
})

test('the anthropic dialect gets an Anthropic error envelope', () => {
  const body = clientStreamErrorBody('anthropic', 'upstream died')
  assert.match(body, /event: error/)
  assert.match(body, /"type":"api_error"/)
  assert.match(body, /upstream died/)
})

test('a mid-stream failure becomes in-band bytes instead of a socket reset', async () => {
  const source = Readable.from(
    (async function* () {
      yield 'data: {"choices":[{"delta":{"content":"half"}}]}\n\n'
      throw new Error('tunnel dropped')
    })(),
  )
  const out = withInBandError(source, 'chat')
  const { text, error } = await collect(out)
  assert.equal(error, null, 'the wrapper must end cleanly so pipeline does not destroy the response')
  assert.match(text, /half/, 'bytes already delivered are preserved')
  assert.match(text, /tunnel dropped/)
  assert.ok(text.trimEnd().endsWith('data: [DONE]'))
})

test('a healthy stream passes through with no injected error', async () => {
  const source = Readable.from(['data: {"a":1}\n\n', 'data: [DONE]\n\n'])
  const { text, error } = await collect(withInBandError(source, 'chat'))
  assert.equal(error, null)
  assert.equal(text, 'data: {"a":1}\n\ndata: [DONE]\n\n')
})

test('an abandoned stream releases the upstream', async () => {
  let released = false
  const source = new Readable({ read() {} })
  source.on('close', () => {
    released = true
  })
  const out = withInBandError(source, 'chat')
  source.push('data: {"a":1}\n\n')
  out.destroy(new Error('client gone'))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(released, true, 'a generation nobody is waiting for must not keep being pulled')
})