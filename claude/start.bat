@echo off
REM ============================================================
REM Claude Code MCP - 启动 (Windows)
REM 委托给跨平台 Node CLI: mcp.mjs
REM
REM   start.bat            启动全部 (HTTP/PM2 常驻，推荐形态)
REM   start.bat browser    仅启动浏览器 MCP
REM   start.bat db         仅启动数据库 MCP
REM
REM HTTP 常驻是推荐形态: 一个服务一份浏览器,所有客户端窗口共享登录态,
REM 每个会话自动分到独立标签页互不干扰。默认只绑 127.0.0.1。
REM 注册客户端端点: node mcp.mjs config   (stdio 为备用形态,同样在该命令里给出)
REM ============================================================
setlocal
cd /d "%~dp0"
node mcp.mjs start %*
endlocal
