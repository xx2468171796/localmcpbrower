@echo off
title MCP Bridge - Diagnostic Tool
cd /d "%~dp0"

echo ========================================
echo   MCP Bridge Diagnostic Tool
echo ========================================
echo.

:: Check Node.js
echo [1/8] Checking Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Node.js not installed
    echo [FIX] Download from: https://nodejs.org/
) else (
    for /f "tokens=1" %%v in ('node -v') do echo [OK] Node.js %%v
)
echo.

:: Check PM2
echo [2/8] Checking PM2...
pm2 -v >nul 2>&1
if errorlevel 1 (
    echo [FAIL] PM2 not installed
    echo [FIX] Run: npm install -g pm2
) else (
    for /f "tokens=1" %%v in ('pm2 -v') do echo [OK] PM2 v%%v
)
echo.

:: Check node_modules
echo [3/8] Checking dependencies...
if exist "node_modules" (
    echo [OK] node_modules exists
) else (
    echo [FAIL] node_modules not found
    echo [FIX] Run: npm install
)
echo.

:: Check dist folder
echo [4/8] Checking build output...
if exist "dist\server.js" (
    echo [OK] dist/server.js exists
) else (
    echo [FAIL] Project not built
    echo [FIX] Run: npm run build
)
echo.

:: Check Playwright
echo [5/8] Checking Playwright Chromium...
npx playwright --version >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Playwright not installed
    echo [FIX] Run: npx playwright install chromium
) else (
    echo [OK] Playwright installed
)
echo.

:: Check ports
echo [6/8] Checking ports...
netstat -ano | findstr ":3211" >nul 2>&1
if errorlevel 1 (
    echo [OK] Port 3211 available
) else (
    echo [WARN] Port 3211 in use
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3211"') do (
        echo [INFO] Process ID: %%p
    )
)

netstat -ano | findstr ":3212" >nul 2>&1
if errorlevel 1 (
    echo [OK] Port 3212 available
) else (
    echo [WARN] Port 3212 in use
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3212"') do (
        echo [INFO] Process ID: %%p
    )
)
echo.

:: Check firewall (requires admin)
echo [7/8] Checking firewall...
netsh advfirewall firewall show rule name=all | findstr "Node.js" >nul 2>&1
if errorlevel 1 (
    echo [WARN] Node.js not in firewall rules
    echo [FIX] May need to allow Node.js through Windows Firewall
) else (
    echo [OK] Node.js firewall rule exists
)
echo.

:: Test service
echo [8/8] Testing service...
curl.exe -s http://localhost:3211/health >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Service not responding on port 3211
    echo [FIX] Start service: mcp-all-manage.bat
) else (
    echo [OK] Browser MCP service running
)

curl.exe -s http://localhost:3212/health >nul 2>&1
if errorlevel 1 (
    echo [INFO] Database MCP not running (optional)
) else (
    echo [OK] Database MCP service running
)
echo.

echo ========================================
echo   Diagnostic Complete
echo ========================================
echo.
echo Next steps:
echo   1. Fix any [FAIL] items above
echo   2. Run: install-all.bat (if needed)
echo   3. Run: mcp-all-manage.bat
echo.
pause
