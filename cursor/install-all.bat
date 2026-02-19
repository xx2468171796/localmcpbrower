@echo off
title Cursor MCP - Full Installation
cd /d "%~dp0"

echo ========================================
echo   Cursor MCP - Full Installation
echo   Browser MCP + Database MCP
echo ========================================
echo.

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
    echo [ERROR] Node.js version too low. Required: 18+
    pause
    exit /b 1
)
echo [OK] Node.js installed
echo.

echo [2/6] Checking PM2...
pm2 -v >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing PM2...
    call npm install -g pm2
)
echo [OK] PM2 installed
echo.

echo [3/6] Installing Browser MCP dependencies...
call npm install
if errorlevel 1 (
    echo [ERROR] Browser MCP dependencies failed
    pause
    exit /b 1
)
echo [OK] Browser MCP dependencies installed
echo.

echo [4/6] Installing Playwright Chromium...
call npx playwright install chromium
echo [OK] Chromium installed
echo.

echo [5/6] Building Browser MCP...
call npm run build
if errorlevel 1 (
    echo [ERROR] Browser MCP build failed
    pause
    exit /b 1
)
echo [OK] Browser MCP built
echo.

echo [6/6] Installing + Building Database MCP...
cd /d "%~dp0mcp-database"
call npm install
if errorlevel 1 (
    echo [ERROR] Database MCP dependencies failed
    pause
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo [ERROR] Database MCP build failed
    pause
    exit /b 1
)
echo [OK] Database MCP built
echo.

cd /d "%~dp0mcp-database"
if not exist .env (
    copy .env.example .env >nul
    echo [INFO] Created database config: mcp-database\.env
    echo [INFO] Please edit it with your database credentials.
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
echo   2. Run: manage.bat
echo.
echo Cursor MCP Config (add to ~/.cursor/mcp.json):
echo {
echo   "mcpServers": {
echo     "stable-browser": { "url": "http://localhost:3211/mcp" },
echo     "database": { "url": "http://localhost:3212/mcp" }
echo   }
echo }
echo.
pause
