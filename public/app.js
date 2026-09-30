'use strict'
/* op2gw debug console — vanilla JS, no build step. Talks to /admin/* and /v1/*. */

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

// Bearer key used for both admin + v1 when the gateway requires auth. The UI
// reads it from localStorage so a keyed deployment still works from the panel.
function authHeaders() {
  const key = localStorage.getItem('op2gw_key') || ''
  return key ? { authorization: 'Bearer ' + key } : {}
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(options.headers || {}) },
  })
  if (res.status === 401) {
    const key = prompt('网关需要密钥，请输入 API key：')
    if (key) {
      localStorage.setItem('op2gw_key', key)
      return api(path, options)
    }
  }
  return res
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  const h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm'
}

function fmtTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

// --- Tabs ---
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'))
    $$('.panel').forEach((p) => p.classList.remove('active'))
    tab.classList.add('active')
    $('#tab-' + tab.dataset.tab).classList.add('active')
    if (tab.dataset.tab === 'models') loadModels()
    if (tab.dataset.tab === 'pool') loadStatus()
    if (tab.dataset.tab === 'traces') loadTraces()
    if (tab.dataset.tab === 'playground') loadModelOptions()
    if (tab.dataset.tab === 'settings') {
      refreshPoolHealth().then(loadSettings)
    }
  })
})

// --- Status / Overview ---
async function loadStatus() {
  try {
    const res = await api('/admin/status')
    const s = await res.json()
    $('#chipHealth').textContent = '● 在线'
    $('#chipHealth').className = 'chip good'
    $('#chipPool').textContent = s.pool.enabled ? 'IP池 开' : 'IP池 关(直连)'
    $('#chipPool').className = 'chip ' + (s.pool.enabled ? 'good' : '')
    $('#chipModels').textContent = '模型 ' + s.catalog.exposed + '/' + s.catalog.total
    $('#chipModels').className = 'chip ' + (s.catalog.status === 'ready' ? 'good' : 'warn')
    $('#chipUptime').textContent = '运行 ' + fmtDuration(s.uptimeMs)
    const proxyChip = $('#chipProxy')
    if (proxyChip) {
      proxyChip.textContent = s.proxy ? '代理 ' + s.proxy.replace(/^https?:\/\//, '').replace(/^socks5:\/\//, 's5:') : '直连'
      proxyChip.className = 'chip ' + (s.proxy ? 'good' : '')
    }

    $('#ovVersion').textContent = s.version
    $('#ovUptime').textContent = fmtDuration(s.uptimeMs)
    $('#ovCatalog').textContent = s.catalog.status
    $('#ovExposed').textContent = s.catalog.exposed + ' / ' + s.catalog.total
    $('#ovPool').textContent = s.pool.enabled ? '启用' : '直连'
    $('#ovExits').textContent = s.pool.total
    $('#ovError').textContent = JSON.stringify(s.catalog, null, 2)

    $('#baseUrlBox').textContent =
      'base_url = ' + location.origin + '/v1\n' + 'api_key  = (留空，或配置的网关密钥)'

    renderExits(s.pool.exits || [])
    renderSources(s.pool.sources || [])
  } catch (err) {
    $('#chipHealth').textContent = '● 离线'
    $('#chipHealth').className = 'chip bad'
  }
}

// --- Models ---
async function loadModels() {
  const res = await api('/admin/models')
  const data = await res.json()
  const filter = ($('#modelFilter').value || '').toLowerCase()
  const rows = (data.models || [])
    .filter((m) => m.id.toLowerCase().includes(filter))
    .map((m) => {
      const ctx = m.limits && m.limits.contextWindow ? m.limits.contextWindow.toLocaleString() : '—'
      const out = m.limits && m.limits.maxOutput ? m.limits.maxOutput.toLocaleString() : '—'
      const reason = m.reasoning && m.reasoning.reasoning ? (m.reasoning.effortValues.join(',') || 'yes') : '—'
      return `<tr><td>${m.id}</td><td>${m.decision.source}</td><td>${ctx}</td><td>${out}</td><td>${reason}</td></tr>`
    })
    .join('')
  $('#modelRows').innerHTML = rows || '<tr><td colspan="5" class="muted">无</td></tr>'
}

// --- Pool ---
function renderExits(exits) {
  const rows = exits
    .map((e) => {
      let stateCls = e.state
      let stateText = e.state
      if (e.cooling) {
        stateCls = 'cooling'
        stateText = 'cooling ' + fmtDuration(e.cooldownRemainingMs)
      }
      const del = e.id === 'direct' ? '' : `<button class="btn danger" data-del="${escapeAttr(e.id)}">删除</button>`
      const pin = e.id === 'direct' ? '' : `<button class="btn" data-pin="${escapeAttr(e.id)}">${e.pinned ? '已固定' : '固定'}</button>`
      return `<tr>
        <td>${escapeHtml(maskUri(e.id))}</td><td>${e.kind}</td><td>${e.source}</td>
        <td>${e.exitIP || '—'}</td>
        <td><span class="state ${stateCls}">${stateText}</span></td>
        <td>${e.latencyMs ? e.latencyMs + 'ms' : '—'}</td>
        <td>${pin} ${del}</td></tr>`
    })
    .join('')
  $('#exitRows').innerHTML = rows || '<tr><td colspan="7" class="muted">无</td></tr>'
  $$('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api('/admin/pool/exits', { method: 'DELETE', body: JSON.stringify({ id: b.dataset.del }) })
      loadStatus()
    }),
  )
  $$('[data-pin]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api('/admin/pool/pin', { method: 'POST', body: JSON.stringify({ id: b.dataset.pin }) })
      loadStatus()
    }),
  )
}

function renderSources(sources) {
  const rows = sources
    .map(
      (s) =>
        `<tr><td>${s.url}</td><td>${s.yielded}</td><td>${s.consecutiveFailures}</td><td>${s.lastError || '—'}</td></tr>`,
    )
    .join('')
  $('#sourceRows').innerHTML = rows || '<tr><td colspan="4" class="muted">未配置免费源</td></tr>'
}

// --- Traces ---
async function loadTraces() {
  const res = await api('/admin/traces?limit=200')
  const data = await res.json()
  const rows = (data.traces || [])
    .slice()
    .reverse()
    .map((t) => {
      const cls = t.outcome === 'ok' ? 'good' : 'bad'
      return `<tr>
        <td>${fmtTime(t.ts)}</td><td>${t.model}</td><td>${t.stream ? '是' : '否'}</td>
        <td>${t.status}</td><td>${t.exit || '—'}${t.exitIP ? ' (' + t.exitIP + ')' : ''}</td>
        <td>${t.attempts}</td><td>${t.durationMs}ms</td>
        <td><span class="state ${cls === 'good' ? 'ok' : 'dead'}">${t.outcome}</span></td></tr>`
    })
    .join('')
  $('#traceRows').innerHTML = rows || '<tr><td colspan="8" class="muted">暂无请求</td></tr>'
}

// --- Logs (SSE) ---
let logStream = null
function startLogStream() {
  if (logStream) logStream.close()
  const key = localStorage.getItem('op2gw_key') || ''
  const url = '/admin/logs/stream' + (key ? '?key=' + encodeURIComponent(key) : '')
  logStream = new EventSource(url)
  logStream.onmessage = (ev) => {
    try {
      appendLog(JSON.parse(ev.data))
    } catch {}
  }
  logStream.onerror = () => {
    /* browser auto-reconnects */
  }
}
function appendLog(r) {
  const view = $('#logView')
  const line = document.createElement('div')
  line.className = 'logline'
  const data = r.data ? ' ' + JSON.stringify(r.data) : ''
  line.innerHTML = `<span class="lv ${r.level}">${r.level.toUpperCase()}</span> <span class="muted">${fmtTime(r.ts)}</span> <span class="sc">[${r.scope}]</span> ${escapeHtml(r.msg)}${escapeHtml(data)}`
  view.appendChild(line)
  while (view.childNodes.length > 1000) view.removeChild(view.firstChild)
  if ($('#logFollow').checked) view.scrollTop = view.scrollHeight
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// --- Playground ---
async function loadModelOptions() {
  const res = await api('/v1/models')
  const data = await res.json()
  const sel = $('#pgModel')
  const current = sel.value
  sel.innerHTML = (data.data || []).map((m) => `<option value="${m.id}">${m.id}</option>`).join('')
  if (current) sel.value = current
}

async function sendPlayground() {
  const model = $('#pgModel').value
  const api_ = $('#pgApi').value
  const stream = $('#pgStream').checked
  const system = $('#pgSystem').value.trim()
  const user = $('#pgUser').value
  const out = $('#pgOut')
  out.textContent = ''
  $('#pgMsg').textContent = '发送中…'

  let path, body
  if (api_ === 'responses') {
    path = '/v1/responses'
    body = { model, input: user, stream }
  } else {
    path = '/v1/chat/completions'
    const messages = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: user })
    body = { model, messages, stream }
  }

  const started = Date.now()
  try {
    const res = await api(path, { method: 'POST', body: JSON.stringify(body) })
    if (!res.ok) {
      out.textContent = await res.text()
      $('#pgMsg').textContent = 'HTTP ' + res.status + ' · ' + (Date.now() - started) + 'ms'
      return
    }
    if (stream && res.body) {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = '',
        acc = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() || ''
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const obj = JSON.parse(data)
            const delta = obj.choices && obj.choices[0] && obj.choices[0].delta
            if (delta && typeof delta.content === 'string') acc += delta.content
            const rdelta = delta && delta.reasoning_content
            if (typeof rdelta === 'string') acc += rdelta
          } catch {}
          out.textContent = acc
        }
      }
      $('#pgMsg').textContent = '完成 · ' + (Date.now() - started) + 'ms'
    } else {
      const json = await res.json()
      const content =
        json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : null
      out.textContent = content ? content + '\n\n---\n' + JSON.stringify(json, null, 2) : JSON.stringify(json, null, 2)
      $('#pgMsg').textContent = '完成 · ' + (Date.now() - started) + 'ms'
    }
  } catch (err) {
    out.textContent = String(err)
    $('#pgMsg').textContent = '错误'
  }
}

// --- Button wiring ---
$('#btnRefreshCatalog').addEventListener('click', async () => {
  $('#ovMsg').textContent = '刷新中…'
  await api('/admin/catalog/refresh', { method: 'POST' })
  $('#ovMsg').textContent = '目录已刷新'
  loadStatus()
})
$('#btnRefreshPool').addEventListener('click', async () => {
  $('#ovMsg').textContent = '刷新中…'
  await api('/admin/pool/refresh', { method: 'POST' })
  $('#ovMsg').textContent = 'IP 池已刷新'
  loadStatus()
})
$('#btnReloadModels').addEventListener('click', loadModels)
$('#modelFilter').addEventListener('input', loadModels)
$('#btnAddExit').addEventListener('click', async () => {
  const scheme = $('#exitScheme').value
  const host = $('#exitHost').value.trim()
  const port = $('#exitPort').value.trim()
  const user = $('#exitUser').value.trim()
  const pass = $('#exitPass').value
  const msg = $('#poolMsg')
  if (!host) {
    msg.textContent = '✗ 请填写主机 / IP'
    return
  }
  if (!/^\d{2,5}$/.test(port) || +port < 1 || +port > 65535) {
    msg.textContent = '✗ 端口必须是 1-65535 的数字'
    return
  }
  // Structured submit: the server assembles + validates the URI (and
  // percent-encodes credentials), so special chars in passwords stay correct.
  const res = await api('/admin/pool/exits', {
    method: 'POST',
    body: JSON.stringify({ scheme, host, port: Number(port), username: user, password: pass }),
  })
  const data = await res.json()
  if (data.ok) {
    msg.textContent = '已添加 ' + maskUri(data.id)
    $('#exitHost').value = ''
    $('#exitPort').value = ''
    $('#exitUser').value = ''
    $('#exitPass').value = ''
    updateExitPreview()
  } else {
    msg.textContent = '✗ ' + (data.error || '失败')
  }
  loadStatus()
})

// Paste a full URI (with optional user:pass) and fill the form from it.
$('#btnParseExitUri').addEventListener('click', () => {
  const raw = $('#exitUri').value.trim()
  const msg = $('#poolMsg')
  if (!raw) return
  const m = /^(https?|socks5h?):\/\/(?:([^@/:?#]*)(?::([^@/?#]*))?@)?([^:/?#]+)(?::(\d{2,5}))?(?:[/?#].*)?$/i.exec(raw)
  if (!m) {
    msg.textContent = '✗ 无法解析，请检查 URI 格式'
    return
  }
  const decode = (v) => {
    try {
      return decodeURIComponent(v)
    } catch {
      return v
    }
  }
  $('#exitScheme').value = m[1].toLowerCase() === 'socks5h' ? 'socks5' : m[1].toLowerCase()
  $('#exitUser').value = m[2] !== undefined ? decode(m[2]) : ''
  $('#exitPass').value = m[3] !== undefined ? decode(m[3]) : ''
  $('#exitHost').value = m[4]
  $('#exitPort').value = m[5] || ''
  $('#exitUri').value = ''
  updateExitPreview()
  msg.textContent = '已填充到表单，确认后点「添加」'
})

$('#exitShowPass').addEventListener('change', () => {
  $('#exitPass').type = $('#exitShowPass').checked ? 'text' : 'password'
})

// Live preview of the URI that will be built from the form fields.
function buildExitUriDraft() {
  const scheme = $('#exitScheme').value
  const host = $('#exitHost').value.trim()
  const port = $('#exitPort').value.trim()
  const user = $('#exitUser').value.trim()
  const pass = $('#exitPass').value
  const auth = user ? user + (pass ? ':' + encodeURIComponent(pass) : '') + '@' : pass ? ':' + encodeURIComponent(pass) + '@' : ''
  if (!host || !port) return ''
  return `${scheme}://${auth}${host}:${port}`
}

function updateExitPreview() {
  const uri = buildExitUriDraft()
  $('#exitPreview').textContent = uri
    ? '预览：' + maskUri(uri)
    : '填写后自动预览。加密机场节点（vmess/vless 等）需外部 sing-box，超出内置拨号范围。凭据仅保存在本机配置文件中。'
}

;['exitScheme', 'exitHost', 'exitPort', 'exitUser'].forEach((id) =>
  $('#' + id).addEventListener('input', updateExitPreview),
)
$('#exitPass').addEventListener('input', updateExitPreview)

function maskUri(uri) {
  try {
    const u = new URL(uri)
    if (u.username || u.password) {
      u.username = u.username ? '***' : ''
      u.password = u.password ? '***' : ''
    }
    return u.toString()
  } catch {
    return uri.replace(/\/\/([^@/]+)@/, '//$1***@')
  }
}
$('#btnReloadTraces').addEventListener('click', loadTraces)
$('#btnSetLevel').addEventListener('click', async () => {
  await api('/admin/log-level', { method: 'POST', body: JSON.stringify({ level: $('#logLevel').value }) })
})
$('#btnClearLogs').addEventListener('click', () => ($('#logView').innerHTML = ''))
$('#btnSend').addEventListener('click', sendPlayground)

// --- Settings ---
async function loadSettings() {
  const res = await api('/admin/settings')
  const s = await res.json()
  $('#setHost').value = s.host || ''
  $('#setPort').value = s.port || ''
  $('#setRefresh').value = s.refreshSeconds || ''
  $('#setProxy').value = s.proxy || ''
  $('#setLogLevel').value = s.logLevel || 'info'
  $('#setPoolHint').textContent = s.poolEnabled ? '已启用（出口轮换）' : '未启用（直连 / 单一代理）'
  $('#setApiKeys').value = ''
  $('#setApiKeys').placeholder = s.hasApiKeys ? '已设置（留空则不改动）' : 'key1,key2（留空为开放）'
  $('#envProxyHint').textContent = s.envProxyDetected
    ? '系统检测到代理：' + s.envProxyDetected
    : '未在环境变量中检测到代理'
  $('#setPath').textContent = '配置文件：' + (s.configPath || '')
  renderPoolTable(s)
}

// --- Settings: proxy pool card ---
let poolHealth = new Map()

async function refreshPoolHealth() {
  try {
    const res = await api('/admin/status')
    const s = await res.json()
    poolHealth = new Map((s.pool.exits || []).map((e) => [e.id, e]))
  } catch {}
}

function renderPoolTable(s) {
  const rows = s.proxyPool || []
  const tbody = $('#poolRows')
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">代理池为空，在下方添加第一个代理</td></tr>'
    $('#poolHint').textContent = ''
    return
  }
  tbody.innerHTML = rows
    .map((uri) => {
      const isDefault = uri === s.proxy
      const h = poolHealth.get(uri)
      const state = h
        ? `<span class="state ${h.cooling ? 'cooling' : h.state}">${h.cooling ? 'cooling' : h.state}</span>${h.exitIP ? ' <span class="muted small">' + h.exitIP + '</span>' : ''}`
        : '<span class="muted small">—</span>'
      const latency = h && h.latencyMs ? h.latencyMs + 'ms' : '—'
      const defaultBtn = isDefault
        ? '<span class="muted small">★ 当前默认</span>'
        : `<button class="btn" data-def="${escapeAttr(uri)}">设为默认</button>`
      return `<tr${isDefault ? ' class="row-default"' : ''}>
        <td>${escapeHtml(maskUri(uri))}${isDefault ? ' <span class="state ok">default</span>' : ''}</td>
        <td>${state}</td><td>${latency}</td>
        <td>${defaultBtn} <button class="btn danger" data-pdel="${escapeAttr(uri)}">删除</button></td></tr>`
    })
    .join('')
  $('#poolHint').textContent = '默认代理：' + (s.proxy ? maskUri(s.proxy) : '直连') +
    (rows.length === 1 ? ' · 池内共 1 个代理' : ` · 池内共 ${rows.length} 个代理`)
  $$('[data-def]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await api('/admin/settings/default-proxy', { method: 'POST', body: JSON.stringify({ uri: b.dataset.def }) })
      const data = await res.json()
      $('#poolMsg').textContent = data.ok ? '✓ 已设为默认代理' : '✗ ' + (data.error || '失败')
      loadSettings()
    }),
  )
  $$('[data-pdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await api('/admin/settings')
      const s2 = await res.json()
      const next = (s2.proxyPool || []).filter((u) => u !== b.dataset.pdel)
      const put = await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ proxyPool: next }) })
      const data = await put.json()
      $('#poolMsg').textContent = data.ok ? '✓ 已删除' : '✗ ' + (data.error || '失败')
      loadSettings()
    }),
  )
}

$('#btnAddPoolProxy').addEventListener('click', async () => {
  const scheme = $('#poolScheme').value
  const host = $('#poolHost').value.trim()
  if (!host) {
    $('#poolMsg').textContent = '请填写 host:port'
    return
  }
  const user = $('#poolUser').value.trim()
  const pass = $('#poolPass').value
  const auth = user ? encodeURIComponent(user) + (pass ? ':' + encodeURIComponent(pass) : '') + '@' : ''
  const uri = `${scheme}://${auth}${host}`
  const res = await api('/admin/settings')
  const s = await res.json()
  const pool = s.proxyPool || []
  if (pool.includes(uri)) {
    $('#poolMsg').textContent = '该代理已在池中'
    return
  }
  const payload = { proxyPool: [...pool, uri] }
  if ($('#poolMakeDefault').checked) payload.proxy = uri
  const put = await api('/admin/settings', { method: 'PUT', body: JSON.stringify(payload) })
  const data = await put.json()
  if (data.ok) {
    $('#poolMsg').textContent = '✓ 已添加' + ($('#poolMakeDefault').checked ? '并设为默认' : '')
    $('#poolHost').value = ''
    $('#poolUser').value = ''
    $('#poolPass').value = ''
    $('#poolMakeDefault').checked = false
    loadStatus()
  } else {
    $('#poolMsg').textContent = '✗ ' + (data.error || '失败')
  }
  loadSettings()
})

$('#btnUseEnvProxy').addEventListener('click', async () => {
  const res = await api('/admin/settings')
  const s = await res.json()
  if (s.envProxyDetected) $('#setProxy').value = s.envProxyDetected
  else $('#setMsg').textContent = '未检测到系统代理'
})
$('#btnClearProxy').addEventListener('click', () => ($('#setProxy').value = ''))
$('#btnTestProxy').addEventListener('click', async () => {
  const out = $('#proxyTestOut')
  out.style.display = 'block'
  out.textContent = '测试中…（保存代理后经它拉取模型列表）'
  // Apply session-only, then hit /v1/models to verify egress works.
  const proxy = $('#setProxy').value.trim()
  await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ proxy, persist: false }) })
  const started = Date.now()
  try {
    const r = await api('/v1/models')
    const j = await r.json()
    out.textContent = `✓ 通过 · ${Date.now() - started}ms · 模型 ${((j.data) || []).length} 个` + (proxy ? `\n出口代理：${proxy}` : '\n直连')
  } catch (e) {
    out.textContent = '✗ 失败：' + String(e)
  }
})

$('#btnSaveSettings').addEventListener('click', async () => {
  $('#setMsg').textContent = '保存中…'
  const payload = {
    host: $('#setHost').value.trim(),
    port: Number($('#setPort').value) || undefined,
    refreshSeconds: Number($('#setRefresh').value) || undefined,
    proxy: $('#setProxy').value.trim(),
    logLevel: $('#setLogLevel').value,
  }
  const keys = $('#setApiKeys').value.trim()
  if (keys) payload.apiKeys = keys.split(',').map((k) => k.trim()).filter(Boolean)
  const res = await api('/admin/settings', { method: 'PUT', body: JSON.stringify(payload) })
  const data = await res.json()
  if (data.ok) {
    let msg = '✓ 已保存'
    if (data.notes && data.notes.length) msg += ' · ' + data.notes.join('；')
    $('#setMsg').textContent = msg
    loadStatus()
    loadSettings()
  } else {
    $('#setMsg').textContent = '✗ ' + (data.error || '失败')
  }
})

// --- Boot ---
loadStatus()
startLogStream()
setInterval(loadStatus, 5000)
