@echo off
chcp 65001 >nul
title MCP Database Bridge 安装程序

echo ========================================
echo   MCP Database Bridge 一键安装
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
echo [OK] Node.js 已安装

:: 安装依赖
echo [2/4] 安装项目依赖...
call npm install
if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo [OK] 依赖已安装

:: 构建项目
echo [3/4] 构建项目...
call npm run build
if errorlevel 1 (
    echo [错误] 构建失败
    pause
    exit /b 1
)
echo [OK] 构建完成

:: 创建配置文件
echo [4/4] 创建配置文件...
if not exist .env (
    copy .env.example .env >nul
    echo [OK] 已创建 .env 配置文件
    echo.
    echo ========================================
    echo   请编辑 .env 文件填写数据库信息！
    echo ========================================
    echo.
    echo   DB_TYPE=postgresql 或 mysql
    echo   DB_HOST=数据库主机
    echo   DB_PORT=端口号
    echo   DB_NAME=数据库名
    echo   DB_USER=用户名
    echo   DB_PASSWORD=密码
    echo.
    notepad .env
) else (
    echo [OK] .env 配置文件已存在
)

echo.
echo ========================================
echo   安装完成！
echo ========================================
echo.
echo 下一步:
echo   1. 确认 .env 中的数据库信息已填写
echo   2. 运行 npm start 启动服务
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
