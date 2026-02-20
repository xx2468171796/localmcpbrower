@echo off
title Windsurf MCP Service Manager
cd /d "%~dp0"

set BROWSER_NAME=windsurf-mcp-bridge
set DB_NAME=windsurf-mcp-database
set BROWSER_PORT=3211
set DB_PORT=3212

:menu
cls
echo.
echo  ====================================================
echo    Windsurf MCP Service Manager
echo    Browser: port %BROWSER_PORT%  Database: port %DB_PORT%
echo  ====================================================
echo.
echo    [1] Start All
echo    [2] Stop All
echo    [3] Restart All
echo    [4] Status
echo    [5] Logs - Browser
echo    [6] Logs - Database
echo    [7] Edit Database Config
echo    [8] Show IDE Config
echo    [9] Full Install
echo    [0] Exit
echo.
choice /c 1234567890 /n /m "Press a number: "

if errorlevel 10 goto do_exit
if errorlevel 9 goto do_install
if errorlevel 8 goto do_ide_config
if errorlevel 7 goto do_edit_db
if errorlevel 6 goto do_logs_db
if errorlevel 5 goto do_logs_browser
if errorlevel 4 goto do_status
if errorlevel 3 goto do_restart
if errorlevel 2 goto do_stop
if errorlevel 1 goto do_start
goto menu

REM ========== EXIT ==========
:do_exit
echo Bye!
exit /b 0

REM ========== START ALL ==========
:do_start
cls
echo.
echo ================================================
echo   Starting all services...
echo ================================================
echo.

if not exist "%~dp0dist\server.js" (
    echo [WARN] Browser not built. Run [9] Full Install first.
    echo.
    pause
    goto menu
)
if not exist "%~dp0mcp-database\dist\server.js" (
    echo [WARN] Database not built. Run [9] Full Install first.
    echo.
    pause
    goto menu
)

echo [1/2] Starting Browser MCP...
pm2 delete %BROWSER_NAME% >nul 2>&1
cd /d "%~dp0"
pm2 start ecosystem.config.cjs
echo.

echo [2/2] Starting Database MCP...
pm2 delete %DB_NAME% >nul 2>&1
cd /d "%~dp0mcp-database"
pm2 start ecosystem.config.cjs
cd /d "%~dp0"
echo.

echo [OK] All services started. Waiting 5s...
timeout /t 5 /nobreak >nul
goto do_status

REM ========== STOP ALL ==========
:do_stop
cls
echo.
echo ================================================
echo   Stopping all services...
echo ================================================
echo.
pm2 stop %BROWSER_NAME% >nul 2>&1
pm2 delete %BROWSER_NAME% >nul 2>&1
echo [OK] Browser MCP stopped.
pm2 stop %DB_NAME% >nul 2>&1
pm2 delete %DB_NAME% >nul 2>&1
echo [OK] Database MCP stopped.
echo.
goto do_status

REM ========== RESTART ALL ==========
:do_restart
cls
echo.
echo ================================================
echo   Restarting all services...
echo ================================================
echo.

echo [1/2] Restarting Browser MCP...
cd /d "%~dp0"
pm2 delete %BROWSER_NAME% >nul 2>&1
pm2 start ecosystem.config.cjs
echo.

echo [2/2] Restarting Database MCP...
cd /d "%~dp0mcp-database"
pm2 delete %DB_NAME% >nul 2>&1
pm2 start ecosystem.config.cjs
cd /d "%~dp0"
echo.

echo [OK] All services restarted. Waiting 5s...
timeout /t 5 /nobreak >nul
goto do_status

REM ========== STATUS ==========
:do_status
cls
echo.
echo ================================================
echo   Current Status
echo ================================================
echo.
echo ---- PM2 Processes ----
pm2 status 2>nul
echo.
echo ---- Browser MCP (port %BROWSER_PORT%) ----
node -e "fetch('http://localhost:%BROWSER_PORT%/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('  Not responding:',e.message))" 2>nul
echo.
echo ---- Database MCP (port %DB_PORT%) ----
node -e "fetch('http://localhost:%DB_PORT%/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('  Not responding:',e.message))" 2>nul
echo.
echo ================================================
echo   Press any key to return to menu...
echo ================================================
pause >nul
goto menu

REM ========== LOGS BROWSER ==========
:do_logs_browser
cls
echo.
echo ---- Browser MCP Logs (last 50 lines) ----
echo.
pm2 logs %BROWSER_NAME% --lines 50 --nostream 2>nul
echo.
echo ================================================
echo   Press any key to return to menu...
echo ================================================
pause >nul
goto menu

REM ========== LOGS DATABASE ==========
:do_logs_db
cls
echo.
echo ---- Database MCP Logs (last 50 lines) ----
echo.
pm2 logs %DB_NAME% --lines 50 --nostream 2>nul
echo.
echo ================================================
echo   Press any key to return to menu...
echo ================================================
pause >nul
goto menu

REM ========== EDIT DB CONFIG ==========
:do_edit_db
cls
cd /d "%~dp0mcp-database"
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [INFO] Created .env from .env.example
    ) else (
        echo [ERROR] .env.example not found
    )
)
if exist .env (
    echo [INFO] Opening .env in notepad...
    start notepad .env
)
cd /d "%~dp0"
echo.
echo ================================================
echo   Press any key to return to menu...
echo ================================================
pause >nul
goto menu

REM ========== SHOW IDE CONFIG ==========
:do_ide_config
cls
echo.
echo ================================================
echo   Windsurf IDE Config
echo ================================================
echo.
echo   File: C:\Users\YOUR_USERNAME\.codeium\windsurf\mcp_config.json
echo.
echo   {
echo     "mcpServers": {
echo       "stable-browser": {
echo         "serverUrl": "http://localhost:%BROWSER_PORT%/mcp"
echo       },
echo       "database": {
echo         "serverUrl": "http://localhost:%DB_PORT%/mcp"
echo       }
echo     }
echo   }
echo.
echo ================================================
echo   Press any key to return to menu...
echo ================================================
pause >nul
goto menu

REM ========== FULL INSTALL ==========
:do_install
cls
echo.
echo ================================================
echo   Full Install
echo ================================================
echo.

echo [1/6] Checking PM2...
where pm2 >nul 2>&1
if errorlevel 1 (
    echo        Installing PM2...
    call npm install -g pm2
)
echo        PM2 OK
echo.

echo [2/6] Installing Browser dependencies...
cd /d "%~dp0"
call npm install
echo.

echo [3/6] Installing Playwright Chromium...
call npx playwright install chromium
echo.

echo [4/6] Building Browser MCP...
call npm run build
echo.

echo [5/6] Installing Database dependencies...
cd /d "%~dp0mcp-database"
call npm install
echo.

echo [6/6] Building Database MCP...
call npm run build
cd /d "%~dp0"
echo.

echo ================================================
echo   Install complete! Press any key, then use [1] to start.
echo ================================================
pause >nul
goto menu
