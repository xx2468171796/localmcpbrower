#!/bin/bash
# MCP Bridge Manager [Browser + Database] (macOS)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

show_menu() {
    clear
    echo "========================================"
    echo "  MCP Bridge Manager [Browser + Database]"
    echo "========================================"
    echo ""
    echo "  Ports:"
    echo "    Browser MCP: 3213"
    echo "    Database MCP: 3214"
    echo ""
    echo "========================================"
    echo "  1. Start All"
    echo "  2. Stop All"
    echo "  3. Restart All"
    echo "  4. Status"
    echo "  5. Browser MCP"
    echo "  6. Database MCP"
    echo "  7. Edit DB Config"
    echo "  8. Show MCP Config"
    echo "  0. Exit"
    echo "========================================"
    echo ""
}

start_all() {
    clear
    echo "========================================"
    echo "  Starting All MCP Services..."
    echo "========================================"
    echo ""
    echo "[1/2] Browser MCP..."
    cd "$SCRIPT_DIR"
    pm2 start ecosystem.config.cjs
    echo ""
    echo "[2/2] Database MCP..."
    cd "$SCRIPT_DIR/mcp-database"
    pm2 start ecosystem.config.cjs
    echo ""
    echo "========================================"
    echo "  Status:"
    echo "========================================"
    pm2 status
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

stop_all() {
    clear
    echo "========================================"
    echo "  Stopping All MCP Services..."
    echo "========================================"
    echo ""
    pm2 stop claudemcp-browser claudemcp-database 2>/dev/null || true
    echo ""
    read -n 1 -s -r -p "Press any key to continue..."
}

restart_all() {
    clear
    echo "========================================"
    echo "  Restarting All MCP Services..."
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
    read -n 1 -s -r -p "Press any key to continue..."
}

status_all() {
    clear
    echo "========================================"
    echo "  MCP Bridge Status - $(date)"
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

browser_manage() {
    cd "$SCRIPT_DIR"
    ./manage.sh
}

database_manage() {
    cd "$SCRIPT_DIR/mcp-database"
    if [ -f manage.sh ]; then
        ./manage.sh
    else
        echo "Database manage script not found."
        read -n 1 -s -r -p "Press any key to continue..."
    fi
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
}

show_mcp_config() {
    clear
    echo "========================================"
    echo "  MCP Config [Windsurf/Cursor]"
    echo "========================================"
    echo ""
    echo "Config file location:"
    echo "  Windsurf: ~/.codeium/windsurf/mcp_config.json"
    echo "  Cursor:   ~/.cursor/mcp.json"
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

# Main loop
while true; do
    show_menu
    read -n 1 -s sel
    case $sel in
        1) start_all ;;
        2) stop_all ;;
        3) restart_all ;;
        4) status_all ;;
        5) browser_manage ;;
        6) database_manage ;;
        7) edit_db_config ;;
        8) show_mcp_config ;;
        0) echo ""; exit 0 ;;
        *) ;;
    esac
done
