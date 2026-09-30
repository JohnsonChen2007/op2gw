/**
 * Shared types for op2gw.
 *
 * op2gw is a standalone OpenAI v1-compatible gateway. Any OpenAI-compatible
 * client (opencode CLI, curl, SDKs, other tools) points its baseURL at this
 * gateway; the gateway disguises the request as the OpenCode CLI and forwards
 * it to the OpenCode Zen anonymous free lane over a rotating exit-IP pool.
 */

/** Which upstream protocol a model speaks on Zen. */
export type UpstreamApi = 'chat' | 'responses'

/** OpenAI Chat Completions request (the subset we inspect/rewrite). */
export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: unknown[]
  tool_choice?: unknown
  reasoning_effort?: string
  [key: string]: unknown
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  [key: string]: unknown
}

/** A model row as exposed on GET /v1/models (OpenAI shape). */
export interface OpenAIModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
}

/** Free-model verdict from the catalog. */
export interface FreeDecision {
  allowed: boolean
  /** How the verdict was reached (diagnostics). */
  source: string
  /** true when metadata could speak authoritatively. */
  known: boolean
}

/** Correlation ids derived per request, mirroring the OpenCode CLI. */
export interface RequestIDs {
  session: string
  request: string
  project: string
}

/** A single exit node in the IP pool (the address we dial through). */
export interface ExitNode {
  /** Unique id: the dial URL, e.g. "socks5://127.0.0.1:1080" or "direct". */
  id: string
  kind: 'direct' | 'http' | 'socks5'
  source: 'direct' | 'manual' | 'free' | 'subscription'
  pinned: boolean
  /** Observed public egress IP (routing key + display); '' until probed. */
  exitIP: string
  location: string
  latencyMs: number
  addedAt: number
}

export type ExitState = 'unknown' | 'ok' | 'dead'
export type BanState = 'ok' | 'suspect' | 'banned'

/** The failure taxonomy that drives cooldown / ban / rotate. */
export type FailureKind = 'transport' | 'limited' | 'refused' | 'region' | 'server'

/** A structured log record (ring buffer + stdout). */
export interface LogRecord {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  msg: string
  data?: Record<string, unknown>
}

/** Per-request trace surfaced to the debug UI. */
export interface RequestTrace {
  id: string
  ts: number
  model: string
  stream: boolean
  status: number
  exit: string
  exitIP: string
  attempts: number
  durationMs: number
  outcome: 'ok' | 'error'
  error?: string
}
