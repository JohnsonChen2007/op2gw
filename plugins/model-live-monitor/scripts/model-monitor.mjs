#!/usr/bin/env node
// 实时查看 ZCode 模型调用与生成速度。用法：node model-monitor.mjs [now|last N|summary|tail] [选项]
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  extractJsonObjects,
  formatClock,
  formatDuration,
  formatSpeed,
  logDir,
  matchSession,
  normalizeRecord,
  readTail,
  rolloutDirs,
  rolloutFiles,
  speedPerSec,
} from "./lib.mjs";

const DEFAULT_READ_BYTES = 8 * 1024 * 1024;
const POLL_INTERVAL_MS = 500;
const USAGE = `用法: node model-monitor.mjs [命令] [选项]
命令:
  now            最近一次模型调用（默认）
  last [N]       最近 N 次调用，默认 10
  summary        按模型汇总调用次数、平均耗时与平均速度
  tail           实时跟随新的模型调用与请求开始事件
选项:
  --session ID   只看指定会话（匹配会话 ID 或文件名）
  --json         以 JSON 行输出，便于脚本处理
  --seconds N    tail 运行 N 秒后自动退出（默认一直运行）
  --bytes N      now/last/summary 每个文件读取的尾部字节数（默认 8388608）
  --all          now/last/summary 读取完整文件而非尾部
  --no-log       tail 不监听应用日志中的请求开始事件
  -h, --help     显示帮助`;

async function loadRecords({ all, bytes, session }) {
  const files = await rolloutFiles();
  const records = [];
  await Promise.all(
    files.map(async (file) => {
      const text = await readTail(file.path, all ? file.size : bytes);
      const { objects } = extractJsonObjects(text);
      for (const raw of objects) {
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!rec || (!rec.response && rec.type !== "model_io")) continue;
        const record = normalizeRecord(rec);
        if (matchSession(record, file.path, session)) records.push(record);
      }
    }),
  );
  records.sort((a, b) => String(b.time ?? "").localeCompare(String(a.time ?? "")));
  return { records, fileCount: files.length };
}

function recordSummaryLine(r, json) {
  if (json) return JSON.stringify({ ...r, speedPerSec: speedPerSec(r) });
  const failure = r.error ? ` · 错误 ${String(r.error).slice(0, 80)}` : "";
  return [
    formatClock(r.time),
    r.error ? "✗" : "✓",
    `${r.model}@${r.provider}`,
    formatDuration(r.durationMs),
    `输出 ${r.outputTokens} tok`,
    `${formatSpeed(speedPerSec(r))} tok/s`,
    r.finishReason || "-",
    r.querySource || "-",
    r.attempt > 1 ? `attempt ${r.attempt}` : "",
    failure,
  ]
    .filter(Boolean)
    .join("  ");
}

function reportNone() {
  console.log("未找到模型调用记录。");
  console.log(`已检查：${rolloutDirs().join("、")}。确认目录非空，或用环境变量 ZCODE_ROLLOUT_DIR 指定记录目录。`);
}

async function commandNow({ json, session, all, bytes }) {
  const { records } = await loadRecords({ all, bytes, session });
  const r = records[0];
  if (!r) return reportNone();
  if (json) {
    console.log(JSON.stringify({ ...r, speedPerSec: speedPerSec(r) }));
    return;
  }
  console.log(`最近一次模型调用（${formatClock(r.time)}）`);
  console.log(`模型：${r.model}@${r.provider}`);
  console.log(
    `耗时：${formatDuration(r.durationMs)} | 输出：${r.outputTokens} tok${r.reasoningTokens > 0 ? `（推理 ${r.reasoningTokens}）` : ""} | 速度：${formatSpeed(speedPerSec(r))} tok/s`,
  );
  console.log(
    `输入：${r.inputTokens} tok（缓存命中 ${r.cacheReadTokens}） | 完成原因：${r.finishReason || "-"} | 来源：${r.querySource || "-"}`,
  );
  if (r.error) console.log(`错误：${String(r.error).slice(0, 200)}`);
  console.log(`会话：${r.sessionId}${r.attempt > 1 ? `（attempt ${r.attempt}）` : ""}`);
}

async function commandLast(count, { json, session, all, bytes }) {
  const { records } = await loadRecords({ all, bytes, session });
  const picked = records.slice(0, count);
  if (!picked.length) return reportNone();
  for (const r of picked) console.log(recordSummaryLine(r, json));
}

async function commandSummary({ json, session, all, bytes }) {
  const { records, fileCount } = await loadRecords({ all, bytes, session });
  if (!records.length) return reportNone();
  const groups = new Map();
  for (const r of records) {
    const key = `${r.model}@${r.provider}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const rows = [];
  for (const [key, list] of groups) {
    const withDuration = list.filter((r) => r.durationMs > 0);
    const totalOut = list.reduce((sum, r) => sum + r.outputTokens, 0);
    const totalMs = withDuration.reduce((sum, r) => sum + r.durationMs, 0);
    const speeds = list.map(speedPerSec).filter((v) => v != null);
    rows.push({
      model: key,
      calls: list.length,
      failures: list.filter((r) => r.error).length,
      outputTokens: totalOut,
      avgDurationMs: withDuration.length ? Math.round(totalMs / withDuration.length) : 0,
      avgSpeedPerSec: totalMs > 0 ? (totalOut * 1000) / totalMs : null,
      minSpeedPerSec: speeds.length ? Math.min(...speeds) : null,
      maxSpeedPerSec: speeds.length ? Math.max(...speeds) : null,
    });
  }
  rows.sort((a, b) => b.calls - a.calls);
  if (json) {
    for (const row of rows) console.log(JSON.stringify(row));
    return;
  }
  const scanned = all ? "完整读取" : `每文件尾部 ${Math.round(bytes / 1024)}KB`;
  console.log(`按模型汇总（${fileCount} 个记录文件，${records.length} 次调用，${scanned}）`);
  for (const row of rows) {
    const parts = [`调用 ${row.calls} 次`, `输出 ${row.outputTokens} tok`];
    if (row.avgDurationMs) parts.push(`平均耗时 ${formatDuration(row.avgDurationMs)}`);
    if (row.avgSpeedPerSec != null) {
      parts.push(`平均速度 ${formatSpeed(row.avgSpeedPerSec)} tok/s`);
      if (row.minSpeedPerSec != null) {
        parts.push(`区间 ${formatSpeed(row.minSpeedPerSec)}–${formatSpeed(row.maxSpeedPerSec)} tok/s`);
      }
    }
    if (row.failures) parts.push(`失败 ${row.failures} 次`);
    console.log(row.model);
    console.log(`  ${parts.join(" | ")}`);
  }
}

/** 跟随模式：轮询 rollout 目录中的新记录，并监听应用日志中的请求开始事件。 */
async function commandTail({ json, seconds, noLog, session }) {
  const fileStates = new Map();
  const logState = { path: null, offset: 0 };
  const hint = process.env.ZCODE_ROLLOUT_DIR || "~/.zcode/cli/rollout";
  let captured = 0;
  let announcedMissing = false;
  let initialPoll = true;

  function emitRecord(rec) {
    const record = normalizeRecord(rec);
    if (session && !record.sessionId.includes(session)) return;
    captured++;
    if (json) console.log(JSON.stringify({ ...record, speedPerSec: speedPerSec(record) }));
    else console.log(recordSummaryLine(record, false));
  }

  async function readFrom(handle, offset, length) {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return buffer.toString("utf8");
  }

  async function pollRollout() {
    const files = await rolloutFiles();
    if (!files.length && !announcedMissing && !json) {
      announcedMissing = true;
      console.log(`提示：${hint} 中暂无记录文件，出现新调用后会自动输出。`);
    }
    for (const file of files) {
      let size;
      try {
        size = (await stat(file.path)).size;
      } catch {
        fileStates.delete(file.path);
        continue;
      }
      let state = fileStates.get(file.path);
      if (!state) {
        // 启动时已存在的文件跳到末尾，只输出之后的新调用；监控期间新出现的文件从头读。
        state = { offset: initialPoll ? size : 0, leftover: "" };
        fileStates.set(file.path, state);
      }
      if (size < state.offset) {
        // 文件被轮转或截断：从头重新读取。
        state.offset = 0;
        state.leftover = "";
      }
      if (size === state.offset) continue;
      const handle = await open(file.path, "r");
      let text;
      try {
        text = await readFrom(handle, state.offset, size - state.offset);
      } finally {
        await handle.close();
      }
      state.offset = size;
      const { objects, rest } = extractJsonObjects(state.leftover + text);
      state.leftover = rest;
      for (const raw of objects) {
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!rec || (!rec.response && rec.type !== "model_io")) continue;
        emitRecord(rec);
      }
    }
    initialPoll = false;
  }

  async function pollLog() {
    if (noLog) return;
    let names = [];
    try {
      names = await readdir(logDir());
    } catch {
      return;
    }
    const latest = names.filter((n) => /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().pop();
    if (!latest) return;
    const path = join(logDir(), latest);
    if (logState.path !== path) {
      // 新的一天日志从末尾开始读，只看之后的事件。
      logState.path = path;
      try {
        logState.offset = (await stat(path)).size;
      } catch {
        logState.offset = 0;
      }
      return;
    }
    let size;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    if (size <= logState.offset) return;
    const handle = await open(path, "r");
    let text;
    try {
      text = await readFrom(handle, logState.offset, size - logState.offset);
    } finally {
      await handle.close();
    }
    logState.offset = size;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.event !== "model.request.started") continue;
      if (session && !(event.sessionId ?? "").includes(session)) continue;
      if (json) {
        console.log(
          JSON.stringify({ kind: "request-started", time: event.timestamp, sessionId: event.sessionId, turnId: event.turnId }),
        );
      } else {
        const who = event.sessionId ? event.sessionId.replace(/^sess_/, "").slice(0, 8) : "?";
        console.log(`${formatClock(event.timestamp)}  ▶ 请求开始（会话 ${who}）`);
      }
    }
  }

  if (!json) {
    const files = await rolloutFiles();
    console.log(`开始监控模型调用：${hint}（当前 ${files.length} 个记录文件）`);
    console.log("速度 = 输出 token ÷ 总耗时（含网络与首字延迟）。Ctrl-C 退出。");
  }

  let running = true;
  let pollBusy = false;
  const timer = setInterval(() => {
    if (pollBusy) return;
    pollBusy = true;
    pollRollout()
      .then(() => pollLog())
      .catch((error) => {
        if (!json) console.log(`监控轮询出错（将重试）：${error.message}`);
      })
      .finally(() => {
        pollBusy = false;
      });
  }, POLL_INTERVAL_MS);

  const stop = () => {
    if (!running) return;
    running = false;
    clearInterval(timer);
    if (!json) console.log(`— 监控结束，期间捕获 ${captured} 次模型调用 —`);
  };
  if (seconds > 0) setTimeout(stop, seconds * 1000);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        session: { type: "string" },
        json: { type: "boolean" },
        seconds: { type: "string" },
        bytes: { type: "string" },
        all: { type: "boolean" },
        "no-log": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const seconds = values.seconds !== undefined ? Number(values.seconds) : 0;
  const bytes = values.bytes !== undefined ? Math.floor(Number(values.bytes)) : DEFAULT_READ_BYTES;
  if (!Number.isFinite(seconds) || seconds < 0) {
    console.error(`--seconds 应为非负数字：${values.seconds}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(bytes) || bytes <= 0) {
    console.error(`--bytes 应为正整数：${values.bytes}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const command = positionals[0] ?? "now";
  const shared = {
    json: values.json ?? false,
    session: values.session,
    all: values.all ?? false,
    bytes,
    seconds,
    noLog: values["no-log"] ?? false,
  };
  switch (command) {
    case "now":
      await commandNow(shared);
      break;
    case "last": {
      const count = Number.parseInt(positionals[1] ?? "10", 10);
      if (!Number.isFinite(count) || count <= 0) {
        console.error(`last 的参数应为正整数：${positionals[1]}\n${USAGE}`);
        process.exitCode = 1;
        return;
      }
      await commandLast(count, shared);
      break;
    }
    case "summary":
      await commandSummary(shared);
      break;
    case "tail":
      await commandTail(shared);
      break;
    default:
      console.error(`未知命令：${command}\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
