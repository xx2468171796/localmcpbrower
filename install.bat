@echo off
title MCP Browser Bridge Installer

echo ========================================
echo   MCP Browser Bridge - Installation
echo ========================================
echo.

:: Check Node.js
echo [1/5] Checking Node.js...
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

:: Check PM2
echo [2/5] Checking PM2...
pm2 -v >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing PM2...
    npm install -g pm2
    if errorlevel 1 (
        echo [ERROR] PM2 installation failed
        pause
        exit /b 1
    )
)
echo [OK] PM2 installed

:: Install dependencies
echo [3/5] Installing dependencies...
call npm install
if errorlevel 1 (
    echo [ERROR] Dependencies installation failed
    pause
    exit /b 1
)
echo [OK] Dependencies installed

:: Install Playwright Chromium
echo [4/5] Installing Playwright Chromium...
echo [INFO] This will download ~150MB Chromium browser
echo [INFO] If slow, set mirror: set PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
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

:: Create config file
if not exist .env (
    echo [INFO] Creating config file...
    copy .env.example .env >nul
    echo [OK] Config file created
)

:: Build project
echo [5/5] Building project...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Installation Complete!
echo ========================================
echo.
echo Start service: manage.bat
echo.
echo MCP Config (add to Windsurf/Cursor):
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "serverUrl": "http://localhost:3211/mcp"
echo     }
echo   }
echo }
echo.
pause
