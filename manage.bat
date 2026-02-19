@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"

title Local MCP Browser - 统一管理脚本

:select_version
cls
echo.
echo  ====================================================
echo    Local MCP Browser - 统一管理脚本
echo    浏览器 MCP + 数据库 MCP
echo  ====================================================
echo.
echo    请选择版本:
echo.
echo    1. Cursor   版本
echo    2. Windsurf 版本
echo    0. 退出
echo.
set /p ver=请选择 (0-2): 

if "%ver%"=="1" (
    set VERSION=cursor
    set BROWSER_PM2=cursor-mcp-bridge
    set DB_PM2=cursor-mcp-database
    goto menu
)
if "%ver%"=="2" (
    set VERSION=windsurf
    set BROWSER_PM2=windsurf-mcp-bridge
    set DB_PM2=windsurf-mcp-database
    goto menu
)
if "%ver%"=="0" exit /b 0
echo 无效选择！
timeout /t 2 >nul
goto select_version

:menu
cls
echo.
echo  ====================================================
echo    [%VERSION%] MCP 服务管理 [Browser 3211 + Database 3212]
echo  ====================================================
echo.
echo    1. 启动全部    (PM2 守护，被kill自动重启)
echo    2. 停止全部    (彻底停止，不自动重启)
echo    3. 重启全部
echo    4. 查看状态 + 健康检查
echo    5. 查看日志    (Browser)
echo    6. 查看日志    (Database)
echo    7. 编辑数据库配置
echo    8. 显示 IDE 配置
echo    9. 一键安装    (依赖 + Playwright + 构建)
echo    B. 返回版本选择
echo    0. 退出
echo.
set /p choice=请选择操作: 

if "%choice%"=="1" goto start_all
if "%choice%"=="2" goto stop_all
if "%choice%"=="3" goto restart_all
if "%choice%"=="4" goto status_all
if "%choice%"=="5" goto logs_browser
if "%choice%"=="6" goto logs_database
if "%choice%"=="7" goto edit_db_config
if "%choice%"=="8" goto show_mcp_config
if "%choice%"=="9" goto install_all
if /i "%choice%"=="B" goto select_version
if "%choice%"=="0" exit /b 0

echo 无效的选择！
timeout /t 2 >nul
goto menu

:check_pm2
where pm2 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] PM2 未安装！正在安装...
    call npm install -g pm2
    if %ERRORLEVEL% NEQ 0 (
        echo [错误] PM2 安装失败
        pause
        goto menu
    )
)
exit /b 0

:check_build_browser
if not exist "%~dp0%VERSION%\dist\server.js" (
    echo [提示] Browser 尚未构建，正在自动构建...
    cd /d "%~dp0%VERSION%"
    if not exist "node_modules" (
        echo [提示] 正在安装 Browser 依赖...
        call npm install
    )
    call npm run build
    cd /d "%~dp0"
    if %ERRORLEVEL% NEQ 0 (
        echo [错误] Browser 构建失败！
        pause
        goto menu
    )
)
exit /b 0

:check_build_database
if not exist "%~dp0%VERSION%\mcp-database\dist\server.js" (
    echo [提示] Database 尚未构建，正在自动构建...
    cd /d "%~dp0%VERSION%\mcp-database"
    if not exist "node_modules" (
        echo [提示] 正在安装 Database 依赖...
        call npm install
    )
    call npm run build
    cd /d "%~dp0"
    if %ERRORLEVEL% NEQ 0 (
        echo [错误] Database 构建失败！
        pause
        goto menu
    )
)
exit /b 0

:start_all
cls
echo.
call :check_pm2
call :check_build_browser
call :check_build_database
echo ================================================
echo   [%VERSION%] 启动全部 MCP 服务...
echo ================================================
echo.
echo [1/2] Browser MCP (端口 3211)...
pm2 delete %BROWSER_PM2% >nul 2>&1
cd /d "%~dp0%VERSION%"
pm2 start ecosystem.config.cjs
echo.
echo [2/2] Database MCP (端口 3212)...
pm2 delete %DB_PM2% >nul 2>&1
cd /d "%~dp0%VERSION%\mcp-database"
pm2 start ecosystem.config.cjs
cd /d "%~dp0"
echo.
echo [启动] 全部服务已启动！被 kill 会自动重启。
echo.
timeout /t 5 >nul
echo [验证] 健康检查:
echo.
echo --- Browser MCP ---
node -e "fetch('http://localhost:3211/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('等待中...',e.message))" 2>nul
echo.
echo --- Database MCP ---
node -e "fetch('http://localhost:3212/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('等待中...',e.message))" 2>nul
echo.
pause
goto menu

:stop_all
cls
echo.
echo ================================================
echo   [%VERSION%] 彻底停止全部 MCP 服务...
echo ================================================
echo.
pm2 stop %BROWSER_PM2% >nul 2>&1
pm2 delete %BROWSER_PM2% >nul 2>&1
echo [停止] Browser MCP 已停止。
pm2 stop %DB_PM2% >nul 2>&1
pm2 delete %DB_PM2% >nul 2>&1
echo [停止] Database MCP 已停止。
echo.
timeout /t 2 >nul
goto menu

:restart_all
cls
echo.
call :check_pm2
call :check_build_browser
call :check_build_database
echo ================================================
echo   [%VERSION%] 重启全部 MCP 服务...
echo ================================================
echo.
echo [1/2] Browser MCP...
cd /d "%~dp0%VERSION%"
pm2 restart %BROWSER_PM2% >nul 2>&1 || (
    echo [提示] Browser 未运行，正在启动...
    pm2 start ecosystem.config.cjs
)
echo.
echo [2/2] Database MCP...
cd /d "%~dp0%VERSION%\mcp-database"
pm2 restart %DB_PM2% >nul 2>&1 || (
    echo [提示] Database 未运行，正在启动...
    pm2 start ecosystem.config.cjs
)
cd /d "%~dp0"
echo.
echo [重启] 全部服务已重启！
timeout /t 2 >nul
goto menu

:status_all
cls
echo.
echo ---- PM2 进程状态 ----
pm2 status
echo.
echo ---- Browser MCP (端口 3211) ----
node -e "fetch('http://localhost:3211/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('服务未响应:',e.message))" 2>nul
echo.
echo ---- Database MCP (端口 3212) ----
node -e "fetch('http://localhost:3212/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('服务未响应:',e.message))" 2>nul
echo.
pause
goto menu

:logs_browser
cls
echo.
echo [%VERSION% Browser MCP 日志] 最近 50 行
echo.
pm2 logs %BROWSER_PM2% --lines 50 --nostream
echo.
pause
goto menu

:logs_database
cls
echo.
echo [%VERSION% Database MCP 日志] 最近 50 行
echo.
pm2 logs %DB_PM2% --lines 50 --nostream
echo.
pause
goto menu

:edit_db_config
cd /d "%~dp0%VERSION%\mcp-database"
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [提示] 已从 .env.example 创建 .env 配置文件
    ) else (
        echo [错误] 未找到 .env.example 模板
        pause
        goto menu
    )
)
start notepad .env
cd /d "%~dp0"
goto menu

:show_mcp_config
cls
echo.
echo ================================================
echo   IDE MCP 配置
echo ================================================
echo.
echo --- Cursor 配置 ---
echo 文件: C:\Users\你的用户名\.cursor\mcp.json
echo.
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "url": "http://localhost:3211/mcp"
echo     },
echo     "database": {
echo       "url": "http://localhost:3212/mcp"
echo     }
echo   }
echo }
echo.
echo --- Windsurf 配置 ---
echo 文件: C:\Users\你的用户名\.codeium\windsurf\mcp_config.json
echo.
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "serverUrl": "http://localhost:3211/mcp"
echo     },
echo     "database": {
echo       "serverUrl": "http://localhost:3212/mcp"
echo     }
echo   }
echo }
echo.
pause
goto menu

:install_all
cls
echo.
echo ================================================
echo   [%VERSION%] 一键安装全部
echo ================================================
echo.
echo [1/6] 安装 PM2...
where pm2 >nul 2>&1 || call npm install -g pm2
echo.
echo [2/6] 安装 Browser 依赖...
cd /d "%~dp0%VERSION%"
call npm install
echo.
echo [3/6] 安装 Playwright Chromium...
call npx playwright install chromium
echo.
echo [4/6] 构建 Browser...
call npm run build
echo.
echo [5/6] 安装 Database 依赖...
cd /d "%~dp0%VERSION%\mcp-database"
call npm install
echo.
echo [6/6] 构建 Database...
call npm run build
cd /d "%~dp0"
echo.
if %ERRORLEVEL% EQU 0 (
    echo ================================================
    echo   安装完成！请选择 [1.启动全部] 开始使用
    echo ================================================
) else (
    echo [错误] 安装过程中出现问题，请检查上方日志
)
echo.
pause
goto menu
