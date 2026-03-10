#!/bin/bash

# MCP 服务健康检查脚本

echo "==================================="
echo "MCP 服务健康检查"
echo "==================================="
echo ""

# 检查 Browser MCP
echo "1. Browser MCP (端口 3213)"
echo "-----------------------------------"
BROWSER_HEALTH=$(curl -s http://localhost:3213/health 2>&1)
if [ $? -eq 0 ]; then
    echo "✅ Browser MCP 运行正常"
    echo "$BROWSER_HEALTH" | jq '.' 2>/dev/null || echo "$BROWSER_HEALTH"
else
    echo "❌ Browser MCP 无响应"
    echo "   请检查: pm2 status claudemcp-browser"
fi
echo ""

# 检查 Database MCP
echo "2. Database MCP (端口 3214)"
echo "-----------------------------------"
DB_HEALTH=$(curl -s http://localhost:3214/health 2>&1)
if [ $? -eq 0 ]; then
    echo "✅ Database MCP 运行正常"
    echo "$DB_HEALTH" | jq '.' 2>/dev/null || echo "$DB_HEALTH"
else
    echo "❌ Database MCP 无响应"
    echo "   请检查: pm2 status claudemcp-database"
fi
echo ""

# 检查 PM2 服务状态
echo "3. PM2 服务状态"
echo "-----------------------------------"
pm2 list | grep -E "claudemcp-browser|claudemcp-database" || echo "❌ 未找到 MCP 服务"
echo ""

# 检查配置文件
echo "4. 配置文件检查"
echo "-----------------------------------"
if [ -f ~/.config/claude-code/mcp.json ]; then
    echo "✅ Claude Code 配置存在: ~/.config/claude-code/mcp.json"
else
    echo "❌ Claude Code 配置不存在"
fi

if [ -f ~/.codeium/windsurf/mcp_config.json ]; then
    echo "✅ Windsurf 配置存在: ~/.codeium/windsurf/mcp_config.json"
else
    echo "⚠️  Windsurf 配置不存在"
fi

if [ -f /Users/macbook/code/csgo0128/.cursor/mcp.json ]; then
    echo "✅ Cursor 配置存在: .cursor/mcp.json"
else
    echo "⚠️  Cursor 配置不存在"
fi
echo ""

echo "==================================="
echo "检查完成"
echo "==================================="
