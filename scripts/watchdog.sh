#!/bin/bash
# op2gw watchdog — log-driven self-healing for the launchd-managed gateway.
#
# Two independent triggers share this script.
#
# A. TRAFFIC — Every launchd tick (60s) it computes the TRAILING streak of
# consecutive errors in logs/op2gw.log:
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
# B. CATALOG — independent of traffic, because the catalog refreshes on its own
#    schedule (config refreshSeconds, currently daily). At that cadence a
#    silently failing refresh stays invisible for a full day, so this reads the
#    self-heal status file (rewritten every 60s) and escalates its own ladder
#    after CATALOG_THRESHOLD consecutive unhealthy ticks:
#   C1 强刷目录 — POST /admin/catalog/refresh. No process is touched; on its
#      own this recovers a transient source outage.
#   C2 交给 L3 — the catalog was still unhealthy after a C1, so the refresh
#      link itself is suspect: hand over to the L3 restart rung.
#    Both respect CATALOG_COOLDOWN and are remembered in watchdog.state lines
#    4-5, so they never fight the traffic ladder over lines 1-2. An unreadable
#    status file counts as healthy: the absence of evidence must not restart a
#    healthy gateway.
#
# C. CATALOG FRESHNESS — 1b only notices a refresh that FAILS. A refresh that
#    silently stops running leaves status=ready with an ever-older lastRefresh,
#    and nothing escalates. So this compares lastRefresh against the catalog's
#    own refreshSeconds (plus an hour of grace, and never less than
#    CATALOG_MAX_AGE) and forces a C1 refresh when the age exceeds it. A forced
#    refresh is remembered in state line 6 so it cannot fight 1b's C1, and if
#    the refresh still does not stick, 1b's ladder takes over and escalates.
#
# D. CLIENT SYNC — the gateway catalog is the truth, but every local agent
#    (opencode, mimocode, kilo, codex, grok, kimi, jcode, hermes, goose, zed,
#    codebuddy, workbuddy) keeps its OWN copy of the free-model list. When the
#    upstream adds or delists a model those copies drift silently — a delisted
#    model stayed advertised to every client for weeks. So on a long interval
#    (default 6h) this runs scripts/sync-clients.mjs --apply, which rewrites
#    only drifted files, backs each one up first, and exits non-zero if any
#    target failed. Line 7 remembers the last successful run; a failure retries
#    within 30 min instead of waiting a full interval.
#
# Install: com.op2gw.watchdog.plist in ~/Library/LaunchAgents (StartInterval 60).
#
# Env overrides (for testing): OP2GW_WATCHDOG_LOG, OP2GW_WATCHDOG_THRESHOLD,
# OP2GW_WATCHDOG_MIN_INTERVAL, OP2GW_WATCHDOG_RECENT_MS, OP2GW_WATCHDOG_DRY_RUN,
# OP2GW_WATCHDOG_STATE, OP2GW_WATCHDOG_STATUS, OP2GW_WATCHDOG_CATALOG_THRESHOLD,
# OP2GW_WATCHDOG_CATALOG_COOLDOWN, OP2GW_WATCHDOG_CATALOG_MAX_AGE,
# OP2GW_WATCHDOG_SYNC_INTERVAL, OP2GW_WATCHDOG_SYNC_LOG, OP2GW_SYNC_SCRIPT,
# OP2GW_XRAY_SCRIPT, OP2GW_XRAY_CONFIG, OP2GW_XRAYPOOL_JOB.
set -u

ROOT="${OP2GW_ROOT:-$HOME/src/op2gw}"
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
STATUS="${OP2GW_WATCHDOG_STATUS:-$HOME/.op2gw/status.json}"
CATALOG_THRESHOLD="${OP2GW_WATCHDOG_CATALOG_THRESHOLD:-30}"
CATALOG_COOLDOWN="${OP2GW_WATCHDOG_CATALOG_COOLDOWN:-1800}"
CATALOG_MAX_AGE="${OP2GW_WATCHDOG_CATALOG_MAX_AGE:-21600}"
SYNC_INTERVAL="${OP2GW_WATCHDOG_SYNC_INTERVAL:-21600}"
SYNC_SCRIPT="${OP2GW_SYNC_SCRIPT:-$ROOT/scripts/sync-clients.mjs}"
SYNC_LOG="${OP2GW_WATCHDOG_SYNC_LOG:-$ROOT/logs/client-sync.log}"

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

gw_up() {
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$GW/v1/models" 2>/dev/null)" = "200" ]
}

# State layout: line 1 = traffic last-action ts, line 2 = traffic rung,
# line 3 = consecutive unhealthy catalog ticks, line 4 = catalog last-action ts,
# line 5 = catalog rung (0 none, 1 = C1 refresh taken), line 6 = last forced
# freshness refresh, line 7 = last successful client sync, line 8 = consecutive
# unresponsive ticks (the dead-man switch). Lines 3-8 are absent in files
# written before those triggers existed and read back as 0.
read_state() {
  LAST_TS=0; LAST_RUNG=0; CAT_STREAK=0; CAT_TS=0; CAT_RUNG=0; FRESH_TS=0; SYNC_TS=0; DOWN_TICKS=0
  if [ -f "$STATE" ]; then
    local t r c ct cr ft st dn
    t=$(sed -n '1p' "$STATE" 2>/dev/null); r=$(sed -n '2p' "$STATE" 2>/dev/null)
    c=$(sed -n '3p' "$STATE" 2>/dev/null)
    ct=$(sed -n '4p' "$STATE" 2>/dev/null); cr=$(sed -n '5p' "$STATE" 2>/dev/null)
    ft=$(sed -n '6p' "$STATE" 2>/dev/null); st=$(sed -n '7p' "$STATE" 2>/dev/null)
    dn=$(sed -n '8p' "$STATE" 2>/dev/null)
    case "$t" in (*[!0-9]*|"") t=0 ;; esac
    case "$r" in (*[!0-9]*|"") r=0 ;; esac
    case "$c" in (*[!0-9]*|"") c=0 ;; esac
    case "$ct" in (*[!0-9]*|"") ct=0 ;; esac
    case "$cr" in (*[!0-9]*|"") cr=0 ;; esac
    case "$ft" in (*[!0-9]*|"") ft=0 ;; esac
    case "$st" in (*[!0-9]*|"") st=0 ;; esac
    case "$dn" in (*[!0-9]*|"") dn=0 ;; esac
    LAST_TS=$t; LAST_RUNG=$r; CAT_STREAK=$c; CAT_TS=$ct; CAT_RUNG=$cr
    FRESH_TS=$ft; SYNC_TS=$st; DOWN_TICKS=$dn
  fi
}

# Persist all eight fields from the current variables.
write_state_all() {
  printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$LAST_TS" "$LAST_RUNG" "$CAT_STREAK" "$CAT_TS" "$CAT_RUNG" "$FRESH_TS" "$SYNC_TS" "$DOWN_TICKS" \
    > "$STATE" 2>/dev/null || true
}

write_state() {
  LAST_TS=$(date +%s); LAST_RUNG="${1:-$LAST_RUNG}"
  write_state_all
}

# Persist the catalog counters (and now the freshness/sync stamps) WITHOUT
# stamping line 1: write_state sets it to "now", which would reset the traffic
# ladder's cooldown on every catalog tick, and the catalog counter has to be
# durable even on the ticks where no remediation fires — otherwise it restarts
# from the last acted-upon value every minute and can never climb to
# CATALOG_THRESHOLD.
write_catalog_state() {
  write_state_all
}

# --- 1. trailing error streak -------------------------------------------------
read -r STREAK NEWEST QUOTA_ONLY <<< "$(node --input-type=module -e '
import { readFileSync } from "node:fs"
let text = ""
try { text = readFileSync(process.argv[1], "utf8") } catch { console.log("0 0 0"); process.exit(0) }
const lines = text.split("\n").filter((l) => l.startsWith("{")).slice(-500)
let streak = 0, newest = 0, quota = 0
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
  // Quota pressure rather than a sick path: a 429 back-off, or the self-heal
  // line that reports every exit cooling because of 429s. Everything else
  // (transport failures, upstream 5xx/400, identity-gate verdicts) says the
  // path itself is broken — that is what the upper rungs are for.
  if (j.msg === "attempt failed" && j.data && j.data.kind === "limited") quota++
  else if (typeof j.msg === "string" && j.msg.startsWith("pool degraded")) quota++
}
const quotaOnly = streak > 0 && quota === streak ? 1 : 0
console.log(String(streak), String(newest), String(quotaOnly))
' "$LOG")" || { say "WARN: streak probe failed"; exit 0; }
case "$QUOTA_ONLY" in (*[!0-9]*|"") QUOTA_ONLY=0 ;; esac

# --- 1b. catalog health (independent of traffic) ------------------------------
# Runs BEFORE the traffic gates so a quiet gateway still notices a dead refresh
# link. An unreadable status file counts as healthy: absence of evidence must
# never restart a working gateway.
read_state
CAT_UNHEALTHY=$(node --input-type=module -e '
import { readFileSync } from "node:fs"
try {
  const s = JSON.parse(readFileSync(process.argv[1], "utf8"))
  const c = s.catalog ?? {}
  console.log((c.lastError ?? "") !== "" || c.status !== "ready" ? "1" : "0")
} catch { console.log("0") }
' "$STATUS" 2>/dev/null) || CAT_UNHEALTHY=0

if [ "$CAT_UNHEALTHY" = "1" ]; then
  CAT_STREAK=$(( CAT_STREAK + 1 ))
  write_catalog_state
else
  if [ "$CAT_STREAK" -gt 0 ]; then
    say "catalog recovered after ${CAT_STREAK} unhealthy tick(s)"
    CAT_STREAK=0; CAT_RUNG=0; CAT_TS=0
    write_catalog_state
  fi
fi

# --- 1c. catalog freshness (ready but silently stale) -------------------------
# 1b waits for lastError / status != ready. Neither fires when the refresh job
# simply stops running: the catalog keeps saying "ready" while lastRefresh ages,
# so every client keeps advertising models the upstream has already delisted.
# The age limit follows the catalog's own cadence (refreshSeconds + 1h) and is
# never below CATALOG_MAX_AGE, so a slow-but-healthy refresh cannot trip it.
read -r CAT_AGE CAT_LIMIT <<< "$(node --input-type=module -e '
import { readFileSync } from "node:fs"
try {
  const s = JSON.parse(readFileSync(process.argv[1], "utf8"))
  const c = s.catalog ?? {}
  const last = Date.parse(c.lastRefresh ?? "")
  if (!Number.isFinite(last)) { console.log("-1 0"); process.exit(0) }
  const rs = Number(c.refreshSeconds) || 86400
  const floor = Number(process.argv[2]) || 21600
  console.log(String(Math.round((Date.now() - last) / 1000)), String(Math.max(floor, rs + 3600)))
} catch { console.log("-1 0") }
' "$STATUS" "$CATALOG_MAX_AGE" 2>/dev/null)" || { CAT_AGE=-1; CAT_LIMIT=0; }

if [ "$CAT_AGE" -ge 0 ] && [ "$CAT_LIMIT" -gt 0 ] && [ "$CAT_AGE" -gt "$CAT_LIMIT" ]; then
  now_fresh=$(date +%s)
  if [ "$FRESH_TS" -gt 0 ] && [ $((now_fresh - FRESH_TS)) -lt "$CATALOG_COOLDOWN" ]; then
    say "catalog lastRefresh is ${CAT_AGE}s old but a forced refresh was taken $((now_fresh - FRESH_TS))s ago — waiting"
  elif [ "$DRY_RUN" = "1" ]; then
    say "DRY-RUN: would force a catalog refresh (lastRefresh ${CAT_AGE}s old > ${CAT_LIMIT}s)"
  else
    say "ALERT: catalog lastRefresh is ${CAT_AGE}s old (> ${CAT_LIMIT}s) — forcing a refresh so clients stop advertising stale models"
    curl -s -m 60 -X POST "$GW/admin/catalog/refresh" -o /dev/null -w 'catalog refresh: %{http_code}\n'
    FRESH_TS=$now_fresh
    write_catalog_state
    say "catalog freshness action complete"
  fi
  exit 0
fi

# --- 1d. client model-config sync --------------------------------------------
# The gateway catalog is the truth, but each local agent keeps its own copy of
# the free-model list, and those copies drift silently whenever the upstream
# adds or delists a model. Rewriting user config files is not a per-minute
# action, so this runs on SYNC_INTERVAL (default 6h) and only while the gateway
# can be read (the script's source of truth).
now_sync=$(date +%s)
if [ $((now_sync - SYNC_TS)) -ge "$SYNC_INTERVAL" ] && gw_up; then
  if [ ! -f "$SYNC_SCRIPT" ]; then
    # Stamp like a failure: a missing script must not warn every single minute.
    say "WARN: client sync script missing ($SYNC_SCRIPT) — retrying in 30min"
    SYNC_TS=$(( now_sync - SYNC_INTERVAL + 1800 ))
    write_catalog_state
  elif [ "$DRY_RUN" = "1" ]; then
    say "DRY-RUN: would reconcile client model lists via node $SYNC_SCRIPT --apply"
  elif out=$(node "$SYNC_SCRIPT" --apply 2>&1); then
    printf '%s\n' "$out" > "$SYNC_LOG" 2>/dev/null || true
    say "client sync: $(printf '%s\n' "$out" | tail -1)"
    SYNC_TS=$now_sync
    write_catalog_state
  else
    rc=$?
    printf '%s\n' "$out" > "$SYNC_LOG" 2>/dev/null || true
    say "WARN: client sync failed (rc=$rc) — see $SYNC_LOG; retrying in 30min"
    SYNC_TS=$(( now_sync - SYNC_INTERVAL + 1800 ))
    write_catalog_state
  fi
fi

# --- 1e. dead-man switch: is the gateway answering? (no log line needed) -------
# Every ladder above reads the LOG, so all of them need the gateway to be writing.
# A hung gateway (it still accepts sockets, so launchd's KeepAlive never fires)
# or an unloaded job writes nothing — and silence is indistinguishable from
# "busy but fine", so the watchdog would stand down while the gateway is off-line.
# Two signals that do not come from the log:
#   * the HTTP probe itself, and
#   * the age of status.json — selfheal rewrites it every tick (60s), so a stale
#     file means the event loop is gone even while HTTP still answers.
DOWN_THRESHOLD="${OP2GW_WATCHDOG_DOWN_THRESHOLD:-3}"
STATUS_MAX_AGE="${OP2GW_WATCHDOG_STATUS_MAX_AGE:-300}"
read_state

down_reason=""
if ! gw_up; then
  down_reason="HTTP probe failed"
else
  status_age=-1
  if [ -f "$STATUS" ]; then
    mtime=$(stat -f %m "$STATUS" 2>/dev/null || echo 0)
    case "$mtime" in (*[!0-9]*|"") mtime=0 ;; esac
    status_age=$(( $(date +%s) - mtime ))
    if [ "$status_age" -gt "$STATUS_MAX_AGE" ]; then
      down_reason="status.json stale for ${status_age}s (self-heal stopped ticking)"
    fi
  else
    down_reason="status.json missing"
  fi
fi

if [ -n "$down_reason" ]; then
  DOWN_TICKS=$(( DOWN_TICKS + 1 ))
else
  DOWN_TICKS=0
fi
# Persisted WITHOUT stamping line 1 so the dead-man counter survives a tick that
# takes no action (the ladder's cooldown must not be reset by a mere health probe).
write_catalog_state

DEADMAN=0
if [ "$DOWN_TICKS" -ge "$DOWN_THRESHOLD" ]; then
  DEADMAN=1
  say "ALERT: gateway unresponsive for ${DOWN_TICKS} consecutive tick(s) (${down_reason}) — dead-man escalates straight to L3"
fi

# --- 1f. sidecar liveness: the physical layer of 7 of the 9 pool exits ---------
# The xray sidecar behind socks5://127.0.0.1:21001-21010 carries most of the
# pool's distinct egress IPs. If that job is not running the pool silently drops
# to a couple of exits and 429 pressure comes straight back, so revive it here
# rather than waiting for the traffic ladder to notice the degraded pool.
XRAY_PLIST="$HOME/Library/LaunchAgents/$XRAYPOOL_JOB.plist"
if [ -f "$XRAY_PLIST" ] && ! launchctl print "gui/$(id -u)/$XRAYPOOL_JOB" 2>/dev/null | grep -q "state = running"; then
  say "ALERT: sidecar $XRAYPOOL_JOB is not running — most of the pool's egress IPs sit behind it"
  launchctl kickstart "gui/$(id -u)/$XRAYPOOL_JOB" 2>/dev/null \
    || launchctl bootstrap "gui/$(id -u)" "$XRAY_PLIST" 2>/dev/null \
    || say "WARN: could not restart $XRAYPOOL_JOB"
  say "sidecar restart issued"
fi

# Set when the catalog ladder escalates into the L3 restart rung below.
CAT_ESCALATED=0

if [ "$CAT_STREAK" -ge "$CATALOG_THRESHOLD" ]; then
  now_cat=$(( $(date +%s) ))
  if [ "$CAT_TS" -gt 0 ] && [ $((now_cat - CAT_TS)) -lt "$CATALOG_COOLDOWN" ]; then
    # C1 was taken recently and it did not stick: the refresh link, not the
    # source, is the suspect. Hand over to L3 rather than hammering the API.
    if [ "$CAT_RUNG" -ge 1 ]; then
      say "ALERT: catalog still unhealthy for ${CAT_STREAK} consecutive tick(s) after a C1 refresh — escalating to L3"
      CAT_ESCALATED=1
    fi
  else
    if [ "$DRY_RUN" = "1" ]; then
      say "DRY-RUN: would force a catalog refresh (C1) — streak=$CAT_STREAK"
      write_state 0
    else
      say "ALERT: catalog unhealthy for ${CAT_STREAK} consecutive tick(s) — C1 forcing a refresh"
      curl -s -m 60 -X POST "$GW/admin/catalog/refresh" -o /dev/null -w 'catalog refresh: %{http_code}\n'
      CAT_TS=$now_cat; CAT_RUNG=1
      write_state 0
      say "remediation complete (C1)"
    fi
    exit 0
  fi
fi

if [ "${STREAK:-0}" -lt "$THRESHOLD" ] && [ "$CAT_ESCALATED" -eq 0 ] && [ "$DEADMAN" -eq 0 ]; then
  exit 0
fi

now_ms=$(( $(date +%s) * 1000 ))
if [ "$CAT_ESCALATED" -eq 0 ] && [ "$DEADMAN" -eq 0 ] && { [ "${NEWEST:-0}" -eq 0 ] || [ $((now_ms - NEWEST)) -gt "$RECENT_MS" ]; }; then
  say "streak=$STREAK but the newest error is stale — standing down"
  exit 0
fi

# --- 2. cooldown gate ---------------------------------------------------------
read_state
elapsed=$(( $(date +%s) - LAST_TS ))
# The dead-man bypasses this: an off-line gateway may be retried every time it
# trips (every third tick), not once per MIN_INTERVAL — launchd's ThrottleInterval
# is what stops a hot restart loop, not this gate.
if [ "$DEADMAN" -eq 0 ] && [ "$LAST_TS" -gt 0 ] && [ "$elapsed" -lt "$MIN_INTERVAL" ]; then
  say "streak=$STREAK but the last action (L$LAST_RUNG) was ${elapsed}s ago (< ${MIN_INTERVAL}s cooldown) — waiting"
  exit 0
fi

# Next rung: L1 first, then L2 if the streak survived L1, then L3 if it
# survived L2; after L3 the ladder resets for the next incident.
RUNG=$(( LAST_RUNG + 1 ))
if [ "$RUNG" -gt 3 ]; then RUNG=1; fi

# Quota storms stay on L1. Re-probing, clearing stickies and topping up the free
# pool are the only responses that can move an upstream rate limit, while L2 has
# no fresh egress IPs to offer and L3 restarts a healthy process — which drops
# every in-flight request for the ~6s the launchd respawn takes (observed
# 2026-10-21: a 429 streak of 9 took the rung straight to L3 and nine client
# requests came back connection-refused). The overrides below still win: a dead
# process or a broken catalog is not quota pressure.
if [ "$QUOTA_ONLY" -eq 1 ] && [ "$LAST_RUNG" -gt 1 ]; then
  say "quota-only streak (all ${STREAK} errors are 429/pool-cooling) — staying on L1 (re-probe + top-up), no restart (previous L$LAST_RUNG)"
fi
if [ "$QUOTA_ONLY" -eq 1 ]; then RUNG=1; fi

# The catalog ladder's C2 hands over to a restart regardless of where the
# traffic ladder happens to be sitting — and so does the dead-man switch: an
# unresponsive gateway needs a restart, not a re-probe.
if [ "$CAT_ESCALATED" = "1" ] || [ "$DEADMAN" -eq 1 ]; then RUNG=3; fi

if [ "$CAT_ESCALATED" = "1" ]; then
  say "ALERT: catalog remediation — forcing L3 (previous L$LAST_RUNG)"
elif [ "$DEADMAN" -eq 1 ]; then
  say "dead-man remediation — forcing L3 (previous L$LAST_RUNG)"
elif [ "${STREAK:-0}" -ge "$THRESHOLD" ]; then
  say "ALERT: $STREAK consecutive errors (newest $(date -r $((NEWEST / 1000)) '+%H:%M:%S' 2>/dev/null)) — remediation L$RUNG (previous L$LAST_RUNG)"
fi

# A dead gateway skips the API-based rungs entirely: restart is the only lever.
if ! gw_up && [ "$RUNG" -lt 3 ]; then
  say "gateway is not answering — escalating straight to L3"
  RUNG=3
fi

# --- L1: 重发会话 — re-probe exits + clear sticky bindings --------------------
if [ "$RUNG" = "1" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "DRY-RUN: would force a pool probe round, top up the free pool, and clear all sticky session bindings"
  else
    curl -s -m 10 -X POST "$GW/admin/pool/probe" -o /dev/null -w "pool probe: %{http_code}\n"
    # A degraded pool is nearly always quota pressure, and the only lasting cure
    # for per-IP quota is more distinct egress IPs: take the free-source top-up
    # in the same rung as the re-probe instead of waiting for the self-heal cadence.
    curl -s -m 30 -X POST "$GW/admin/pool/refresh" -o /dev/null -w "free pool top-up: %{http_code}\n"
    curl -s -m 10 -X POST "$GW/admin/pool/pin" -H 'content-type: application/json' \
      -d '{"id":"none"}' -o /dev/null -w "sticky cleared (pin stays off): %{http_code}\n"
    say "L1 done: exits re-verified, free pool topped up, every session re-dealt by round-robin"
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
    # Snapshot what the CURRENT sidecar actually delivers before touching it.
    # Rotation is only an improvement when it ends with at least as many live
    # ports and distinct egress IPs as it started with: a node library that has
    # run dry answers `gen` with shared-egress aliases (measured 2026-10-21: four
    # freshly picked nodes all exited at one IP, four more timed out), and that
    # "successful" swap would leave the pool with fewer working exits than before.
    PRE_LINE=$(node "$XRAY_SCRIPT" verify --count 10 --base-port 21001 --timeout 8000 | tail -1)
    PRE_LIVE=$(printf '%s' "$PRE_LINE" | sed -n 's/.*live \([0-9]*\)\/10.*/\1/p')
    PRE_IPS=$(printf '%s' "$PRE_LINE" | sed -n 's/.*distinct exit IPs \([0-9]*\).*/\1/p')
    case "$PRE_LIVE" in (*[!0-9]*|"") PRE_LIVE=0 ;; esac
    case "$PRE_IPS" in (*[!0-9]*|"") PRE_IPS=0 ;; esac
    cp -p "$XRAY_CONFIG" "$XRAY_CONFIG.pre-rotate" 2>/dev/null || true

    say "rotating v2ray egress IPs: excluding $(echo "$CUR" | tr ',' ' ' | wc -w | tr -d ' ') current nodes (baseline: ${PRE_LIVE}x live, ${PRE_IPS} distinct exit IP)"
    # gen refuses to write a partial/shared-egress pool and exits non-zero with
    # the reason on stderr — that message belongs in this log, so it is not
    # silenced here.
    if node "$XRAY_SCRIPT" gen --count 10 --base-port 21001 --exclude "$CUR" --out "$XRAY_CONFIG"; then
      launchctl kickstart -k "gui/$(id -u)/$XRAYPOOL_JOB" 2>/dev/null \
        || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$XRAYPOOL_JOB.plist" 2>/dev/null
      sleep 6
      POST_LINE=$(node "$XRAY_SCRIPT" verify --count 10 --base-port 21001 --timeout 8000 | tee /dev/stderr | tail -1)
      POST_LIVE=$(printf '%s' "$POST_LINE" | sed -n 's/.*live \([0-9]*\)\/10.*/\1/p')
      POST_IPS=$(printf '%s' "$POST_LINE" | sed -n 's/.*distinct exit IPs \([0-9]*\).*/\1/p')
      case "$POST_LIVE" in (*[!0-9]*|"") POST_LIVE=0 ;; esac
      case "$POST_IPS" in (*[!0-9]*|"") POST_IPS=0 ;; esac

      if [ "$POST_LIVE" -lt "$PRE_LIVE" ] || [ "$POST_IPS" -lt "$PRE_IPS" ]; then
        say "WARN: rotation is WORSE (live ${POST_LIVE}x/ips ${POST_IPS} < baseline ${PRE_LIVE}x/ips ${PRE_IPS}) — restoring the previous sidecar"
        cp -p "$XRAY_CONFIG.pre-rotate" "$XRAY_CONFIG" 2>/dev/null || true
        launchctl kickstart -k "gui/$(id -u)/$XRAYPOOL_JOB" 2>/dev/null
        sleep 6
        curl -s -m 10 -X POST "$GW/admin/pool/probe" -o /dev/null -w "pool probe after rollback: %{http_code}\n"
        say "sidecar rolled back to the previous node set — falling back to L3"
        RUNG=3
      else
        curl -s -m 10 -X POST "$GW/admin/pool/probe" -o /dev/null -w "pool probe: %{http_code}\n"
        say "L2 done: sidecar regenerated behind unchanged ports 21001-21010 (live ${POST_LIVE}x, distinct exit IPs ${POST_IPS}), exits re-probing"
        write_state 2
        say "remediation complete (L2)"
        exit 0
      fi
    else
      say "WARN: sidecar regeneration refused (no distinct-egress nodes left) — keeping the working config, falling back to L3"
      RUNG=3
    fi
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
# The restart above pulled a fresh catalog, so the catalog ladder starts over
# too — otherwise the next tick would keep counting the outage just cured.
CAT_STREAK=0; CAT_RUNG=0; CAT_TS=0
write_state 0
say "remediation complete (L3, ladder reset)"
