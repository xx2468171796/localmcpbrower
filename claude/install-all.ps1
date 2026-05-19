# ============================================================
# Claude Code MCP - 一键安装 (Windows PowerShell)
# 浏览器 MCP + 数据库 MCP
# 等价于 install-all.sh / node mcp.mjs install
# ============================================================
$ErrorActionPreference = 'Stop'
$Root  = $PSScriptRoot
$DbDir = Join-Path $Root 'mcp-database'

Write-Host '============================================================'
Write-Host '  Claude Code MCP - 安装 (Windows)'
Write-Host '  Browser MCP + Database MCP'
Write-Host '============================================================'
Write-Host ''

# ── 检查 Node.js ──
Write-Host '[1/6] 检查 Node.js...'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error '未找到 Node.js，请先安装 Node.js 20+ : https://nodejs.org/'
    exit 1
}
$nodeVer = (node -v).TrimStart('v')
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Error "Node.js 版本过低 (v$nodeVer)，需要 >= 20"
    exit 1
}
Write-Host "[OK] Node.js v$nodeVer"
Write-Host ''

# ── 检查 PM2 (HTTP 模式需要) ──
Write-Host '[2/6] 检查 PM2...'
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host '[INFO] 安装 PM2...'
    npm install -g pm2
}
Write-Host '[OK] PM2 已就绪'
Write-Host ''

# ── 浏览器 MCP 依赖 ──
Write-Host '[3/6] 安装浏览器 MCP 依赖...'
Push-Location $Root
npm install
Write-Host '[OK] 浏览器 MCP 依赖安装完成'
Write-Host ''

# ── Playwright Chromium ──
Write-Host '[4/6] 安装 Playwright Chromium...'
npx playwright install chromium
Write-Host '[OK] Chromium 安装完成'
Write-Host ''

# ── 构建浏览器 MCP ──
Write-Host '[5/6] 构建浏览器 MCP...'
npm run build
Write-Host '[OK] 浏览器 MCP 构建完成'
Pop-Location
Write-Host ''

# ── 数据库 MCP ──
Write-Host '[6/6] 安装并构建数据库 MCP...'
Push-Location $DbDir
npm install
npm run build
if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host '[INFO] 已创建数据库配置: mcp-database\.env，请填写连接信息'
}
Pop-Location
Write-Host '[OK] 数据库 MCP 构建完成'
Write-Host ''

Write-Host '============================================================'
Write-Host '  安装完成！'
Write-Host '============================================================'
Write-Host ''
Write-Host '后续步骤:'
Write-Host '  推荐 (stdio 原生):  node mcp.mjs config   获取 Claude Code 配置命令'
Write-Host '  HTTP / PM2 模式:    .\manage.ps1 start    或  node mcp.mjs start'
Write-Host ''
