@echo off
REM ============================================================
REM Claude Code MCP - 停止 (Windows)
REM 委托给跨平台 Node CLI: mcp.mjs
REM
REM   stop.bat            停止全部
REM   stop.bat browser    仅停止浏览器 MCP
REM   stop.bat db         仅停止数据库 MCP
REM ============================================================
setlocal
cd /d "%~dp0"
node mcp.mjs stop %*
endlocal
