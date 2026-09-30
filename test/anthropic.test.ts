import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  chatToMessagesBody,
  chatToMessagesStream,
  messagesToChatBody,
  toAnthropicErrorBody,
} from '../dist/gateway/anthropic.js'

/**
 * Anthropic Messages bridge tests.
 *
 * Claude Code is strict about the Messages wire format: a malformed envelope
 * or a missing SSE event makes it fail the whole turn rather than degrade. These
 * tests lock the three shapes that matter — the request translation (system
 * hoisting, tool_use/tool_result pairing), the non-streaming response
 * envelope, and the six-event SSE sequence.
 */

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  return Buffer.concat(chunks).toString('utf8')
}

// ---------- request: Anthropic -> OpenAI chat ----------

test('messagesToChatBody hoists the top-level system prompt into a system message', () => {
  const out = messagesToChatBody({
    model: 'muse-spark-1.3-contributor-free',
    max_tokens: 256,
    system: 'you are terse',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(out.model, 'muse-spark-1.3-contributor-free')
  assert.equal(out.max_tokens, 256)
  const messages = out.messages as Array<Record<string, unknown>>
  assert.equal(messages[0]!.role, 'system')
  assert.equal(messages[0]!.content, 'you are terse')
  assert.equal(messages[1]!.role, 'user')
})

test('messagesToChatBody flattens Anthropic content blocks to text', () => {
  const out = messagesToChatBody({
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
      },
    ],
  })
  const messages = out.messages as Array<Record<string, unknown>>
  assert.equal(messages[0]!.content, 'part one part two')
})

test('messagesToChatBody converts tools to the OpenAI function shape', () => {
  const out = messagesToChatBody({
    model: 'm',
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'Bash' },
  })
  const tools = out.tools as Array<Record<string, unknown>>
  assert.equal(tools.length, 1)
  const fn = tools[0]!.function as Record<string, unknown>
  assert.equal(tools[0]!.type, 'function')
  assert.equal(fn.name, 'Bash')
  assert.deepEqual(fn.parameters, { type: 'object', properties: { cmd: { type: 'string' } } })
  assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'Bash' } })
})

test('messagesToChatBody maps Anthropic tool_choice variants', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'x' }] }
  assert.equal(messagesToChatBody({ ...base, tool_choice: { type: 'auto' } }).tool_choice, 'auto')
  assert.equal(messagesToChatBody({ ...base, tool_choice: { type: 'any' } }).tool_choice, 'required')
  assert.equal(messagesToChatBody({ ...base, tool_choice: { type: 'none' } }).tool_choice, 'none')
})

test('messagesToChatBody turns an assistant tool_use turn into OpenAI tool_calls', () => {
  const out = messagesToChatBody({
    model: 'm',
    messages: [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } }],
      },
    ],
  })
  const messages = out.messages as Array<Record<string, unknown>>
  const assistant = messages[1]!
  assert.equal(assistant.role, 'assistant')
  const calls = assistant.tool_calls as Array<Record<string, unknown>>
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.id, 'toolu_01')
  assert.deepEqual(JSON.parse((calls[0]!.function as Record<string, string>).arguments), { command: 'ls' })
})

test('messagesToChatBody turns a user tool_result block into a role:tool reply', () => {
  const out = messagesToChatBody({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'file.txt' }],
      },
    ],
  })
  const messages = out.messages as Array<Record<string, unknown>>
  const toolMsg = messages.find((m) => m.role === 'tool')!
  assert.equal(toolMsg.tool_call_id, 'toolu_01')
  assert.equal(toolMsg.content, 'file.txt')
})

test('messagesToChatBody preserves the client stream intent', () => {
  assert.equal(messagesToChatBody({ model: 'm', stream: true, messages: [] }).stream, true)
  assert.equal(messagesToChatBody({ model: 'm', messages: [] }).stream, false)
})

test('messagesToChatBody tolerates a malformed body without throwing', () => {
  assert.equal(messagesToChatBody(null).model, '')
  assert.equal(messagesToChatBody({}).model, '')
  assert.deepEqual(messagesToChatBody({ messages: 'nope' }).messages, [])
})

// ---------- response: OpenAI chat -> Anthropic Messages ----------

test('chatToMessagesBody produces the Anthropic message envelope', () => {
  const out = chatToMessagesBody(
    {
      id: 'chatcmpl-abc',
      model: 'mimo-v2.6-flash-free',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    },
    'muse-spark-1.3-contributor-free',
  )
  assert.equal(out.type, 'message')
  assert.equal(out.role, 'assistant')
  assert.equal(out.stop_reason, 'end_turn')
  assert.equal(out.model, 'mimo-v2.6-flash-free')
  const content = out.content as Array<Record<string, unknown>>
  assert.deepEqual(content, [{ type: 'text', text: 'ok' }])
  const usage = out.usage as Record<string, unknown>
  assert.equal(usage.input_tokens, 10)
  assert.equal(usage.output_tokens, 3)
})

test('chatToMessagesBody emits tool_use blocks and the tool_use stop reason', () => {
  const out = chatToMessagesBody(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'm',
  )
  assert.equal(out.stop_reason, 'tool_use')
  const content = out.content as Array<Record<string, unknown>>
  assert.equal(content[0]!.type, 'tool_use')
  assert.equal(content[0]!.name, 'Bash')
  assert.deepEqual(content[0]!.input, { command: 'ls' })
})

test('chatToMessagesBody maps the length finish reason to max_tokens', () => {
  const out = chatToMessagesBody({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }, 'm')
  assert.equal(out.stop_reason, 'max_tokens')
})

test('chatToMessagesBody survives unparseable tool arguments', () => {
  const out = chatToMessagesBody(
    { choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'Bash', arguments: '{bad' } }] }, finish_reason: 'tool_calls' }] },
    'm',
  )
  const content = out.content as Array<Record<string, unknown>>
  assert.deepEqual(content[0]!.input, {}, 'partial JSON must not throw')
})

// ---------- streaming: OpenAI chat SSE -> Anthropic SSE ----------

function sse(chunks: unknown[]): Readable {
  return Readable.from(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`))
}

test('chatToMessagesStream emits the full Anthropic event sequence in order', async () => {
  const out = await collect(
    chatToMessagesStream(
      sse([
        { choices: [{ delta: { content: 'he' } }] },
        { choices: [{ delta: { content: 'llo' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
      'm',
    ),
  )
  const order = [...out.matchAll(/^event: (\w+)$/gm)].map((m) => m[1])
  assert.deepEqual(order, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  // The two text deltas must reassemble to the upstream text.
  const deltas = [...out.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1])
  assert.equal(deltas.join(''), 'hello')
  // Usage rides on message_delta for Claude Code's token accounting.
  assert.match(out, /"input_tokens":5/)
  assert.match(out, /"output_tokens":2/)
  assert.match(out, /"stop_reason":"end_turn"/)
})

test('chatToMessagesStream gives each tool call its own content block index', async () => {
  const out = await collect(
    chatToMessagesStream(
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"a":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'Read', arguments: '{}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]),
      'm',
    ),
  )
  const starts = [...out.matchAll(/"type":"content_block_start","index":(\d+)/g)].map((m) => m[1])
  assert.deepEqual(starts, ['0', '1', '2'], 'index 0 is text, then one per tool call')
  assert.match(out, /"type":"input_json_delta"/)
  assert.match(out, /"stop_reason":"tool_use"/)
  // Both tool blocks must be closed before message_stop.
  const stops = [...out.matchAll(/"type":"content_block_stop","index":(\d+)/g)].map((m) => m[1])
  assert.deepEqual(stops, ['1', '2'])
})

test('chatToMessagesStream surfaces an in-stream error as an Anthropic error event', async () => {
  const out = await collect(
    chatToMessagesStream(sse([{ error: { message: 'upstream exploded' } }]), 'm'),
  )
  assert.match(out, /event: error/)
  assert.match(out, /upstream exploded/)
})

test('chatToMessagesStream still terminates when the source is empty', async () => {
  const out = await collect(chatToMessagesStream(Readable.from([]), 'm'))
  assert.match(out, /event: message_start/)
  assert.match(out, /event: message_stop/)
})

test('chatToMessagesBody falls back to reasoning text when content is empty', () => {
  // muse-spark can burn the whole max_tokens budget on thinking and return an
  // empty content; Claude Code must still receive a renderable message.
  const out = chatToMessagesBody(
    { choices: [{ message: { role: 'assistant', content: '', reasoning: 'thinking out loud' }, finish_reason: 'stop' }] },
    'muse-spark-1.3-contributor-free',
  )
  const content = out.content as Array<Record<string, unknown>>
  assert.deepEqual(content, [{ type: 'text', text: 'thinking out loud' }])
})

test('chatToMessagesStream falls back to reasoning deltas when content is empty', async () => {
  const out = await collect(
    chatToMessagesStream(
      sse([
        { choices: [{ delta: { reasoning: 'step one ' } }] },
        { choices: [{ delta: { reasoning: 'step two' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
      'muse-spark-1.3-contributor-free',
    ),
  )
  const deltas = [...out.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1])
  assert.equal(deltas.join(''), 'step one step two')
})

// ---------- errors ----------

test('toAnthropicErrorBody preserves known Anthropic error types', () => {
  const parsed = JSON.parse(toAnthropicErrorBody('nope', 'authentication_error'))
  assert.equal(parsed.type, 'error')
  assert.equal(parsed.error.type, 'authentication_error')
  assert.equal(parsed.error.message, 'nope')
})

test('toAnthropicErrorBody maps unknown gateway types to api_error', () => {
  const parsed = JSON.parse(toAnthropicErrorBody('boom', 'upstream_error'))
  assert.equal(parsed.error.type, 'api_error')
})
