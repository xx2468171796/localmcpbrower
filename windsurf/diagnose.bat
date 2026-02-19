@echo off
title Windsurf MCP - Diagnostic Tool
cd /d "%~dp0"

echo ========================================
echo   Windsurf MCP Diagnostic Tool
echo ========================================
echo.

echo [1/8] Checking Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Node.js not installed
) else (
    for /f "tokens=1" %%v in ('node -v') do echo [OK] Node.js %%v
)
echo.

echo [2/8] Checking PM2...
pm2 -v >nul 2>&1
if errorlevel 1 (
    echo [FAIL] PM2 not installed
) else (
    for /f "tokens=1" %%v in ('pm2 -v') do echo [OK] PM2 v%%v
)
echo.

echo [3/8] Checking Browser dependencies...
if exist "node_modules" (echo [OK] node_modules exists) else (echo [FAIL] node_modules not found)
echo.

echo [4/8] Checking Browser build...
if exist "dist\server.js" (echo [OK] dist/server.js exists) else (echo [FAIL] Project not built)
echo.

echo [5/8] Checking Playwright...
npx playwright --version >nul 2>&1
if errorlevel 1 (echo [FAIL] Playwright not installed) else (echo [OK] Playwright installed)
echo.

echo [6/8] Checking Database MCP...
if exist "mcp-database\dist\server.js" (echo [OK] Database MCP built) else (echo [FAIL] Database MCP not built)
echo.

echo [7/8] Checking ports...
netstat -ano | findstr ":3211" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (echo [INFO] Port 3211 available) else (echo [OK] Port 3211 in use)
netstat -ano | findstr ":3212" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (echo [INFO] Port 3212 available) else (echo [OK] Port 3212 in use)
echo.

echo [8/8] Testing services...
curl.exe -s http://localhost:3211/health >nul 2>&1
if errorlevel 1 (echo [INFO] Browser MCP not responding) else (echo [OK] Browser MCP running)
curl.exe -s http://localhost:3212/health >nul 2>&1
if errorlevel 1 (echo [INFO] Database MCP not responding) else (echo [OK] Database MCP running)
echo.

echo ========================================
echo   Diagnostic Complete
echo ========================================
echo.
pause
