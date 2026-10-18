// Path ablation: /inference/v1 vs /inference/openai/v1, anonymous 'public'.
import { request, ProxyAgent } from 'undici'
import { deriveRequestIDs, disguiseHeaders } from '../dist/core/ids.js'
import { ensureChatFreeLaneShape } from '../dist/core/freelane.js'

const EXITS = (process.env.PROBE_EXITS ?? 'http://127.0.0.1:10808,socks5://127.0.0.1:21001,socks5://127.0.0.1:21002').split(',')
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const PATHS = process.env.PROBE_PATHS ?? '/inference/v1/chat/completions,/inference/openai/v1/chat/completions'

const d = disguiseHeaders(deriveRequestIDs([{ role: 'user', content: 'hi' }]), 'chat')
const headers = {
  authorization: 'Bearer public',
  'content-type': 'application/json',
  'user-agent': d['user-agent'],
  'x-opencode-client': d['x-opencode-client'],
  'x-opencode-project': d['x-opencode-project'],
  'x-opencode-request': d['x-opencode-request'],
  'x-opencode-session': d['x-opencode-session'],
  accept: '*/*',
}

async function send(agent, path) {
  const body0 = { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: ok' }], stream: true }
  const { body } = ensureChatFreeLaneShape(body0)
  const res = await request(`https://opencode.ai${path}`, {
    dispatcher: agent,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    headersTimeout: 30_000,
    bodyTimeout: 0,
  })
  let hint = ''
  if (res.statusCode !== 200) hint = (await res.body.text()).slice(0, 140)
  else { for await (const c of res.body) { hint = String(c).slice(0, 60); break } res.body.destroy() }
  return { status: res.statusCode, hint }
}

for (const exit of EXITS) {
  const agent = new ProxyAgent({ uri: exit.trim(), pipelining: 0, headersTimeout: 20_000, bodyTimeout: 0 })
  for (const path of PATHS.split(',')) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await send(agent, path.trim())
        console.log(exit.split('//')[1].padEnd(18), path.trim().replace('/chat/completions', ''), r.status, r.hint.replace(/\n/g, ' ').slice(0, 110))
      } catch (e) {
        console.log(exit.split('//')[1].padEnd(18), path.trim().replace('/chat/completions', ''), 'ERR', e.message.slice(0, 60))
      }
    }
  }
  await agent.close()
}
