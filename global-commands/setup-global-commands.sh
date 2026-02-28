#!/bin/bash
# ============================================================
# setup-global-commands.sh - 注册 MCP 全局命令到系统 PATH
# ============================================================
#
# 运行此脚本后，以下命令将在任何目录下可用:
#   mcp            - 总管理命令
#   mcp-browser    - 浏览器 MCP 管理
#   mcp-database   - 数据库 MCP 管理
#
# 用法: bash setup-global-commands.sh
# ============================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.local/bin"

echo "========================================"
echo "  MCP Global Commands Setup"
echo "========================================"
echo ""

# 1. 创建 bin 目录
mkdir -p "$BIN_DIR"
echo "[OK] Created $BIN_DIR"

# 2. 复制命令脚本
cp "$SCRIPT_DIR/mcp" "$BIN_DIR/mcp"
cp "$SCRIPT_DIR/mcp-browser" "$BIN_DIR/mcp-browser"
cp "$SCRIPT_DIR/mcp-database" "$BIN_DIR/mcp-database"
chmod +x "$BIN_DIR/mcp" "$BIN_DIR/mcp-browser" "$BIN_DIR/mcp-database"
echo "[OK] Installed commands to $BIN_DIR"

# 3. 添加到 PATH (如果还没有)
SHELL_RC="$HOME/.zshrc"
if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
fi

if ! grep -q '.local/bin' "$SHELL_RC" 2>/dev/null; then
    cat >> "$SHELL_RC" << 'RCEOF'

# ============================================================
# MCP 本地服务 - 全局命令
# ============================================================
# 可用命令:
#   mcp            - 总管理 (start/stop/restart/status/health/info)
#   mcp-browser    - 浏览器 MCP 管理
#   mcp-database   - 数据库 MCP 管理
# ============================================================
export PATH="$HOME/.local/bin:$PATH"
RCEOF
    echo "[OK] Added ~/.local/bin to PATH in $SHELL_RC"
else
    echo "[OK] PATH already configured in $SHELL_RC"
fi

echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
echo "请运行以下命令使配置生效:"
echo "  source $SHELL_RC"
echo ""
echo "然后可以使用:"
echo "  mcp help           # 查看帮助"
echo "  mcp start cursor   # 启动 Cursor 版 MCP"
echo "  mcp info           # 查看服务信息"
echo ""
