@echo off
title MCP Bridge - Full Installation
cd /d "%~dp0"

echo ========================================
echo   MCP Bridge - Full Installation
echo   Browser MCP + Database MCP
echo ========================================
echo.

:: Check Node.js
echo [1/6] Checking Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not installed. Please install Node.js 18+
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=1,2,3 delims=." %%a in ('node -v') do set NODE_VER=%%a
set NODE_VER=%NODE_VER:v=%
if %NODE_VER% LSS 18 (
    echo [ERROR] Node.js version too low. Required: 18+, Current: %NODE_VER%
    pause
    exit /b 1
)
echo [OK] Node.js installed
echo.

:: Check PM2
echo [2/6] Checking PM2...
pm2 -v >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing PM2...
    call npm install -g pm2
    if errorlevel 1 (
        echo [ERROR] PM2 installation failed
        pause
        exit /b 1
    )
)
echo [OK] PM2 installed
echo.

:: Install Browser MCP
echo ========================================
echo [3/6] Installing Browser MCP...
echo ========================================
echo.
call npm install
if errorlevel 1 (
    echo [ERROR] Browser MCP dependencies failed
    pause
    exit /b 1
)
echo [OK] Browser MCP dependencies installed
echo.

:: Install Playwright Chromium
echo [4/6] Installing Playwright Chromium...
echo [INFO] Downloading ~150MB Chromium browser
echo [INFO] If slow, use mirror: set PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
echo.
call npx playwright install chromium
if errorlevel 1 (
    echo.
    echo [WARN] Chromium installation failed!
    echo [FIX] Method 1: Run manually: npx playwright install chromium
    echo [FIX] Method 2: Use mirror:
    echo         set PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
    echo         npx playwright install chromium
    echo.
    pause
)
echo [OK] Chromium installed
echo.

:: Build Browser MCP
echo [5/6] Building Browser MCP...
call npm run build
if errorlevel 1 (
    echo [ERROR] Browser MCP build failed
    pause
    exit /b 1
)
echo [OK] Browser MCP built
echo.

:: Install Database MCP
echo ========================================
echo [6/6] Installing Database MCP...
echo ========================================
cd /d "%~dp0mcp-database"
call npm install
if errorlevel 1 (
    echo [ERROR] Database MCP dependencies failed
    pause
    exit /b 1
)
echo [OK] Database MCP dependencies installed
echo.

:: Build Database MCP
echo Building Database MCP...
call npm run build
if errorlevel 1 (
    echo [ERROR] Database MCP build failed
    pause
    exit /b 1
)
echo [OK] Database MCP built
echo.

:: Create config files
cd /d "%~dp0"
if not exist .env (
    copy .env.example .env >nul
    echo [INFO] Created Browser MCP config
)

cd /d "%~dp0mcp-database"
if not exist .env (
    copy .env.example .env >nul
    echo [INFO] Created Database MCP config
    echo.
    echo ========================================
    echo   Please edit database config!
    echo ========================================
    echo.
    echo   File: mcp-database\.env
    echo.
    echo   DB_TYPE=postgresql or mysql
    echo   DB_HOST=database host
    echo   DB_PORT=port number
    echo   DB_NAME=database name
    echo   DB_USER=username
    echo   DB_PASSWORD=password
    echo.
    start notepad .env
)

cd /d "%~dp0"
echo.
echo ========================================
echo   Installation Complete!
echo ========================================
echo.
echo Next steps:
echo   1. Edit database config: mcp-database\.env
echo   2. Start services: mcp-all-manage.bat
echo.
echo MCP Config (add to Windsurf/Cursor):
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
pause
