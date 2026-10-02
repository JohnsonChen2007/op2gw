#!/bin/bash
# op2gw watchdog — log-driven self-healing for the launchd-managed gateway.
#
# Every launchd tick (60s) it computes the TRAILING streak of consecutive
# errors in logs/op2gw.log:
#   - counts as error:  "attempt failed" (request path), level=error,
#                       "pool degraded..." (pool starved, requests refused)
#   - resets the count: "request ok" (traffic is flowing again)
#   - neutral:          anything else (e.g. transient catalog refresh warns)
# On a streak >= THRESHOLD whose newest error is fresh (RECENT_MS), it
# remediates at most once per MIN_INTERVAL seconds:
#   1. 更换链路 — rotate the default egress to the healthiest OTHER pool exit
#      (via /admin/settings/default-proxy, which live-applies + persists; when
#      the gateway is not answering, edit ~/.op2gw/config.json directly),
#   2. 重启网关 — launchctl kickstart -k of com.op2gw.gateway,
#   3. 更新所有可用的免费模型 — POST /admin/catalog/refresh plus a full pool
#      re-probe once the gateway is back.
# Install: com.op2gw.watchdog.plist in ~/Library/LaunchAgents (StartInterval 60).
#
# Env overrides (for testing): OP2GW_WATCHDOG_LOG, OP2GW_WATCHDOG_THRESHOLD,
# OP2GW_WATCHDOG_MIN_INTERVAL, OP2GW_WATCHDOG_RECENT_MS, OP2GW_WATCHDOG_DRY_RUN.
set -u

ROOT="/Users/esadmin/src/opencode2gw/op2gw"
LOG="${OP2GW_WATCHDOG_LOG:-$ROOT/logs/op2gw.log}"
STATE="$ROOT/logs/watchdog.state"
CFG="$HOME/.op2gw/config.json"
GW="http://127.0.0.1:8787"
JOB="com.op2gw.gateway"
THRESHOLD="${OP2GW_WATCHDOG_THRESHOLD:-5}"
MIN_INTERVAL="${OP2GW_WATCHDOG_MIN_INTERVAL:-600}"
RECENT_MS="${OP2GW_WATCHDOG_RECENT_MS:-600000}"
DRY_RUN="${OP2GW_WATCHDOG_DRY_RUN:-0}"

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

gw_up() {
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$GW/v1/models" 2>/dev/null)" = "200" ]
}

# --- 1. trailing error streak -------------------------------------------------
read -r STREAK NEWEST <<< "$(node --input-type=module -e '
import { readFileSync } from "node:fs"
let text = ""
try { text = readFileSync(process.argv[1], "utf8") } catch { console.log("0 0"); process.exit(0) }
const lines = text.split("\n").filter((l) => l.startsWith("{")).slice(-500)
let streak = 0, newest = 0
for (let i = lines.length - 1; i >= 0; i--) {
  let j
  try { j = JSON.parse(lines[i]) } catch { continue }
  if (j.msg === "request ok") break
  const isError =
    j.level === "error" ||
    j.msg === "attempt failed" ||
    (typeof j.msg === "string" && j.msg.startsWith("pool degraded"))
  if (!isError) continue
  streak++
  newest = Math.max(newest, Number(j.ts) || 0)
}
console.log(String(streak), String(newest))
' "$LOG")" || { say "WARN: streak probe failed"; exit 0; }

if [ "${STREAK:-0}" -lt "$THRESHOLD" ]; then
  exit 0
fi

now_ms=$(( $(date +%s) * 1000 ))
if [ "${NEWEST:-0}" -eq 0 ] || [ $((now_ms - NEWEST)) -gt "$RECENT_MS" ]; then
  say "streak=$STREAK but the newest error is stale — standing down"
  exit 0
fi

# --- 2. cooldown gate ---------------------------------------------------------
if [ -f "$STATE" ]; then
  last=$(head -n 1 "$STATE" 2>/dev/null || echo 0)
  case "$last" in (*[!0-9]*|"") last=0 ;; esac
  elapsed=$(( $(date +%s) - last ))
  if [ "$elapsed" -lt "$MIN_INTERVAL" ]; then
    say "streak=$STREAK but the last action was ${elapsed}s ago (< ${MIN_INTERVAL}s cooldown) — waiting"
    exit 0
  fi
fi

say "ALERT: $STREAK consecutive errors (newest $(date -r $((NEWEST / 1000)) '+%H:%M:%S' 2>/dev/null)) — remediating"

# --- 3. 更换链路: default egress -> healthiest other exit ---------------------
NEXT=$(node --input-type=module -e '
import { readFileSync } from "node:fs"
let cfg = {}
try { cfg = JSON.parse(readFileSync(process.argv[1], "utf8")) } catch { console.log(""); process.exit(0) }
const cur = cfg.proxy || ""
const others = (cfg.pool?.manual ?? []).filter((u) => u !== cur)
if (others.length === 0) { console.log(""); process.exit(0) }
let status = null
try {
  status = await fetch("http://127.0.0.1:8787/admin/status", { signal: AbortSignal.timeout(4000) }).then((r) => r.json())
} catch {}
const health = new Map((status?.pool?.exits ?? []).map((e) => [e.id, e]))
const rank = (u) => {
  const h = health.get(u)
  if (!h || h.cooling) return 2
  if (h.state === "ok") return 0
  if (h.state !== "dead") return 1
  return 2
}
others.sort((a, b) => rank(a) - rank(b))
console.log(others[0] ?? "")
' "$CFG")

if [ -n "$NEXT" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "DRY-RUN: would switch the default egress link -> $NEXT"
  else
    code=$(curl -s -m 10 -X POST "$GW/admin/settings/default-proxy" \
      -H 'content-type: application/json' -d "{\"uri\": \"$NEXT\"}" \
      -o /dev/null -w '%{http_code}' 2>/dev/null)
    if [ "$code" = "200" ]; then
      say "link switched (live-applied + persisted) -> $NEXT"
    else
      if node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs"
const [cfgPath, uri] = process.argv.slice(1)
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"))
cfg.proxy = uri
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
' "$CFG" "$NEXT" 2>/dev/null; then
        say "gateway not answering (code=$code); new link written to config.json -> $NEXT"
      else
        say "WARN: could not switch the link (api code=$code, config edit failed) — restarting with the current link"
      fi
    fi
  fi
else
  say "no alternative exit in the manual pool — keeping the current link"
fi

# --- 4. 重启网关 --------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  say "DRY-RUN: would restart launchd job $JOB"
else
  say "restarting launchd job $JOB"
  if ! launchctl kickstart -k "gui/$(id -u)/$JOB" 2>/dev/null; then
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$JOB.plist" 2>/dev/null
    launchctl kickstart -k "gui/$(id -u)/$JOB" 2>/dev/null || say "WARN: restart command failed"
  fi
  up=0
  for _ in $(seq 1 60); do
    if gw_up; then up=1; break; fi
    sleep 2
  done
  if [ "$up" = "1" ]; then
    say "gateway is back (v1/models 200)"
  else
    say "WARN: gateway did not come back within 120s — launchd will keep retrying"
  fi
fi

# --- 5. 更新所有可用的免费模型 + 全量复探出口 ----------------------------------
if [ "$DRY_RUN" = "1" ]; then
  say "DRY-RUN: would refresh the catalog and re-probe the pool"
else
  curl -s -m 30 -X POST "$GW/admin/catalog/refresh" -o /dev/null -w 'catalog refresh: %{http_code}\n'
  curl -s -m 10 -X POST "$GW/admin/pool/probe" -o /dev/null -w 'pool probe: %{http_code}\n'
  sleep 15
  curl -s -m 5 "$GW/admin/status" | node -e '
let d = ""
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  try {
    const s = JSON.parse(d)
    const exits = s.pool.exits.map((e) => `${e.state}${e.cooling ? "(cooling)" : ""}`).join(", ")
    console.log(`post-action state: catalog=${s.catalog.status} exposed=${s.catalog.exposed} exits=[${exits}]`)
  } catch { console.log("post-action state: unreadable") }
})'
fi

if [ "$DRY_RUN" != "1" ]; then
  date +%s > "$STATE"
fi
say "remediation complete"
