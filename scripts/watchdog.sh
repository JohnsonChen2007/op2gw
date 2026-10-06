#!/bin/bash
# op2gw watchdog — log-driven self-healing for the launchd-managed gateway.
#
# Every launchd tick (60s) it computes the TRAILING streak of consecutive
# errors in logs/op2gw.log:
#   - counts as error:  "attempt failed" (request path), level=error,
#                       "pool degraded..." (pool starved, requests refused)
#   - resets the count: "request ok" (traffic is flowing again)
#   - neutral:          anything else (e.g. transient catalog refresh warns)
# On a streak >= THRESHOLD whose newest error is fresh (RECENT_MS), it runs ONE
# rung of an escalating remediation ladder per trigger (MIN_INTERVAL cooldown
# between triggers; the rung taken is remembered in logs/watchdog.state):
#
#   L1 重发会话 — force a pool probe round (revives flapping exits) and clear
#      every sticky session binding (POST /admin/pool/pin id=none), so all
#      conversations are re-dealt by the pool's round-robin across exits.
#      Cheap: no process is touched. The OLD behaviour of re-pointing the
#      default egress at a single "healthiest" exit is deliberately gone —
#      pinning one exit funnels all traffic through one IP and recreates the
#      per-IP 429 quota exhaustion this pool exists to avoid.
#   L2 切换 v2ray 出口 IP — the streak survived L1, so the current egress IP
#      set itself is burned: regenerate the xray sidecar node set EXCLUDING
#      the addresses currently in use (scripts/xray-pool.mjs gen --exclude
#      ...), kick com.op2gw.xraypool, verify the ports, and force a re-probe.
#      op2gw keeps pointing at socks5://127.0.0.1:21001-21010 — only the
#      nodes (egress IPs) behind those ports change.
#   L3 重启网关 — the streak survived even fresh egress IPs: restart the
#      gateway (launchctl kickstart -k), refresh the catalog, full pool
#      probe, then reset the ladder to L1 for the next incident.
#
# Install: com.op2gw.watchdog.plist in ~/Library/LaunchAgents (StartInterval 60).
#
# Env overrides (for testing): OP2GW_WATCHDOG_LOG, OP2GW_WATCHDOG_THRESHOLD,
# OP2GW_WATCHDOG_MIN_INTERVAL, OP2GW_WATCHDOG_RECENT_MS, OP2GW_WATCHDOG_DRY_RUN,
# OP2GW_WATCHDOG_STATE, OP2GW_XRAY_SCRIPT, OP2GW_XRAY_CONFIG, OP2GW_XRAYPOOL_JOB.
set -u

ROOT="${OP2GW_ROOT:-$HOME/src/opencode2gw/op2gw}"
LOG="${OP2GW_WATCHDOG_LOG:-$ROOT/logs/op2gw.log}"
STATE="${OP2GW_WATCHDOG_STATE:-$ROOT/logs/watchdog.state}"
CFG="$HOME/.op2gw/config.json"
XRAY_CONFIG="${OP2GW_XRAY_CONFIG:-$HOME/.op2gw/xray-pool/config.json}"
XRAY_SCRIPT="${OP2GW_XRAY_SCRIPT:-$ROOT/scripts/xray-pool.mjs}"
XRAYPOOL_JOB="${OP2GW_XRAYPOOL_JOB:-com.op2gw.xraypool}"
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

# current rung: state file line 1 = last action ts, line 2 = last action rung.
read_state() {
  LAST_TS=0; LAST_RUNG=0
  if [ -f "$STATE" ]; then
    local t r
    t=$(sed -n '1p' "$STATE" 2>/dev/null); r=$(sed -n '2p' "$STATE" 2>/dev/null)
    case "$t" in (*[!0-9]*|"") t=0 ;; esac
    case "$r" in (*[!0-9]*|"") r=0 ;; esac
    LAST_TS=$t; LAST_RUNG=$r
  fi
}

write_state() {
  printf '%s\n%s\n' "$(date +%s)" "$1" > "$STATE" 2>/dev/null || true
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
read_state
elapsed=$(( $(date +%s) - LAST_TS ))
if [ "$LAST_TS" -gt 0 ] && [ "$elapsed" -lt "$MIN_INTERVAL" ]; then
  say "streak=$STREAK but the last action (L$LAST_RUNG) was ${elapsed}s ago (< ${MIN_INTERVAL}s cooldown) — waiting"
  exit 0
fi

# Next rung: L1 first, then L2 if the streak survived L1, then L3 if it
# survived L2; after L3 the ladder resets for the next incident.
RUNG=$(( LAST_RUNG + 1 ))
if [ "$RUNG" -gt 3 ]; then RUNG=1; fi

say "ALERT: $STREAK consecutive errors (newest $(date -r $((NEWEST / 1000)) '+%H:%M:%S' 2>/dev/null)) — remediation L$RUNG (previous L$LAST_RUNG)"

# A dead gateway skips the API-based rungs entirely: restart is the only lever.
if ! gw_up && [ "$RUNG" -lt 3 ]; then
  say "gateway is not answering — escalating straight to L3"
  RUNG=3
fi

# --- L1: 重发会话 — re-probe exits + clear sticky bindings --------------------
if [ "$RUNG" = "1" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "DRY-RUN: would force a pool probe round and clear all sticky session bindings"
  else
    curl -s -m 10 -X POST "$GW/admin/pool/probe" -o /dev/null -w "pool probe: %{http_code}\n"
    curl -s -m 10 -X POST "$GW/admin/pool/pin" -H 'content-type: application/json' \
      -d '{"id":"none"}' -o /dev/null -w "sticky cleared (pin stays off): %{http_code}\n"
    say "L1 done: exits re-verified, every session re-dealt by round-robin"
  fi
  [ "$DRY_RUN" != "1" ] && write_state 1
  say "remediation complete (L1)"
  exit 0
fi

# --- L2: 切换 v2ray 出口 IP — regenerate the sidecar with fresh nodes ---------
if [ "$RUNG" = "2" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "DRY-RUN: would regenerate $XRAY_CONFIG excluding the current node addresses and restart $XRAYPOOL_JOB"
    exit 0
  fi
  CUR=$(node --input-type=module -e '
import { readFileSync } from "node:fs"
try {
  const cfg = JSON.parse(readFileSync(process.argv[1], "utf8"))
  const addrs = (cfg.outbounds ?? [])
    .map((o) => o.settings?.vnext?.[0]?.address)
    .filter(Boolean)
  console.log([...new Set(addrs)].join(","))
} catch { console.log("") }
' "$XRAY_CONFIG")
  if [ -z "$CUR" ]; then
    say "WARN: could not read current sidecar nodes from $XRAY_CONFIG — falling back to L3"
    RUNG=3
  else
    say "rotating v2ray egress IPs: excluding $(echo "$CUR" | tr ',' ' ' | wc -w | tr -d ' ') current nodes"
    if node "$XRAY_SCRIPT" gen --count 10 --base-port 21001 --exclude "$CUR" --out "$XRAY_CONFIG" >> /dev/null 2>&1; then
      launchctl kickstart -k "gui/$(id -u)/$XRAYPOOL_JOB" 2>/dev/null \
        || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$XRAYPOOL_JOB.plist" 2>/dev/null
      sleep 6
      node "$XRAY_SCRIPT" verify --count 10 --base-port 21001 --timeout 10000 || true
      curl -s -m 10 -X POST "$GW/admin/pool/probe" -o /dev/null -w "pool probe: %{http_code}\n"
      say "L2 done: sidecar regenerated behind unchanged ports 21001-21010, exits re-probing"
      write_state 2
      say "remediation complete (L2)"
      exit 0
    fi
    say "WARN: sidecar regeneration failed — falling back to L3"
    RUNG=3
  fi
fi

# --- L3: 重启网关 — last resort, then reset the ladder ------------------------
if [ "$DRY_RUN" = "1" ]; then
  say "DRY-RUN: would restart launchd job $JOB and refresh catalog + pool"
  exit 0
fi
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
write_state 0
say "remediation complete (L3, ladder reset)"
