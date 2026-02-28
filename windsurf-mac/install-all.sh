#!/bin/bash
# Windsurf MCP - Full Installation (macOS)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  Windsurf MCP - Full Installation (Mac)"
echo "  Browser MCP + Database MCP"
echo "========================================"
echo ""

echo "[1/6] Checking Node.js..."
if ! command -v node &>/dev/null; then
    echo "[ERROR] Node.js not installed. Please install Node.js 18+"
    echo "Install via: brew install node"
    exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
    echo "[ERROR] Node.js version too low. Required: 18+"
    exit 1
fi
echo "[OK] Node.js $(node -v)"
echo ""

echo "[2/6] Checking PM2..."
if ! command -v pm2 &>/dev/null; then
    echo "[INFO] Installing PM2..."
    npm install -g pm2
fi
echo "[OK] PM2 $(pm2 -v)"
echo ""

echo "[3/6] Installing Browser MCP dependencies..."
npm install
echo "[OK] Browser MCP dependencies installed"
echo ""

echo "[4/6] Installing Playwright Chromium..."
npx playwright install chromium
echo "[OK] Chromium installed"
echo ""

echo "[5/6] Building Browser MCP..."
npm run build
echo "[OK] Browser MCP built"
echo ""

echo "[6/6] Installing + Building Database MCP..."
cd "$SCRIPT_DIR/mcp-database"
npm install
npm run build
echo "[OK] Database MCP built"
echo ""

if [ ! -f .env ]; then
    cp .env.example .env
    echo "[INFO] Created database config: mcp-database/.env"
    echo "[INFO] Please edit it with your database credentials."
    open -t .env 2>/dev/null || true
fi

cd "$SCRIPT_DIR"
echo ""
echo "========================================"
echo "  Installation Complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "  1. Edit database config: mcp-database/.env"
echo "  2. Run: ./manage.sh"
echo ""
echo "Windsurf MCP Config (add to mcp_config.json):"
echo '{'
echo '  "mcpServers": {'
echo '    "stable-browser": { "serverUrl": "http://localhost:3213/mcp" },'
echo '    "database": { "serverUrl": "http://localhost:3214/mcp" }'
echo '  }'
echo '}'
echo ""
