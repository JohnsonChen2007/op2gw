// Variant probe #2: field-level differences that might trip the anonymous lane.
import { request, ProxyAgent } from 'undici'
import { deriveRequestIDs, disguiseHeaders } from '../dist/core/ids.js'
import { ensureChatFreeLaneShape } from '../dist/core/freelane.js'

const EXIT = process.env.PROBE_EXIT ?? 'socks5://127.0.0.1:21005'
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const BASE = 'https://opencode.ai/inference'
const agent = new ProxyAgent({ uri: EXIT, pipelining: 0, headersTimeout: 20_000, bodyTimeout: 0 })

async function send(label, extra) {
  const base = { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: ok' }], stream: true }
  const { body } = ensureChatFreeLaneShape({ ...base, ...extra })
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
      try { hint = (await res.body.text()).slice(0, 110) } catch { /* ignore */ }
    } else {
      for await (const c of res.body) { hint = String(c).slice(0, 40); break }
      res.body.destroy()
    }
    console.log(label.padEnd(40), res.statusCode, hint.replace(/\n/g, ' ').slice(0, 100))
  } catch (err) {
    console.log(label.padEnd(40), 'ERR', err.message)
  }
}

await send('baseline max_tokens=16', {})
await send('max_tokens=4096', { max_tokens: 4096 })
await send('max_tokens=16384', { max_tokens: 16384 })
await send('max_tokens=32768', { max_tokens: 32768 })
await send('no max_tokens', { max_tokens: undefined })
await send('max_completion_tokens', { max_completion_tokens: 4096 })
await send('temperature=0.7', { temperature: 0.7 })
await send('top_p=0.9', { top_p: 0.9 })
await send('system msg', { messages: [{ role: 'system', content: 'You are a helpful assistant. ' + 'Be terse. '.repeat(50) }, { role: 'user', content: 'Reply with exactly: ok' }] })
await send('developer role msg', { messages: [{ role: 'developer', content: 'Be terse.' }, { role: 'user', content: 'Reply with exactly: ok' }] })
await send('reasoning effort field', { reasoning_effort: 'low' })
await send('parallel_tool_calls', { parallel_tool_calls: true })
await send('response_format json', { response_format: { type: 'json_object' } })
await send('user field', { user: 'pi-anon-123' })
await send('stream=false wire', { stream: false })
await agent.close()
