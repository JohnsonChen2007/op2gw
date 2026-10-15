/**
 * Free-lane agent-shape gate.
 *
 * The OpenCode anonymous free lane rejects any body that is not
 * "agent-shaped": it must stream AND its `tools` array must include function
 * tools named "bash" AND "glob" AND "grep" AND "read" (the full agent set the
 * official CLI always carries — captured 2026-10-14). Since the 2026-10
 * tightening the lane also inspects those tools' schemas, so injected stubs
 * are refused with FreeTierError; the gateway injects verbatim copies of the
 * official definitions (see gate-tools.ts). It refuses `tool_choice: "none"`
 * as well, so injected tools keep the default choice.
 *
 * `-free` models are served on /v1/responses or /v1/chat/completions per model
 * (muse-spark-* only speaks responses; the lane answers
 * `ModelProtocolUnsupported` otherwise and the gateway flips and retries).
 * The lane also DECODES the correlation ids (see ids.ts).
 *
 * This module rewrites the request BODY (not headers). The gateway calls it on
 * the parsed JSON payload before forwarding.
 */

import { GATE_TOOL_FUNCTIONS } from './gate-tools.js'

export const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'glob', 'grep', 'read'] as const

type GateName = (typeof FREE_LANE_GATE_TOOL_NAMES)[number]

interface ChatFunctionTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

function gateFunction(name: GateName): { name: string; description: string; parameters: Record<string, unknown> } {
  const { description, parameters } = GATE_TOOL_FUNCTIONS[name]
  return { name, description, parameters: structuredClone(parameters) }
}

function gateChatTool(name: GateName): ChatFunctionTool {
  return { type: 'function', function: gateFunction(name) }
}

function gateResponsesTool(name: GateName): Record<string, unknown> {
  return { type: 'function', ...gateFunction(name), strict: false }
}

/** Name of a chat tool entry (OpenAI nested shape). */
function chatToolName(tool: unknown): string | undefined {
  const fn = isRecord(tool) ? (tool as { function?: { name?: unknown } }).function : undefined
  return isRecord(fn) && typeof fn.name === 'string' ? fn.name : undefined
}

/** Name of a responses tool entry (flat shape). */
function responsesToolName(tool: unknown): string | undefined {
  if (!isRecord(tool) || tool.type !== 'function') return undefined
  return typeof tool.name === 'string' ? tool.name : undefined
}

/** True when a responses tool entry already carries the official gate definition. */
function isOfficialResponsesTool(tool: unknown, name: GateName): boolean {
  if (!isRecord(tool)) return false
  const official = gateFunction(name)
  return (
    tool.type === 'function' &&
    tool.name === name &&
    tool.description === official.description &&
    sameJson(tool.parameters, official.parameters)
  )
}

/**
 * Normalize a gate tool list: entries named like a gate tool are swapped for
 * the official definition when they don't match it verbatim, duplicates
 * collapse to one (the lane rejects duplicate tool names), everything else
 * passes through verbatim and in order.
 */
function normalizeGateTools(
  tools: unknown[],
  nameOf: (tool: unknown) => string | undefined,
  isOfficial: (tool: unknown, name: GateName) => boolean,
  makeGateTool: (name: GateName) => unknown,
): { normalized: unknown[]; seen: Set<string>; changed: boolean } {
  const seen = new Set<string>()
  const normalized: unknown[] = []
  let changed = false
  for (const tool of tools) {
    const name = nameOf(tool)
    if (name !== undefined && (FREE_LANE_GATE_TOOL_NAMES as readonly string[]).includes(name)) {
      if (seen.has(name)) {
        changed = true
        continue
      }
      seen.add(name)
      const gateName = name as GateName
      if (isOfficial(tool, gateName)) {
        normalized.push(tool)
      } else {
        normalized.push(makeGateTool(gateName))
        changed = true
      }
      continue
    }
    normalized.push(tool)
  }
  return { normalized, seen, changed }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep-compare via JSON (key order is stable for our shapes). */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** True when a chat tool entry already carries the official gate definition. */
function isOfficialChatTool(tool: unknown, name: GateName): boolean {
  if (!isRecord(tool) || tool.type !== 'function') return false
  const fn = tool.function
  if (!isRecord(fn) || fn.name !== name) return false
  const official = gateFunction(name)
  return fn.description === official.description && sameJson(fn.parameters, official.parameters)
}

/**
 * Ensure a chat-completions body satisfies the gate. Returns a new body when a
 * rewrite was needed, or the original body unchanged. Also forces
 * `stream: true` on the wire (the gate requires streaming), but the caller
 * tracks whether the *client* asked to stream so the response can be
 * re-aggregated for non-streaming clients.
 *
 * `tool_choice: "none"` would un-shape the request (the model may not touch
 * the gate tools), so it is coerced to `"auto"` — the official CLI always
 * sends `"auto"`. An explicit non-none choice is left alone.
 */
export function ensureChatFreeLaneShape(body: unknown): { body: unknown; injected: boolean } {
  if (!isRecord(body) || !Array.isArray(body.messages)) return { body, injected: false }
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const { normalized, seen, changed } = normalizeGateTools(tools, chatToolName, isOfficialChatTool, gateChatTool)
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !seen.has(name))
  for (const name of missing) {
    normalized.push(gateChatTool(name))
  }
  const needsRewrite = changed || missing.length > 0
  const badChoice = body.tool_choice === undefined || body.tool_choice === 'none'
  const missingStreamOptions = !isRecord(body.stream_options)
  if (!needsRewrite && !badChoice && !missingStreamOptions) return { body, injected: false }
  const next: Record<string, unknown> = needsRewrite ? { ...body, tools: normalized } : { ...body }
  // The CLI sends stream_options.include_usage on every chat call; mirror it
  // when the client omitted the field entirely (never overwrite theirs).
  if (missingStreamOptions) next.stream_options = { include_usage: true }
  if (badChoice) next.tool_choice = 'auto'
  return { body: next, injected: true }
}

/**
 * Ensure a responses body satisfies the gate (flat function tools, tool_choice
 * must be 'auto' on this lane).
 *
 * `input` is normalised to an array first: the Responses API accepts a bare
 * string, the gate tools can be injected regardless, and leaving a string in
 * place would skip injection entirely on a request that still needs it.
 */
export function ensureResponsesFreeLaneShape(body: unknown): { body: unknown; injected: boolean } {
  if (!isRecord(body)) return { body, injected: false }
  const shapedInput =
    typeof body.input === 'string'
      ? [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }]
      : Array.isArray(body.input)
        ? body.input
        : []
  const inputNormalised = body.input === undefined || Array.isArray(body.input)
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const { normalized, seen, changed } = normalizeGateTools(tools, responsesToolName, isOfficialResponsesTool, gateResponsesTool)
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !seen.has(name))
  for (const name of missing) {
    normalized.push(gateResponsesTool(name))
  }
  const needsRewrite = changed || missing.length > 0
  const invalidChoice = body.tool_choice !== undefined && body.tool_choice !== 'auto'
  if (!needsRewrite && !invalidChoice && inputNormalised) return { body, injected: false }
  const next: Record<string, unknown> = { ...body, tool_choice: 'auto' }
  if (needsRewrite) next.tools = normalized
  if (!inputNormalised) next.input = shapedInput
  return { body: next, injected: true }
}

/** Anonymous credential the free lane accepts. */
export const ANONYMOUS_KEY = 'public'

/**
 * Resolve the upstream credential: a configured Zen API key wins, otherwise
 * the anonymous `public` credential. Since the 2026-10 transport gating the
 * anonymous lane rejects non-CLI TLS stacks with FreeTierError, operators who
 * hit that wall should set a key (env OPENCODE_API_KEY, config `zenApiKey`);
 * the keyed channel is unaffected by the gate.
 */
export function resolveUpstreamKey(configured: string | undefined): string {
  const trimmed = (configured ?? '').trim()
  return trimmed.length > 0 ? trimmed : ANONYMOUS_KEY
}
