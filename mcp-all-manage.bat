@echo off
title MCP Bridge Manager

:menu
cls
echo ========================================
echo   MCP Bridge Manager (Browser + Database)
echo ========================================
echo.
echo   Ports:
echo     - Browser MCP: 3211
echo     - Database MCP: 3212
echo.
echo ========================================
echo   [All Services]
echo   1. Start All
echo   2. Stop All
echo   3. Restart All
echo   4. Status
echo.
echo   [Individual]
echo   5. Browser MCP
echo   6. Database MCP
echo.
echo   [Config]
echo   7. Edit Database Config (.env)
echo   8. Show MCP Config
echo.
echo   0. Exit
echo ========================================
set /p choice=Select [0-8]: 

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
echo [START] Starting all MCP services...
echo.
echo [1/2] Starting Browser MCP...
cd /d "%~dp0"
pm2 start ecosystem.config.cjs
echo.
echo [2/2] Starting Database MCP...
cd /d "%~dp0mcp-database"
pm2 start ecosystem.config.cjs
echo.
echo [DONE] All services started!
pm2 status
echo.
pause
goto menu

:stop_all
echo.
echo [STOP] Stopping all MCP services...
pm2 stop windsurf-mcp-bridge mcp-database-bridge
echo.
pause
goto menu

:restart_all
echo.
echo [RESTART] Restarting all MCP services...
pm2 restart windsurf-mcp-bridge mcp-database-bridge
echo.
pause
goto menu

:status_all
echo.
echo [STATUS] All services:
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
    echo [INFO] Database config file created
)
notepad .env
goto menu

:show_mcp_config
cls
echo ========================================
echo   MCP Config (Windsurf/Cursor)
echo ========================================
echo.
echo Config file location:
echo   Windsurf: C:\Users\USERNAME\.codeium\windsurf\mcp_config.json
echo   Cursor:   C:\Users\USERNAME\.cursor\mcp.json
echo.
echo Config content (copy JSON below):
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
