@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set BROWSER_NAME=cursor-mcp-bridge
set DB_NAME=cursor-mcp-database
set BROWSER_PORT=3211
set DB_PORT=3212

title Cursor MCP Service Manager [Browser + Database]

:menu
cls
echo.
echo  ====================================================
echo    Cursor MCP Service Manager [Browser %BROWSER_PORT% + Database %DB_PORT%]
echo  ====================================================
echo.
echo    1. Start All     (PM2 daemon, auto-restart on kill)
echo    2. Stop All      (Full stop, no auto-restart)
echo    3. Restart All
echo    4. Status + Health Check
echo    5. View Logs     (Browser)
echo    6. View Logs     (Database)
echo    7. Edit Database Config
echo    8. Show IDE Config
echo    9. Full Install  (deps + Playwright + build)
echo    0. Exit
echo.
set /p choice=Select option (0-9): 

if "%choice%"=="1" goto start_all
if "%choice%"=="2" goto stop_all
if "%choice%"=="3" goto restart_all
if "%choice%"=="4" goto status_all
if "%choice%"=="5" goto logs_browser
if "%choice%"=="6" goto logs_database
if "%choice%"=="7" goto edit_db_config
if "%choice%"=="8" goto show_mcp_config
if "%choice%"=="9" goto install_all
if "%choice%"=="0" exit /b 0

echo Invalid selection!
timeout /t 2 >nul
goto menu

:check_pm2
where pm2 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] PM2 not installed! Installing...
    call npm install -g pm2
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] PM2 installation failed
        pause
        goto menu
    )
)
exit /b 0

:check_build_browser
if not exist "%~dp0dist\server.js" (
    echo [INFO] Browser not built yet, building now...
    cd /d "%~dp0"
    if not exist "node_modules" (
        echo [INFO] Installing Browser dependencies...
        call npm install
    )
    call npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Browser build failed!
        pause
        goto menu
    )
)
exit /b 0

:check_build_database
if not exist "%~dp0mcp-database\dist\server.js" (
    echo [INFO] Database not built yet, building now...
    cd /d "%~dp0mcp-database"
    if not exist "node_modules" (
        echo [INFO] Installing Database dependencies...
        call npm install
    )
    call npm run build
    cd /d "%~dp0"
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Database build failed!
        pause
        goto menu
    )
)
exit /b 0

:show_status
echo.
echo ---- PM2 Process Status ----
pm2 status
echo.
echo ---- Browser MCP (port %BROWSER_PORT%) ----
node -e "fetch('http://localhost:%BROWSER_PORT%/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('Not responding:',e.message))" 2>nul
echo.
echo ---- Database MCP (port %DB_PORT%) ----
node -e "fetch('http://localhost:%DB_PORT%/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('Not responding:',e.message))" 2>nul
echo.
exit /b 0

:start_all
cls
echo.
call :check_pm2
call :check_build_browser
call :check_build_database
echo ================================================
echo   Starting all Cursor MCP services...
echo ================================================
echo.
echo [1/2] Browser MCP (port %BROWSER_PORT%)...
pm2 delete %BROWSER_NAME% >nul 2>&1
cd /d "%~dp0"
pm2 start ecosystem.config.cjs
echo.
echo [2/2] Database MCP (port %DB_PORT%)...
pm2 delete %DB_NAME% >nul 2>&1
cd /d "%~dp0mcp-database"
pm2 start ecosystem.config.cjs
cd /d "%~dp0"
echo.
echo [STARTED] All services running. Auto-restart on kill.
echo [INFO] Waiting 5s for services to initialize...
timeout /t 5 >nul
call :show_status
pause
goto menu

:stop_all
cls
echo.
echo ================================================
echo   Stopping all Cursor MCP services...
echo ================================================
echo.
pm2 stop %BROWSER_NAME% >nul 2>&1
pm2 delete %BROWSER_NAME% >nul 2>&1
echo [STOPPED] Browser MCP stopped.
pm2 stop %DB_NAME% >nul 2>&1
pm2 delete %DB_NAME% >nul 2>&1
echo [STOPPED] Database MCP stopped.
echo.
echo [INFO] Services will NOT auto-restart. Use [1.Start All] to start again.
call :show_status
pause
goto menu

:restart_all
cls
echo.
call :check_pm2
call :check_build_browser
call :check_build_database
echo ================================================
echo   Restarting all Cursor MCP services...
echo ================================================
echo.
echo [1/2] Browser MCP...
cd /d "%~dp0"
pm2 restart %BROWSER_NAME% >nul 2>&1 || (
    echo [INFO] Browser not running, starting...
    pm2 start ecosystem.config.cjs
)
echo.
echo [2/2] Database MCP...
cd /d "%~dp0mcp-database"
pm2 restart %DB_NAME% >nul 2>&1 || (
    echo [INFO] Database not running, starting...
    pm2 start ecosystem.config.cjs
)
cd /d "%~dp0"
echo.
echo [RESTARTED] All services restarted!
echo [INFO] Waiting 5s for services to initialize...
timeout /t 5 >nul
call :show_status
pause
goto menu

:status_all
cls
call :show_status
pause
goto menu

:logs_browser
cls
echo.
echo [Browser MCP Logs] Last 50 lines
echo.
pm2 logs %BROWSER_NAME% --lines 50 --nostream
echo.
call :show_status
pause
goto menu

:logs_database
cls
echo.
echo [Database MCP Logs] Last 50 lines
echo.
pm2 logs %DB_NAME% --lines 50 --nostream
echo.
call :show_status
pause
goto menu

:edit_db_config
cd /d "%~dp0mcp-database"
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [INFO] Created .env from .env.example
    ) else (
        echo [ERROR] .env.example not found
        pause
        goto menu
    )
)
start notepad .env
cd /d "%~dp0"
call :show_status
pause
goto menu

:show_mcp_config
cls
echo.
echo ================================================
echo   Cursor MCP Config
echo ================================================
echo.
echo File: C:\Users\YOUR_USERNAME\.cursor\mcp.json
echo.
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "url": "http://localhost:%BROWSER_PORT%/mcp"
echo     },
echo     "database": {
echo       "url": "http://localhost:%DB_PORT%/mcp"
echo     }
echo   }
echo }
echo.
call :show_status
pause
goto menu

:install_all
cls
echo.
echo ================================================
echo   Cursor MCP Full Install
echo ================================================
echo.
echo [1/6] Installing PM2...
where pm2 >nul 2>&1 || call npm install -g pm2
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
if %ERRORLEVEL% EQU 0 (
    echo ================================================
    echo   Install complete! Select [1.Start All] to run.
    echo ================================================
) else (
    echo [ERROR] Something went wrong. Check logs above.
)
echo.
call :show_status
pause
goto menu
