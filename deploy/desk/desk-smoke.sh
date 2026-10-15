#!/usr/bin/env bash
# 工位冒烟(root 跑):带该工位的 MCP 令牌按 MCP 协议 navigate 一个网址,读回标题;Selkies 带 / 不带密码各打一次;
# 并以工位用户身份截它自己的虚拟屏到 /home/desk-<id>/data/shots/desk-smoke.png。
#   bash desk-smoke.sh <id> [网址]
# 令牌只经 root 700 临时目录里的头文件交给 curl,不进命令行,也不打印。
set -euo pipefail
die() { echo "desk-smoke: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "需要 root"
ID=${1:-}; URL=${2:-https://www.baidu.com}
URL_RE='^https?://[A-Za-z0-9._~:/?#@!&()*+,;=%-]+$'   # 网址要拼进 JSON,不许引号 / 反斜杠
[[ "$URL" =~ $URL_RE ]] || die "网址不合法"
[[ "$ID" =~ ^[a-z][a-z0-9]{0,26}$ ]] || die "用法:desk-smoke.sh <id> [网址]"
F=/etc/ai-desk/desks/$ID.env
[ -f "$F" ] || die "没有工位 $ID"
get() { sed -n "s/^$1=//p" "$F" | tail -n1; }
HOST=$(get HOST); PORT=$(get PORT); SPORT=$(get SELKIES_PORT); DISP=$(get DISPLAY)
E=http://$HOST:$PORT/mcp
T=$(mktemp -d /run/desk-smoke.XXXXXX); trap 'rm -rf "$T"' EXIT
printf 'Authorization: Bearer %s\nContent-Type: application/json\nAccept: application/json, text/event-stream\nMCP-Protocol-Version: 2025-11-25\n' "$(get MCP_AUTH_TOKEN)" > "$T/h"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$E" -H 'Content-Type: application/json' -d '{}')
echo "无令牌 POST /mcp → HTTP $code(应为 401)"
SID=$(curl -sS -H @"$T/h" -D - -o /dev/null -X POST "$E" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"desk-smoke","version":"1"}}}' \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}')
[ -n "$SID" ] || die "initialize 失败(令牌不对或服务没起)"
echo "Mcp-Session-Id: $SID" >> "$T/h"
curl -sS -H @"$T/h" -o /dev/null -X POST "$E" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo "工具数 $(curl -sS -H @"$T/h" -X POST "$E" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"' | sort -u | wc -l)"
curl -sS -H @"$T/h" -X POST "$E" -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"navigate\",\"arguments\":{\"url\":\"$URL\"}}}" \
  | grep -o '"title\\\{0,1\}":\\\{0,1\}"[^"\\]\{0,80\}' | head -1 | sed 's/^/navigate → /'

# 会话还开着时截屏(会话关掉、最后一页关了 Chrome 会退出,画面只剩壁纸)
sleep 1
SHOT=/home/desk-$ID/data/shots/desk-smoke.png
runuser -u "desk-$ID" -- env DISPLAY="$DISP" XAUTHORITY="/home/desk-$ID/.Xauthority" import -window root "$SHOT" && runuser -u "desk-$ID" -- identify "$SHOT"
curl -sS -H @"$T/h" -o /dev/null -X DELETE "$E" || true

printf 'user = "admin:%s"\n' "$(get SELKIES_BASIC_AUTH_PASSWORD)" > "$T/c"
echo "Selkies 无密码 → HTTP $(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$SPORT/")(应为 401)"
echo "Selkies 带密码 → HTTP $(curl -sk -K "$T/c" -o /dev/null -w '%{http_code}' "https://127.0.0.1:$SPORT/")(应为 200)"
echo "SMOKE_DONE $ID"
