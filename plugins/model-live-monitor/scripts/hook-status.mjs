#!/usr/bin/env node
// UserPromptSubmit 钩子：读取最近一次模型调用，向会话注入一行速度状态；与上次注入相同则不重复输出。
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  extractJsonObjects,
  formatDuration,
  formatSpeed,
  normalizeRecord,
  readTail,
  resolveRecordFile,
  speedPerSec,
} from "./lib.mjs";

const TAIL_BYTES = 2 * 1024 * 1024; // 单条记录可达数百 KB，取足够覆盖一条完整记录的尾部

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readLastRecord(path) {
  const { size } = await stat(path);
  let bytes = TAIL_BYTES;
  let text = "";
  for (;;) {
    text = await readTail(path, bytes);
    // 尾部以 } 收尾才说明已覆盖最后一条完整记录；单条记录过大时逐级扩大窗口。
    if (!text.trimEnd().endsWith("}") || bytes >= size) break;
    bytes = Math.min(bytes * 4, size);
  }
  const { objects } = extractJsonObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(objects[i]);
      if (rec && (rec.response || rec.type === "model_io")) return normalizeRecord(rec);
    } catch {}
  }
  return null;
}

function statusLine(record) {
  if (record.error) {
    return `[模型监控] 最近调用失败：${record.model}@${record.provider} · ${String(record.error).slice(0, 120)}`;
  }
  const parts = [
    `[模型监控] 最近调用 ${record.model}@${record.provider}`,
    `耗时 ${formatDuration(record.durationMs)}`,
    `输出 ${record.outputTokens} tok${record.reasoningTokens > 0 ? `（推理 ${record.reasoningTokens}）` : ""}`,
    `速度 ${formatSpeed(speedPerSec(record))} tok/s`,
  ];
  if (record.finishReason) parts.push(record.finishReason);
  if (record.querySource) parts.push(record.querySource);
  return parts.join(" · ").slice(0, 400);
}

/** 同一次调用只注入一次，避免每次提问都向历史追加一行。 */
async function shouldInject(sessionId, key) {
  const dataDir = process.env.ZCODE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir || !key) return true;
  const file = join(dataDir, "model-live-monitor-state.json");
  try {
    let state = {};
    try {
      state = JSON.parse(await readFile(file, "utf8"));
    } catch {}
    if (state[sessionId] === key) return false;
    state[sessionId] = key;
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, JSON.stringify(state), "utf8");
    return true;
  } catch {
    return true;
  }
}

async function run() {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {}
  const sessionId = input.session_id || input.sessionId || process.env.CLAUDE_SESSION_ID || "";
  const file = await resolveRecordFile(sessionId);
  if (!file || !(await stat(file).catch(() => null))) return null;
  const record = await readLastRecord(file);
  if (!record) return null;
  const key = record.requestId || record.time || "";
  if (!(await shouldInject(sessionId || "default", key))) return null;
  return { additionalContext: statusLine(record) };
}

run()
  .then((output) => {
    if (output) process.stdout.write(JSON.stringify(output) + "\n");
  })
  .catch(() => {})
  .finally(() => process.exit(0));
