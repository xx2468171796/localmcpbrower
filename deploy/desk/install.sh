#!/usr/bin/env bash
# 工位机(ai-desk)安装 / 更新第 4 期工位管理。root 跑,可反复执行:
#   bash install.sh [--branch 分支] [--no-build] [--no-firewall]
# 做的事:
#   1. 共用只读代码检出 /opt/ai-desk/browser-mcp(root 所有):clone / git pull --ff-only → npm ci → npm run build
#      Chromium 装到 /opt/ai-desk/ms-playwright(所有工位共用,只读)
#   2. 装 systemd 模板单元(desk@.target + desk-*@.service + ai-desk-firewall.service)、/usr/local/sbin/deskctl、desk-smoke
#   3. 装防火墙规则 /etc/ai-desk/nftables.nft 并启用 ai-desk-firewall(只管 8080–8099 / 3215–3234)
# 不碰已有工位的数据和密钥;代码更新后要 `deskctl restart <id>`(或逐个)才生效。
# 拉代码用 /etc/ai-desk/git-credentials(root 600,deploy-ai-desk 只读令牌;首次从 /home/desk/.git-credentials 拷)。
set -euo pipefail
die() { echo "install: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "需要 root"

BRANCH=feat/desk-3.0
BUILD=1
FIREWALL=1
while [ $# -gt 0 ]; do
  case $1 in
    --branch) BRANCH=${2:-}; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    *) die "看不懂参数 $1" ;;
  esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
REPO_URL=http://192.168.110.246:3001/gonggong/localmcpbrower.git
CODE=/opt/ai-desk/browser-mcp
BROWSERS=/opt/ai-desk/ms-playwright
CRED=/etc/ai-desk/git-credentials
export PLAYWRIGHT_BROWSERS_PATH=$BROWSERS

install -d -m 700 /etc/ai-desk /etc/ai-desk/desks
install -d -m 755 /opt/ai-desk
if [ ! -s "$CRED" ] && [ -s /home/desk/.git-credentials ]; then
  install -m 600 -o root -g root /home/desk/.git-credentials "$CRED"
fi
[ -s "$CRED" ] || die "缺 $CRED(Gitea deploy-ai-desk 只读令牌,资产「Gitea · ai-desk 只读部署令牌 deploy-ai-desk」)"
GIT=(git -c "credential.helper=store --file=$CRED" -c safe.directory="$CODE")

if [ "$BUILD" = 1 ]; then
  if [ ! -d "$CODE/.git" ]; then
    "${GIT[@]}" clone --branch "$BRANCH" "$REPO_URL" "$CODE"
  else
    "${GIT[@]}" -C "$CODE" fetch origin "$BRANCH"
    "${GIT[@]}" -C "$CODE" checkout -q "$BRANCH" 2>/dev/null || "${GIT[@]}" -C "$CODE" checkout -q -b "$BRANCH" "origin/$BRANCH"
    "${GIT[@]}" -C "$CODE" merge --ff-only "origin/$BRANCH"
  fi
  (cd "$CODE/claude" && npm ci --no-audit --no-fund && npm run build)
  (cd "$CODE/claude" && npx patchright install chromium)
  chown -R root:root "$CODE" "$BROWSERS"
  chmod -R a+rX,go-w "$CODE" "$BROWSERS"
  echo "install: 代码 $(git -c safe.directory="$CODE" -C "$CODE" log --oneline -1)"
fi

install -m 644 "$HERE"/units/desk@.target "$HERE"/units/desk-*@.service "$HERE"/units/ai-desk-firewall.service /etc/systemd/system/
install -m 750 "$HERE/deskctl" /usr/local/sbin/deskctl
install -m 750 "$HERE/desk-smoke.sh" /usr/local/sbin/desk-smoke
systemctl daemon-reload

if [ "$FIREWALL" = 1 ]; then
  install -m 600 "$HERE/nftables/ai-desk.nft" /etc/ai-desk/nftables.nft
  nft -c -f /etc/ai-desk/nftables.nft || die "防火墙规则检查没过"
  systemctl enable -q ai-desk-firewall
  systemctl restart ai-desk-firewall
  echo "install: 防火墙已加载(nft list table inet ai_desk)"
fi
echo "INSTALL_OK"
