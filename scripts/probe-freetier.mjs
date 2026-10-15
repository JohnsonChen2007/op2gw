// Controlled live probe: identical CLI-shaped requests, one exit, both endpoints.
import { request, ProxyAgent } from 'undici'
import { deriveRequestIDs, disguiseHeaders } from '../dist/core/ids.js'
import { ensureChatFreeLaneShape } from '../dist/core/freelane.js'

const EXIT = process.env.PROBE_EXIT ?? 'socks5://127.0.0.1:21005'
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const N = Number(process.env.PROBE_N ?? 6)

const agent = new ProxyAgent({ uri: EXIT, pipelining: 0, headersTimeout: 20_000, bodyTimeout: 0 })

async function send(baseUrl) {
  const body0 = {
    model: MODEL,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    stream: true,
  }
  const { body } = ensureChatFreeLaneShape(body0)
  const ids = deriveRequestIDs([{ role: 'user', content: 'Reply with exactly: ok' }])
  const d = disguiseHeaders(ids, 'chat')
  const res = await request(`${baseUrl}/v1/chat/completions`, {
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
    try { hint = (await res.body.text()).slice(0, 160) } catch { /* ignore */ }
  } else {
    // read just the first chunk then destroy
    for await (const c of res.body) { hint = String(c).slice(0, 80); break }
    res.body.destroy()
  }
  return { status: res.statusCode, hint }
}

for (const base of ['https://opencode.ai/inference', 'https://opencode.ai/zen']) {
  const results = []
  for (let i = 0; i < N; i++) {
    try {
      const r = await send(base)
      results.push(r.status)
      console.log(base.replace('https://opencode.ai', ''), `#${i + 1}`, r.status, r.hint.replace(/\n/g, ' ').slice(0, 120))
    } catch (err) {
      results.push('ERR')
      console.log(base.replace('https://opencode.ai', ''), `#${i + 1}`, 'ERR', err.message)
    }
  }
  console.log(base, '=>', results.join(','), '\n')
}
await agent.close()
