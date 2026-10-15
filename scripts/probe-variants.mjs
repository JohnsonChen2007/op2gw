// Variant isolation: which request property trips the FreeTierError on /inference?
import { request, ProxyAgent } from 'undici'
import { deriveRequestIDs, disguiseHeaders } from '../dist/core/ids.js'
import { ensureChatFreeLaneShape } from '../dist/core/freelane.js'
import { GATE_TOOL_FUNCTIONS } from '../dist/core/gate-tools.js'

const EXIT = process.env.PROBE_EXIT ?? 'socks5://127.0.0.1:21005'
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const BASE = 'https://opencode.ai/inference'
const agent = new ProxyAgent({ uri: EXIT, pipelining: 0, headersTimeout: 20_000, bodyTimeout: 0 })

const STUB = {
  bash: { type: 'function', function: { name: 'bash', description: 'Reserved for the host runtime; do not call it.', parameters: { type: 'object', properties: {} } } },
  glob: { type: 'function', function: { name: 'glob', description: 'Reserved for the host runtime; do not call it.', parameters: { type: 'object', properties: {} } } },
  grep: { type: 'function', function: { name: 'grep', description: 'Reserved for the host runtime; do not call it.', parameters: { type: 'object', properties: {} } } },
  read: { type: 'function', function: { name: 'read', description: 'Reserved for the host runtime; do not call it.', parameters: { type: 'object', properties: {} } } },
}

function official() {
  return (['bash', 'glob', 'grep', 'read']).map((n) => ({ type: 'function', function: { name: n, description: GATE_TOOL_FUNCTIONS[n].description, parameters: structuredClone(GATE_TOOL_FUNCTIONS[n].parameters) } }))
}

async function send(label, body) {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hi' }])
  const d = disguiseHeaders(ids, 'chat')
  try {
    const res = await request(`${BASE}/v1/chat/completions`, {
      dispatcher: agent,
      method: 'POST',
      headers: {
        authorization: 'Bearer public',
        'content-type': 'application/json',
        'user-agent': d['user-agent'],
        'x-opencode-client': d['x-opencode-client'],
        'x-opencode-project': d['x-opencode-project'],
        'x-opencode-request': d['x-opencode-request'],
        'x-opencode-session': d['x-opencode-session'],
        accept: '*/*',
      },
      body: JSON.stringify(body),
      headersTimeout: 30_000,
      bodyTimeout: 0,
    })
    let hint = ''
    if (res.statusCode !== 200) {
      try { hint = (await res.body.text()).slice(0, 120) } catch { /* ignore */ }
    } else {
      for await (const c of res.body) { hint = String(c).slice(0, 60); break }
      res.body.destroy()
    }
    console.log(label.padEnd(34), res.statusCode, `(${JSON.stringify(body).length}B)`, hint.replace(/\n/g, ' ').slice(0, 100))
  } catch (err) {
    console.log(label.padEnd(34), 'ERR', err.message)
  }
}

const smallMsgs = [{ role: 'user', content: 'Reply with exactly: ok' }]
const bigMsgs = [{ role: 'user', content: 'Here is a long conversation context. ' + 'lorem ipsum dolor sit amet '.repeat(400) + '\nReply with exactly: ok' }]
// A realistic agent-shaped body: many turns including assistant tool_calls + tool results
const agentMsgs = [
  { role: 'user', content: 'Read the config file and summarize it.' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"/etc/app/config.json"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ lines: 'x'.repeat(600) }) },
  { role: 'assistant', content: 'The config has ' + 'detail '.repeat(300) },
  { role: 'user', content: 'Reply with exactly: ok' },
]

await send('A official-tools small', { model: MODEL, max_tokens: 16, messages: smallMsgs, tools: official(), tool_choice: 'auto', stream: true, stream_options: { include_usage: true } })
await send('B stub-tools small', { model: MODEL, max_tokens: 16, messages: smallMsgs, tools: Object.values(STUB), tool_choice: 'auto', stream: true, stream_options: { include_usage: true } })
await send('C no-tools small', { model: MODEL, max_tokens: 16, messages: smallMsgs, stream: true, stream_options: { include_usage: true } })
await send('D official-tools big-msg', { model: MODEL, max_tokens: 16, messages: bigMsgs, tools: official(), tool_choice: 'auto', stream: true, stream_options: { include_usage: true } })
await send('E official-tools agent-msgs', { model: MODEL, max_tokens: 16, messages: agentMsgs, tools: official(), tool_choice: 'auto', stream: true, stream_options: { include_usage: true } })
await send('F official + 2 caller tools', { model: MODEL, max_tokens: 16, messages: smallMsgs, tools: [...official(), { type: 'function', function: { name: 'edit', description: 'Edit a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }], tool_choice: 'auto', stream: true, stream_options: { include_usage: true } })
await agent.close()
