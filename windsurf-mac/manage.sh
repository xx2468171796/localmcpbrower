#!/bin/bash
# Windsurf MCP Bridge Manager (macOS)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

show_menu() {
    clear
    echo "========================================"
    echo "  Windsurf MCP Bridge Manager (Mac)"
    echo "========================================"
    echo ""
    echo "  Ports:"
    echo "    Browser MCP: 3213"
    echo "    Database MCP: 3214"
    echo ""
    echo "========================================"
    echo "  1. Start All"
    echo "  2. Kill MCP"
    echo "  3. Restart All"
    echo "  4. Status"
    echo "  5. Logs - Browser"
    echo "  6. Logs - Database"
    echo "  7. Edit DB Config"
    echo "  8. Show MCP Config"
    echo "  9. Full Install"
    echo "  0. Exit"
    echo "========================================"
    echo ""
}

start_all() {
    clear
    echo "========================================"
    echo "  Starting All Windsurf MCP Services..."
    echo "========================================"
    echo ""
    echo "[1/2] Browser MCP..."
    cd "$SCRIPT_DIR"
    pm2 delete windsurf-mcp-bridge 2>/dev/null || true
    pm2 start ecosystem.config.cjs
    echo ""
    echo "[2/2] Database MCP..."
    cd "$SCRIPT_DIR/mcp-database"
    pm2 delete windsurf-mcp-database 2>/dev/null || true
    pm2 start ecosystem.config.cjs
    echo ""
    echo "========================================"
    echo "  Waiting 5s for services to start..."
    echo "========================================"
    sleep 5
    echo ""
    echo "========================================"
    echo "  Status:"
    echo "========================================"
    pm2 status
    echo ""
    echo "[Browser MCP - Port 3213]"
    curl -s http://localhost:3213/health 2>/dev/null || echo "(not responding)"
    echo ""
    echo ""
    echo "[Database MCP - Port 3214]"
    curl -s http://localhost:3214/health 2>/dev/null || echo "(not responding)"
    echo ""
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

stop_all() {
    clear
    echo "========================================"
    echo "  Killing Windsurf MCP Services..."
    echo "========================================"
    echo ""
    pm2 stop windsurf-mcp-bridge 2>/dev/null || true
    pm2 delete windsurf-mcp-bridge 2>/dev/null || true
    echo "[OK] windsurf-mcp-bridge killed."
    pm2 stop windsurf-mcp-database 2>/dev/null || true
    pm2 delete windsurf-mcp-database 2>/dev/null || true
    echo "[OK] windsurf-mcp-database killed."
    echo ""
    echo "========================================"
    echo "  Status:"
    echo "========================================"
    pm2 status
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

restart_all() {
    clear
    echo "========================================"
    echo "  Restarting All Windsurf MCP Services..."
    echo "========================================"
    echo ""
    echo "[1/2] Browser MCP..."
    cd "$SCRIPT_DIR"
    pm2 restart ecosystem.config.cjs 2>/dev/null || pm2 start ecosystem.config.cjs
    echo ""
    echo "[2/2] Database MCP..."
    cd "$SCRIPT_DIR/mcp-database"
    pm2 restart ecosystem.config.cjs 2>/dev/null || pm2 start ecosystem.config.cjs
    echo ""
    echo "========================================"
    echo "  Status:"
    echo "========================================"
    pm2 status
    echo ""
    echo "[Browser MCP - Port 3213]"
    curl -s http://localhost:3213/health 2>/dev/null || echo "(not responding)"
    echo ""
    echo ""
    echo "[Database MCP - Port 3214]"
    curl -s http://localhost:3214/health 2>/dev/null || echo "(not responding)"
    echo ""
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

status_all() {
    clear
    echo "========================================"
    echo "  Windsurf MCP Status - $(date)"
    echo "========================================"
    echo ""
    echo "[PM2 Processes]"
    pm2 list 2>/dev/null
    echo ""
    echo "[Browser MCP - Port 3213]"
    curl -s http://localhost:3213/health 2>/dev/null || echo "(not responding)"
    echo ""
    echo ""
    echo "[Database MCP - Port 3214]"
    curl -s http://localhost:3214/health 2>/dev/null || echo "(not responding)"
    echo ""
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

logs_browser() {
    clear
    echo "========================================"
    echo "  Browser MCP Logs (last 50 lines)"
    echo "========================================"
    echo ""
    pm2 logs windsurf-mcp-bridge --lines 50 --nostream 2>/dev/null
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

logs_database() {
    clear
    echo "========================================"
    echo "  Database MCP Logs (last 50 lines)"
    echo "========================================"
    echo ""
    pm2 logs windsurf-mcp-database --lines 50 --nostream 2>/dev/null
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

edit_db_config() {
    cd "$SCRIPT_DIR/mcp-database"
    if [ ! -f .env ]; then
        if [ -f .env.example ]; then
            cp .env.example .env
            echo "[INFO] Database config file created"
        fi
    fi
    open -t .env 2>/dev/null || nano .env
    cd "$SCRIPT_DIR"
}

show_mcp_config() {
    clear
    echo "========================================"
    echo "  Windsurf MCP Config"
    echo "========================================"
    echo ""
    echo "Config file location:"
    echo "  ~/.codeium/windsurf/mcp_config.json"
    echo ""
    echo "Config content:"
    echo ""
    echo '{'
    echo '  "mcpServers": {'
    echo '    "stable-browser": {'
    echo '      "serverUrl": "http://localhost:3213/mcp"'
    echo '    },'
    echo '    "database": {'
    echo '      "serverUrl": "http://localhost:3214/mcp"'
    echo '    }'
    echo '  }'
    echo '}'
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

full_install() {
    clear
    echo "========================================"
    echo "  Windsurf MCP Full Install"
    echo "========================================"
    echo ""
    echo "[1/7] Checking PM2..."
    if ! command -v pm2 &>/dev/null; then
        echo "       Installing PM2..."
        npm install -g pm2
    fi
    echo "       PM2 OK"
    echo ""
    echo "[2/7] Installing Browser dependencies..."
    cd "$SCRIPT_DIR"
    npm install
    echo ""
    echo "[3/7] Installing Playwright Chromium..."
    npx playwright install chromium
    echo ""
    echo "[4/7] Building Browser MCP..."
    npm run build
    echo ""
    echo "[5/7] Installing Database dependencies..."
    cd "$SCRIPT_DIR/mcp-database"
    npm install
    echo ""
    echo "[6/7] Building Database MCP..."
    npm run build
    cd "$SCRIPT_DIR"
    echo ""
    echo "[7/7] Writing Windsurf MCP config..."
    MCP_DIR="$HOME/.codeium/windsurf"
    mkdir -p "$MCP_DIR"
    cat > "$MCP_DIR/mcp_config.json" << 'EOF'
{
  "mcpServers": {
    "stable-browser": {
      "serverUrl": "http://localhost:3213/mcp"
    },
    "database": {
      "serverUrl": "http://localhost:3214/mcp"
    }
  }
}
EOF
    echo "       Written to: $MCP_DIR/mcp_config.json"
    echo ""
    echo "========================================"
    echo "  Install complete! Use [1] to start."
    echo "========================================"
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

# Main loop
while true; do
    show_menu
    read -n 1 -s sel
    case $sel in
        1) start_all ;;
        2) stop_all ;;
        3) restart_all ;;
        4) status_all ;;
        5) logs_browser ;;
        6) logs_database ;;
        7) edit_db_config ;;
        8) show_mcp_config ;;
        9) full_install ;;
        0) echo ""; exit 0 ;;
        *) ;;
    esac
done
