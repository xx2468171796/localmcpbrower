#!/bin/bash
# ============================================================
# Claude Code MCP 统一管理器 (bash, macOS / Linux)
# 有头浏览器(3213) + 无头浏览器(3215) + 数据库(3214)
# 跨平台主入口为 mcp.mjs (含 Windows)；本脚本为类 Unix 原生回退
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OS=$(uname -s)
IS_LINUX=false
[[ "$OS" == "Linux" ]] && IS_LINUX=true

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

health() {
  local port=$1
  local result
  result=$(curl -sf "http://localhost:$port/health" 2>/dev/null)
  if [[ $? -eq 0 ]]; then
    local alive
    alive=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('browserAlive') or d.get('status')=='ok' else 'err')" 2>/dev/null || echo "ok")
    [[ "$alive" == "ok" ]] && echo -e "${GREEN}running${NC}" || echo -e "${YELLOW}degraded${NC}"
  else
    echo -e "${RED}stopped${NC}"
  fi
}

db_health() {
  curl -sf "http://localhost:3214/health" &>/dev/null && echo -e "${GREEN}running${NC}" || echo -e "${RED}stopped${NC}"
}

show_menu() {
  clear
  echo -e "${CYAN}============================================================${NC}"
  echo -e "${CYAN}${BOLD}  Claude Code MCP 管理器${NC}${CYAN} ($(uname -s))${NC}"
  echo -e "${CYAN}============================================================${NC}"
  echo ""
  echo -e "  服务状态:"
  if [[ "$IS_LINUX" == "false" ]]; then
    echo -e "    有头浏览器  port 3213  $(health 3213)"
  fi
  echo -e "    无头浏览器  port 3215  $(health 3215)"
  echo -e "    数据库      port 3214  $(db_health)"
  echo ""
  echo -e "${CYAN}──────────────────────────────────────────────────────────${NC}"
  if [[ "$IS_LINUX" == "false" ]]; then
    echo "  1. 启动全部 (有头 + 无头 + 数据库)"
    echo "  2. 仅启动无头浏览器 + 数据库 (服务器模式)"
  else
    echo "  1. 启动全部 (无头浏览器 + 数据库)"
    echo "  2. 仅启动无头浏览器"
  fi
  echo "  3. 停止全部"
  echo "  4. 重启全部"
  echo "  5. 查看状态"
  echo "  6. 日志 - 有头浏览器"
  echo "  7. 日志 - 无头浏览器"
  echo "  8. 日志 - 数据库"
  echo "  9. 编辑数据库配置"
  echo "  c. 显示 Claude Code MCP 配置"
  echo "  i. 全新安装"
  echo "  0. 退出"
  echo ""
}

start_all() {
  clear
  echo -e "${CYAN}── 启动所有 MCP 服务${NC}"
  echo ""

  if [[ "$IS_LINUX" == "false" ]]; then
    echo "[1/3] 有头浏览器 MCP (port 3213)..."
    cd "$SCRIPT_DIR"
    pm2 delete claudemcp-browser 2>/dev/null || true
    pm2 start ecosystem.config.cjs
    echo ""
    echo "[2/3] 无头浏览器 MCP (port 3215)..."
    pm2 delete claudemcp-headless 2>/dev/null || true
    pm2 start ecosystem.headless.cjs --name claudemcp-headless
    echo ""
    echo "[3/3] 数据库 MCP (port 3214)..."
    cd "$SCRIPT_DIR/mcp-database"
    pm2 delete claudemcp-database 2>/dev/null || true
    pm2 start ecosystem.config.cjs
  else
    echo "[1/2] 无头浏览器 MCP (port 3215)..."
    cd "$SCRIPT_DIR"
    pm2 delete claudemcp-headless 2>/dev/null || true
    pm2 start ecosystem.headless.cjs --name claudemcp-headless
    echo ""
    echo "[2/2] 数据库 MCP (port 3214)..."
    cd "$SCRIPT_DIR/mcp-database"
    pm2 delete claudemcp-database 2>/dev/null || true
    pm2 start ecosystem.config.cjs
  fi

  cd "$SCRIPT_DIR"
  sleep 5
  echo ""
  _show_status
  read -n 1 -s -r -p "按任意键继续..."
}

start_headless_db() {
  clear
  echo -e "${CYAN}── 启动无头浏览器 + 数据库${NC}"
  echo ""
  echo "[1/2] 无头浏览器 MCP (port 3215)..."
  cd "$SCRIPT_DIR"
  pm2 delete claudemcp-headless 2>/dev/null || true
  pm2 start ecosystem.headless.cjs
  echo ""
  echo "[2/2] 数据库 MCP (port 3214)..."
  cd "$SCRIPT_DIR/mcp-database"
  pm2 delete claudemcp-database 2>/dev/null || true
  pm2 start ecosystem.config.cjs
  cd "$SCRIPT_DIR"
  sleep 5
  echo ""
  _show_status
  read -n 1 -s -r -p "按任意键继续..."
}

stop_all() {
  clear
  echo -e "${CYAN}── 停止所有 MCP 服务${NC}"
  echo ""
  for svc in claudemcp-browser claudemcp-headless claudemcp-database; do
    pm2 stop "$svc" 2>/dev/null && pm2 delete "$svc" 2>/dev/null && echo "  [OK] $svc 已停止" || true
  done
  echo ""
  pm2 status
  echo ""
  read -n 1 -s -r -p "按任意键继续..."
}

restart_all() {
  clear
  echo -e "${CYAN}── 重启所有 MCP 服务${NC}"
  echo ""
  if [[ "$IS_LINUX" == "false" ]]; then
    cd "$SCRIPT_DIR"
    pm2 restart claudemcp-browser 2>/dev/null || pm2 start ecosystem.config.cjs
    pm2 restart claudemcp-headless 2>/dev/null || pm2 start ecosystem.headless.cjs --name claudemcp-headless
  else
    cd "$SCRIPT_DIR"
    pm2 restart claudemcp-headless 2>/dev/null || pm2 start ecosystem.headless.cjs --name claudemcp-headless
  fi
  cd "$SCRIPT_DIR/mcp-database"
  pm2 restart claudemcp-database 2>/dev/null || pm2 start ecosystem.config.cjs
  cd "$SCRIPT_DIR"
  sleep 3
  echo ""
  _show_status
  read -n 1 -s -r -p "按任意键继续..."
}

_show_status() {
  echo -e "${CYAN}── 服务状态${NC}"
  pm2 list 2>/dev/null
  echo ""
  if [[ "$IS_LINUX" == "false" ]]; then
    echo -n "  有头浏览器 (3213): "
    curl -s "http://localhost:3213/health" 2>/dev/null || echo "(无响应)"
    echo ""
  fi
  echo -n "  无头浏览器 (3215): "
  curl -s "http://localhost:3215/health" 2>/dev/null || echo "(无响应)"
  echo ""
  echo -n "  数据库 (3214):     "
  curl -s "http://localhost:3214/health" 2>/dev/null || echo "(无响应)"
  echo ""
}

status_all() {
  clear
  _show_status
  read -n 1 -s -r -p "按任意键继续..."
}

logs_headed()   { clear; pm2 logs claudemcp-browser --lines 60 --nostream 2>/dev/null; echo ""; read -n 1 -s -r -p "按任意键继续..."; }
logs_headless() { clear; pm2 logs claudemcp-headless --lines 60 --nostream 2>/dev/null; echo ""; read -n 1 -s -r -p "按任意键继续..."; }
logs_database() { clear; pm2 logs claudemcp-database --lines 60 --nostream 2>/dev/null; echo ""; read -n 1 -s -r -p "按任意键继续..."; }

edit_db_config() {
  local env_file="$SCRIPT_DIR/mcp-database/.env"
  if [[ ! -f "$env_file" ]]; then
    [[ -f "$SCRIPT_DIR/mcp-database/.env.example" ]] && cp "$SCRIPT_DIR/mcp-database/.env.example" "$env_file"
  fi
  open -t "$env_file" 2>/dev/null || nano "$env_file"
}

show_claude_config() {
  clear
  echo -e "${CYAN}── Claude Code MCP 配置${NC}"
  echo ""
  echo -e "${YELLOW}  方式 A: stdio 原生模式 (推荐，无需 PM2 / 端口)${NC}"
  echo "  由 Claude Code 直接拉起进程。在项目目录执行:"
  echo "    claude mcp add browser -- node \"$SCRIPT_DIR/dist/server.js\" --stdio"
  echo "    claude mcp add database -e MCP_TRANSPORT=stdio -- node \"$SCRIPT_DIR/mcp-database/dist/server.js\" --stdio"
  echo ""
  echo "  或将项目根目录的 .mcp.json.example 复制为 .mcp.json 并填入绝对路径。"
  echo "  也可运行:  node mcp.mjs config   一键获取上述命令。"
  echo ""
  echo -e "${YELLOW}  方式 B: HTTP / PM2 模式 (服务器或多客户端共享)${NC}"
  echo "  配置文件: ~/.config/claude-code/mcp.json"
  echo ""
  if [[ "$IS_LINUX" == "false" ]]; then
    echo '  macOS 配置 (有头 + 无头 + 数据库):'
    echo '  {'
    echo '    "mcpServers": {'
    echo '      "browser-headed":   { "type": "http", "url": "http://localhost:3213/mcp" },'
    echo '      "browser-headless": { "type": "http", "url": "http://localhost:3215/mcp" },'
    echo '      "database":         { "type": "http", "url": "http://localhost:3214/mcp" }'
    echo '    }'
    echo '  }'
  else
    echo '  Linux 配置 (无头 + 数据库):'
    echo '  {'
    echo '    "mcpServers": {'
    echo '      "browser-headless": { "type": "http", "url": "http://localhost:3215/mcp" },'
    echo '      "database":         { "type": "http", "url": "http://localhost:3214/mcp" }'
    echo '    }'
    echo '  }'
  fi
  echo ""
  echo "  添加命令:"
  echo "    claude mcp add --transport http browser-headless http://localhost:3215/mcp"
  echo "    claude mcp add --transport http database http://localhost:3214/mcp"
  echo ""
  read -n 1 -s -r -p "按任意键继续..."
}

full_install() {
  clear
  echo -e "${CYAN}── 全新安装${NC}"
  echo ""
  bash "$SCRIPT_DIR/install.sh"
  echo ""
  read -n 1 -s -r -p "按任意键继续..."
}

# 命令行模式
case "${1:-}" in
  start)   start_all; exit 0 ;;
  stop)    stop_all; exit 0 ;;
  restart) restart_all; exit 0 ;;
  status)  _show_status; exit 0 ;;
  headless) start_headless_db; exit 0 ;;
esac

# 菜单模式
while true; do
  show_menu
  read -n 1 -s sel
  case $sel in
    1) start_all ;;
    2) start_headless_db ;;
    3) stop_all ;;
    4) restart_all ;;
    5) status_all ;;
    6) logs_headed ;;
    7) logs_headless ;;
    8) logs_database ;;
    9) edit_db_config ;;
    c|C) show_claude_config ;;
    i|I) full_install ;;
    0) echo ""; exit 0 ;;
    *) ;;
  esac
done
