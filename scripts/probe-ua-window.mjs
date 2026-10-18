// UA-version window ablation: which opencode/<v> does the lane accept today?
import { request, ProxyAgent } from 'undici'
import { deriveRequestIDs, disguiseHeaders } from '../dist/core/ids.js'
import { ensureChatFreeLaneShape } from '../dist/core/freelane.js'

const EXIT = process.env.PROBE_EXIT ?? 'http://127.0.0.1:10808'
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const BASE = 'https://opencode.ai/inference'
const agent = new ProxyAgent({ uri: EXIT, pipelining: 0, headersTimeout: 20_000, bodyTimeout: 0 })

const d0 = disguiseHeaders(deriveRequestIDs([{ role: 'user', content: 'hi' }]), 'chat')

async function send(label, ua) {
  const body0 = {
    model: MODEL,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    stream: true,
  }
  const { body } = ensureChatFreeLaneShape(body0)
  const ids = deriveRequestIDs([{ role: 'user', content: 'Reply with exactly: ok' }])
  const d = disguiseHeaders(ids, 'chat')
  try {
    const res = await request(`${BASE}/v1/chat/completions`, {
      dispatcher: agent,
      method: 'POST',
      headers: {
        authorization: 'Bearer public',
        'content-type': 'application/json',
        'user-agent': ua,
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
      for await (const c of res.body) { hint = String(c).slice(0, 50); break }
      res.body.destroy()
    }
    console.log(label.padEnd(28), res.statusCode, hint.replace(/\n/g, ' ').slice(0, 100))
  } catch (err) {
    console.log(label.padEnd(28), 'ERR', err.message)
  }
}

const suffix = 'ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const versions = ['1.17.9', '1.18.18', '1.18.30', '1.19.0', '1.19.3', '1.20.0']
for (const v of versions) await send(`opencode/${v}`, `opencode/${v} ${suffix}`)
// control: bare UA without suffix
await send('bare opencode/1.19.3', 'opencode/1.19.3')
await agent.close()
