#!/usr/bin/env node
/**
 * op2gw client model-config sync.
 *
 * The gateway already knows the truth: its exposed catalog is "every upstream
 * in-sale model that is free" (src/catalog/catalog.ts). What goes stale is the
 * copy of that list pasted into each local agent's config — models get delisted
 * (space-bunny-free) or added (minimax-m3.1-flash-free) upstream and every
 * client keeps advertising the old set until someone edits 15 files by hand.
 *
 * This script closes that gap. For each known client it renders the models
 * block from GET /v1/models and compares the result with what is on disk:
 *
 *   node scripts/sync-clients.mjs            # report drift only (default)
 *   node scripts/sync-clients.mjs --apply    # rewrite drifted files (+ backup)
 *   node scripts/sync-clients.mjs --only=opencode,kilo --apply
 *   node scripts/sync-clients.mjs --list     # show registered targets
 *
 * Safety rules, in order of how much they matter:
 *
 *  1. A target that cannot be read/parsed is SKIPPED, never rewritten. A client
 *     whose config this script does not understand must not lose its config.
 *  2. Every rewrite is preceded by a timestamped .bak-op2gwsync copy.
 *  3. Files are written atomically (temp + rename) so a crash mid-write cannot
 *     truncate a config the user is about to launch.
 *  4. Only entries that this script owns are touched: for files that mix
 *     providers, op2gw entries are identified by provider/url/id, and every
 *     other entry is passed through untouched.
 *  5. Rendering is idempotent — a second run with unchanged upstream produces
 *     byte-identical output, so --apply on a clean tree writes nothing.
 *
 * Format handling. JSON/JSONC and TOML are edited by TEXT SURGERY rather than
 * re-serialisation: the models object/sections are located, replaced in place,
 * and every other byte (comments, key order, single-line vs multi-line style,
 * other providers) is preserved. YAML uses the `yaml` Document API, which round
 * trips comments too.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parseDocument } from 'yaml'

const HOME = homedir()
const GW = process.env.OP2GW_GW_URL ?? 'http://127.0.0.1:8787'
const GW_V1 = `${GW}/v1`

// ---------------------------------------------------------------- utilities

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const LIST = args.includes('--list')
const DIFF = args.includes('--diff')
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length)
const onlyIds = ONLY ? ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null

const log = (msg) => console.log(msg)

/** "deepseek-v4.1-flash-free" -> "DeepSeek v4.1 Flash (free)" */
const NAME_OVERRIDES = {
  'beam-free': 'Beam (free)',
  'big-pickle': 'Big Pickle (free)',
  'deepseek-v4.1-flash-free': 'DeepSeek v4.1 Flash (free)',
  'glm-5.3-flash-free': 'GLM 5.3 Flash (free)',
  'longcat-2.5-preview-free': 'LongCat 2.5 Preview (free)',
  'mimo-v2.6-flash-free': 'MiMo v2.6 Flash (free)',
  'minimax-m3.1-flash-free': 'MiniMax M3.1 Flash (free)',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning (free)',
  'nemotron-3.5-super-vl-free': 'Nemotron 3.5 Super VL (free)',
}
const pretty = (id) => NAME_OVERRIDES[id] ?? id
const plainName = (id) => pretty(id).replace(/\s*\(free\)$/, '')
const isVision = (id) => /-vl-|-vision-|-omni-/.test(id)

function readKey() {
  // Credentials deliberately come from the caller environment (normally by
  // sourcing the ignored `.env.op2gw.local` bundle). Never scrape client config
  // files: they should contain only the non-secret placeholder `public`.
  return process.env.OP2GW_API_KEY ?? ''
}

/** Gateway is the single source of truth for the free/ in-sale set. */
async function fetchModels() {
  const key = readKey()
  const res = await fetch(`${GW_V1}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`GET /v1/models -> HTTP ${res.status}`)
  const body = await res.json()
  const models = (body.data ?? []).map((m) => ({
    id: m.id,
    context: Number(m.context_length) || 0,
    output: Number(m.max_output_tokens) || 0,
  }))
  if (models.length === 0) throw new Error('gateway returned an empty model list')
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Cursor's model catalog is delivered by Cursor's own backend, so the gateway
 * can say nothing about it: the local config only caches a selection that goes
 * stale when Cursor retires a model. `--list-models` is the only source of truth.
 */
let cursorCatalogCache
function cursorCatalog() {
  if (cursorCatalogCache !== undefined) return cursorCatalogCache
  const bin = process.env.CURSOR_AGENT_BIN ?? 'cursor-agent'
  const res = spawnSync(bin, ['--list-models'], { encoding: 'utf8', timeout: 20000 })
  const rows = (res.stdout ?? '')
    .split('\n')
    .map((line) => line.match(/^([A-Za-z0-9._-]+) - (.+?)\s*$/))
    .filter(Boolean)
    .map((m) => ({ id: m[1], name: m[2] }))
  cursorCatalogCache = res.status === 0 && rows.length > 0 ? rows : null
  return cursorCatalogCache
}

/**
 * Infer the file's indentation UNIT from its shallowest indented line. Taking
 * the first quoted line instead would return the nesting depth of that key
 * (8 spaces for an array of objects) rather than the 4-space unit.
 */
const indentOf = (text, fallback = 2) => {
  const seen = [...text.matchAll(/^([ \t]+)(?=["{[])/gm)].map((m) => m[1])
  if (seen.length === 0) return ' '.repeat(fallback)
  return seen.reduce((a, b) => (b.length < a.length ? b : a))
}

/**
 * Given the index of an opening bracket, return the index just past its match,
 * skipping strings and (in JSONC) comments. Throws on imbalance so a malformed
 * config is reported instead of半-rewritten.
 */
function matchBracket(text, open, openCh = '{', closeCh = '}') {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++
        else if (text[i] === '"') break
      }
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (c === openCh) depth++
    else if (c === closeCh) {
      depth--
      if (depth === 0) return { end: i + 1, innerStart: open + 1, innerEnd: i }
    }
  }
  throw new Error(`unbalanced ${openCh} at offset ${open}`)
}

/**
 * Locate `"key" : {` inside text[start,end) at nesting depth 0 of that slice and
 * return the bracket span of its value object.
 */
function findChildObject(text, key, from = 0, to = text.length) {
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*\\{`, 'g')
  re.lastIndex = from
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index >= to) return null
    // reject matches nested inside a deeper object: walk backwards counting braces
    let depth = 0
    for (let i = m.index - 1; i >= 0; i--) {
      const c = text[i]
      if (c === '"') {
        for (i--; i >= 0; i--) {
          if (text[i] === '"' && text[i - 1] !== '\\') break
        }
        continue
      }
      if (c === '}') depth++
      else if (c === '{') {
        if (depth === 0) break
        depth--
      }
    }
    const span = matchBracket(text, m.index + m[0].length - 1)
    return { anchor: m.index, ...span }
  }
  return null
}

/**
 * Re-indent a block of generated JSON entries so braces line up with `indent`.
 * `expandNested` mirrors how the target file already writes nested objects:
 * opencode spreads `limit` over several lines, mimocode/kilo keep it inline.
 */
function renderJsonObjectEntries(entries, indent, expandNested = false) {
  const i2 = indent + '  '
  return entries
    .map(([key, body]) => {
      const keys = Object.keys(body)
      const lines = [`${indent}${JSON.stringify(key)}: {`]
      keys.forEach((k, i) => {
        const v = body[k]
        const comma = i === keys.length - 1 ? '' : ','
        const isPlainObject = v !== null && typeof v === 'object' && !Array.isArray(v)
        // Depth-two maps ({"low": {"reasoningEffort": "low"}}) are written one
        // key per line with the leaf objects inline, the way kilo stores them.
        const nested = isPlainObject && Object.values(v).some((x) => x !== null && typeof x === 'object')
        if (isPlainObject && (expandNested || nested)) {
          const vet = Object.entries(v)
          lines.push(`${i2}"${k}": {`)
          vet.forEach(([vk, vv], j) => {
            const tail = j === vet.length - 1 ? '' : ','
            const inline =
              vv !== null && typeof vv === 'object'
                ? `{ ${Object.entries(vv).map(([gk, gv]) => `"${gk}": ${JSON.stringify(gv)}`).join(', ')} }`
                : JSON.stringify(vv)
            lines.push(`${i2}  "${vk}": ${inline}${tail}`)
          })
          lines.push(`${i2}}${comma}`)
        } else if (isPlainObject) {
          const flat = Object.entries(v)
            .map(([vk, vv]) => `"${vk}": ${JSON.stringify(vv)}`)
            .join(', ')
          lines.push(`${i2}"${k}": { ${flat} }${comma}`)
        } else {
          lines.push(
            `${i2}"${k}": ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v)}${comma}`,
          )
        }
      })
      lines.push(`${indent}}`)
      return lines.join('\n')
    })
    .join(',\n')
}

/**
 * Look up a field already set for `id` in the models block, so conventions the
 * user or a previous run established (display names, capability wording) are
 * carried over instead of being re-invented.
 */
function priorField(text, id, field, window = 400) {
  const re = new RegExp(`"${field}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\])`)
  let at = -1
  while ((at = text.indexOf(`"${id}"`, at + 1)) !== -1) {
    const m = text.slice(at, at + window).match(re)
    if (m) {
      try {
        return JSON.parse(m[1].replace(/,\s*\]$/, ']'))
      } catch {
        return null
      }
    }
  }
  return null
}
const priorName = (text, id) => priorField(text, id, 'name')

/**
 * Parse a models map block back into objects. Clients enrich these entries
 * themselves (reasoning variants, thinking levels), so a rewrite has to start
 * from what is already on disk instead of from a hardcoded field list.
 */
function modelsMapOf(block) {
  try {
    return JSON.parse(`{${block}}`)
  } catch {
    return {}
  }
}

/**
 * Replace the inner text of a JSON object found at provider.<name>.models. */function replaceProviderModels(text, provider, buildEntries) {
  const providerBlock = findChildObject(text, 'provider')
  if (!providerBlock) throw new Error('no "provider" object')
  const provBlock = findChildObject(text, provider, providerBlock.innerStart, providerBlock.innerEnd)
  if (!provBlock) throw new Error(`no provider.${provider}`)
  const modelsBlock = findChildObject(text, 'models', provBlock.innerStart, provBlock.innerEnd)
  if (!modelsBlock) throw new Error(`no provider.${provider}.models`)
  const block = text.slice(modelsBlock.innerStart, modelsBlock.innerEnd)
  const indent = indentOf(block, '      ')
  const expandNested = /"\w+"\s*:\s*\{\s*\n/.test(block)
  const inner = `\n${buildEntries(indent, block, { expandNested })}\n${indent.slice(2)}`
  return text.slice(0, modelsBlock.innerStart) + inner + text.slice(modelsBlock.innerEnd)
}

// ------------------------------------------------------------------- TOML

/** Split a TOML document into a header line (possibly empty) + body chunks. */
function tomlSections(text) {
  const lines = text.split('\n')
  const out = []
  let cur = { header: null, lines: [] }
  for (const line of lines) {
    if (/^\s*\[\[?[^\]]+\]\]?\s*$/.test(line)) {
      out.push(cur)
      cur = { header: line.trim(), lines: [] }
    } else {
      cur.lines.push(line)
    }
  }
  out.push(cur)
  return out
}
const tomlRender = (sections) => {
  const parts = []
  for (const s of sections) {
    const body = s.lines.join('\n')
    if (s.header === null) {
      // Only a pre-header block that actually holds content (comments) exists;
      // an empty one must not emit a stray leading newline.
      if (body.trim() !== '') parts.push(body)
      continue
    }
    parts.push(s.header, body)
  }
  return parts.join('\n')
}
const tomlKey = (id) => (/^[A-Za-z0-9_-]+$/.test(id) ? id : JSON.stringify(id))

/** The model to fall back to when a client's default points at a delisted id. */
const preferredId = (models) =>
  models.some((m) => m.id === 'deepseek-v4.1-flash-free') ? 'deepseek-v4.1-flash-free' : models[0].id

/** 1048576 -> 1_048_576, matching the underscore style these configs already use. */
const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_')

/**
 * Drop every owned section and drop in `generated` where the first one stood.
 * All other sections keep their exact position, so other providers stay put.
 * Returns null when the document has no owned section (target not applicable).
 */
function replaceOwnedSections(sections, isOwned, generated) {
  const firstIdx = sections.findIndex(isOwned)
  if (firstIdx === -1) return null
  const before = sections.slice(0, firstIdx)
  const after = sections.slice(firstIdx).filter((s) => !isOwned(s))
  return [...before, ...generated, ...after]
}

/**
 * Split the inner text of a JSON array into raw top-level element slices.
 * Commas are dropped so callers can drop/reorder/insert elements and re-join,
 * keeping every byte of the elements they do not own.
 */
function splitTopLevel(text) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++
        else if (text[i] === '"') break
      }
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out.filter((s) => s.trim() !== '')
}

// -------------------------------------------------------------------- YAML

function yamlEdit(text, mutate) {
  const doc = parseDocument(text)
  mutate(doc)
  return doc.toString()
}

/**
 * Round-tripping the whole document is the cheapest way to touch one YAML block
 * without hand-rolling a sequence parser, but it is only safe when the
 * serialiser reproduces the file it was given. Verify that first and degrade to
 * "no drift" otherwise, so a reflowing file is never rewritten as collateral.
 */
function yamlSurgical(text, mutate, options = {}) {
  const stripTail = (s) => s.replace(/\n+$/, '')
  const tail = text.match(/\n+$/)?.[0] ?? ''
  const doc = parseDocument(text)
  if (stripTail(doc.toString(options)) !== stripTail(text)) return text
  mutate(doc)
  return stripTail(doc.toString(options)) + tail
}

/** Serialise with the file's own indent unit and trailing-newline convention. */
const jsonWrite = (doc, text) =>
  JSON.stringify(doc, null, indentOf(text).length || 2) + (text.endsWith('\n') ? '\n' : '')

// ----------------------------------------------------------------- targets

/**
 * Each target renders the FULL new file text from the old text + gateway models.
 * Returning the input unchanged means "no drift" and guarantees that a target
 * with an unexpected shape degrades to a no-op instead of a corruption.
 */
const targets = [
  // ---- opencode family: provider.<name>.models maps ----------------------
  {
    id: 'opencode',
    file: () => join(HOME, '.config/opencode/opencode.jsonc'),
    render(text, models) {
      let out = replaceProviderModels(text, 'op2gw', (indent, block, style) =>
        renderJsonObjectEntries(
          models.map((m) => {
            const body = {
              name: priorName(block, m.id) ?? pretty(m.id),
              reasoning: true,
              limit: { context: m.context, output: m.output },
            }
            if (isVision(m.id)) body.attachment = true
            return [m.id, body]
          }),
          indent,
          style.expandNested,
        ),
      )
      // The builtin `opencode` provider advertises the same free ids; keep its
      // key set identical but leave it names-only (no limits there today).
      out = replaceProviderModels(out, 'opencode', (indent, block, style) =>
        renderJsonObjectEntries(
          models.map((m) => [m.id, { name: priorName(block, m.id) ?? `${plainName(m.id)} Free` }]),
          indent,
          style.expandNested,
        ),
      )
      return out
    },
  },
  {
    id: 'mimocode',
    file: () => join(HOME, '.config/mimocode/mimocode.jsonc'),
    render(text, models) {
      return replaceProviderModels(text, 'op2gw', (indent, block, style) =>
        renderJsonObjectEntries(
          models.map((m) => {
            const body = {
              name: priorName(block, m.id) ?? pretty(m.id),
              limit: { context: m.context, output: m.output },
              capabilities:
                priorField(block, m.id, 'capabilities') ?? (isVision(m.id) ? ['image', 'tools'] : ['tools']),
            }
            return [m.id, body]
          }),
          indent,
          style.expandNested,
        ),
      )
    },
  },
  {
    id: 'kilo',
    file: () => join(HOME, '.config/kilo/kilo.json'),
    render(text, models) {
      return replaceProviderModels(text, 'op2gw', (indent, block, style) =>
        renderJsonObjectEntries(
          models.map((m) => {
            // kilo writes per-model reasoning variants; restating the entry from
            // scratch would delete them.
            const prior = modelsMapOf(block)[m.id] ?? {}
            const body = {
              ...prior,
              name: prior.name ?? pretty(m.id),
              reasoning: true,
              limit: { context: m.context, output: m.output },
            }
            return [m.id, body]
          }),
          indent,
          style.expandNested,
        ),
      )
    },
  },

  // ---- dedicated full-file model lists ----------------------------------
  {
    id: 'goose-provider',
    file: () => join(HOME, '.config/goose/custom_providers/custom_op2gw.json'),
    render(text, models) {
      const doc = JSON.parse(text)
      doc.models = models.map((m) => ({
        name: m.id,
        context_limit: m.context,
        input_token_cost: 0.0,
        output_token_cost: 0.0,
        currency: null,
        supports_cache_control: null,
        reasoning: true,
      }))
      return (
        JSON.stringify(doc, null, indentOf(text).length || 2)
          // goose writes free costs as 0.0; JSON.stringify would flatten to 0.
          .replace(/"input_token_cost": 0,/g, '"input_token_cost": 0.0,')
          .replace(/"output_token_cost": 0,/g, '"output_token_cost": 0.0,') + '\n'
      )
    },
  },
  {
    id: 'codex-models',
    file: () => join(HOME, '.codex/models-op2gw.json'),
    render(text, models) {
      const doc = JSON.parse(text)
      const prior = new Map((doc.models ?? []).map((m) => [m.slug, m]))
      const template = (doc.models ?? []).find((m) => m.slug) ?? null
      if (!template) return text
      doc.models = models.map((m, i) => {
        const old = prior.get(m.id)
        return {
          ...structuredClone(template),
          slug: m.id,
          display_name: old?.display_name ?? plainName(m.id),
          description: old?.description ?? `op2gw free model (${m.id}) via ${GW}`,
          priority: old?.priority ?? 200 + i,
          context_window: m.context,
          max_context_window: m.context,
        }
      })
      return JSON.stringify(doc, null, indentOf(text).length || 2) + '\n'
    },
  },

  // ---- mixed-provider files: own only the op2gw rows --------------------
  {
    id: 'codex-catalog',
    file: () => join(HOME, '.codex/models.json'),
    render(text, models) {
      const doc = JSON.parse(text)
      if (!Array.isArray(doc.models)) return text
      const owned = doc.models.filter((m) => m.provider === 'op2gw' || m.provider_id === 'op2gw')
      const others = doc.models.filter((m) => !(m.provider === 'op2gw' || m.provider_id === 'op2gw'))
      if (owned.length === 0) return text // never invent entries here
      const template = owned[0]
      const prior = new Map(owned.map((m) => [m.slug, m]))
      const rebuilt = models.map((m, i) => {
        const old = prior.get(m.id)
        return {
          ...structuredClone(template),
          slug: m.id,
          display_name: old?.display_name ?? `${m.id} (op2gw)`,
          description: old?.description ?? `Op2Gw ${m.id} via zen.`,
          priority: old?.priority ?? 210 + i,
          context_window: m.context,
          max_context_window: m.context,
        }
      })
      const at = doc.models.findIndex((m) => m.provider === 'op2gw' || m.provider_id === 'op2gw')
      const merged = [...others.slice(0, at), ...rebuilt, ...others.slice(at)]
      doc.models = merged
      return JSON.stringify(doc, null, indentOf(text).length || 2) + '\n'
    },
  },
  {
    id: 'zed',
    file: () => join(HOME, '.config/zed/settings.json'),
    render(text, models) {
      const ids = new Set(models.map((m) => m.id))
      const at = text.indexOf('"models"')
      const open = at === -1 ? -1 : text.indexOf('[', at)
      if (open === -1) return text
      const span = matchBracket(text, open, '[', ']')
      const innerText = text.slice(span.innerStart, span.innerEnd)
      const trail = innerText.match(/\s*$/)[0] // keeps "]\n" aligned where it was
      const parts = splitTopLevel(innerText.slice(0, innerText.length - trail.length))
      // zed's models array mixes providers; ours are the ones pointing at the gateway.
      const owned = parts.map((p, i) => (/127\.0\.0\.1:8787/.test(p) ? i : -1)).filter((i) => i >= 0)
      if (owned.length === 0) return text
      const priorList = owned.map((i) => JSON.parse(parts[i].trim()))
      const prior = new Map(priorList.map((o) => [o.model, o]))
      const template = priorList[0]
      const indent = (parts[owned[0]].match(/\n([ \t]+)\{/) ?? [, '    '])[1]
      const rendered = models.map((m) => {
        const old = prior.get(m.id)
        const obj = { ...structuredClone(template), name: old?.name ?? `${plainName(m.id)} (op2gw free)`, model: m.id }
        // Only carry this key when it already applies, so untouched entries stay untouched.
        const feats = old?.default_for_features ?? (isVision(m.id) ? template.default_for_features : undefined)
        if (feats) obj.default_for_features = feats
        return `\n${indent}${JSON.stringify(obj, null, 2).replace(/\n/g, `\n${indent}`)}`
      })
      const raw = parts.flatMap((p, i) => (i === owned[0] ? [rendered.join(',')] : owned.includes(i) ? [] : [p]))
      const out = text.slice(0, span.innerStart) + raw.join(',') + trail + text.slice(span.innerEnd)
      // agent_servers defaults can also name a delisted model.
      return out.replace(
        /"model":\s*"(op2gw|opencode)\/([^"]*)"/g,
        (full, prov, id) => (ids.has(id) ? full : `"model": "${prov}/${preferredId(models)}"`),
      )
    },
  },
  {
    id: 'codebuddy',
    file: () => join(HOME, '.codebuddy/models.json'),
    render(text, models) {
      const doc = JSON.parse(text)
      if (!Array.isArray(doc.models)) return text
      const mine = (m) => typeof m?.url === 'string' && m.url.includes('127.0.0.1:8787')
      const first = doc.models.findIndex(mine)
      if (first === -1) return text
      const template = doc.models[first]
      const prior = new Map(doc.models.filter(mine).map((m) => [m.id, m]))
      const rebuilt = models.map((m) => ({
        ...structuredClone(template),
        id: m.id,
        name: prior.get(m.id)?.name ?? `op2gw/${m.id}`,
        maxInputTokens: m.context,
        maxOutputTokens: m.output,
        supportsImages: isVision(m.id),
        supportsReasoning: true,
      }))
      doc.models = [...doc.models.filter((m) => !mine(m)), ...rebuilt]
      return JSON.stringify(doc, null, indentOf(text).length || 2) + '\n'
    },
  },
  {
    id: 'workbuddy',
    file: () => join(HOME, '.workbuddy/models.json'),
    render(text, models) {
      const doc = JSON.parse(text)
      if (!Array.isArray(doc)) return text
      const mine = (m) => typeof m?.url === 'string' && m.url.includes('127.0.0.1:8787')
      const first = doc.findIndex(mine)
      if (first === -1) return text
      const template = doc[first]
      const prior = new Map(doc.filter(mine).map((m) => [m.id, m]))
      const rebuilt = models.map((m) => ({
        ...structuredClone(template),
        id: m.id,
        name: prior.get(m.id)?.name ?? `op2gw/${m.id}`,
        maxInputTokens: m.context,
        maxOutputTokens: m.output,
        supportsImages: isVision(m.id),
        supportsReasoning: true,
      }))
      const merged = [...doc.filter((m) => !mine(m)), ...rebuilt]
      return JSON.stringify(merged, null, indentOf(text).length || 2) + '\n'
    },
  },

  // ---- agent model catalogs: providers.<name>.models ---------------------
  {
    id: 'pi',
    file: () => join(HOME, '.pi/agent/models.json'),
    render(text, models) {
      const doc = JSON.parse(text)
      const prov = doc?.providers?.op2gw
      if (!Array.isArray(prov?.models) || prov.models.length === 0) return text
      // pi stores cost/limits per model, so a new id inherits the shape of an
      // existing entry rather than a hardcoded guess at the field set.
      const template = prov.models[0]
      const prior = new Map(prov.models.map((m) => [m.id, m]))
      prov.models = models.map((m) => {
        // Keep the model's own extras (pi adds thinkingLevelMap per model);
        // only the fields the gateway owns are restated.
        const base = structuredClone(prior.get(m.id) ?? template)
        return {
          ...base,
          id: m.id,
          name: prior.get(m.id)?.name ?? m.id,
          input: isVision(m.id) ? ['text', 'image'] : ['text'],
          contextWindow: m.context,
          maxTokens: m.output,
        }
      })
      return jsonWrite(doc, text)
    },
  },
  {
    id: 'omp',
    file: () => join(HOME, '.omp/agent/models.yml'),
    render(text, models) {
      // omp writes un-indented sequences (- id: at the key's own indent), which
      // is why the round-trip check passes indentSeq:false explicitly.
      return yamlSurgical(
        text,
        (doc) => {
          if (!doc.getIn(['providers', 'op2gw'], true)) return
          const cur = doc.getIn(['providers', 'op2gw', 'models'], true)
          const prior = new Map(((cur?.toJSON?.() ?? cur ?? [])).map((m) => [m.id, m]))
          doc.setIn(
            ['providers', 'op2gw', 'models'],
            models.map((m) => ({
              id: m.id,
              name: prior.get(m.id)?.name ?? m.id,
              reasoning: true,
              input: isVision(m.id) ? ['text', 'image'] : ['text'],
              contextWindow: m.context,
              maxTokens: m.output,
            })),
          )
        },
        { indentSeq: false },
      )
    },
  },
  {
    id: 'minimax',
    file: () => join(HOME, '.minimax/config.yaml'),
    render(text, models) {
      return yamlSurgical(text, (doc) => {
        if (!doc.getIn(['custom_provider', 'op2gw'], true)) return
        const cur = doc.getIn(['custom_provider', 'op2gw', 'models'], true)
        const prior = new Map(Object.entries(cur?.toJSON?.() ?? cur ?? {}))
        const map = {}
        for (const m of models) {
          map[m.id] =
            prior.get(m.id) ?? { reasoning: true, thinking_config: { mode: 'switchable', default_value: 'true' } }
        }
        doc.setIn(['custom_provider', 'op2gw', 'models'], map)
      })
    },
  },
  {
    id: 'zcode',
    file: () => join(HOME, '.zcode/v2/provider_config.json'),
    render(text, models) {
      const doc = JSON.parse(text)
      const cfg = doc?.config
      const rules = cfg?.providerConfigRules?.providerRules
      if (!Array.isArray(rules)) return text
      const rule = rules.find((r) => r?.providerName === 'op2gw')
      if (!rule?.config) return text
      const ids = models.map((m) => m.id)
      // Both lists are owned; only rewrite the ones this file actually carries.
      let touched = false
      for (const key of ['personalModelIds', 'modelOrder']) {
        if (!Array.isArray(rule.config[key])) continue
        rule.config[key] = [...ids]
        touched = true
      }
      if (!touched) return text
      // A delisted default silently breaks the client's first launch.
      const sel = cfg.defaultModelSelection
      if (sel?.providerId === rule.providerId && !ids.includes(sel.modelId)) sel.modelId = preferredId(models)
      return jsonWrite(doc, text)
    },
  },

  // ---- selection-only clients: prune what the vendor has retired ----------
  {
    id: 'cursor',
    file: () => join(HOME, '.cursor/cli-config.json'),
    catalog: () => cursorCatalog(),
    render(text, models) {
      const live = new Set(models.map((m) => m.id))
      if (live.size === 0) return text
      const doc = JSON.parse(text)
      // "default" is a sentinel rather than a catalog id, and cursor-agent
      // writes it back whenever the selection is the default.
      const stale = (id) => typeof id === 'string' && id !== 'default' && !live.has(id)
      let dropped = false
      let touched = false
      // cursor-agent rejects a selection naming an unknown model — "auto" as an
      // explicit modelId is not accepted either — so a retired entry is deleted
      // and the client re-defaults on its next run instead of being redirected.
      for (const field of ['model', 'selectedModel']) {
        if (stale(doc[field]?.modelId)) {
          delete doc[field]
          dropped = touched = true
        }
      }
      if (doc.modelParameters && typeof doc.modelParameters === 'object') {
        for (const id of Object.keys(doc.modelParameters)) {
          if (!stale(id)) continue
          delete doc.modelParameters[id]
          touched = true
        }
      }
      if (Array.isArray(doc.modelSelectionHistory)) {
        const kept = doc.modelSelectionHistory.filter((id) => !stale(id))
        if (kept.length !== doc.modelSelectionHistory.length) {
          if (kept.length > 0) doc.modelSelectionHistory = kept
          else delete doc.modelSelectionHistory
          touched = true
        }
      }
      if (stale(doc.exploreSubagentModel)) {
        doc.exploreSubagentModel = 'default'
        touched = true
      }
      if (dropped) doc.hasChangedDefaultModel = false
      return touched ? jsonWrite(doc, text) : text
    },
  },

  // ---- TOML: one section per model --------------------------------------
  {
    id: 'grok',
    file: () => join(HOME, '.grok/config.toml'),
    render(text, models) {
      const ids = new Set(models.map((m) => m.id))
      const sections = tomlSections(text)
      const owned = new Set([
        'model',
        'model_provider',
        'name',
        'context_window',
        'max_completion_tokens',
        'supports_reasoning_effort',
      ])
      const prior = new Map()
      for (const s of sections) {
        if (!s.header || !/^\[model\./.test(s.header)) continue
        const body = s.lines.join('\n')
        const id = body.match(/^model = "([^"]+)"$/m)?.[1]
        const name = body.match(/^name = "([^"]*)"$/m)?.[1]
        if (!id || !name) continue
        // Keep whatever the generator does not own, plus a curated
        // supports_reasoning_effort (grok marks non-reasoning models false).
        const extras = s.lines.filter((l) => {
          const key = l.match(/^([A-Za-z_]+)\s*=/)?.[1]
          return key !== undefined && !owned.has(key)
        })
        prior.set(id, { name, extras, effort: body.match(/^supports_reasoning_effort\s*=\s*(\w+)/m)?.[1] })
      }
      const isOwned = (s) => s.header !== null && /^\[model\."?op2gw-/.test(s.header)
      const generated = models.map((m) => ({
        header: `[model.${tomlKey(`op2gw-${m.id}`)}]`,
        lines: [
          `model = ${JSON.stringify(m.id)}`,
          'model_provider = "op2gw"',
          `name = ${JSON.stringify(prior.get(m.id)?.name ?? `${plainName(m.id)} (op2gw 免费)`)}`,
          `context_window = ${num(m.context)}`,
          `max_completion_tokens = ${num(m.output)}`,
          `supports_reasoning_effort = ${prior.get(m.id)?.effort ?? 'true'}`,
          ...(prior.get(m.id)?.extras ?? []),
          '',
        ],
      }))
      const next = replaceOwnedSections(sections, isOwned, generated)
      if (!next) return text
      const out = tomlRender(next)
      // [models] default can point at a delisted id; keep a valid preference.
      const cur = out.match(/^default\s*=\s*"op2gw-([^"]*)"\s*$/m)
      const preferred = preferredId(models)
      if (cur && ids.has(cur[1])) return out
      return out.replace(/^default\s*=\s*"op2gw-[^"]*"\s*$/m, `default = ${JSON.stringify(`op2gw-${preferred}`)}`)
    },
  },
  {
    id: 'kimi-code',
    file: () => join(HOME, '.kimi-code/config.toml'),
    render(text, models) {
      const isOwned = (s) =>
        s.header !== null &&
        /^\[models\./.test(s.header) &&
        s.lines.some((l) => /^provider\s*=\s*"op2gw"\s*$/.test(l.trim()))
      const sections = tomlSections(text)
      const owned = new Set(['provider', 'model', 'max_context_size', 'max_output_size', 'capabilities'])
      // kimi-code stores a per-model effort ladder (support_efforts /
      // default_effort); any line we do not own is carried over verbatim.
      const extras = new Map()
      for (const s of sections) {
        if (!isOwned(s)) continue
        const id = s.lines.join('\n').match(/^model = "([^"]+)"/m)?.[1]
        if (!id) continue
        extras.set(
          id,
          s.lines.filter((l) => {
            const key = l.match(/^([A-Za-z_]+)\s*=/)?.[1]
            return key !== undefined && !owned.has(key)
          }),
        )
      }
      const generated = models.map((m) => ({
        // kimi-code quotes every [models."..."] header, even bare-safe ids.
        header: `[models."${m.id}"]`,
        lines: [
          'provider = "op2gw"',
          `model = ${JSON.stringify(m.id)}`,
          `max_context_size = ${m.context}`,
          `max_output_size = ${m.output}`,
          `capabilities = [ ${isVision(m.id) ? '"image_in", "tool_use", "thinking"' : '"tool_use", "thinking"'} ]`,
          ...(extras.get(m.id) ?? []),
          '',
        ],
      }))
      const next = replaceOwnedSections(sections, isOwned, generated)
      return next ? tomlRender(next) : text
    },
  },
  {
    id: 'jcode',
    file: () => join(HOME, '.jcode/config.toml'),
    render(text, models) {
      const isOwned = (s) => s.header === '[[providers.op2gw.models]]'
      const generated = models.map((m) => ({
        header: '[[providers.op2gw.models]]',
        lines: [`id = ${JSON.stringify(m.id)}`, `context_window = ${m.context}`, ''],
      }))
      const next = replaceOwnedSections(tomlSections(text), isOwned, generated)
      return next ? tomlRender(next) : text
    },
  },
  {
    id: 'codex-profile',
    file: () => join(HOME, '.codex/op2gw.config.toml'),
    render(text, models) {
      const ids = new Set(models.map((m) => m.id))
      return text.replace(/^model\s*=\s*"([^"]*)"\s*$/m, (full, cur) =>
        ids.has(cur) ? full : `model = ${JSON.stringify(preferredId(models))}`,
      )
    },
  },

  // ---- YAML -------------------------------------------------------------
  {
    id: 'hermes',
    file: () => join(HOME, '.hermes/config.yaml'),
    render(text, models) {
      const ids = new Set(models.map((m) => m.id))
      let touched = false
      const out = yamlEdit(text, (doc) => {
        const block = doc.getIn(['providers', 'op2gw'], true)
        if (!block) return
        touched = true
        const map = {}
        for (const m of models) map[m.id] = { context_length: m.context }
        doc.setIn(['providers', 'op2gw', 'models'], map)
        const def = doc.getIn(['providers', 'op2gw', 'default_model'])
        if (typeof def === 'string' && !ids.has(def)) {
          doc.setIn(['providers', 'op2gw', 'default_model'], preferredId(models))
        }
      })
      return touched ? out : text
    },
  },
  {
    id: 'goose-config',
    file: () => join(HOME, '.config/goose/config.yaml'),
    render(text, models) {
      const ids = new Set(models.map((m) => m.id))
      let touched = false
      const out = yamlEdit(text, (doc) => {
        // config.yaml only holds the pointer; the model list itself lives in
        // custom_providers/custom_op2gw.json (handled by goose-provider above).
        const cur = doc.getIn(['providers', 'custom_op2gw', 'model'])
        if (typeof cur === 'string' && !ids.has(cur)) {
          doc.setIn(['providers', 'custom_op2gw', 'model'], preferredId(models))
          touched = true
        }
      })
      return touched ? out : text
    },
  },
]

// -------------------------------------------------------------------- main

function backup(file) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const dest = `${file}.bak-${stamp}-op2gwsync`
  copyFileSync(file, dest)
  return dest
}

function atomicWrite(file, text) {
  const tmp = `${dirname(file)}/.${Date.now()}.op2gwsync.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

async function main() {
  if (LIST) {
    for (const t of targets) log(`${t.id.padEnd(16)} ${t.file()}`)
    return
  }

  let models
  try {
    models = await fetchModels()
  } catch (err) {
    log(`FATAL: cannot read the gateway catalog — ${err.message}`)
    process.exit(2)
  }
  log(`gateway free models (${models.length}): ${models.map((m) => m.id).join(' ')}`)

  const selected = onlyIds ? targets.filter((t) => onlyIds.includes(t.id)) : targets
  let drifted = 0
  let written = 0
  const failures = []

  for (const target of selected) {
    const file = target.file()
    if (!existsSync(file)) {
      log(`--  ${target.id.padEnd(16)} skip (not installed)`)
      continue
    }
    // Most clients mirror the gateway catalog; a client whose list comes from
    // its own backend (cursor) supplies that catalog instead.
    const targetModels = target.catalog ? target.catalog() : models
    if (!targetModels) {
      log(`!!  ${target.id.padEnd(16)} skip (catalog unavailable)`)
      continue
    }
    let old
    try {
      old = readFileSync(file, 'utf8')
    } catch (err) {
      log(`!!  ${target.id.padEnd(16)} skip (unreadable: ${err.message})`)
      continue
    }
    let next
    try {
      next = target.render(old, targetModels)
    } catch (err) {
      // Never rewrite what we could not plan. Report and move on.
      failures.push(target.id)
      log(`!!  ${target.id.padEnd(16)} skip (render failed: ${err.message})`)
      continue
    }
    if (next === old) {
      log(`ok  ${target.id.padEnd(16)} in sync`)
      continue
    }
    drifted++
    // Catalog targets only prune a cached selection, they do not materialise a
    // model list, so "added" would just echo the vendor catalog.
    const added = target.catalog
      ? []
      : targetModels.filter((m) => !old.includes(`"${m.id}"`) && !old.includes(`'${m.id}'`) && !old.includes(m.id))
    const removed = [...old.matchAll(/"([^"\\]+)"/g)]
      .map((m) => m[1])
      .filter(
        (id, i, a) =>
          a.indexOf(id) === i &&
          !id.startsWith('op2gw-') &&
          !targetModels.some((m) => m.id === id) &&
          (target.catalog
            ? /^[a-z0-9][a-z0-9._-]*$/.test(id) && id.includes('-')
            : /-free$|^big-pickle$/.test(id)),
      )
    log(
      `>>  ${target.id.padEnd(16)} DRIFT  +[${added.map((m) => m.id).join(' ') || '-'}]  -[${removed.join(' ') || '-'}]`,
    )
    if (DIFF) {
      const a = join(tmpdir(), `op2gw-sync-a-${target.id}`)
      const b = join(tmpdir(), `op2gw-sync-b-${target.id}`)
      writeFileSync(a, old)
      writeFileSync(b, next)
      const d = spawnSync('diff', ['-u', '--label', 'disk', '--label', 'planned', a, b], { encoding: 'utf8' })
      const lines = (d.stdout ?? '').split('\n')
      log(lines.slice(0, 80).join('\n') + (lines.length > 80 ? `\n... (${lines.length - 80} more diff lines)` : ''))
      unlinkSync(a)
      unlinkSync(b)
    }
    if (APPLY) {
      try {
        const bak = backup(file)
        atomicWrite(file, next)
        written++
        log(`    wrote ${file.replace(HOME, '~')}  (backup ${bak.split('/').pop()})`)
      } catch (err) {
        failures.push(target.id)
        log(`    WRITE FAILED: ${err.message}`)
      }
    }
  }

  log('')
  log(
    `${APPLY ? 'applied' : 'checked'}: ${selected.length} target(s), ${drifted} drifted, ${written} written${
      failures.length ? `, ${failures.length} failed [${failures.join(', ')}]` : ''
    }`,
  )
  if (!APPLY && drifted > 0) log('re-run with --apply to rewrite (each file is backed up first)')
  // Exit code: 0 clean, 1 drift found (check mode), 2 hard failure (handled above).
  process.exit(failures.length > 0 ? 2 : drifted > 0 && !APPLY ? 1 : 0)
}

main().catch((err) => {
  log(`FATAL: ${err.stack ?? err.message}`)
  process.exit(2)
})
