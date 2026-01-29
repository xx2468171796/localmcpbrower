@echo off
chcp 65001 >nul
title MCP Database Bridge 服务管理

:menu
cls
echo ========================================
echo   MCP Database Bridge 服务管理
echo ========================================
echo.
echo   1. 启动服务
echo   2. 停止服务
echo   3. 重启服务
echo   4. 查看状态
echo   5. 查看日志
echo   6. 编辑配置
echo   0. 退出
echo.
echo ========================================
set /p choice=请选择操作 [0-6]: 

if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto restart
if "%choice%"=="4" goto status
if "%choice%"=="5" goto logs
if "%choice%"=="6" goto config
if "%choice%"=="0" goto exit
goto menu

:start
echo.
echo [启动] 正在启动 MCP Database Bridge...
pm2 start ecosystem.config.cjs
echo.
pause
goto menu

:stop
echo.
echo [停止] 正在停止服务...
pm2 stop mcp-database-bridge
echo.
pause
goto menu

:restart
echo.
echo [重启] 正在重启服务...
pm2 restart mcp-database-bridge
echo.
pause
goto menu

:status
echo.
echo [状态] 服务状态:
pm2 status mcp-database-bridge
echo.
pause
goto menu

:logs
echo.
echo [日志] 实时日志 (Ctrl+C 退出):
pm2 logs mcp-database-bridge --lines 50
goto menu

:config
echo.
echo [配置] 打开配置文件...
if not exist .env (
    copy .env.example .env >nul
    echo [提示] 已创建 .env 配置文件
)
notepad .env
goto menu

:exit
exit /b 0
