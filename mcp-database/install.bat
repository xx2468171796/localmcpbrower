@echo off
chcp 65001 >nul
title MCP Database Bridge 安装程序

echo ========================================
echo   MCP Database Bridge 一键安装
echo ========================================
echo.

:: 检查 Node.js
echo [1/3] 检查 Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo [错误] 未安装 Node.js，请先安装 Node.js 18+
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js 已安装

:: 安装依赖
echo [2/3] 安装项目依赖...
call npm install
if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo [OK] 依赖已安装

:: 构建项目
echo [3/3] 构建项目...
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
echo 启动服务: npm start
echo 或使用 PM2: pm2 start ecosystem.config.cjs
echo.
echo MCP 配置 (添加到 Windsurf/Cursor):
echo {
echo   "mcpServers": {
echo     "database": {
echo       "serverUrl": "http://localhost:3212/mcp"
echo     }
echo   }
echo }
echo.
pause
