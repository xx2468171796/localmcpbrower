@echo off
setlocal
title MCP Bridge Manager
cd /d "%~dp0"

set PORT=3211

:menu
cls
echo.
echo ========================================
echo     Windsurf MCP Bridge Manager
echo ========================================
echo.
echo   Port: %PORT%
echo.
echo   1. Start (PM2 Background)
echo   2. Stop
echo   3. Restart
echo   4. Status
echo   5. Config
echo   6. Logs
echo   7. Connection Check
echo   8. Install PM2
echo   9. Install Browser
echo   0. Exit
echo.
choice /c 1234567890 /n /m "Select: "

if %errorlevel%==10 goto quit
if %errorlevel%==9 goto install_browser
if %errorlevel%==8 goto install_pm2
if %errorlevel%==7 goto connection
if %errorlevel%==6 goto logs
if %errorlevel%==5 goto config
if %errorlevel%==4 goto status
if %errorlevel%==3 goto restart
if %errorlevel%==2 goto stop
if %errorlevel%==1 goto start
goto menu

:start
cls
echo Starting service...
call pm2 start ecosystem.config.cjs
echo.
echo MCP Config:
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "type": "sse",
echo       "url": "http://localhost:%PORT%/sse"
echo     }
echo   }
echo }
echo.
pause
goto menu

:stop
cls
echo Stopping service...
call pm2 stop windsurf-mcp-bridge
echo Done.
pause
goto menu

:restart
cls
echo Restarting service...
call pm2 restart windsurf-mcp-bridge
echo Done.
pause
goto menu

:status
cls
echo ========================================
echo     Service Status (Live Monitor)
echo ========================================
echo.
echo Press Ctrl+C to exit, then any key to return to menu.
echo.
echo Watching connections... (updates every 2 seconds)
echo.
:status_loop
cls
echo ========================================
echo        MCP Bridge - %time%
echo ========================================
echo.
echo [PM2]
call pm2 list 2>nul
echo.
echo [Lian Jie]
curl.exe -s http://localhost:%PORT%/connections 2>nul
echo.
echo.
echo [Jian Kang]
curl.exe -s http://localhost:%PORT%/health 2>nul
echo.
echo.
echo ----------------------------------------
echo 2 miao shua xin... (Ctrl+C ting zhi)
timeout /t 2 /nobreak >nul
goto status_loop

:config
cls
echo.
echo ========================================
echo           MCP Bridge Config
echo ========================================
echo.
echo Port: %PORT%
echo.
echo [Local IPs]
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do echo   %%b
)
echo.
echo [Local Config]
echo   http://localhost:%PORT%/sse
echo.
echo [Remote Config - use your IP]
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "type": "sse",
echo       "url": "http://YOUR_IP:%PORT%/sse"
echo     }
echo   }
echo }
echo.
pause
goto menu

:logs
cls
echo Viewing logs (Ctrl+C to exit):
echo.
call pm2 logs windsurf-mcp-bridge --lines 50
pause
goto menu

:connection
cls
echo ========================================
echo     Connection Check
echo ========================================
echo.
echo Checking health endpoint...
echo.
curl.exe -s http://localhost:%PORT%/health
echo.
echo.
echo ----------------------------------------
echo Recent SSE Connections (last 10 lines):
echo ----------------------------------------
call pm2 logs windsurf-mcp-bridge --lines 10 --nostream 2>nul | findstr /i "SSE"
echo.
echo ----------------------------------------
echo If browserAlive=true, service is ready.
echo If you see "sessionId", clients are connected.
echo ----------------------------------------
echo.
pause
goto menu

:install_pm2
cls
echo Installing PM2...
call npm install -g pm2
echo Done.
pause
goto menu

:install_browser
cls
echo Installing Playwright Browser...
call npx playwright install chromium
echo Done.
pause
goto menu

:quit
endlocal
exit /b 0
