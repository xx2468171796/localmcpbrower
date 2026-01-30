@echo off
setlocal enabledelayedexpansion
title MCP Bridge Manager
cd /d "%~dp0"

:menu
cls
echo ========================================
echo   MCP Bridge Manager [Browser + Database]
echo ========================================
echo.
echo   Ports:
echo     Browser MCP: 3211
echo     Database MCP: 3212
echo.
echo ========================================
echo   1. Start All
echo   2. Stop All
echo   3. Restart All
echo   4. Status
echo   5. Browser MCP
echo   6. Database MCP
echo   7. Edit DB Config
echo   8. Show MCP Config
echo   0. Exit
echo ========================================
echo.
choice /c 123456780 /n /m "Select [0-8]: "
set sel=%errorlevel%

if %sel%==1 goto start_all
if %sel%==2 goto stop_all
if %sel%==3 goto restart_all
if %sel%==4 goto status_all
if %sel%==5 goto browser_manage
if %sel%==6 goto database_manage
if %sel%==7 goto edit_db_config
if %sel%==8 goto show_mcp_config
if %sel%==9 goto exit
goto menu

:start_all
cls
echo ========================================
echo   Starting All MCP Services...
echo ========================================
echo.
echo [1/2] Browser MCP...
cd /d "%~dp0"
call pm2 start ecosystem.config.cjs
if errorlevel 1 (
    echo [ERROR] Browser MCP start failed!
)
echo.
echo [2/2] Database MCP...
cd /d "%~dp0mcp-database"
call pm2 start ecosystem.config.cjs
if errorlevel 1 (
    echo [ERROR] Database MCP start failed!
)
echo.
echo ========================================
echo   Status:
echo ========================================
call pm2 status
echo.
echo Press any key to continue...
pause >nul
goto menu

:stop_all
cls
echo ========================================
echo   Stopping All MCP Services...
echo ========================================
echo.
call pm2 stop windsurf-mcp-bridge mcp-database-bridge
echo.
echo Press any key to continue...
pause >nul
goto menu

:restart_all
cls
echo ========================================
echo   Restarting All MCP Services...
echo ========================================
echo.
echo [1/2] Browser MCP...
cd /d "%~dp0"
call pm2 restart ecosystem.config.cjs 2>nul
if errorlevel 1 (
    echo [INFO] Process not found, starting instead...
    call pm2 start ecosystem.config.cjs
)
echo.
echo [2/2] Database MCP...
cd /d "%~dp0mcp-database"
call pm2 restart ecosystem.config.cjs 2>nul
if errorlevel 1 (
    echo [INFO] Process not found, starting instead...
    call pm2 start ecosystem.config.cjs
)
echo.
echo ========================================
echo   Status:
echo ========================================
call pm2 status
echo.
echo Press any key to continue...
pause >nul
goto menu

:status_all
cls
echo ========================================
echo   All Services Status [Live Monitor]
echo ========================================
echo   Press any key to stop monitoring...
echo ========================================
echo.

:status_loop
cls
echo ========================================
echo   MCP Bridge Status - %date% %time%
echo ========================================
echo.
echo [PM2 Processes]
call pm2 list 2>nul
echo.
echo [Browser MCP - Port 3211]
curl.exe -s http://localhost:3211/health 2>nul
echo.
echo.
echo [Database MCP - Port 3212]
curl.exe -s http://localhost:3212/health 2>nul
echo.
echo.
echo ========================================
echo   Refreshing in 3 seconds...
echo   Press any key to return to menu
echo ========================================
timeout /t 3 /nobreak >nul 2>nul
if errorlevel 1 goto menu
goto status_loop

:browser_manage
cd /d "%~dp0"
call manage.bat
goto menu

:database_manage
cd /d "%~dp0mcp-database"
call manage.bat
goto menu

:edit_db_config
cd /d "%~dp0mcp-database"
if not exist .env (
    copy .env.example .env >nul
    echo [INFO] Database config file created
)
start notepad .env
goto menu

:show_mcp_config
cls
echo ========================================
echo   MCP Config [Windsurf/Cursor]
echo ========================================
echo.
echo Config file location:
echo   Windsurf: C:\Users\USERNAME\.codeium\windsurf\mcp_config.json
echo   Cursor:   C:\Users\USERNAME\.cursor\mcp.json
echo.
echo Config content:
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
echo Press any key to continue...
pause >nul
goto menu

:exit
endlocal
exit /b 0
