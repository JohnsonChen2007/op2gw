import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  chatToResponsesBody,
  chatToResponsesStream,
  chatToResponsesCompletion,
  responsesToChatBody,
  responsesToChatStream,
} from '../dist/gateway/protocol.js'

/**
 * Protocol-bridge round 2 — the directions the first suite left open:
 * chat-wire -> responses-client (stream, completion, tool-call transcode) and
 * the content-shape edge cases (images, arrays) in both directions.
 */

function collect(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    stream.on('data', (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))))
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    stream.on('error', reject)
  })
}

function ssePayloads(text: string): Array<Record<string, unknown>> {
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

function chatSse(model: string, events: Array<Record<string, unknown>>): string {
  return (
    events.map((e) => `data: ${JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model, ...e })}\n\n`).join('') +
    'data: [DONE]\n\n'
  )
}

test('chatToResponsesStream translates deltas and terminates with response.completed', async () => {
  const model = 'big-pickle'
  const sse = chatSse(model, [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  const text = await collect(chatToResponsesStream(Readable.from([sse]), model))
  const types = ssePayloads(text).map((e) => e.type)
  assert.ok(types.includes('response.created'), 'opens the responses envelope')
  const delta = ssePayloads(text).find((e) => e.type === 'response.output_text.delta') as { delta?: string }
  assert.equal(delta?.delta, 'hi')
  assert.ok(types.includes('response.completed'), 'terminal event present')
  assert.ok(text.includes('data: [DONE]'))
})

test('chatToResponsesStream transcodes tool calls into function_call items', async () => {
  const model = 'big-pickle'
  const sse = chatSse(model, [
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"cmd"' } }] },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const text = await collect(chatToResponsesStream(Readable.from([sse]), model))
  const done = ssePayloads(text).find((e) => e.type === 'response.output_item.done') as {
    item?: { type?: string; name?: string; arguments?: string }
  }
  assert.equal(done?.item?.type, 'function_call')
  assert.equal(done?.item?.name, 'bash')
  assert.equal(done?.item?.arguments, '{"cmd":"ls"}', 'argument fragments are reassembled')
})

test('chatToResponsesStream carries a pre-content failure as response.failed', async () => {
  const text = await collect(
    chatToResponsesStream(Readable.from([]), 'big-pickle', { status: 403, message: 'RegionError: blocked' }),
  )
  const events = ssePayloads(text)
  const failed = events.find((e) => e.type === 'response.failed') as { response?: { error?: { message?: string } } }
  assert.ok(failed, 'a swallowed failure must not look like an empty success')
  assert.equal(failed?.response?.error?.message, 'RegionError: blocked')
})

test('chatToResponsesCompletion aggregates deltas and tool calls into one response object', async () => {
  const model = 'big-pickle'
  const sse = chatSse(model, [
    { choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: ' there' }, finish_reason: 'stop' }] },
  ])
  const payload = JSON.parse(await collect(await chatToResponsesCompletion(Readable.from([sse]), model))) as {
    object: string
    status: string
    model: string
    output: Array<{ type: string; content?: Array<{ text: string }> }>
  }
  assert.equal(payload.object, 'response')
  assert.equal(payload.status, 'completed')
  assert.equal(payload.model, model)
  assert.equal(payload.output[0]?.content?.[0]?.text, 'Hello there')
})

test('responsesToChatStream forwards a function_call as chat tool_calls and finishes tool_calls', async () => {
  const model = 'muse-spark-1.3-contributor-free'
  const ev = (type: string, extra: unknown): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`
  const sse =
    ev('response.created', { response: { id: 'resp_tc', model, created_at: 100 } }) +
    ev('response.output_item.added', { item: { id: 'fc_1', type: 'function_call', call_id: 'call_7', name: 'read', arguments: '' } }) +
    ev('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"path"' }) +
    ev('response.function_call_arguments.delta', { item_id: 'fc_1', delta: ':"a"}' }) +
    ev('response.output_item.done', { item: { id: 'fc_1', type: 'function_call', call_id: 'call_7', name: 'read', arguments: '{"path":"a"}' } }) +
    ev('response.completed', { response: { id: 'resp_tc', model, status: 'completed' } })
  const text = await collect(responsesToChatStream(Readable.from([sse]), model))
  assert.ok(text.includes('"name":"read"'), 'tool name forwarded')
  // OpenAI streams arguments incrementally: collect the fragments in order.
  const argsFragments: string[] = []
  for (const e of ssePayloads(text)) {
    const calls = (e.choices as Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> | undefined)?.[0]?.delta
      ?.tool_calls
    for (const call of calls ?? []) {
      const frag = call.function?.arguments
      if (typeof frag === 'string' && frag.length > 0) argsFragments.push(frag)
    }
  }
  assert.equal(argsFragments.join(''), '{"path":"a"}{"path":"a"}', 'deltas stream incrementally, done replays the full args')
  assert.ok(text.includes('"finish_reason":"tool_calls"'), 'tool-call finish reason preserved')
  assert.ok(text.includes('data: [DONE]'))
})

test('responsesToChatBody maps function_call items into assistant tool_calls', () => {
  const out = responsesToChatBody({
    model: 'm',
    input: [{ type: 'function_call', call_id: 'call_3', name: 'bash', arguments: '{"cmd":"ls"}' }],
  }) as { messages: Array<{ role: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }> }
  assert.equal(out.messages[0]?.role, 'assistant')
  assert.equal(out.messages[0]?.tool_calls?.[0]?.function.name, 'bash')
  assert.equal(out.messages[0]?.tool_calls?.[0]?.function.arguments, '{"cmd":"ls"}')
  assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_3')
})

test('responsesToChatBody skips reasoning items and maps outputs to tool messages', () => {
  const out = responsesToChatBody({
    model: 'm',
    input: [{ type: 'reasoning', summary: 'thinking' }, { type: 'function_call_output', call_id: 'call_3', output: 'ok' }],
  }) as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> }
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0]?.role, 'tool')
  assert.equal(out.messages[0]?.tool_call_id, 'call_3')
  assert.equal(out.messages[0]?.content, 'ok')
})

test('chatToResponsesBody maps content arrays (text + image) to input parts', () => {
  const out = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ],
  }) as { input: Array<{ content: unknown }> }
  const content = out.input[0]?.content as Array<{ type: string; text?: string; image_url?: string }>
  assert.equal(content[0]?.type, 'input_text')
  assert.equal(content[0]?.text, 'look')
  assert.equal(content[1]?.type, 'input_image')
  assert.equal(content[1]?.image_url, 'data:image/png;base64,AAA')
})

test('tool_choice round-trips through both dialects', () => {
  const r = chatToResponsesBody({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: 'none',
  }) as { tool_choice?: string }
  assert.equal(r.tool_choice, 'none')
  const c = responsesToChatBody({ model: 'm', input: [{ role: 'user', content: 'hi' }], tool_choice: 'auto' }) as {
    tool_choice?: string
  }
  assert.equal(c.tool_choice, 'auto')
})
