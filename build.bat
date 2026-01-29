@echo off
chcp 65001 >nul
title Windsurf MCP Bridge - 打包

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║           Windsurf MCP Bridge - 打包构建                      ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

echo [1/3] 安装依赖...
call npm install --omit=dev
if %errorlevel% neq 0 (
    echo ❌ 安装依赖失败
    pause
    exit /b 1
)

echo.
echo [2/3] 编译 TypeScript...
call npm run build
if %errorlevel% neq 0 (
    echo ❌ 编译失败
    pause
    exit /b 1
)

echo.
echo [3/3] 安装 Playwright 浏览器...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo ❌ 安装浏览器失败
    pause
    exit /b 1
)

echo.
echo ════════════════════════════════════════════════════════════════
echo ✅ 打包完成！
echo.
echo 📂 输出文件:
echo    - dist/           编译后的 JavaScript
echo    - node_modules/   运行时依赖
echo    - start.bat       一键启动脚本
echo.
echo 🚀 使用方法:
echo    双击 start.bat 启动服务
echo ════════════════════════════════════════════════════════════════
echo.

pause
