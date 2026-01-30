@echo off
setlocal
title MCP Database Bridge Manager
cd /d "%~dp0"

:menu
cls
echo ========================================
echo   MCP Database Bridge Manager
echo ========================================
echo.
echo   1. Start
echo   2. Stop
echo   3. Restart
echo   4. Status
echo   5. Logs
echo   6. Edit Config
echo   0. Exit
echo.
echo ========================================
echo.
choice /c 1234560 /n /m "Select [0-6]: "
set sel=%errorlevel%

if %sel%==1 goto start
if %sel%==2 goto stop
if %sel%==3 goto restart
if %sel%==4 goto status
if %sel%==5 goto logs
if %sel%==6 goto config
if %sel%==7 goto exit
goto menu

:start
cls
echo ========================================
echo   Starting MCP Database Bridge...
echo ========================================
echo.
call pm2 start ecosystem.config.cjs
echo.
call pm2 status mcp-database-bridge
echo.
echo Press any key to continue...
pause >nul
goto menu

:stop
cls
echo ========================================
echo   Stopping MCP Database Bridge...
echo ========================================
echo.
call pm2 stop mcp-database-bridge
echo.
echo Press any key to continue...
pause >nul
goto menu

:restart
cls
echo ========================================
echo   Restarting MCP Database Bridge...
echo ========================================
echo.
call pm2 restart mcp-database-bridge
echo.
echo Press any key to continue...
pause >nul
goto menu

:status
cls
echo ========================================
echo   Service Status:
echo ========================================
echo.
call pm2 status mcp-database-bridge
echo.
echo Press any key to continue...
pause >nul
goto menu

:logs
cls
echo ========================================
echo   Live Logs [Ctrl+C to exit]
echo ========================================
echo.
call pm2 logs mcp-database-bridge --lines 50
echo.
echo Press any key to continue...
pause >nul
goto menu

:config
if not exist .env (
    copy .env.example .env >nul
    echo [INFO] Created .env config file
)
start notepad .env
goto menu

:exit
endlocal
exit /b 0
