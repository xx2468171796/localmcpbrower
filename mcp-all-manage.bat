@echo off
chcp 65001 >nul
title MCP 服务总管理

:menu
cls
echo ========================================
echo   MCP 服务总管理 (浏览器 + 数据库)
echo ========================================
echo.
echo   端口分配:
echo     - 浏览器 MCP: 3211
echo     - 数据库 MCP: 3212
echo.
echo ========================================
echo   [全部操作]
echo   1. 启动全部服务
echo   2. 停止全部服务
echo   3. 重启全部服务
echo   4. 查看全部状态
echo.
echo   [单独操作]
echo   5. 管理浏览器 MCP
echo   6. 管理数据库 MCP
echo.
echo   [配置]
echo   7. 编辑数据库配置 (.env)
echo   8. 查看 MCP 配置说明
echo.
echo   0. 退出
echo ========================================
set /p choice=请选择操作 [0-8]: 

if "%choice%"=="1" goto start_all
if "%choice%"=="2" goto stop_all
if "%choice%"=="3" goto restart_all
if "%choice%"=="4" goto status_all
if "%choice%"=="5" goto browser_manage
if "%choice%"=="6" goto database_manage
if "%choice%"=="7" goto edit_db_config
if "%choice%"=="8" goto show_mcp_config
if "%choice%"=="0" goto exit
goto menu

:start_all
echo.
echo [启动] 正在启动全部 MCP 服务...
echo.
echo [1/2] 启动浏览器 MCP...
cd /d "%~dp0"
pm2 start ecosystem.config.cjs
echo.
echo [2/2] 启动数据库 MCP...
cd /d "%~dp0mcp-database"
pm2 start ecosystem.config.cjs
echo.
echo [完成] 全部服务已启动!
pm2 status
echo.
pause
goto menu

:stop_all
echo.
echo [停止] 正在停止全部 MCP 服务...
pm2 stop windsurf-mcp-bridge mcp-database-bridge
echo.
pause
goto menu

:restart_all
echo.
echo [重启] 正在重启全部 MCP 服务...
pm2 restart windsurf-mcp-bridge mcp-database-bridge
echo.
pause
goto menu

:status_all
echo.
echo [状态] 全部服务状态:
echo.
pm2 status
echo.
pause
goto menu

:browser_manage
echo.
cd /d "%~dp0"
call manage.bat
goto menu

:database_manage
echo.
cd /d "%~dp0mcp-database"
call manage.bat
goto menu

:edit_db_config
echo.
cd /d "%~dp0mcp-database"
if not exist .env (
    copy .env.example .env >nul
    echo [提示] 已创建数据库配置文件
)
notepad .env
goto menu

:show_mcp_config
cls
echo ========================================
echo   MCP 配置说明 (Windsurf/Cursor)
echo ========================================
echo.
echo 配置文件位置:
echo   Windsurf: C:\Users\用户名\.codeium\windsurf\mcp_config.json
echo   Cursor:   C:\Users\用户名\.cursor\mcp.json
echo.
echo 配置内容 (复制以下 JSON):
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
echo ========================================
echo.
pause
goto menu

:exit
exit /b 0
