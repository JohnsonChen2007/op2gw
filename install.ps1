# op2gw one-click installer + launcher (Windows PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   .\install.ps1 -Pool                 # start with the IP pool enabled
#   .\install.ps1 -Port 9000            # custom port
#   .\install.ps1 -NoStart              # install only
#
# Checks Node >= 20, installs dependencies, builds, then starts the server.

param(
  [switch]$Pool,
  [switch]$NoStart,
  [int]$Port = 8787,
  [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "op2gw — OpenCode Zen 免费网关 · 一键安装" -ForegroundColor Cyan
Write-Host ""

# 1. Node check
try { $nodeVersion = (node -p 'process.versions.node') } catch { throw "未找到 Node.js，请先安装 Node >= 20 (https://nodejs.org)。" }
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 20) { throw "Node 版本过低（当前 v$nodeVersion），需要 >= 20。" }
Write-Host "✓ Node v$nodeVersion" -ForegroundColor Green

# 2. package root
if (-not (Test-Path 'package.json')) { throw "未找到 package.json，请在 op2gw\ 目录内运行。" }

# 3. install deps
Write-Host "▸ 安装依赖…" -ForegroundColor Blue
if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm install } else { npm install --no-audit --no-fund }
Write-Host "✓ 依赖就绪" -ForegroundColor Green

# 4. build
Write-Host "▸ 编译 TypeScript…" -ForegroundColor Blue
npm run build | Out-Null
Write-Host "✓ 编译完成 (dist\)" -ForegroundColor Green

# 5. assemble args
$argsList = @()
if ($Pool) { $argsList += '--pool' }
if ($Port -ne 8787) { $argsList += @('--port', "$Port") }
if ($ExtraArgs) { $argsList += $ExtraArgs }

if ($NoStart) {
  Write-Host ""
  Write-Host "安装完成。启动： npm start" -ForegroundColor Green
  exit 0
}

Write-Host ""
Write-Host "启动 op2gw…" -ForegroundColor Green
Write-Host "  调试台      : http://127.0.0.1:$Port/"
Write-Host "  OpenAI 端点 : http://127.0.0.1:$Port/v1"
Write-Host "  停止        : Ctrl+C"
Write-Host ""

node dist/index.js @argsList
