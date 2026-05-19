# ============================================================
# Claude Code MCP - 服务管理 (Windows PowerShell)
# 无头浏览器(3215) + 有头浏览器(3213) + 数据库(3214)
# 等价于 manage.sh / node mcp.mjs <cmd>
#
# 用法:
#   .\manage.ps1 start   [browser|db|all]
#   .\manage.ps1 stop    [browser|db|all]
#   .\manage.ps1 restart [browser|db|all]
#   .\manage.ps1 status
#   .\manage.ps1 config
# ============================================================
param(
    [Parameter(Position = 0)]
    [string]$Command = 'menu',
    [Parameter(Position = 1)]
    [string]$Target = 'all'
)

$ErrorActionPreference = 'Continue'
$Root  = $PSScriptRoot
$DbDir = Join-Path $Root 'mcp-database'

$Services = @{
    browser = @{ Name = 'claudemcp-headless'; Eco = (Join-Path $Root 'ecosystem.headless.cjs'); Label = '无头浏览器 MCP (3215)' }
    db      = @{ Name = 'claudemcp-database'; Eco = (Join-Path $DbDir 'ecosystem.config.cjs'); Label = '数据库 MCP (3214)' }
}

function Resolve-Targets($t) {
    switch ($t.ToLower()) {
        'all'     { return @('browser', 'db') }
        'browser' { return @('browser') }
        'db'      { return @('db') }
        default   { Write-Error "未知服务: $t (可选: browser | db | all)"; exit 1 }
    }
}

function Start-Services($t) {
    foreach ($key in (Resolve-Targets $t)) {
        $svc = $Services[$key]
        Write-Host "── 启动 $($svc.Label)"
        pm2 delete $svc.Name 2>$null | Out-Null
        pm2 start $svc.Eco
    }
    Show-Status
}

function Stop-Services($t) {
    foreach ($key in (Resolve-Targets $t)) {
        $svc = $Services[$key]
        Write-Host "── 停止 $($svc.Label)"
        pm2 stop $svc.Name 2>$null
        pm2 delete $svc.Name 2>$null
    }
}

function Restart-Services($t) {
    foreach ($key in (Resolve-Targets $t)) {
        $svc = $Services[$key]
        Write-Host "── 重启 $($svc.Label)"
        pm2 restart $svc.Name 2>$null
        if ($LASTEXITCODE -ne 0) { pm2 start $svc.Eco }
    }
    Show-Status
}

function Show-Status {
    Write-Host ''
    Write-Host '── PM2 服务状态'
    pm2 list
}

function Show-Config {
    $browserServer = Join-Path $Root 'dist\server.js'
    $dbServer      = Join-Path $DbDir 'dist\server.js'
    Write-Host '── Claude Code MCP 配置'
    Write-Host ''
    Write-Host '方式 A: stdio 原生模式 (推荐，无需 PM2 / 端口):'
    Write-Host "  claude mcp add browser -- node `"$browserServer`" --stdio"
    Write-Host "  claude mcp add database -e MCP_TRANSPORT=stdio -- node `"$dbServer`" --stdio"
    Write-Host '  也可使用项目根目录的 .mcp.json (见 .mcp.json.example)'
    Write-Host ''
    Write-Host '方式 B: HTTP / PM2 模式:'
    Write-Host '  claude mcp add --transport http browser-headless http://localhost:3215/mcp'
    Write-Host '  claude mcp add --transport http database          http://localhost:3214/mcp'
    Write-Host ''
}

function Show-Menu {
    Write-Host '============================================================'
    Write-Host '  Claude Code MCP 管理器 (Windows)'
    Write-Host '============================================================'
    Write-Host '  1. 启动全部 (无头浏览器 + 数据库)'
    Write-Host '  2. 停止全部'
    Write-Host '  3. 重启全部'
    Write-Host '  4. 查看状态'
    Write-Host '  5. 显示 Claude Code 配置'
    Write-Host '  0. 退出'
    Write-Host '============================================================'
    $sel = Read-Host '请选择'
    switch ($sel) {
        '1' { Start-Services 'all' }
        '2' { Stop-Services 'all' }
        '3' { Restart-Services 'all' }
        '4' { Show-Status }
        '5' { Show-Config }
        '0' { return $false }
        default { }
    }
    return $true
}

switch ($Command.ToLower()) {
    'start'   { Start-Services $Target }
    'stop'    { Stop-Services $Target }
    'restart' { Restart-Services $Target }
    'status'  { Show-Status }
    'config'  { Show-Config }
    'menu'    { while (Show-Menu) { Write-Host '' } }
    default   { Write-Error "未知命令: $Command (可选: start | stop | restart | status | config)"; exit 1 }
}
