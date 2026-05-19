#!/bin/bash
# Claude Code MCP - 诊断工具 (macOS / Linux)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  Claude Code MCP Diagnostic Tool"
echo "========================================"
echo ""

echo "[1/8] Checking Node.js..."
if command -v node &>/dev/null; then
    echo "[OK] Node.js $(node -v)"
else
    echo "[FAIL] Node.js not installed (需要 >= 20)"
    echo "[FIX] macOS: brew install node  |  Linux: 见 nodesource.com  |  Windows: nodejs.org"
fi
echo ""

echo "[2/8] Checking PM2..."
if command -v pm2 &>/dev/null; then
    echo "[OK] PM2 v$(pm2 -v)"
else
    echo "[FAIL] PM2 not installed"
    echo "[FIX] Run: npm install -g pm2"
fi
echo ""

echo "[3/8] Checking Browser dependencies..."
if [ -d "node_modules" ]; then
    echo "[OK] node_modules exists"
else
    echo "[FAIL] node_modules not found"
    echo "[FIX] Run: npm install"
fi
echo ""

echo "[4/8] Checking Browser build..."
if [ -f "dist/server.js" ]; then
    echo "[OK] dist/server.js exists"
else
    echo "[FAIL] Project not built"
    echo "[FIX] Run: npm run build"
fi
echo ""

echo "[5/8] Checking Playwright Chromium..."
if npx playwright --version &>/dev/null; then
    echo "[OK] Playwright installed"
else
    echo "[FAIL] Playwright not installed"
    echo "[FIX] Run: npx playwright install chromium"
fi
echo ""

echo "[6/8] Checking Database MCP..."
if [ -f "mcp-database/dist/server.js" ]; then
    echo "[OK] Database MCP built"
else
    echo "[FAIL] Database MCP not built"
    echo "[FIX] cd mcp-database && npm install && npm run build"
fi
echo ""

echo "[7/8] Checking ports..."
for p in 3213 3215 3214; do
    if lsof -ti tcp:$p &>/dev/null; then
        echo "[OK]   Port $p in use"
    else
        echo "[INFO] Port $p available"
    fi
done
echo "  (3213=有头浏览器  3215=无头浏览器  3214=数据库)"
echo ""

echo "[8/8] Testing services (HTTP 模式)..."
for entry in "3213:有头浏览器 MCP" "3215:无头浏览器 MCP" "3214:数据库 MCP"; do
    port="${entry%%:*}"; label="${entry#*:}"
    if curl -s "http://localhost:$port/health" &>/dev/null; then
        echo "[OK]   $label ($port) running"
    else
        echo "[INFO] $label ($port) not responding"
    fi
done
echo ""
echo "[提示] stdio 原生模式由 Claude Code 直接拉起进程，不占用端口；"
echo "       上述端口检查仅适用于 HTTP / PM2 模式。"
echo ""

echo "========================================"
echo "  Diagnostic Complete"
echo "========================================"
