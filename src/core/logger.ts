import type { LogRecord, RequestTrace } from './types.js'

/**
 * Structured logger with an in-memory ring buffer.
 *
 * Every record goes to stdout as a single JSON line (machine-readable, easy to
 * ship) AND into a bounded ring buffer the debug UI reads over /admin/logs.
 * Request traces get their own bounded buffer so the UI can render a request
 * timeline without scanning the full log stream.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerOptions {
  level?: LogLevel
  /** Max log records kept in memory (ring buffer). */
  capacity?: number
  /** Max request traces kept in memory. */
  traceCapacity?: number
  /** Write JSON lines to stdout (default true). */
  stdout?: boolean
}

type Listener = (record: LogRecord) => void

export class Logger {
  #level: LogLevel
  #cap: number
  #traceCap: number
  #stdout: boolean
  #buffer: LogRecord[] = []
  #traces: RequestTrace[] = []
  #seq = 0
  #listeners = new Set<Listener>()

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? 'info'
    this.#cap = options.capacity ?? 2000
    this.#traceCap = options.traceCapacity ?? 500
    this.#stdout = options.stdout ?? true
  }

  setLevel(level: LogLevel): void {
    this.#level = level
  }

  get level(): LogLevel {
    return this.#level
  }

  /** Subscribe to live records (used by the SSE log stream). */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  child(scope: string): ScopedLogger {
    return new ScopedLogger(this, scope)
  }

  log(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return
    const record: LogRecord = { ts: Date.now(), level, scope, msg }
    if (data && Object.keys(data).length > 0) record.data = data
    this.#buffer.push(record)
    if (this.#buffer.length > this.#cap) this.#buffer.splice(0, this.#buffer.length - this.#cap)
    if (this.#stdout) {
      const line = JSON.stringify(record)
      if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
      else process.stdout.write(line + '\n')
    }
    for (const listener of this.#listeners) {
      try {
        listener(record)
      } catch {
        // a broken listener must never break logging
      }
    }
  }

  /** Record a completed request trace. */
  trace(trace: RequestTrace): void {
    this.#traces.push(trace)
    if (this.#traces.length > this.#traceCap) this.#traces.splice(0, this.#traces.length - this.#traceCap)
  }

  /** Monotonic request id for correlation. */
  nextRequestId(): string {
    this.#seq += 1
    return `r${Date.now().toString(36)}${this.#seq.toString(36)}`
  }

  /** Snapshot the log ring buffer (newest last), optionally filtered. */
  records(options: { level?: LogLevel; scope?: string; limit?: number } = {}): LogRecord[] {
    let out = this.#buffer
    if (options.level) {
      const min = LEVEL_ORDER[options.level]
      out = out.filter((r) => LEVEL_ORDER[r.level] >= min)
    }
    if (options.scope) out = out.filter((r) => r.scope === options.scope)
    if (options.limit && out.length > options.limit) out = out.slice(out.length - options.limit)
    return out
  }

  traces(limit = 200): RequestTrace[] {
    return this.#traces.slice(Math.max(0, this.#traces.length - limit))
  }
}

/** A logger bound to a scope so call sites don't repeat it. */
export class ScopedLogger {
  #parent: Logger
  #scope: string

  constructor(parent: Logger, scope: string) {
    this.#parent = parent
    this.#scope = scope
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.#parent.log('debug', this.#scope, msg, data)
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.#parent.log('info', this.#scope, msg, data)
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.#parent.log('warn', this.#scope, msg, data)
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.#parent.log('error', this.#scope, msg, data)
  }
}
