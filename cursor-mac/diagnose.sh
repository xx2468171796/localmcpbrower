#!/bin/bash
# Cursor MCP - Diagnostic Tool (macOS)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  Cursor MCP Diagnostic Tool (Mac)"
echo "========================================"
echo ""

echo "[1/8] Checking Node.js..."
if command -v node &>/dev/null; then
    echo "[OK] Node.js $(node -v)"
else
    echo "[FAIL] Node.js not installed"
    echo "[FIX] Run: brew install node"
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
if lsof -ti tcp:3211 &>/dev/null; then
    echo "[OK] Port 3211 in use (Browser MCP running)"
else
    echo "[INFO] Port 3211 available (Browser MCP not running)"
fi
if lsof -ti tcp:3212 &>/dev/null; then
    echo "[OK] Port 3212 in use (Database MCP running)"
else
    echo "[INFO] Port 3212 available (Database MCP not running)"
fi
echo ""

echo "[8/8] Testing services..."
if curl -s http://localhost:3211/health &>/dev/null; then
    echo "[OK] Browser MCP service running"
else
    echo "[INFO] Browser MCP not responding"
fi
if curl -s http://localhost:3212/health &>/dev/null; then
    echo "[OK] Database MCP service running"
else
    echo "[INFO] Database MCP not responding"
fi
echo ""

echo "========================================"
echo "  Diagnostic Complete"
echo "========================================"
