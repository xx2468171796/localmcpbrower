@echo off
setlocal enabledelayedexpansion
title MCP Bridge
cd /d "%~dp0"

set PORT=3210

:menu
cls
echo.
echo  ====== Windsurf MCP Bridge ======
echo.
echo  Port: %PORT%
echo.
echo  [1] Start Server
echo  [2] PM2 Start
echo  [3] PM2 Stop
echo  [4] Show Config
echo  [5] Install PM2
echo  [6] Install Browser
echo  [0] Exit
echo.
set /p c=Choice: 

if "%c%"=="1" goto run
if "%c%"=="2" goto pm2start
if "%c%"=="3" goto pm2stop
if "%c%"=="4" goto config
if "%c%"=="5" goto installpm2
if "%c%"=="6" goto installbrowser
if "%c%"=="0" exit /b 0
goto menu

:run
cls
echo Starting server on port %PORT%...
set PORT=%PORT%
node dist/server.js
pause
goto menu

:pm2start
cls
pm2 start ecosystem.config.cjs
pause
goto menu

:pm2stop
cls
pm2 stop windsurf-mcp-bridge
pause
goto menu

:config
cls
echo.
echo  MCP Config:
echo  {
echo    "mcpServers": {
echo      "stable-browser": {
echo        "type": "sse",
echo        "url": "http://localhost:%PORT%/sse"
echo      }
echo    }
echo  }
echo.
pause
goto menu

:installpm2
cls
echo Installing PM2...
npm install -g pm2
pause
goto menu

:installbrowser
cls
echo Installing Playwright browser...
npx playwright install chromium
pause
goto menu
