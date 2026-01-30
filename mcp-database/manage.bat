@echo off
title MCP Database Bridge Manager

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
set /p choice=Select [0-6]: 

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
echo [START] Starting MCP Database Bridge...
pm2 start ecosystem.config.cjs
echo.
pause
goto menu

:stop
echo.
echo [STOP] Stopping service...
pm2 stop mcp-database-bridge
echo.
pause
goto menu

:restart
echo.
echo [RESTART] Restarting service...
pm2 restart mcp-database-bridge
echo.
pause
goto menu

:status
echo.
echo [STATUS] Service status:
pm2 status mcp-database-bridge
echo.
pause
goto menu

:logs
echo.
echo [LOGS] Live logs (Ctrl+C to exit):
pm2 logs mcp-database-bridge --lines 50
goto menu

:config
echo.
echo [CONFIG] Opening config file...
if not exist .env (
    copy .env.example .env >nul
    echo [INFO] Created .env config file
)
notepad .env
goto menu

:exit
exit /b 0
