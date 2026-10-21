import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  chatToResponsesBody,
  responsesToChatBody,
  responsesToChatCompletion,
  responsesToChatStream,
  resolveUpstreamApi,
  isResponsesWireModel,
  stripCallerBoundReasoning,
} from '../dist/gateway/protocol.js'
import { ensureChatFreeLaneShape, ensureResponsesFreeLaneShape } from '../dist/core/freelane.js'

/**
 * Protocol-bridge tests.
 *
 * These lock in the two translation bugs that made any tool-using or
 * system-prompted conversation fail on a Responses-wire model (muse-spark-*),
 * plus the aggregation path that silently hung a non-streaming chat client.
 */

test('resolveUpstreamApi routes contributor muse-spark ids to responses and everything else to chat', () => {
  assert.equal(resolveUpstreamApi('muse-spark-1.3-contributor-free'), 'responses')
  assert.equal(resolveUpstreamApi('muse-spark-1.2-contributor-free'), 'responses')
  assert.equal(resolveUpstreamApi('big-pickle'), 'chat')
  assert.equal(resolveUpstreamApi('mimo-v2.5-free'), 'chat')
  assert.equal(resolveUpstreamApi('space-bunny-free'), 'chat')
  assert.equal(isResponsesWireModel('muse-spark-1.2-contributor-free'), true)
  assert.equal(isResponsesWireModel('big-pickle'), false)
})

test('chat -> responses moves the system prompt into instructions', () => {
  const out = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'hi' },
    ],
    stream: true,
  })
  assert.equal(out.instructions, 'You are a coding agent.')
  for (const item of out.input as Array<Record<string, unknown>>) {
    assert.notEqual(item.role, 'system', 'system must never appear as an input role')
  }
  assert.deepEqual(out.input, [{ role: 'user', content: 'hi' }])
})

test('chat -> responses normalizes Bash command aliases and empty arguments safely', () => {
  const aliased = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_alias', type: 'function', function: { name: 'bash', arguments: '{"cmd":"printf alias"}' } }] },
    ],
  })
  assert.equal((aliased.input as Array<Record<string, unknown>>)[0]?.arguments, '{"command":"printf alias"}')

  const empty = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_empty', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    ],
  })
  assert.equal(
    (empty.input as Array<Record<string, unknown>>)[0]?.arguments,
    JSON.stringify({ command: "printf '%s\\n' 'The Bash tool call had empty arguments; please retry with a command.'" }),
  )
})

test('responses -> chat normalizes Bash command aliases and empty arguments safely', () => {
  const aliased = responsesToChatBody({
    model: 'big-pickle',
    input: [{ type: 'function_call', call_id: 'call_alias', name: 'bash', arguments: '{"shell_command":"printf alias"}' }],
  })
  const aliasCall = ((aliased.messages as Array<Record<string, unknown>>)[0]?.tool_calls as Array<Record<string, unknown>>)[0]
  assert.deepEqual(aliasCall, {
    id: 'call_alias',
    type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ command: 'printf alias' }) },
  })

  const empty = responsesToChatBody({
    model: 'big-pickle',
    input: [{ type: 'function_call', call_id: 'call_empty', name: 'Bash', arguments: '{}' }],
  })
  const call = ((empty.messages as Array<Record<string, unknown>>)[0]?.tool_calls as Array<Record<string, unknown>>)[0]
  assert.equal(
    (call.function as Record<string, unknown>).arguments,
    JSON.stringify({ command: "printf '%s\\n' 'The Bash tool call had empty arguments; please retry with a command.'" }),
  )
})

test('chat -> responses converts a tool result into function_call_output', () => {
  const out = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
    ],
    stream: true,
  })
  const input = out.input as Array<Record<string, unknown>>
  assert.deepEqual(input[0], { role: 'user', content: 'list files' })
  assert.deepEqual(input[1], { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) })
  assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' })
  for (const item of input) {
    assert.notEqual(item.role, 'tool', 'a tool result is not a message role in this dialect')
  }
})

test('chat -> responses merges multiple system/developer turns into instructions', () => {
  const out = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [
      { role: 'system', content: 'first' },
      { role: 'developer', content: 'second' },
      { role: 'user', content: 'go' },
    ],
  })
  assert.equal(out.instructions, 'first\n\nsecond')
  assert.equal((out.input as unknown[]).length, 1)
})

test('responses -> chat keeps working for a plain user turn', () => {
  const out = responsesToChatBody({ model: 'big-pickle', input: [{ role: 'user', content: 'hi' }], stream: true })
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }])
})

/**
 * Regression: a codex echo of prior-turn `reasoning.encrypted_content` blobs
 * 400s with `reasoning 'encrypted_content' was not issued to this caller`
 * whenever the echo reaches the provider under a different caller identity
 * than the one that minted the blobs — which exit rotation makes routine.
 * The passthrough must therefore never carry reasoning items or the include
 * entry that asks for new blobs.
 */
test('stripCallerBoundReasoning drops reasoning items and trims the encrypted_content include', () => {
  const out = stripCallerBoundReasoning({
    model: 'muse-spark-1.3-contributor-free',
    instructions: 'base instructions',
    input: [
      { role: 'user', content: 'list files' },
      { type: 'reasoning', summary: [], encrypted_content: 'gAAAAA issued-by-exit-a' },
      { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      { type: 'reasoning', encrypted_content: 'gAAAAA issued-by-exit-b' },
      { role: 'assistant', content: 'done' },
    ],
    include: ['reasoning.encrypted_content'],
    store: false,
    stream: true,
  })
  const input = out.input as Array<Record<string, unknown>>
  assert.deepEqual(
    input.map((item) => item.type ?? item.role),
    ['user', 'function_call', 'function_call_output', 'assistant'],
    'every reasoning item is gone; message/function items keep their order',
  )
  assert.equal(out.include, undefined, 'the only include entry was the encrypted_content one')
  assert.equal(out.instructions, 'base instructions')
  assert.equal(out.store, false)
})

test('stripCallerBoundReasoning keeps unrelated include entries and drops the field when trimmed empty', () => {
  const kept = stripCallerBoundReasoning({
    input: [{ role: 'user', content: 'hi' }],
    include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
  })
  assert.deepEqual(kept.include, ['message.output_text.logprobs'])

  const dropped = stripCallerBoundReasoning({
    input: [{ role: 'user', content: 'hi' }],
    include: ['reasoning.encrypted_content'],
  })
  assert.equal(dropped.include, undefined)
})

test('stripCallerBoundReasoning returns a body without reasoning state by reference', () => {
  const body = { model: 'muse-spark-1.3-contributor-free', input: [{ role: 'user', content: 'hi' }], stream: true }
  assert.equal(stripCallerBoundReasoning(body), body, 'no copy when there is nothing to strip')
})

test('stripCallerBoundReasoning falls back to a placeholder when reasoning items were the whole input', () => {
  const out = stripCallerBoundReasoning({
    model: 'muse-spark-1.3-contributor-free',
    input: [{ type: 'reasoning', encrypted_content: 'gAAAAA' }],
  })
  assert.deepEqual(out.input, [{ role: 'user', content: '' }])
})

test('the responses free-lane gate normalises a string input to an array', () => {
  const { body, injected } = ensureResponsesFreeLaneShape({ model: 'big-pickle', input: 'hi', stream: true })
  assert.equal(injected, true)
  const shaped = body as Record<string, unknown>
  assert.deepEqual(shaped.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], 'a bare string becomes a user message')
  assert.equal(shaped.tool_choice, 'auto')
  const names = (shaped.tools as Array<Record<string, unknown>>).map((t) => t.name)
  assert.ok(names.includes('bash') && names.includes('read'))
})

test('the chat free-lane gate injects the official bash and read definitions and sets tool_choice auto', () => {
  const { body } = ensureChatFreeLaneShape({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] })
  const shaped = body as Record<string, unknown>
  const tools = shaped.tools as Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>
  const bash = tools.find((t) => t.function.name === 'bash')
  assert.ok(bash && bash.function.description.length > 1000, 'a stub description is rejected by the lane')
  assert.ok(tools.some((t) => t.function.name === 'read'))
  assert.equal(shaped.tool_choice, 'auto', 'the CLI always sends auto; the lane 403s none')
})

test('the free-lane gate replaces a client stub bash with the official definition and keeps other tools', () => {
  const stub = { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } } }
  const other = { type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } } }
  const { body } = ensureChatFreeLaneShape({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], tools: [stub, other] })
  const tools = (body as { tools: Array<{ function: { name: string; description: string } }> }).tools
  const bash = tools.filter((t) => t.function.name === 'bash')
  assert.equal(bash.length, 1, 'one bash tool after the rewrite')
  assert.ok(bash[0]!.function.description.length > 1000, 'the official bash schema replaces the stub')
  assert.ok(tools.some((t) => t.function.name === 'grep'), 'other client tools are kept')
  assert.ok(tools.some((t) => t.function.name === 'read'))
})

test('the responses free-lane gate replaces a client stub bash with the official definition', () => {
  const stub = { type: 'function', name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }
  const { body } = ensureResponsesFreeLaneShape({ model: 'muse-spark-1.3-contributor-free', input: 'hi', tools: [stub] })
  const tools = (body as { tools: Array<{ name: string; description: string; strict: boolean }> }).tools
  const bash = tools.filter((t) => t.name === 'bash')
  assert.equal(bash.length, 1)
  assert.ok(bash[0]!.description.length > 1000)
  assert.equal(bash[0]!.strict, false)
})

test('the chat free-lane gate coerces a client tool_choice "none" to auto (the lane 403s it) and keeps other choices', () => {
  const weather = { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } }
  const messages = [{ role: 'user', content: 'hi' }]
  const none = ensureChatFreeLaneShape({ model: 'big-pickle', messages, tools: [weather], tool_choice: 'none' }).body as Record<string, unknown>
  assert.equal(none.tool_choice, 'auto', 'none is coerced to the CLI default')
  const noneNoTools = ensureChatFreeLaneShape({ model: 'big-pickle', messages, tool_choice: 'none' }).body as Record<string, unknown>
  assert.equal(noneNoTools.tool_choice, 'auto')
  for (const choice of ['auto', 'required', { type: 'function', function: { name: 'get_weather' } }]) {
    const kept = ensureChatFreeLaneShape({ model: 'big-pickle', messages, tools: [weather], tool_choice: choice }).body as Record<string, unknown>
    assert.deepEqual(kept.tool_choice, choice, 'choices the lane accepts pass through untouched')
  }
})

test('the gate tool definitions carry no machine-specific paths', () => {
  const { body } = ensureChatFreeLaneShape({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] })
  const wire = JSON.stringify(body)
  assert.doesNotMatch(wire, /\/var\/folders|\/Users\/esadmin/)
})

/**
 * Regression: reasoning effort was silently dropped in BOTH translation
 * directions. Both translators are whitelist rebuilds, so a client asking for
 * `xhigh` got the model's default effort and no error anywhere — worst kind of
 * failure, because the response looks perfectly healthy.
 */
test('chat -> responses carries reasoning_effort across as reasoning.effort', () => {
  const out = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'xhigh',
    stream: true,
  })
  assert.deepEqual(out.reasoning, { effort: 'xhigh' })
  assert.equal(out.reasoning_effort, undefined, 'the flat chat field must not leak into the responses body')
})

test('chat -> responses accepts the nested reasoning shape a client may send instead', () => {
  const out = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: { effort: 'minimal', summary: 'auto' },
  })
  assert.deepEqual(out.reasoning, { effort: 'minimal' })
})

test('responses -> chat carries reasoning.effort across as reasoning_effort', () => {
  const out = responsesToChatBody({
    model: 'big-pickle',
    input: [{ role: 'user', content: 'hi' }],
    reasoning: { effort: 'high' },
  })
  assert.equal(out.reasoning_effort, 'high')
  assert.equal(out.reasoning, undefined, 'the nested field must not leak into the chat body')
})

test('responses -> chat accepts a flat reasoning_effort from the client', () => {
  const out = responsesToChatBody({
    model: 'big-pickle',
    input: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'medium',
  })
  assert.equal(out.reasoning_effort, 'medium')
})

test('a malformed effort is never forwarded to upstream, while junk siblings are ignored', () => {
  // Negative half: nothing recognisable means no field at all, so the gateway
  // cannot hand upstream a shape it would reject.
  for (const value of [undefined, null, '', '   ', 42, {}, []]) {
    const chat = chatToResponsesBody({
      model: 'muse-spark-1.3-contributor-free',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: value,
    })
    assert.equal(chat.reasoning, undefined, `chat body must not grow a reasoning field for ${JSON.stringify(value)}`)

    const responses = responsesToChatBody({
      model: 'big-pickle',
      input: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: value },
    })
    assert.equal(responses.reasoning_effort, undefined, `responses body must not grow an effort field for ${JSON.stringify(value)}`)
  }
  // Positive half: a usable value still wins over unrecognised siblings, and the
  // emitted object stays exactly {effort} rather than inheriting the junk.
  const withJunk = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: { effort: 'high', bogus: 1, nested: { deep: true } },
  })
  assert.deepEqual(withJunk.reasoning, { effort: 'high' })
})

test('the native spelling wins over the foreign one, and an unusable native falls through', () => {
  // Both spellings, different values: the dialect-native one decides. Mirrored
  // in each direction, so the two clients that differ here are both pinned.
  assert.deepEqual(
    chatToResponsesBody({
      model: 'muse-spark-1.3-contributor-free',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
      reasoning: { effort: 'low' },
    }).reasoning,
    { effort: 'xhigh' },
  )
  assert.equal(
    responsesToChatBody({
      model: 'big-pickle',
      input: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'high' },
      reasoning_effort: 'low',
    }).reasoning_effort,
    'high',
  )
  // Native present but unusable -> fall through to the foreign value, rather
  // than dropping the request's intent entirely.
  assert.deepEqual(
    chatToResponsesBody({
      model: 'muse-spark-1.3-contributor-free',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 0,
      reasoning: { effort: 'low' },
    }).reasoning,
    { effort: 'low' },
  )
})

test('the effort token is trimmed so a padded client value is still accepted', () => {
  const out = chatToResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: '  xhigh  ',
  })
  assert.deepEqual(out.reasoning, { effort: 'xhigh' })
})

/**
 * Regression: the aggregator used to attach listeners to a paused stream and
 * await its 'end' event, which never fired — a non-streaming chat client on a
 * Responses-wire model hung instead of getting its answer.
 */
test('responsesToChatCompletion aggregates a responses SSE body without hanging', async () => {
  const sse = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_abc","model":"muse-spark-1.3-contributor-free","created_at":100}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_abc","model":"muse-spark-1.3-contributor-free","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
  ].join('')

  const result = await responsesToChatCompletion(Readable.from([Buffer.from(sse, 'utf8')]), 'muse-spark-1.3-contributor-free')
  const chunks: Buffer[] = []
  for await (const chunk of result) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>

  assert.equal(payload.object, 'chat.completion')
  assert.equal(payload.model, 'muse-spark-1.3-contributor-free')
  assert.equal(payload.choices[0].message.content, 'Hello world')
  assert.equal(payload.choices[0].finish_reason, 'stop')
  assert.equal(payload.usage.prompt_tokens, 5)
})

test('responsesToChatCompletion surfaces a failed response instead of an empty answer', async () => {
  const sse =
    'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_x","status":"failed","error":{"code":"upstream_403","message":"This model is not available in your country."}}}\n\n'
  await assert.rejects(
    () => responsesToChatCompletion(Readable.from([Buffer.from(sse, 'utf8')]), 'muse-spark-1.3-contributor-free'),
    /not available in your country/,
  )
})

test('responsesToChatStream emits chat chunks and a DONE sentinel', async () => {
  const sse = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_abc","model":"m","created_at":100}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_abc","model":"m","status":"completed"}}\n\n',
  ].join('')
  const out: string[] = []
  for await (const chunk of responsesToChatStream(Readable.from([Buffer.from(sse, 'utf8')]), 'm')) out.push(String(chunk))
  const text = out.join('')
  assert.ok(text.includes('"content":"hi"'), 'the delta is forwarded as chat content')
  assert.ok(text.includes('data: [DONE]'), 'the stream is terminated for chat clients')
})
