#!/bin/bash
# Claude Code MCP - 一键安装 (macOS / Linux)
# 跨平台主入口为 node mcp.mjs install (含 Windows)；本脚本为类 Unix 原生回退
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  Claude Code MCP - Full Installation"
echo "  Browser MCP + Database MCP"
echo "========================================"
echo ""

echo "[1/6] Checking Node.js..."
if ! command -v node &>/dev/null; then
    echo "[ERROR] Node.js not installed. Please install Node.js 20+"
    echo "Install via: brew install node"
    exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
    echo "[ERROR] Node.js version too low. Required: 20+"
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
# rebrowser-playwright 自带 CLI 有 bug，调用其内置 playwright-core CLI 安装
node -e "const p=require('path'),cp=require('child_process');const dir=p.dirname(require.resolve('rebrowser-playwright/package.json'));const cli=p.join(dir,'node_modules','playwright-core','cli.js');cp.execFileSync(process.execPath,[cli,'install','chromium'],{stdio:'inherit'})"
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
echo "  2a. 推荐 (stdio 原生): 运行  node mcp.mjs config  获取 Claude Code 配置命令"
echo "  2b. HTTP / PM2 模式:   运行  ./manage.sh"
echo ""
echo "Claude Code MCP - stdio 原生配置 (推荐，无需 PM2 / 端口):"
echo "  claude mcp add browser  -- node \"$SCRIPT_DIR/dist/server.js\" --stdio"
echo "  claude mcp add database -e MCP_TRANSPORT=stdio -- node \"$SCRIPT_DIR/mcp-database/dist/server.js\" --stdio"
echo ""
echo "Claude Code MCP - HTTP 配置 (服务器 / 多客户端共享):"
echo '{'
echo '  "mcpServers": {'
echo '    "browser":  { "type": "http", "url": "http://localhost:3213/mcp" },'
echo '    "database": { "type": "http", "url": "http://localhost:3214/mcp" }'
echo '  }'
echo '}'
echo ""
