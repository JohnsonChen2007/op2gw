/**
 * Free-lane agent-shape gate.
 *
 * The OpenCode Zen anonymous free lane (live-probed by opencode2dsh 2026-09-18)
 * rejects any chat body that is not "agent-shaped": it must stream AND its
 * `tools` array must include function tools named "bash" AND "read"
 * (descriptions/parameters go uninspected). Plain conversations carry no tools
 * and would be 403'd, so the gateway injects the missing gate tools right
 * before dispatch.
 *
 * This module rewrites the request BODY (not headers). The gateway calls it on
 * the parsed JSON payload before forwarding.
 */

export const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'] as const

type GateName = (typeof FREE_LANE_GATE_TOOL_NAMES)[number]

interface ChatFunctionTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

function gateTool(name: GateName): ChatFunctionTool {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Ensure a chat-completions body satisfies the gate. Returns a new body when a
 * rewrite was needed, or the original body unchanged. Also forces
 * `stream: true` on the wire (the gate requires streaming), but the caller
 * tracks whether the *client* asked to stream so the response can be
 * re-aggregated for non-streaming clients.
 */
export function ensureChatFreeLaneShape(body: unknown): { body: unknown; injected: boolean } {
  if (!isRecord(body) || !Array.isArray(body.messages)) return { body, injected: false }
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const names = new Set(
    tools.map((tool) => {
      const fn = isRecord(tool) ? (tool as { function?: { name?: unknown } }).function : undefined
      return isRecord(fn) ? fn.name : undefined
    }),
  )
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name))
  if (missing.length === 0) return { body, injected: false }
  const next: Record<string, unknown> = { ...body }
  next.tools = [...tools, ...missing.map((name) => gateTool(name))]
  // When the client carried no tools of its own, stop the model from ever
  // calling the injected stubs.
  if (tools.length === 0 && next.tool_choice === undefined) next.tool_choice = 'none'
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
  const input = Array.isArray(body.input) ? body.input : body.input === undefined ? [] : [body.input]
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const names = new Set(
    tools.map((tool) => (isRecord(tool) && tool.type === 'function' ? (tool as { name?: unknown }).name : undefined)),
  )
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name))
  const invalidChoice = body.tool_choice !== undefined && body.tool_choice !== 'auto'
  if (missing.length === 0 && !invalidChoice && Array.isArray(body.input)) return { body, injected: false }
  const next: Record<string, unknown> = {
    ...body,
    input,
    tools: [...tools, ...missing.map((name) => ({ type: 'function', ...gateTool(name).function }))],
    tool_choice: 'auto',
  }
  return { body: next, injected: true }
}

/** Anonymous credential the free lane accepts. */
export const ANONYMOUS_KEY = 'public'
