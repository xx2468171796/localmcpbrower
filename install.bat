@echo off
chcp 65001 >nul
title MCP Browser Bridge 安装程序

echo ========================================
echo   MCP Browser Bridge 一键安装
echo ========================================
echo.

:: 检查 Node.js
echo [1/4] 检查 Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo [错误] 未安装 Node.js，请先安装 Node.js 18+
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=1,2,3 delims=." %%a in ('node -v') do set NODE_VER=%%a
set NODE_VER=%NODE_VER:v=%
if %NODE_VER% LSS 18 (
    echo [错误] Node.js 版本过低，需要 18+，当前: %NODE_VER%
    pause
    exit /b 1
)
echo [OK] Node.js 已安装

:: 检查 PM2
echo [2/4] 检查 PM2...
pm2 -v >nul 2>&1
if errorlevel 1 (
    echo [提示] 正在安装 PM2...
    npm install -g pm2
    if errorlevel 1 (
        echo [错误] PM2 安装失败
        pause
        exit /b 1
    )
)
echo [OK] PM2 已安装

:: 安装依赖
echo [3/4] 安装项目依赖...
call npm install
if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo [OK] 依赖已安装

:: 安装 Playwright 浏览器
echo [4/4] 安装 Playwright 浏览器...
npx playwright install chromium
if errorlevel 1 (
    echo [警告] Playwright 浏览器安装失败，请手动执行: npx playwright install chromium
)
echo [OK] Playwright 已安装

:: 创建配置文件
if not exist .env (
    echo [提示] 创建配置文件...
    copy .env.example .env >nul
    echo [OK] 配置文件已创建
)

:: 构建项目
echo [5/5] 构建项目...
call npm run build
if errorlevel 1 (
    echo [错误] 构建失败
    pause
    exit /b 1
)

echo.
echo ========================================
echo   安装完成！
echo ========================================
echo.
echo 启动服务: manage.bat start
echo 查看状态: manage.bat status
echo 查看日志: manage.bat logs
echo.
echo MCP 配置 (添加到 Windsurf/Cursor):
echo {
echo   "mcpServers": {
echo     "stable-browser": {
echo       "serverUrl": "http://localhost:3211/mcp"
echo     }
echo   }
echo }
echo.
pause
