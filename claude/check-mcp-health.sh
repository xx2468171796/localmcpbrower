#!/bin/bash
# ============================================================
# Claude Code MCP - 服务健康检查 (HTTP / PM2 模式)
# 注: stdio 原生模式不占端口，无需此检查
# ============================================================

echo "==================================="
echo "Claude Code MCP 服务健康检查"
echo "==================================="
echo ""

# 探测地址跟随实际绑定：服务默认只绑 127.0.0.1；按 DEPLOY.md 跨机步骤把 HOST 改成
# 具体网卡地址（如 192.168.1.10）后，再从 localhost 探测会一律 fetch failed、误判服务没起来。
# HOST=0.0.0.0 时它监听全部网卡，回落 127.0.0.1 探测即可。
PROBE_HOST="${HOST:-127.0.0.1}"
if [ "$PROBE_HOST" = "0.0.0.0" ] || [ "$PROBE_HOST" = "::" ]; then
  PROBE_HOST="127.0.0.1"
fi
# 端口同样可被环境变量覆盖，与 ecosystem*.cjs 里改过的 PORT 对齐
HEADED_PORT="${HEADED_PORT:-3213}"
HEADLESS_PORT="${HEADLESS_PORT:-3215}"
DB_PORT="${DB_PORT:-3214}"
# 开了 MCP_AUTH_TOKEN 时 /health 仍开放（专供探活），无需带 token

check_http() {
  local idx=$1 label=$2 port=$3 svc=$4
  echo "$idx. $label ($PROBE_HOST:$port)"
  echo "-----------------------------------"
  local body
  body=$(curl -s "http://$PROBE_HOST:$port/health" 2>&1)
  if [ $? -eq 0 ] && [ -n "$body" ]; then
    echo "✅ $label 运行正常"
    echo "$body" | jq '.' 2>/dev/null || echo "$body"
  else
    echo "❌ $label 无响应"
    echo "   请检查: pm2 status $svc"
  fi
  echo ""
}

check_http 1 "有头浏览器 MCP" "$HEADED_PORT"   claudemcp-browser
check_http 2 "无头浏览器 MCP" "$HEADLESS_PORT" claudemcp-headless
check_http 3 "数据库 MCP"     "$DB_PORT"       claudemcp-database

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
