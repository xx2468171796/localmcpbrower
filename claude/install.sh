#!/bin/bash
# ============================================================
# Claude Code MCP - 安装脚本 (macOS / Linux)
# 跨平台主入口为 node mcp.mjs install (含 Windows)；本脚本为类 Unix 原生回退
# 安装内容: 有头浏览器MCP(3213) + 无头浏览器MCP(3215) + 数据库MCP(3214)
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}── $1${NC}"; }

# ── 检测平台 ──
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
step "检查 Node.js"
if ! command -v node &>/dev/null; then
  if [[ "$PLATFORM" == "macos" ]]; then
    err "未找到 Node.js，请先安装: brew install node"
  else
    err "未找到 Node.js，请先安装:\n  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -\n  sudo apt install -y nodejs"
  fi
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ $NODE_VER -lt 20 ]]; then
  err "Node.js 版本过低 ($(node -v))，需要 >= 20"
fi
log "Node.js $(node -v)"

# ── Linux 系统依赖 (Debian/Ubuntu) ──
if [[ "$PLATFORM" == "linux" ]]; then
  step "安装 Chromium 系统依赖 (Linux)"
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -q
    sudo apt-get install -y -q \
      libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2t64 libpangocairo-1.0-0 libpango-1.0-0 \
      libcairo2 libx11-6 libxext6 fonts-liberation wget ca-certificates \
      2>/dev/null || sudo apt-get install -y -q \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 \
      libcairo2 libx11-6 libxext6 fonts-liberation wget ca-certificates
    log "Chromium 系统依赖安装完成"
  else
    warn "非 apt 系统，请手动安装 Chromium 依赖"
  fi
fi

# ── PM2 ──
step "检查 PM2"
if ! command -v pm2 &>/dev/null; then
  warn "安装 PM2..."
  npm install -g pm2
fi
log "PM2 $(pm2 -v)"

# ── 浏览器 MCP: Node 依赖 ──
step "安装浏览器 MCP 依赖"
npm install
log "浏览器 MCP 依赖安装完成"

# ── 安装 Playwright Chromium ──
step "安装 Playwright Chromium"
if [[ "$PLATFORM" == "linux" ]]; then
  npx playwright install --with-deps chromium
else
  npx playwright install chromium
fi
log "Playwright Chromium 安装完成"

# ── 构建浏览器 MCP ──
step "构建浏览器 MCP"
npm run build
log "浏览器 MCP 构建完成"

# ── 数据库 MCP ──
step "安装数据库 MCP 依赖"
cd "$SCRIPT_DIR/mcp-database"
npm install
log "数据库 MCP 依赖安装完成"

step "构建数据库 MCP"
npm run build
log "数据库 MCP 构建完成"

# ── 初始化数据库配置 ──
if [[ ! -f ".env" ]]; then
  if [[ -f ".env.example" ]]; then
    cp .env.example .env
    warn "请编辑 mcp-database/.env 填写数据库连接信息"
  fi
fi

cd "$SCRIPT_DIR"

# ── 创建日志目录 ──
mkdir -p logs storage/user_data storage/screenshots

# ── 写入 Claude Code MCP 配置 ──
step "写入 Claude Code MCP 配置"
CLAUDE_MCP_DIR="$HOME/.config/claude-code"
mkdir -p "$CLAUDE_MCP_DIR"
MCP_CONFIG="$CLAUDE_MCP_DIR/mcp.json"

# 检查 Linux 上 Claude Code 配置路径
if [[ "$PLATFORM" == "linux" ]]; then
  CLAUDE_MCP_DIR2="$HOME/.claude"
  mkdir -p "$CLAUDE_MCP_DIR2"
  MCP_CONFIG2="$CLAUDE_MCP_DIR2/mcp.json"
fi

if [[ "$PLATFORM" == "macos" ]]; then
  cat > "$MCP_CONFIG" << 'EOF'
{
  "mcpServers": {
    "browser-headed": {
      "type": "http",
      "url": "http://localhost:3213/mcp"
    },
    "browser-headless": {
      "type": "http",
      "url": "http://localhost:3215/mcp"
    },
    "database": {
      "type": "http",
      "url": "http://localhost:3214/mcp"
    }
  }
}
EOF
  log "Claude Code MCP 配置写入: $MCP_CONFIG"
else
  # Linux: 只有无头浏览器 + 数据库
  cat > "$MCP_CONFIG" << 'EOF'
{
  "mcpServers": {
    "browser-headless": {
      "type": "http",
      "url": "http://localhost:3215/mcp"
    },
    "database": {
      "type": "http",
      "url": "http://localhost:3214/mcp"
    }
  }
}
EOF
  log "Claude Code MCP 配置写入: $MCP_CONFIG"
fi

# ── 完成 ──
echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${GREEN}  平台: $PLATFORM${NC}"
echo ""
if [[ "$PLATFORM" == "macos" ]]; then
  echo -e "${GREEN}  有头浏览器 MCP:  port 3213 (本地 Mac 开发)${NC}"
fi
echo -e "${GREEN}  无头浏览器 MCP:  port 3215 (服务器 / SSH 环境)${NC}"
echo -e "${GREEN}  数据库 MCP:      port 3214${NC}"
echo ""
echo -e "${GREEN}  推荐 (stdio 原生模式，无需 PM2 / 端口):${NC}"
echo -e "${GREEN}    node mcp.mjs config        # 获取 claude mcp add 配置命令${NC}"
echo ""
echo -e "${GREEN}  HTTP / PM2 模式:${NC}"
echo -e "${GREEN}    ./manage.sh start          # 启动所有服务${NC}"
echo -e "${GREEN}    ./manage.sh status         # 查看状态${NC}"
echo -e "${GREEN}    ./manage.sh                # 交互式管理菜单${NC}"
echo -e "${GREEN}============================================================${NC}"
