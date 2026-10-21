import { Readable } from 'node:stream'

type Json = Record<string, unknown>
export type ClientApi = 'chat' | 'responses'
export type ToolSchemas = Map<string, Json>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collect every tool's JSON Schema from a client request body. */
export function buildToolSchemas(body: unknown): ToolSchemas {
  const schemas: ToolSchemas = new Map()
  if (!isRecord(body) || !Array.isArray(body.tools)) return schemas
  for (const raw of body.tools) {
    if (!isRecord(raw)) continue
    // chat: { type: 'function', function: { name, parameters } }
    // responses: { type: 'function', name, parameters }
    const fn = isRecord(raw.function) ? raw.function : raw
    const name = typeof fn.name === 'string' ? fn.name : undefined
    const parameters = isRecord(fn.parameters) ? fn.parameters : undefined
    if (name !== undefined && parameters !== undefined) schemas.set(name, parameters)
  }
  return schemas
}

function looseKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

/**
 * Rewrite model-generated tool arguments so their keys match the tool's own
 * JSON Schema. Weaker models routinely emit camelCase (`filePath`) where the
 * agent declared snake_case (`file_path`), which the agent then rejects with
 * INVALID_ARGS. Only keys are renamed; values are never touched, and unknown
 * keys are left alone so the client can still report a genuine mistake.
 */
export function normalizeToolArguments(raw: string, parameters: Json | undefined): string {
  if (parameters === undefined || raw.length === 0) return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!isRecord(parsed)) return raw
  const properties = isRecord(parameters.properties) ? parameters.properties : undefined
  if (properties === undefined) return raw

  const canonical = new Map<string, string>()
  for (const key of Object.keys(properties)) canonical.set(looseKey(key), key)

  let changed = false
  for (const key of Object.keys(parsed)) {
    if (Object.hasOwn(properties, key)) continue
    const target = canonical.get(looseKey(key))
    if (target !== undefined && !Object.hasOwn(parsed, target)) {
      parsed[target] = parsed[key]
      delete parsed[key]
      changed = true
    }
  }

  // A few agent tools require a display-only `description` next to `command`.
  // Models forget it often enough that omitting it should not fail the call.
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === 'string')
    : []
  if (required.includes('description') && parsed.description === undefined && typeof parsed.command === 'string') {
    const firstLine = parsed.command.split(/\r?\n/, 1)[0]?.trim() ?? ''
    parsed.description =
      firstLine.length === 0 ? 'Run command' : firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
    changed = true
  }

  return changed ? JSON.stringify(parsed) : raw
}

function sseData(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''
  return trimmed.slice(5).trim()
}

function dataLine(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

/**
 * Normalize chat-completions SSE chunks. Argument fragments are buffered per
 * tool-call index (a single fragment is not valid JSON) and emitted once, in
 * full, immediately before the finish chunk. Metadata chunks keep their id and
 * name but carry an empty argument string, so clients still see the call as it
 * starts.
 */
export function normalizeChatStream(source: Readable, schemas: ToolSchemas): Readable {
  if (schemas.size === 0) return source
  const out = new Readable({ read() {} })
  void (async () => {
    let buf = ''
    let id = 'chatcmpl-normalized'
    let created = Math.floor(Date.now() / 1000)
    let model = ''
    const pending = new Map<number, { id?: string; name?: string; args: string }>()

    const flush = (index: number): string[] => {
      const slot = pending.get(index)
      if (slot === undefined) return []
      pending.delete(index)
      if (slot.args.length === 0) return []
      const args = normalizeToolArguments(
        slot.args,
        slot.name === undefined ? undefined : schemas.get(slot.name),
      )
      return [
        dataLine({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    ...(slot.id === undefined ? {} : { id: slot.id }),
                    type: 'function',
                    function: {
                      ...(slot.name === undefined ? {} : { name: slot.name }),
                      arguments: args,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      ]
    }
    const flushAll = (): string[] =>
      [...pending.keys()].sort((left, right) => left - right).flatMap(flush)

    try {
      for await (const chunk of source) {
        buf += String(chunk)
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          const payload = sseData(line)
          if (payload === '') {
            out.push(`${line}\n`)
            continue
          }
          if (payload === '[DONE]') {
            for (const line2 of flushAll()) out.push(line2)
            out.push('data: [DONE]\n\n')
            continue
          }
          let evt: Json
          try {
            const parsed: unknown = JSON.parse(payload)
            if (!isRecord(parsed)) {
              out.push(`${line}\n`)
              continue
            }
            evt = parsed
          } catch {
            out.push(`${line}\n`)
            continue
          }
          if (typeof evt.id === 'string') id = evt.id
          if (typeof evt.created === 'number') created = evt.created
          if (typeof evt.model === 'string') model = evt.model

          const choices = Array.isArray(evt.choices) ? evt.choices : []
          if (choices.length === 0) {
            out.push(`${line}\n`)
            continue
          }

          let sanitized = false
          let hasFinish = false
          const sanitizedChoices: unknown[] = []
          for (const rawChoice of choices) {
            if (!isRecord(rawChoice)) {
              sanitizedChoices.push(rawChoice)
              continue
            }
            const delta = isRecord(rawChoice.delta) ? rawChoice.delta : {}
            const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
            if (calls.length > 0) {
              sanitized = true
              const sanitizedCalls: unknown[] = []
              for (const rawCall of calls) {
                if (!isRecord(rawCall)) continue
                const index = typeof rawCall.index === 'number' ? rawCall.index : 0
                const fn = isRecord(rawCall.function) ? rawCall.function : {}
                const slot = pending.get(index) ?? { args: '' }
                if (typeof rawCall.id === 'string') slot.id = rawCall.id
                if (typeof fn.name === 'string' && fn.name.length > 0) slot.name = fn.name
                if (typeof fn.arguments === 'string') slot.args += fn.arguments
                pending.set(index, slot)
                sanitizedCalls.push({
                  index,
                  ...(typeof rawCall.id === 'string' ? { id: rawCall.id } : {}),
                  ...(typeof rawCall.type === 'string' ? { type: rawCall.type } : {}),
                  function: {
                    ...(typeof fn.name === 'string' && fn.name.length > 0 ? { name: fn.name } : {}),
                    arguments: '',
                  },
                })
              }
              sanitizedChoices.push({ ...rawChoice, delta: { ...delta, tool_calls: sanitizedCalls } })
            } else {
              sanitizedChoices.push(rawChoice)
            }
            if (typeof rawChoice.finish_reason === 'string' && rawChoice.finish_reason.length > 0) {
              hasFinish = true
            }
          }

          if (hasFinish) {
            for (const line2 of flushAll()) out.push(line2)
          }
          out.push(sanitized ? dataLine({ ...evt, choices: sanitizedChoices }) : `${line}\n`)
        }
      }
      for (const line2 of flushAll()) out.push(line2)
      out.push(null)
    } catch (err) {
      out.destroy(err as Error)
    }
  })()
  return out
}

/**
 * Normalize responses-API SSE events. `response.function_call_arguments.delta`
 * fragments are buffered and replaced by one full normalized delta; the
 * `arguments.done` / `output_item.done` / `response.completed` events carry the
 * normalized string as well.
 */
export function normalizeResponsesStream(source: Readable, schemas: ToolSchemas): Readable {
  if (schemas.size === 0) return source
  const out = new Readable({ read() {} })
  void (async () => {
    let buf = ''
    const names = new Map<string, string>()
    const pending = new Map<string, string>()
    const flushed = new Set<string>()

    const flush = (itemId: string, outputIndex?: number): string[] => {
      if (flushed.has(itemId)) return []
      const args = pending.get(itemId)
      if (args === undefined || args.length === 0) return []
      flushed.add(itemId)
      const name = names.get(itemId)
      const normalized = normalizeToolArguments(args, name === undefined ? undefined : schemas.get(name))
      return [
        dataLine({
          type: 'response.function_call_arguments.delta',
          item_id: itemId,
          ...(outputIndex === undefined ? {} : { output_index: outputIndex }),
          delta: normalized,
        }),
      ]
    }
    const flushAll = (): string[] => {
      const out2: string[] = []
      for (const itemId of [...pending.keys()]) out2.push(...flush(itemId))
      return out2
    }

    const normalizeItem = (item: Json, itemId: string | undefined): Json => {
      const name = typeof item.name === 'string' ? item.name : undefined
      if (itemId !== undefined && name !== undefined) names.set(itemId, name)
      if (typeof item.arguments === 'string') {
        return {
          ...item,
          arguments: normalizeToolArguments(
            item.arguments,
            name === undefined ? undefined : schemas.get(name),
          ),
        }
      }
      return item
    }

    try {
      for await (const chunk of source) {
        buf += String(chunk)
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          const payload = sseData(line)
          if (payload === '' || payload === '[DONE]') {
            out.push(`${line}\n`)
            continue
          }
          let evt: Json
          try {
            const parsed: unknown = JSON.parse(payload)
            if (!isRecord(parsed)) {
              out.push(`${line}\n`)
              continue
            }
            evt = parsed
          } catch {
            out.push(`${line}\n`)
            continue
          }

          const type = typeof evt.type === 'string' ? evt.type : ''
          if (type === 'response.output_item.added' || type === 'response.output_item.done') {
            const item = isRecord(evt.item) ? evt.item : undefined
            if (item !== undefined && item.type === 'function_call') {
              const itemId =
                typeof item.id === 'string'
                  ? item.id
                  : typeof evt.item_id === 'string'
                    ? evt.item_id
                    : typeof item.call_id === 'string'
                      ? item.call_id
                      : undefined
              if (itemId !== undefined) {
                if (typeof item.name === 'string') names.set(itemId, item.name)
                if (typeof item.arguments === 'string' && item.arguments.length > 0) {
                  pending.set(itemId, item.arguments)
                }
                if (type === 'response.output_item.done') {
                  for (const line2 of flush(itemId, typeof evt.output_index === 'number' ? evt.output_index : undefined)) {
                    out.push(line2)
                  }
                }
              }
              out.push(dataLine({ ...evt, item: normalizeItem(item, itemId) }))
              continue
            }
            out.push(`${line}\n`)
            continue
          }

          if (type === 'response.function_call_arguments.delta') {
            const itemId = typeof evt.item_id === 'string' ? evt.item_id : undefined
            if (itemId === undefined) {
              out.push(`${line}\n`)
              continue
            }
            const delta = typeof evt.delta === 'string' ? evt.delta : ''
            pending.set(itemId, (pending.get(itemId) ?? '') + delta)
            continue
          }

          if (type === 'response.function_call_arguments.done') {
            const itemId = typeof evt.item_id === 'string' ? evt.item_id : undefined
            if (itemId === undefined) {
              out.push(`${line}\n`)
              continue
            }
            if (typeof evt.arguments === 'string' && evt.arguments.length > 0) {
              pending.set(itemId, evt.arguments)
            }
            for (const line2 of flush(itemId, typeof evt.output_index === 'number' ? evt.output_index : undefined)) {
              out.push(line2)
            }
            const name = names.get(itemId)
            const args = pending.get(itemId)
            out.push(
              dataLine({
                ...evt,
                ...(args === undefined
                  ? {}
                  : {
                      arguments: normalizeToolArguments(
                        args,
                        name === undefined ? undefined : schemas.get(name),
                      ),
                    }),
              }),
            )
            continue
          }

          if (type === 'response.completed') {
            for (const line2 of flushAll()) out.push(line2)
            const response = isRecord(evt.response) ? evt.response : undefined
            if (response !== undefined && Array.isArray(response.output)) {
              const output = response.output.map((item) => {
                if (!isRecord(item) || item.type !== 'function_call') return item
                const itemId = typeof item.id === 'string' ? item.id : undefined
                return normalizeItem(item, itemId)
              })
              out.push(dataLine({ ...evt, response: { ...response, output } }))
              continue
            }
            out.push(`${line}\n`)
            continue
          }

          out.push(`${line}\n`)
        }
      }
      for (const line2 of flushAll()) out.push(line2)
      out.push(null)
    } catch (err) {
      out.destroy(err as Error)
    }
  })()
  return out
}

/** Normalize a non-streaming completion body in the client's dialect. */
export function normalizeCompletionBody(api: ClientApi, body: unknown, schemas: ToolSchemas): unknown {
  if (schemas.size === 0 || !isRecord(body)) return body
  if (api === 'chat') {
    const choices = Array.isArray(body.choices) ? body.choices : []
    for (const choice of choices) {
      if (!isRecord(choice) || !isRecord(choice.message)) continue
      const calls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : []
      for (const call of calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue
        const name = typeof call.function.name === 'string' ? call.function.name : undefined
        if (typeof call.function.arguments === 'string') {
          call.function.arguments = normalizeToolArguments(
            call.function.arguments,
            name === undefined ? undefined : schemas.get(name),
          )
        }
      }
    }
    return body
  }

  const response = isRecord(body.response) ? body.response : body
  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'function_call') continue
    const name = typeof item.name === 'string' ? item.name : undefined
    if (typeof item.arguments === 'string') {
      item.arguments = normalizeToolArguments(
        item.arguments,
        name === undefined ? undefined : schemas.get(name),
      )
    }
  }
  return body
}

/** Wrap a client-dialect SSE stream with tool-argument normalization. */
export function normalizeClientStream(api: ClientApi, source: Readable, schemas: ToolSchemas): Readable {
  if (schemas.size === 0) return source
  return api === 'chat' ? normalizeChatStream(source, schemas) : normalizeResponsesStream(source, schemas)
}

/** Wrap a client-dialect non-streaming body with tool-argument normalization. */
export async function normalizeClientCompletion(
  api: ClientApi,
  source: Readable,
  schemas: ToolSchemas,
): Promise<Readable> {
  if (schemas.size === 0) return source
  const chunks: Buffer[] = []
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return Readable.from([text])
  }
  return Readable.from([JSON.stringify(normalizeCompletionBody(api, body, schemas))])
}
