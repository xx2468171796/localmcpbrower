@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3211"') do (
    taskkill /F /PID %%p >nul 2>&1
)
echo MCP Browser server stopped.
