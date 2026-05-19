#!/bin/bash
# ============================================================
# Claude Code MCP - 服务健康检查 (HTTP / PM2 模式)
# 注: stdio 原生模式不占端口，无需此检查
# ============================================================

echo "==================================="
echo "Claude Code MCP 服务健康检查"
echo "==================================="
echo ""

check_http() {
  local idx=$1 label=$2 port=$3 svc=$4
  echo "$idx. $label (端口 $port)"
  echo "-----------------------------------"
  local body
  body=$(curl -s "http://localhost:$port/health" 2>&1)
  if [ $? -eq 0 ] && [ -n "$body" ]; then
    echo "✅ $label 运行正常"
    echo "$body" | jq '.' 2>/dev/null || echo "$body"
  else
    echo "❌ $label 无响应"
    echo "   请检查: pm2 status $svc"
  fi
  echo ""
}

check_http 1 "有头浏览器 MCP" 3213 claudemcp-browser
check_http 2 "无头浏览器 MCP" 3215 claudemcp-headless
check_http 3 "数据库 MCP"     3214 claudemcp-database

# 检查 PM2 服务状态
echo "4. PM2 服务状态"
echo "-----------------------------------"
pm2 list 2>/dev/null | grep -E "claudemcp-browser|claudemcp-headless|claudemcp-database" \
  || echo "⚠️  未找到 PM2 中的 MCP 服务 (stdio 模式下属正常)"
echo ""

# 检查配置文件
echo "5. Claude Code 配置检查"
echo "-----------------------------------"
if [ -f ~/.config/claude-code/mcp.json ]; then
    echo "✅ 全局 HTTP 配置存在: ~/.config/claude-code/mcp.json"
else
    echo "⚠️  未找到 ~/.config/claude-code/mcp.json (HTTP 模式)"
fi
if [ -f .mcp.json ]; then
    echo "✅ 项目级 stdio 配置存在: ./.mcp.json"
else
    echo "⚠️  未找到项目级 ./.mcp.json (stdio 模式，可由 .mcp.json.example 创建)"
fi
echo ""

echo "==================================="
echo "检查完成"
echo "==================================="
