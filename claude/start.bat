@echo off
setlocal

set "DIR=%~dp0"
cd /d "%DIR%"

if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo Created .env from .env.example
)

echo Starting MCP Browser server...
node dist/server.js
