@echo off
REM ============================================================
REM Claude Code MCP - 启动 (Windows)
REM 委托给跨平台 Node CLI: mcp.mjs
REM
REM   start.bat            启动全部 (HTTP/PM2 模式)
REM   start.bat browser    仅启动浏览器 MCP
REM   start.bat db         仅启动数据库 MCP
REM
REM 推荐 stdio 原生模式 (无需 PM2): 运行  node mcp.mjs config
REM ============================================================
setlocal
cd /d "%~dp0"
node mcp.mjs start %*
endlocal
