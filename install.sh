#!/usr/bin/env bash
#
# op2gw one-click installer + launcher (macOS / Linux).
#
#   curl -fsSL .../install.sh | bash          # install & start with defaults
#   ./install.sh                              # from a cloned repo
#   ./install.sh --pool                       # start with the IP pool enabled
#   ./install.sh --port 9000                  # custom port
#   ./install.sh --no-start                   # install only, don't launch
#
# It checks Node >= 20, installs dependencies, builds, then starts the server.
# Re-running is safe (idempotent): it reuses an existing install.

set -euo pipefail

# --- resolve script dir (works when piped or executed) ---
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SCRIPT_DIR="$(pwd)"
fi
cd "$SCRIPT_DIR"

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { printf "${BLUE}▸${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}!${NC} %s\n" "$1"; }
die()   { printf "${RED}✗ %s${NC}\n" "$1" >&2; exit 1; }

# --- args ---
START=1
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

printf "\n${BOLD}op2gw${NC} — OpenCode Zen 免费网关 · 一键安装\n\n"

# --- 1. Node check ---
command -v node >/dev/null 2>&1 || die "未找到 Node.js。请先安装 Node >= 20 (https://nodejs.org)。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "Node 版本过低（当前 $(node -v)），需要 >= 20。"
fi
ok "Node $(node -v)"

# --- 2. locate package root ---
if [[ ! -f package.json ]]; then
  die "未在当前目录找到 package.json。请在 op2gw/ 目录内运行本脚本。"
fi

# --- 3. install deps ---
info "安装依赖…"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --silent 2>&1 | tail -3 || pnpm install
elif command -v npm >/dev/null 2>&1; then
  npm install --no-audit --no-fund 2>&1 | tail -3
else
  die "未找到 npm 或 pnpm。"
fi
ok "依赖就绪"

# --- 4. build ---
info "编译 TypeScript…"
npm run build >/dev/null 2>&1 || die "编译失败，请运行 'npm run build' 查看详细错误。"
ok "编译完成 (dist/)"

# --- 5. done / start ---
PORT="8787"
for ((i=0; i<${#EXTRA_ARGS[@]}; i++)); do
  if [[ "${EXTRA_ARGS[$i]}" == "--port" ]]; then PORT="${EXTRA_ARGS[$((i+1))]:-8787}"; fi
done

if [[ "$START" -eq 0 ]]; then
  printf "\n${GREEN}${BOLD}安装完成。${NC}\n"
  printf "启动： ${BOLD}npm start${NC}   或   ${BOLD}node dist/index.js${NC}\n\n"
  exit 0
fi

printf "\n${GREEN}${BOLD}启动 op2gw…${NC}\n"
printf "  调试台      : ${BOLD}http://127.0.0.1:%s/${NC}\n" "$PORT"
printf "  OpenAI 端点 : ${BOLD}http://127.0.0.1:%s/v1${NC}\n" "$PORT"
printf "  停止        : Ctrl+C\n\n"

exec node dist/index.js "${EXTRA_ARGS[@]}"
