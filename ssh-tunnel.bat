@echo off
chcp 65001 >nul
title SSH Tunnel to MCP Bridge

echo ╔═══════════════════════════════════════════════════╗
echo ║          SSH 隧道连接脚本                         ║
echo ╚═══════════════════════════════════════════════════╝
echo.

REM 配置区 - 根据你的实际情况修改
set REMOTE_USER=root
set REMOTE_HOST=192.168.110.253
set LOCAL_PORT=3211
set REMOTE_PORT=3211

echo [配置信息]
echo   远程服务器: %REMOTE_USER%@%REMOTE_HOST%
echo   本地端口:   %LOCAL_PORT%
echo   远程端口:   %REMOTE_PORT%
echo.
echo [说明] 此隧道会把本地MCP服务(localhost:%LOCAL_PORT%)
echo        映射到远程服务器的 localhost:%REMOTE_PORT%
echo.
echo        远程服务器MCP配置应使用: http://localhost:%REMOTE_PORT%/sse
echo.
echo 按任意键开始连接...
pause >nul

:connect
echo.
echo [%time%] 正在建立SSH隧道...
ssh -R %REMOTE_PORT%:localhost:%LOCAL_PORT% %REMOTE_USER%@%REMOTE_HOST% -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes

echo.
echo [%time%] 连接断开，5秒后重连...
timeout /t 5 /nobreak >nul
goto connect
