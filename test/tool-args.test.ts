import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  buildToolSchemas,
  normalizeChatStream,
  normalizeCompletionBody,
  normalizeResponsesStream,
  normalizeToolArguments,
} from '../dist/gateway/tool-args.js'

/**
 * Tool-argument compatibility layer.
 *
 * Weak models emit camelCase argument keys (`filePath`) where the agent's tool
 * schema declares snake_case (`file_path`), and forget the display-only bash
 * `description`. The gateway rewrites keys against the request's own tool
 * schemas so every downstream agent accepts the call.
 */

function collect(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    stream.on('data', (chunk) => parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    stream.on('error', reject)
  })
}

function payloads(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    out.push(JSON.parse(payload) as Record<string, unknown>)
  }
  return out
}

const readSchema = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    offset: { type: 'number' },
  },
  required: ['file_path'],
}

test('buildToolSchemas understands both chat and responses tool shapes', () => {
  const chat = buildToolSchemas({
    tools: [{ type: 'function', function: { name: 'read', parameters: readSchema } }],
  })
  const responses = buildToolSchemas({ tools: [{ type: 'function', name: 'read', parameters: readSchema }] })
  assert.equal(chat.get('read'), readSchema)
  assert.equal(responses.get('read'), readSchema)
})

test('normalizeToolArguments renames camelCase keys and keeps values', () => {
  assert.deepEqual(JSON.parse(normalizeToolArguments('{"filePath":"/tmp/x","offset":2}', readSchema)), {
    file_path: '/tmp/x',
    offset: 2,
  })
  assert.equal(
    normalizeToolArguments('{"file_path":"/tmp/x"}', readSchema),
    '{"file_path":"/tmp/x"}',
    'already-correct arguments are left byte-identical',
  )
  assert.equal(
    normalizeToolArguments('{"filePath":', readSchema),
    '{"filePath":',
    'incomplete JSON is passed through untouched',
  )
})

test('normalizeToolArguments fills a missing bash description', () => {
  const bashSchema = {
    type: 'object',
    properties: { command: { type: 'string' }, description: { type: 'string' } },
    required: ['command', 'description'],
  }
  const out = JSON.parse(normalizeToolArguments('{"command":"ls -la\\n pwd"}', bashSchema)) as Record<string, string>
  assert.equal(out.description, 'ls -la')
  assert.equal(out.command, 'ls -la\n pwd')
})

test('normalizeChatStream buffers argument fragments and emits one normalized call', async () => {
  const schemas = buildToolSchemas({
    tools: [{ type: 'function', function: { name: 'read', parameters: readSchema } }],
  })
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-x',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  const sse =
    chunk(
      { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath"' } }] },
      null,
    ) +
    chunk({ tool_calls: [{ index: 0, function: { arguments: ':"/tmp/x"}' } }] }, null) +
    chunk({}, 'tool_calls') +
    'data: [DONE]\n\n'

  const text = await collect(normalizeChatStream(Readable.from([sse]), schemas))
  const calls = payloads(text)
    .flatMap((event) => {
      const choices = Array.isArray(event.choices) ? event.choices : []
      const choice = choices[0] as { delta?: { tool_calls?: Array<{ index: number; function?: { arguments?: string } }> } } | undefined
      return choice?.delta?.tool_calls ?? []
    })
    .reduce<Record<number, string>>((acc, call) => {
      const index = typeof call.index === 'number' ? call.index : 0
      acc[index] = (acc[index] ?? '') + (call.function?.arguments ?? '')
      return acc
    }, {})
  assert.deepEqual(JSON.parse(calls[0] ?? '{}'), { file_path: '/tmp/x' })
  assert.ok(!text.includes('filePath'), 'the camelCase key never reaches the client')
})

test('normalizeResponsesStream replaces deltas with one normalized delta and normalizes done items', async () => {
  const schemas = buildToolSchemas({
    tools: [{ type: 'function', name: 'read', parameters: readSchema }],
  })
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const sse =
    event({ type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', name: 'read', arguments: '' } }) +
    event({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"filePath"' }) +
    event({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ':"/tmp/x"}' }) +
    event({
      type: 'response.output_item.done',
      item: { id: 'fc_1', type: 'function_call', name: 'read', arguments: '{"filePath":"/tmp/x"}' },
    }) +
    'data: [DONE]\n\n'

  const text = await collect(normalizeResponsesStream(Readable.from([sse]), schemas))
  const deltas = payloads(text)
    .filter((value) => value.type === 'response.function_call_arguments.delta')
    .map((value) => String(value.delta ?? ''))
    .join('')
  assert.deepEqual(JSON.parse(deltas), { file_path: '/tmp/x' })

  const done = payloads(text).find((value) => value.type === 'response.output_item.done') as {
    item?: { arguments?: string }
  }
  assert.deepEqual(JSON.parse(done?.item?.arguments ?? '{}'), { file_path: '/tmp/x' })
  assert.ok(!text.includes('filePath'))
})

test('normalizeCompletionBody rewrites chat and responses non-streaming bodies', () => {
  const schemas = buildToolSchemas({
    tools: [{ type: 'function', function: { name: 'read', parameters: readSchema } }],
  })
  const chat = normalizeCompletionBody(
    'chat',
    {
      choices: [
        { message: { tool_calls: [{ function: { name: 'read', arguments: '{"filePath":"/tmp/x"}' } }] } },
      ],
    },
    schemas,
  ) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> }
  assert.deepEqual(JSON.parse(chat.choices[0]?.message.tool_calls[0]?.function.arguments ?? '{}'), {
    file_path: '/tmp/x',
  })

  const responses = normalizeCompletionBody(
    'responses',
    { output: [{ type: 'function_call', name: 'read', arguments: '{"filePath":"/tmp/y"}' }] },
    schemas,
  ) as { output: Array<{ arguments: string }> }
  assert.deepEqual(JSON.parse(responses.output[0]?.arguments ?? '{}'), { file_path: '/tmp/y' })
})
