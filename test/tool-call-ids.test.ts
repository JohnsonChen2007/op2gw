import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeChatToolCallIds, chatToResponsesBody, responsesToChatBody, closeUnansweredFunctionCalls } from '../dist/gateway/protocol.js'

/**
 * tool_call_id normalization — the chat-wire repair for the provider 400
 * `tool messages must include a non-empty string tool_call_id` (observed
 * 2026-10-01: identical failures across independent exits proved the body,
 * not the pool, was at fault).
 */

type Msg = Record<string, unknown>

function msgs(body: unknown): Msg[] {
  return (body as { messages: Msg[] }).messages
}

test('missing tool_call_id is paired with the preceding assistant tool_calls', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      { role: 'user', content: 'ls' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', content: 'file1' },
    ],
  })
  assert.equal(msgs(out)[2]?.tool_call_id, 'call_a')
})

test('parallel tool calls pair positionally, FIFO', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'a' },
      { role: 'tool', content: 'b' },
    ],
  })
  assert.equal(msgs(out)[1]?.tool_call_id, 'c1')
  assert.equal(msgs(out)[2]?.tool_call_id, 'c2')
})

test('call_id spelling on a chat-surface tool message is backfilled to tool_call_id', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', call_id: 'call_x', content: 'a' },
    ],
  })
  assert.equal(msgs(out)[1]?.tool_call_id, 'call_x')
})

test('a declared id that exists is never rewritten and the body is returned by reference', () => {
  const body = {
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'ok1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'ok1', content: 'a' },
    ],
  }
  assert.equal(normalizeChatToolCallIds(body), body, 'well-formed bodies pass through without a copy')
})

test('an orphan tool message with no assistant calls gets a present-but-empty id', () => {
  const out = normalizeChatToolCallIds({
    messages: [{ role: 'tool', content: 'a' }],
  })
  assert.equal(msgs(out)[0]?.tool_call_id, '')
  // An already-present empty string is left byte-identical (same reference).
  const body = { messages: [{ role: 'tool', tool_call_id: '', content: 'a' }] }
  assert.equal(normalizeChatToolCallIds(body), body)
})

test('a tool result that arrives before any assistant call pairs with the later calls', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      { role: 'tool', content: 'early' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'late1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'late1', content: 'claimed' },
    ],
  })
  // The orphan stays empty; the explicitly-id'd later result keeps its id.
  assert.equal(msgs(out)[0]?.tool_call_id, '')
  assert.equal(msgs(out)[2]?.tool_call_id, 'late1')
})

test('bodies without a messages array are returned untouched', () => {
  const body = { model: 'm' }
  assert.equal(normalizeChatToolCallIds(body), body)
})

test('chatToResponsesBody binds an id-less tool result to the preceding function_call', () => {
  const out = chatToResponsesBody({
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_p', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', content: 'a' },
    ],
  }) as { input: Array<Record<string, unknown>> }
  const items = out.input
  assert.equal(items[0]?.type, 'function_call')
  assert.equal(items[0]?.call_id, 'call_p')
  assert.equal(items[1]?.type, 'function_call_output')
  assert.equal(items[1]?.call_id, 'call_p')
})

test('a complete parallel tool round is returned by reference', () => {
  const body = {
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a' },
      { role: 'tool', tool_call_id: 'c2', content: 'b' },
    ],
  }
  assert.equal(normalizeChatToolCallIds(body), body)
})

test('an assistant tool_calls turn with no results is closed before the next user message', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'user', content: 'continue' },
    ],
  })
  const m = msgs(out)
  assert.equal(m[1]?.role, 'tool')
  assert.equal(m[1]?.tool_call_id, 'call_a')
  assert.match(String(m[1]?.content), /no tool result/)
  assert.equal(m[2]?.role, 'user')
})

test('only the unanswered member of a parallel tool round is synthesized', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a' },
      { role: 'user', content: 'next' },
    ],
  })
  const m = msgs(out)
  assert.equal(m[1]?.tool_call_id, 'c1')
  assert.equal(m[1]?.content, 'a')
  assert.equal(m[2]?.role, 'tool')
  assert.equal(m[2]?.tool_call_id, 'c2')
  assert.equal(m[3]?.role, 'user')
})

test('consecutive assistant tool_call messages are merged so one round answers every id', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'assistant', content: 'also', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'a' },
      { role: 'tool', tool_call_id: 'c2', content: 'b' },
    ],
  })
  const m = msgs(out)
  assert.equal(m.length, 3, 'the two assistant turns collapse into one')
  const calls = (m[0]?.tool_calls as Array<{ id: string }>) ?? []
  assert.deepEqual(calls.map((call) => call.id), ['c1', 'c2'])
  assert.equal(m[0]?.content, 'also')
  assert.equal(m[1]?.tool_call_id, 'c1')
  assert.equal(m[2]?.tool_call_id, 'c2')
})

test('a tool result stranded after the next user turn is pulled back into its round', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'user', content: 'stop' },
      { role: 'tool', tool_call_id: 'call_a', content: 'real result' },
    ],
  })
  const m = msgs(out)
  assert.equal(m[1]?.role, 'tool')
  assert.equal(m[1]?.tool_call_id, 'call_a')
  assert.equal(m[1]?.content, 'real result')
  assert.equal(m[2]?.role, 'user')
})

test('a later round keeps its own id-less tool result', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: 'belongs to b' },
    ],
  })
  const m = msgs(out)
  assert.equal(m[1]?.role, 'tool')
  assert.equal(m[1]?.tool_call_id, 'call_a')
  assert.match(String(m[1]?.content), /no tool result/)
  assert.equal(m[2]?.role, 'user')
  assert.equal(m[3]?.role, 'assistant')
  assert.equal(m[4]?.role, 'tool')
  assert.equal(m[4]?.tool_call_id, 'call_b')
  assert.equal(m[4]?.content, 'belongs to b')
})

test('responsesToChatBody coalesces consecutive function_calls into one assistant message', () => {
  const out = responsesToChatBody({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{}' },
      { type: 'function_call', call_id: 'c2', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'a' },
      { type: 'function_call_output', call_id: 'c2', output: 'b' },
    ],
  }) as { messages: Array<{ role: string; tool_calls?: Array<{ id: string }> }> }
  assert.equal(out.messages[0]?.role, 'assistant')
  assert.deepEqual(out.messages[0]?.tool_calls?.map((call) => call.id), ['c1', 'c2'])
  assert.equal(out.messages[1]?.role, 'tool')
  assert.equal(out.messages[2]?.role, 'tool')
})

test('chatToResponsesBody emits a function_call_output for an unanswered tool call', () => {
  const out = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_z', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'user', content: 'continue' },
    ],
  }) as { input: Array<Record<string, unknown>> }
  assert.equal(out.input[0]?.type, 'function_call')
  assert.equal(out.input[0]?.call_id, 'call_z')
  assert.equal(out.input[1]?.type, 'function_call_output')
  assert.equal(out.input[1]?.call_id, 'call_z')
  assert.equal(out.input[2]?.role, 'user')
})

test('closeUnansweredFunctionCalls inserts the missing output and leaves a closed round untouched', () => {
  const broken = closeUnansweredFunctionCalls({
    input: [
      { type: 'function_call', call_id: 'call_z', name: 'bash', arguments: '{}' },
      { role: 'user', content: 'continue' },
    ],
  }) as { input: Array<Record<string, unknown>> }
  assert.equal(broken.input[1]?.type, 'function_call_output')
  assert.equal(broken.input[1]?.call_id, 'call_z')
  assert.equal(broken.input[2]?.role, 'user')

  const sound = {
    input: [
      { type: 'function_call', call_id: 'call_z', name: 'bash', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_z', output: 'ok' },
    ],
  }
  assert.equal(closeUnansweredFunctionCalls(sound), sound)
})

test('assistant tool_calls entries without an id get synthesized ids that pair to results', () => {
  const out = normalizeChatToolCallIds({
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', content: 'a' },
    ],
  })
  const m = msgs(out)
  const calls = (m[0]?.tool_calls as Array<Record<string, unknown>>) ?? []
  assert.equal(typeof calls[0]?.id, 'string')
  assert.ok(calls[0] && (calls[0].id as string).length > 0, 'synthesized id is non-empty')
  assert.equal(m[1]?.tool_call_id, calls[0]?.id, 'the result pairs with the synthesized id')
})
