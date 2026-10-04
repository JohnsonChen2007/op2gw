// 共享读取逻辑：rollout 调用记录是唯一含真实 token 的数据源，应用日志中的 token 已脱敏。
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RECORD_FILE_RE = /^model-io-.+\.jsonl$/;

export function rolloutDirs() {
  if (process.env.ZCODE_ROLLOUT_DIR) return [process.env.ZCODE_ROLLOUT_DIR];
  return [join(homedir(), ".zcode", "cli", "rollout"), join(homedir(), ".zcode", "cli", "debug")];
}

export function logDir() {
  return process.env.ZCODE_LOG_DIR || join(homedir(), ".zcode", "cli", "log");
}

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function rolloutFiles() {
  const files = [];
  for (const dir of rolloutDirs()) {
    if (!(await exists(dir))) continue;
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!RECORD_FILE_RE.test(name)) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        files.push({ path, mtime: info.mtimeMs, size: info.size });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

/** 文件名中的会话 ID 与 ZCode 一致，仅替换文件名非法字符。 */
export function sanitizeSessionId(value) {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** 精确匹配当前会话文件，找不到时回退到最近更新的文件。 */
export async function resolveRecordFile(sessionId) {
  if (sessionId) {
    const name = `model-io-${sanitizeSessionId(sessionId)}.jsonl`;
    for (const dir of rolloutDirs()) {
      const path = join(dir, name);
      if (await exists(path)) return path;
    }
  }
  const files = await rolloutFiles();
  return files[0]?.path ?? null;
}

/** 提取文本中完整的顶层 JSON 对象；返回对象文本与剩余未完成部分。 */
export function extractJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let end = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        objects.push(text.slice(start, i + 1));
        end = i + 1;
        start = -1;
      }
    }
  }
  const rest = depth > 0 ? text.slice(start) : end > 0 ? text.slice(end) : text.slice(-4096);
  return { objects, rest };
}

/** 读取文件尾部字节；tail 读取时丢弃第一条不完整记录。 */
export async function readTail(path, bytes) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    if (size > length) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

export function normalizeRecord(rec) {
  const usage = rec?.response?.usage ?? {};
  return {
    time: rec?.completedAt ?? rec?.startedAt ?? null,
    sessionId: rec?.sessionId ?? "",
    model: rec?.model?.modelId ?? rec?.response?.modelId ?? "unknown",
    provider: rec?.model?.providerId ?? "unknown",
    durationMs: Number(rec?.durationMs) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
    inputTokens: Number(usage.inputTokens) || 0,
    cacheReadTokens: Number(usage.cacheReadTokens) || 0,
    reasoningTokens: Number(usage.reasoningTokens) || 0,
    finishReason: rec?.response?.finishReason ?? "",
    querySource: rec?.querySource ?? "",
    attempt: Number(rec?.attempt) || 1,
    requestId: rec?.requestId ?? "",
    error: rec?.error ?? null,
  };
}

/** 生成速度（tok/s）= 输出 token ÷ 总耗时；总耗时含网络与首字延迟。 */
export function speedPerSec(record) {
  if (record.durationMs > 0 && record.outputTokens > 0) {
    return (record.outputTokens * 1000) / record.durationMs;
  }
  return null;
}

export function matchSession(record, path, session) {
  if (!session) return true;
  return record.sessionId.includes(session) || path.includes(session);
}

export function formatClock(iso) {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return String(iso ?? "-");
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatDuration(ms) {
  if (ms <= 0) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function formatSpeed(value) {
  return value == null ? "-" : value.toFixed(1);
}
