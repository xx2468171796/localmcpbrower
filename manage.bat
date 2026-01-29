@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title Windsurf MCP Bridge - 管理控制台
cd /d "%~dp0"

:: 读取当前端口配置
set PORT=3210
if exist ecosystem.config.cjs (
    for /f "tokens=2 delims=: " %%a in ('findstr "PORT:" ecosystem.config.cjs 2^>nul') do set PORT=%%a
    set PORT=!PORT:,=!
)
if "!PORT!"=="" set PORT=3210

:menu
cls
echo.
echo ============================================================
echo           Windsurf MCP Bridge - 管理控制台
echo ============================================================
echo.
echo   当前端口: !PORT!
echo.
echo   [1] 快速启动 (前台运行, 关窗口会停止)
echo   [2] 查看服务状态
echo   [3] 后台启动 (PM2, 推荐, 关窗口不影响)
echo   [4] 停止服务
echo   [5] 重启服务
echo   [6] 查看/复制配置
echo   [7] 更换端口
echo   [8] 查看日志
echo   [9] 环境检测与一键安装
echo   [0] 退出
echo.
set /p choice=请选择操作 [0-9]: 

if "%choice%"=="1" goto quickstart
if "%choice%"=="2" goto status
if "%choice%"=="3" goto start
if "%choice%"=="4" goto stop
if "%choice%"=="5" goto restart
if "%choice%"=="6" goto config
if "%choice%"=="7" goto port
if "%choice%"=="8" goto logs
if "%choice%"=="9" goto env_check
if "%choice%"=="0" goto exit
goto menu

:quickstart
cls
echo.
echo ═══════════════════ 快速启动 ═══════════════════
echo.
echo [配置] 复制以下配置到 Windsurf MCP 设置中:
echo ────────────────────────────────────────────────
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "type": "sse",
echo       "url": "http://localhost:!PORT!/sse"
echo     }
echo   }
echo }
echo ────────────────────────────────────────────────
echo.
echo [地址] 服务地址:
echo    SSE 端点: http://localhost:!PORT!/sse
echo    健康检查: http://localhost:!PORT!/health
echo    DevTools: http://localhost:9222
echo.
echo [启动] 正在启动服务 (按 Ctrl+C 停止)...
echo.
set HEADLESS=false
set DEVTOOLS=true
set PORT=!PORT!
node dist/server.js
pause
goto menu

:status
cls
echo.
echo ═══════════════════ 服务状态 ═══════════════════
echo.
pm2 list
echo.
echo 正在检查健康状态...
curl -s http://localhost:!PORT!/health 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [X] 服务未运行或无法连接
) else (
    echo.
    echo [OK] 服务运行正常
)
echo.
pause
goto menu

:start
cls
echo.
echo ═══════════════════ 启动服务 ═══════════════════
echo.
cd /d "%~dp0"
call pm2 start ecosystem.config.cjs
echo.
echo [OK] 服务已启动
echo.
echo [配置] MCP 配置:
echo ────────────────────────────────────────────────
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "type": "sse",
echo       "url": "http://localhost:!PORT!/sse"
echo     }
echo   }
echo }
echo ────────────────────────────────────────────────
echo.
pause
goto menu

:stop
cls
echo.
echo ═══════════════════ 停止服务 ═══════════════════
echo.
call pm2 stop windsurf-mcp-bridge
echo.
echo [OK] 服务已停止
echo.
pause
goto menu

:restart
cls
echo.
echo ═══════════════════ 重启服务 ═══════════════════
echo.
call pm2 restart windsurf-mcp-bridge
echo.
echo [OK] 服务已重启
echo.
pause
goto menu

:config
cls
echo.
echo ═══════════════════ 当前配置 ═══════════════════
echo.
echo [*] 服务端口: !PORT!
echo [*] SSE 端点: http://localhost:!PORT!/sse
echo [*] 健康检查: http://localhost:!PORT!/health
echo [*] DevTools:  http://localhost:9222
echo.
echo [配置] Windsurf MCP 配置 (复制以下内容):
echo ────────────────────────────────────────────────
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "type": "sse",
echo       "url": "http://localhost:!PORT!/sse"
echo     }
echo   }
echo }
echo ────────────────────────────────────────────────
echo.
echo 📂 配置文件位置:
echo    - ecosystem.config.cjs (PM2配置)
echo    - .env.example (环境变量模板)
echo.
pause
goto menu

:port
cls
echo.
echo ═══════════════════ 更换端口 ═══════════════════
echo.
echo 当前端口: !PORT!
echo.
set /p newport=请输入新端口号: 

if "%newport%"=="" (
    echo [X] 端口号不能为空
    pause
    goto menu
)

echo.
echo 正在更新端口为 %newport%...

:: 更新 ecosystem.config.cjs
powershell -Command "(Get-Content 'ecosystem.config.cjs') -replace 'PORT: \d+', 'PORT: %newport%' | Set-Content 'ecosystem.config.cjs'"

echo.
echo [OK] 端口已更新为 %newport%
echo.
echo [配置] 新的 MCP 配置:
echo ────────────────────────────────────────────────
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "type": "sse",
echo       "url": "http://localhost:%newport%/sse"
echo     }
echo   }
echo }
echo ────────────────────────────────────────────────
echo.
echo [!] 请重启服务以应用新端口
echo.
pause
goto menu

:logs
cls
echo.
echo ═══════════════════ 服务日志 ═══════════════════
echo.
echo 按 Ctrl+C 退出日志查看
echo.
call pm2 logs windsurf-mcp-bridge --lines 50
pause
goto menu

:env_check
cls
echo.
echo ═══════════════════ 环境检测与一键安装 ═══════════════════
echo.
echo [检测] 正在检测运行环境...
echo.

:: 检测 Node.js
node --version >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
    echo [OK] Node.js 已安装: !NODE_VER!
    set NODE_OK=1
) else (
    echo [X] Node.js 未安装
    set NODE_OK=0
)

:: 检测 npm
npm --version >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('npm --version') do set NPM_VER=%%v
    echo [OK] npm 已安装: !NPM_VER!
    set NPM_OK=1
) else (
    echo [X] npm 未安装
    set NPM_OK=0
)

:: 检测 PM2
pm2 --version >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('pm2 --version') do set PM2_VER=%%v
    echo [OK] PM2 已安装: !PM2_VER!
    set PM2_OK=1
) else (
    echo [X] PM2 未安装 (后台运行需要)
    set PM2_OK=0
)

:: 检测 Playwright 浏览器
if exist "%USERPROFILE%\AppData\Local\ms-playwright\chromium-*" (
    echo [OK] Playwright Chromium 浏览器已安装
    set BROWSER_OK=1
) else (
    echo [X] Playwright Chromium 浏览器未安装
    set BROWSER_OK=0
)

echo.
echo ════════════════════════════════════════════════════════════════
echo.

:: 判断是否需要安装
if "%NODE_OK%"=="0" (
    echo [!] 缺少 Node.js, 请先安装 Node.js v18+
    echo     下载地址: https://nodejs.org/
    echo.
    pause
    goto menu
)

if "%PM2_OK%"=="0" (
    echo [安装] 正在安装 PM2 (全局)...
    call npm install -g pm2
    if %errorlevel% equ 0 (
        echo [OK] PM2 安装成功
    ) else (
        echo [X] PM2 安装失败
    )
    echo.
)

if "%BROWSER_OK%"=="0" (
    echo [安装] 正在安装 Playwright Chromium 浏览器...
    call npx playwright install chromium
    if %errorlevel% equ 0 (
        echo [OK] 浏览器安装成功
    ) else (
        echo [X] 浏览器安装失败, 请检查网络连接
    )
    echo.
)

echo ════════════════════════════════════════════════════════════════
echo [OK] 环境检测完成
echo.
pause
goto menu

:exit
echo.
echo 再见
exit /b 0
