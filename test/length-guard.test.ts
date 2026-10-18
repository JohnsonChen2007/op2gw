import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { wrapInstantLengthGuard } from '../dist/gateway/length-guard.js'

/**
 * Instant-length truncation guard tests. The guard turns the free lane's
 * pathological "prompt overflow -> 1-token output -> finish_reason=length"
 * signature into a real in-stream error, so downstream clients stop showing
 * "Output token limit reached / send continue" forever on an unrunnable
 * request. A genuine max-tokens cutoff must pass through untouched.
 */

async function collect(stream: Readable): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  return chunks.join('')
}

function sse(frames: string[]): Readable {
  return Readable.from(frames.map((f) => `${f}\n\n`))
}

const start =
  'data: {"id":"r1","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":""}}],"usage":null}'
const opener =
  'data: {"id":"r1","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"The"}}],"usage":null}'

test('converts a 1-token length cutoff into an in-stream context_length_exceeded error', async () => {
  const converted: Array<{ promptTokens?: number; completionTokens?: number }> = []
  const out = wrapInstantLengthGuard(
    sse([
      start,
      opener,
      'data: {"id":"r1","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":277691,"completion_tokens":1,"total_tokens":277692}}',
    ]),
    { model: 'demo-free', contextWindow: 200000, onConvert: (i) => converted.push(i) },
  )
  const text = await collect(out)
  assert.equal(converted.length, 1, 'onConvert fired once')
  assert.equal(converted[0].promptTokens, 277691)
  assert.equal(converted[0].completionTokens, 1)
  assert.match(text, /"error"/)
  assert.match(text, /context_length_exceeded/)
  assert.match(text, /finish_reason=length after 1 completion token/)
  assert.match(text, /277691/)
  assert.doesNotMatch(text, /"finish_reason"\s*:\s*"length"/, 'the fake length frame is suppressed')
})

test('passes through a genuine max-tokens cutoff with a real output budget', async () => {
  const converted: Array<{ promptTokens?: number; completionTokens?: number }> = []
  const frames = [
    start,
    'data: {"id":"r1","choices":[{"index":0,"delta":{"content":"long answer"}}],"usage":null}',
    'data: {"id":"r1","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":500,"completion_tokens":4096,"total_tokens":4596}}',
    'data: {"id":"r1","choices":[],"usage":{"prompt_tokens":500,"completion_tokens":4096,"total_tokens":4596}}',
    'data: [DONE]',
  ]
  const out = wrapInstantLengthGuard(sse(frames), { model: 'demo-free', onConvert: (i) => converted.push(i) })
  const text = await collect(out)
  assert.equal(converted.length, 0, 'no conversion for a well-burned budget')
  // Byte-preserved frames.
  assert.equal(text, frames.map((f) => `${f}\n\n`).join(''))
})

test('passes a normal stop completion through unchanged', async () => {
  const frames = [
    start,
    opener,
    'data: {"id":"r1","choices":[{"index":0,"delta":{"content":"ready"},"reasoning_content":""}],"usage":null}',
    'data: {"id":"r1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2558,"completion_tokens":14,"total_tokens":2572}}',
    'data: [DONE]',
  ]
  const out = wrapInstantLengthGuard(sse(frames), { model: 'demo-free' })
  assert.equal(await collect(out), frames.map((f) => `${f}\n\n`).join(''))
})

test('zero-usage sliver-of-content length cutoff is converted at EOF', async () => {
  const converted: Array<{ promptTokens?: number; completionTokens?: number }> = []
  const out = wrapInstantLengthGuard(
    sse([
      opener,
      'data: {"id":"r1","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":null}',
    ]),
    { model: 'demo-free', onConvert: (i) => converted.push(i) },
  )
  const text = await collect(out)
  assert.equal(converted.length, 1)
  assert.match(text, /context_length_exceeded/)
  assert.doesNotMatch(text, /"finish_reason"\s*:\s*"length"/)
})

test('zero-usage endpoint with a substantial answer reaches the client untouched', async () => {
  const answer = 'x'.repeat(200)
  const out = wrapInstantLengthGuard(
    sse([
      'data: {"choices":[{"index":0,"delta":{"content":"short"},"usage":null}],"id":"r1"}',
      `data: {"choices":[{"index":0,"delta":{"content":"${answer}"},"usage":null}],"id":"r1"}`,
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":null}',
      'data: [DONE]',
    ]),
    { model: 'demo-free' },
  )
  const text = await collect(out)
  assert.match(text, /finish_reason":"length"/, 'substantial output is a real cap, delivered as-is')
  assert.match(text, /[DONE]/)
})

test('tool-call slivers count as output work and pass through', async () => {
  const out = wrapInstantLengthGuard(
    sse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":""}}]}}],"id":"r1"}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":null}',
      'data: [DONE]',
    ]),
    { model: 'demo-free' },
  )
  const text = await collect(out)
  assert.match(text, /finish_reason":"length"/)
  assert.match(text, /[DONE]/)
})

test('throwOnConvert surfaces a non-rotatable status-400 UpstreamError', async () => {
  const out = wrapInstantLengthGuard(
    sse([
      start,
      opener,
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":244831,"completion_tokens":1,"total_tokens":244832}}',
    ]),
    { model: 'demo-free', throwOnConvert: true },
  )
  await assert.rejects(
    () => collect(out),
    (err: NodeJS.ErrnoException) => {
      const e = err as Error & { kind?: string; status?: number }
      assert.equal(e.status, 400)
      assert.equal(e.kind, 'server')
      assert.match(e.message, /finish_reason=length after 1 completion token/)
      assert.match(e.message, /244831/)
      return true
    },
  )
})

test('a length frame before any output is converted immediately', async () => {
  const out = wrapInstantLengthGuard(
    sse([
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":100,"completion_tokens":0,"total_tokens":100}}',
    ]),
    { model: 'demo-free' },
  )
  const text = await collect(out)
  assert.match(text, /context_length_exceeded/)
  assert.match(text, /after 0 completion token/)
})
