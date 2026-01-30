@echo off
title MCP Database Bridge Installer

echo ========================================
echo   MCP Database Bridge - Installation
echo ========================================
echo.

:: Check Node.js
echo [1/4] Checking Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not installed. Please install Node.js 18+
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js installed

:: Install dependencies
echo [2/4] Installing dependencies...
call npm install
if errorlevel 1 (
    echo [ERROR] Dependencies installation failed
    pause
    exit /b 1
)
echo [OK] Dependencies installed

:: Build project
echo [3/4] Building project...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)
echo [OK] Build complete

:: Create config file
echo [4/4] Creating config file...
if not exist .env (
    copy .env.example .env >nul
    echo [OK] Created .env config file
    echo.
    echo ========================================
    echo   Please edit .env with database info!
    echo ========================================
    echo.
    echo   DB_TYPE=postgresql or mysql
    echo   DB_HOST=database host
    echo   DB_PORT=port number
    echo   DB_NAME=database name
    echo   DB_USER=username
    echo   DB_PASSWORD=password
    echo.
    notepad .env
) else (
    echo [OK] .env config file exists
)

echo.
echo ========================================
echo   Installation Complete!
echo ========================================
echo.
echo Next steps:
echo   1. Verify database info in .env
echo   2. Run: npm start
echo.
echo MCP Config (add to Windsurf/Cursor):
echo {
echo   "mcpServers": {
echo     "database": {
echo       "serverUrl": "http://localhost:3212/mcp"
echo     }
echo   }
echo }
echo.
pause
