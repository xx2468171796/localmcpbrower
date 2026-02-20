@echo off
setlocal enabledelayedexpansion
title Cursor MCP Bridge Manager
cd /d "%~dp0"

:menu
cls
echo ========================================
echo   Cursor MCP Bridge Manager
echo ========================================
echo.
echo   Ports:
echo     Browser MCP: 3211
echo     Database MCP: 3212
echo.
echo ========================================
echo   1. Start All
echo   2. Kill MCP
echo   3. Restart All
echo   4. Status
echo   5. Logs - Browser
echo   6. Logs - Database
echo   7. Edit DB Config
echo   8. Show MCP Config
echo   9. Full Install
echo   0. Exit
echo ========================================
echo.
choice /c 1234567890 /n /m "Select [0-9]: "
set sel=%errorlevel%

if %sel%==1 goto start_all
if %sel%==2 goto stop_all
if %sel%==3 goto restart_all
if %sel%==4 goto status_all
if %sel%==5 goto logs_browser
if %sel%==6 goto logs_database
if %sel%==7 goto edit_db_config
if %sel%==8 goto show_mcp_config
if %sel%==9 goto full_install
if %sel%==10 goto exit
goto menu

:start_all
cls
echo ========================================
echo   Starting All Cursor MCP Services...
echo ========================================
echo.
echo [1/2] Browser MCP...
cd /d "%~dp0"
call pm2 delete cursor-mcp-bridge >nul 2>&1
call pm2 start ecosystem.config.cjs
if errorlevel 1 (
    echo [ERROR] Browser MCP start failed!
)
echo.
echo [2/2] Database MCP...
cd /d "%~dp0mcp-database"
call pm2 delete cursor-mcp-database >nul 2>&1
call pm2 start ecosystem.config.cjs
if errorlevel 1 (
    echo [ERROR] Database MCP start failed!
)
echo.
echo ========================================
echo   Waiting 5s for services to start...
echo ========================================
timeout /t 5 /nobreak >nul
echo.
echo ========================================
echo   Status:
echo ========================================
call pm2 status
echo.
echo [Browser MCP - Port 3211]
curl.exe -s http://localhost:3211/health 2>nul
echo.
echo.
echo [Database MCP - Port 3212]
curl.exe -s http://localhost:3212/health 2>nul
echo.
echo.
echo Press any key to continue...
pause >nul
goto menu

:stop_all
cls
echo ========================================
echo   Killing Cursor MCP Services...
echo ========================================
echo.
call pm2 stop cursor-mcp-bridge >nul 2>&1
call pm2 delete cursor-mcp-bridge >nul 2>&1
echo [OK] cursor-mcp-bridge killed.
call pm2 stop cursor-mcp-database >nul 2>&1
call pm2 delete cursor-mcp-database >nul 2>&1
echo [OK] cursor-mcp-database killed.
echo.
echo ========================================
echo   Status:
echo ========================================
call pm2 status
echo.
echo Press any key to continue...
pause >nul
goto menu

:restart_all
cls
echo ========================================
echo   Restarting All Cursor MCP Services...
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
echo [Browser MCP - Port 3211]
curl.exe -s http://localhost:3211/health 2>nul
echo.
echo.
echo [Database MCP - Port 3212]
curl.exe -s http://localhost:3212/health 2>nul
echo.
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
echo   Cursor MCP Status - %date% %time%
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

:logs_browser
cls
echo ========================================
echo   Browser MCP Logs (last 50 lines)
echo ========================================
echo.
call pm2 logs cursor-mcp-bridge --lines 50 --nostream 2>nul
echo.
echo Press any key to continue...
pause >nul
goto menu

:logs_database
cls
echo ========================================
echo   Database MCP Logs (last 50 lines)
echo ========================================
echo.
call pm2 logs cursor-mcp-database --lines 50 --nostream 2>nul
echo.
echo Press any key to continue...
pause >nul
goto menu

:edit_db_config
cd /d "%~dp0mcp-database"
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [INFO] Database config file created
    )
)
start notepad .env
cd /d "%~dp0"
goto menu

:show_mcp_config
cls
echo ========================================
echo   Cursor MCP Config
echo ========================================
echo.
echo Config file location:
echo   C:\Users\USERNAME\.cursor\mcp.json
echo.
echo Config content:
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
echo Press any key to continue...
pause >nul
goto menu

:full_install
cls
echo ========================================
echo   Cursor MCP Full Install
echo ========================================
echo.
echo [1/7] Checking PM2...
where pm2 >nul 2>&1
if errorlevel 1 (
    echo        Installing PM2...
    call npm install -g pm2
)
echo        PM2 OK
echo.
echo [2/7] Installing Browser dependencies...
cd /d "%~dp0"
call npm install
echo.
echo [3/7] Installing Playwright Chromium...
call npx playwright install chromium
echo.
echo [4/7] Building Browser MCP...
call npm run build
echo.
echo [5/7] Installing Database dependencies...
cd /d "%~dp0mcp-database"
call npm install
echo.
echo [6/7] Building Database MCP...
call npm run build
cd /d "%~dp0"
echo.
echo [7/7] Writing Cursor MCP config...
set "MCP_DIR=%USERPROFILE%\.cursor"
if not exist "%MCP_DIR%" mkdir "%MCP_DIR%"
(
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
) > "%MCP_DIR%\mcp.json"
echo        Written to: %MCP_DIR%\mcp.json
echo.
echo ========================================
echo   Install complete! Use [1] to start.
echo ========================================
echo.
echo Press any key to continue...
pause >nul
goto menu

:exit
endlocal
exit /b 0
