import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyShim } from '../src/shim.ts'

/**
 * Tool-result round trip through the real adapter, the real dsh-llm-pi-ai
 * conversion, and the real pi-ai pipeline (issue #57): a model tool call
 * answered by `hi` must arrive on the wire with matching ids and the real
 * text — never pi-ai's synthetic `No result provided`, which is what an
 * orphaned call id produces. Inputs are Harness-host messages (tool results
 * live as `tool-result` blocks inside user messages), so the layer suspected
 * in #57 — the host → pi-ai conversion — runs for real; only the network is
 * fake.
 */

const MODEL = 'deepseek-v4.1-flash'

function adapter() {
  const catalog = new WorkBuddyCatalog([{
    id: MODEL, name: 'DeepSeek V4.1 Flash', contextWindow: 128_000, maxTokens: 128_000,
    supportsImages: false, billing: { free: false },
  }])
  return createWorkBuddyAdapter({
    catalog,
    store: {} as WorkBuddyCredentialStore,
    shim: {
      ready: Promise.resolve(),
      baseUrl: () => 'http://127.0.0.1:1',
      token: () => 'test-token',
      close: async () => {},
    } as WorkBuddyShim,
  }).adapter
}

interface WireMessage {
  role?: string
  content?: unknown
  tool_calls?: { id?: string, function?: { name?: string } }[]
  tool_call_id?: string
}

async function wireBody(messages: unknown[]): Promise<WireMessage[]> {
  let body: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }))
  const call = await adapter().prepareCall(WORKBUDDY_PROVIDER, MODEL)
  for await (const _chunk of call.stream({ provider: WORKBUDDY_PROVIDER, model: MODEL, messages: messages as never })) {
    // The serialized request is the contract under test.
  }
  return (body?.['messages'] ?? []) as WireMessage[]
}

/** The adapter-private replay envelope dsh-llm-pi-ai validates (version 2). */
function replayEnvelope(options: { provider?: string, kind?: string } = {}): unknown {
  return {
    response: {
      kind: options.kind ?? 'pi-ai',
      version: 2,
      api: 'openai-completions',
      provider: options.provider ?? WORKBUDDY_PROVIDER,
      model: MODEL,
      stopReason: 'toolUse',
    },
    blocks: [{ type: 'tool-call' }],
  }
}

/** A Harness assistant message carrying one tool call per id given. */
function assistantToolCalls(
  ids: readonly { id: string, name: string }[],
  source: Record<string, unknown> = { kind: 'model', provider: WORKBUDDY_PROVIDER, model: MODEL },
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: ids.map(({ id, name }) => ({ type: 'tool-call', id, name, arguments: JSON.stringify({ command: 'echo hi' }) })),
    // Without replayState this is the provider-neutral conversion path —
    // what a cross-provider history exercises; with one, the same-model
    // replay path a normal #57 conversation takes.
    source,
  }
}

/**
 * One Harness tool-result message, in the 0.1.5 host contract: a user-role
 * message whose source is the tool seat, one result block per message.
 */
function toolResultMessage(id: string, text: string): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text }], isError: false }],
    source: { kind: 'tool', callId: id },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('#57 tool results reach the wire intact', () => {
  it('carries a single shell result with matching ids and no synthetic filler', async () => {
    const wire = await wireBody([
      { role: 'user', content: [{ type: 'text', text: 'run echo hi' }], source: { kind: 'user' } },
      assistantToolCalls([{ id: 'call_1', name: 'shell' }]),
      toolResultMessage('call_1', 'hi'),
    ])
    const toolWire = wire.find(message => message.role === 'tool')
    expect(toolWire).toMatchObject({ tool_call_id: 'call_1', content: 'hi' })
    const assistantWire = wire.find(message => message.role === 'assistant')
    expect(assistantWire?.tool_calls?.[0]?.id).toBe('call_1')
    expect(JSON.stringify(wire)).not.toContain('No result provided')
  })

  it('keeps parallel tool calls and results paired', async () => {
    const wire = await wireBody([
      { role: 'user', content: [{ type: 'text', text: 'run both' }], source: { kind: 'user' } },
      assistantToolCalls([
        { id: 'call_a', name: 'shell' },
        { id: 'call_b', name: 'read' },
      ]),
      toolResultMessage('call_a', 'hi'),
      toolResultMessage('call_b', 'file-body'),
    ])
    const toolWire = wire.filter(message => message.role === 'tool')
    expect(toolWire).toHaveLength(2)
    expect(toolWire[0]).toMatchObject({ tool_call_id: 'call_a', content: 'hi' })
    expect(toolWire[1]).toMatchObject({ tool_call_id: 'call_b', content: 'file-body' })
    expect(JSON.stringify(wire)).not.toContain('No result provided')
  })

  it('keeps two consecutive tool rounds paired', async () => {
    const wire = await wireBody([
      { role: 'user', content: [{ type: 'text', text: 'run twice' }], source: { kind: 'user' } },
      assistantToolCalls([{ id: 'call_round1', name: 'shell' }]),
      toolResultMessage('call_round1', 'first-output'),
      assistantToolCalls([{ id: 'call_round2', name: 'shell' }]),
      toolResultMessage('call_round2', 'second-output'),
    ])
    const toolWire = wire.filter(message => message.role === 'tool')
    expect(toolWire).toHaveLength(2)
    expect(toolWire[0]).toMatchObject({ tool_call_id: 'call_round1', content: 'first-output' })
    expect(toolWire[1]).toMatchObject({ tool_call_id: 'call_round2', content: 'second-output' })
    expect(JSON.stringify(wire)).not.toContain('No result provided')
  })

  it('keeps special-character ids paired through sanitization', async () => {
    const odd = 'call_|abc-xyz.123'
    const wire = await wireBody([
      { role: 'user', content: [{ type: 'text', text: 'run echo hi' }], source: { kind: 'user' } },
      assistantToolCalls([{ id: odd, name: 'shell' }]),
      toolResultMessage(odd, 'hi'),
    ])
    const toolWire = wire.find(message => message.role === 'tool')
    const assistantWire = wire.find(message => message.role === 'assistant')
    // openai-completions sanitizes special characters out of ids — on BOTH
    // sides of the pair. What must hold is the pairing and the text, not the
    // id's original spelling.
    expect(toolWire?.tool_call_id).toBe(assistantWire?.tool_calls?.[0]?.id)
    expect(toolWire).toMatchObject({ content: 'hi' })
    expect(JSON.stringify(wire)).not.toContain('No result provided')
  })

  it('keeps results paired across a provider switch', async () => {
    // The reporter's shape: a conversation whose earlier turns ran under the
    // official provider, then requested from workbuddy. The history assistant
    // is foreign (provider/model differ), and its results must still pair.
    const wire = await wireBody([
      { role: 'user', content: [{ type: 'text', text: 'run echo hi' }], source: { kind: 'user' } },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_foreign', name: 'shell', arguments: JSON.stringify({ command: 'echo hi' }) }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
      },
      toolResultMessage('call_foreign', 'hi'),
    ])
    const toolWire = wire.find(message => message.role === 'tool')
    expect(toolWire).toMatchObject({ tool_call_id: 'call_foreign', content: 'hi' })
    expect(JSON.stringify(wire)).not.toContain('No result provided')
  })

  it('pairs results on the same-model replay path', async () => {
    // The normal #57 conversation: the assistant was produced by this very
    // provider, so the host stored a replay envelope and the conversion takes
    // the replayedAssistant path instead of the provider-neutral one.
    const wire = await wireBody([
      { role: 'user', content: [{ type: 'text', text: 'run echo hi' }], source: { kind: 'user' } },
      assistantToolCalls([{ id: 'call_replay', name: 'shell' }], {
        kind: 'model',
        provider: WORKBUDDY_PROVIDER,
        model: MODEL,
        replayState: replayEnvelope(),
      }),
      toolResultMessage('call_replay', 'hi'),
    ])
    const toolWire = wire.find(message => message.role === 'tool')
    expect(toolWire).toMatchObject({ tool_call_id: 'call_replay', content: 'hi' })
    expect(JSON.stringify(wire)).not.toContain('No result provided')
  })

  it('still pairs results when a malformed replay state degrades to the neutral path', async () => {
    // A replay envelope this build cannot use (another adapter's kind) must
    // degrade that one message to provider-neutral conversion — never break
    // the id pairing beside it.
    const wire = await wireBody([
      { role: 'user', content: [{ type: 'text', text: 'run echo hi' }], source: { kind: 'user' } },
      assistantToolCalls([{ id: 'call_degraded', name: 'shell' }], {
        kind: 'model',
        provider: WORKBUDDY_PROVIDER,
        model: MODEL,
        replayState: replayEnvelope({ kind: 'someone-else' }),
      }),
      toolResultMessage('call_degraded', 'hi'),
    ])
    const toolWire = wire.find(message => message.role === 'tool')
    expect(toolWire).toMatchObject({ tool_call_id: 'call_degraded', content: 'hi' })
    expect(JSON.stringify(wire)).not.toContain('No result provided')
  })

  it('still surfaces the synthetic filler when a result is genuinely missing', async () => {
    // Sensitivity pin: the symptom of #57 is pi-ai's orphan filler. Dropping
    // the real result on purpose must reproduce it, proving the harness can
    // tell a healthy round trip from the reported failure.
    const wire = await wireBody([
      { role: 'user', content: [{ type: 'text', text: 'run echo hi' }], source: { kind: 'user' } },
      assistantToolCalls([{ id: 'call_gone', name: 'shell' }]),
    ])
    expect(JSON.stringify(wire)).toContain('No result provided')
  })
})
