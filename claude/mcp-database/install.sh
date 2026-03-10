#!/bin/bash
# ============================================================
# 数据库 MCP 安装脚本
# 支持 macOS / Debian 13 / Ubuntu
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

OS=$(uname -s)
if [[ "$OS" == "Darwin" ]]; then
  PLATFORM="macos"
elif [[ "$OS" == "Linux" ]]; then
  PLATFORM="linux"
else
  err "不支持的操作系统: $OS"
fi
log "平台: $PLATFORM"

# ── 检测 Node.js ──
if ! command -v node &>/dev/null; then
  err "未找到 Node.js (需要 >= 18)"
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
[[ $NODE_VER -lt 18 ]] && err "Node.js 版本过低 ($(node -v)), 需要 >= 18"
log "Node.js $(node -v)"

# ── PM2 ──
if ! command -v pm2 &>/dev/null; then
  warn "安装 PM2..."
  npm install -g pm2
fi
log "PM2 $(pm2 -v)"

# ── Node 依赖 ──
log "安装依赖..."
npm install

# ── 构建 ──
log "构建..."
npm run build

# ── 初始化 .env ──
if [[ ! -f ".env" ]]; then
  if [[ -f ".env.example" ]]; then
    cp .env.example .env
    warn "已创建 .env，请编辑填写数据库连接信息:"
    warn "  nano $SCRIPT_DIR/.env"
  fi
fi

echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  数据库 MCP 安装完成！端口 3214${NC}"
echo ""
echo -e "${GREEN}  启动: pm2 start ecosystem.config.cjs${NC}"
echo -e "${GREEN}  停止: pm2 stop claudemcp-database${NC}"
echo -e "${GREEN}  日志: pm2 logs claudemcp-database${NC}"
echo -e "${GREEN}============================================================${NC}"
