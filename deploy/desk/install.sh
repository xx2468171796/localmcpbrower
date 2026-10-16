#!/usr/bin/env bash
# 工位机(ai-desk)安装 / 更新第 4 期工位管理。root 跑,可反复执行:
#   bash install.sh [--branch 分支] [--no-build] [--no-firewall]
# 做的事:
#   1. 代码:/opt/ai-desk/src 是 git 检出(只拉不跑);每个提交构建成一份 /opt/ai-desk/releases/<提交>(root 所有、只读),
#      构建完再把 /opt/ai-desk/browser-mcp 这个符号链接切过去 —— 不在正跑着的目录里 npm ci(会删掉 node_modules,
#      在跑的服务懒加载模块时会崩)。留最近 3 份。Chromium 装到 /opt/ai-desk/ms-playwright(所有工位共用,只读)
#   2. 装 systemd 模板单元(desk@.target + desk-*@.service + ai-desk-firewall.service)、/usr/local/sbin/deskctl、desk-smoke;
#      缺 xrandr(x11-xserver-utils)/ polkitd 就 apt 装上;polkit 规则 50-ai-desk.rules(工位用户只能重启自己的 desk-selkies@)
#   3. 装防火墙规则 /etc/ai-desk/nftables.nft 并启用 ai-desk-firewall(只管 8080–8099 / 3215–3234);
#      同时 include 进 /etc/nftables.conf —— 那个文件开头是 flush ruleset,谁哪天启用 nftables.service 也不会把工位表冲掉
#   4. 主机杂项:journald 上限、截图 7 天清理、关 LLMNR
# 不碰已有工位的数据和密钥;代码更新后要 `deskctl restart <id>`(或逐个)才生效。
# 不带 --branch 就沿用当前检出的分支(第一次装必须带)。
# 拉代码用 /etc/ai-desk/git-credentials(root 600,deploy-ai-desk 只读令牌)。
set -euo pipefail
die() { echo "install: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "需要 root"

BRANCH=""
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
SRC=/opt/ai-desk/src
RELEASES=/opt/ai-desk/releases
CODE=/opt/ai-desk/browser-mcp
BROWSERS=/opt/ai-desk/ms-playwright
CRED=/etc/ai-desk/git-credentials
KEEP_RELEASES=3
export PLAYWRIGHT_BROWSERS_PATH=$BROWSERS

install -d -m 700 /etc/ai-desk /etc/ai-desk/desks
install -d -m 755 /opt/ai-desk "$RELEASES"
[ -s "$CRED" ] || die "缺 $CRED(Gitea deploy-ai-desk 只读令牌,资产「Gitea · ai-desk 只读部署令牌 deploy-ai-desk」)"
GIT=(git -c "credential.helper=store --file=$CRED" -c safe.directory="$SRC")

# 旧布局:browser-mcp 本身是检出目录 → 挪成 src(在跑的进程不受影响,下次 restart 才换到新 release)
if [ -d "$CODE/.git" ] && [ ! -L "$CODE" ] && [ ! -e "$SRC" ]; then
  mv "$CODE" "$SRC"
  echo "install: 旧检出挪到 $SRC"
fi

if [ "$BUILD" = 1 ]; then
  if [ ! -d "$SRC/.git" ]; then
    [ -n "$BRANCH" ] || die "第一次装要带 --branch"
    "${GIT[@]}" clone --branch "$BRANCH" "$REPO_URL" "$SRC"
  else
    cur=$("${GIT[@]}" -C "$SRC" rev-parse --abbrev-ref HEAD)
    [ -n "$BRANCH" ] || BRANCH=$cur
    "${GIT[@]}" -C "$SRC" fetch origin "$BRANCH"
    if [ "$BRANCH" != "$cur" ]; then
      "${GIT[@]}" -C "$SRC" checkout -q "$BRANCH" 2>/dev/null || "${GIT[@]}" -C "$SRC" checkout -q -b "$BRANCH" "origin/$BRANCH"
    fi
    "${GIT[@]}" -C "$SRC" merge --ff-only "origin/$BRANCH"
  fi
  sha=$("${GIT[@]}" -C "$SRC" rev-parse --short=12 HEAD)
  rel=$RELEASES/$sha
  if [ ! -f "$rel/.built" ]; then
    rm -rf "$rel" "$rel.tmp"; mkdir -p "$rel.tmp"
    "${GIT[@]}" -C "$SRC" archive HEAD | tar -x -C "$rel.tmp"
    (cd "$rel.tmp/claude" && npm ci --no-audit --no-fund && npm run build)
    (cd "$rel.tmp/claude" && npx patchright install chromium)
    chown -R root:root "$rel.tmp" "$BROWSERS"
    chmod -R a+rX,go-w "$rel.tmp" "$BROWSERS"
    touch "$rel.tmp/.built"
    mv -T "$rel.tmp" "$rel"
  fi
  # 符号链接原子切换;若 browser-mcp 还是个普通目录(没有 .git 的残留)先挪开
  if [ -e "$CODE" ] && [ ! -L "$CODE" ]; then mv "$CODE" "$CODE.old-$(date +%Y%m%d%H%M%S)"; fi
  ln -sfn "$rel" "$CODE.new" && mv -T "$CODE.new" "$CODE"
  echo "install: 代码 $("${GIT[@]}" -C "$SRC" log --oneline -1)(release $sha)"
  # 只留最近几份(当前那份不删)
  ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
    [ "$(readlink -f "$old")" = "$(readlink -f "$CODE")" ] || rm -rf "$old"
  done
fi

# 系统包:xrandr(切虚拟屏分辨率)、polkitd(工位用户重启自己的画面服务)。其余(Xvfb / openbox / feh / Selkies)第 0 期已装
missing=()
command -v xrandr >/dev/null || missing+=(x11-xserver-utils)
[ -d /etc/polkit-1/rules.d ] && command -v pkaction >/dev/null || missing+=(polkitd)
if [ ${#missing[@]} -gt 0 ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}" || die "装不上 ${missing[*]}"
fi
install -m 644 "$HERE/polkit/50-ai-desk.rules" /etc/polkit-1/rules.d/50-ai-desk.rules

install -m 644 "$HERE"/units/desk@.target "$HERE"/units/desk-*@.service "$HERE"/units/ai-desk-firewall.service /etc/systemd/system/
install -m 750 "$HERE/deskctl" /usr/local/sbin/deskctl
install -m 750 "$HERE/desk-smoke.sh" /usr/local/sbin/desk-smoke
systemctl daemon-reload

if [ "$FIREWALL" = 1 ]; then
  install -m 600 "$HERE/nftables/ai-desk.nft" /etc/ai-desk/nftables.nft
  nft -c -f /etc/ai-desk/nftables.nft || die "防火墙规则检查没过"
  if [ -f /etc/nftables.conf ] && ! grep -q '/etc/ai-desk/nftables.nft' /etc/nftables.conf; then
    printf '\n# AI 工位端口(deskctl / install.sh 管;flush ruleset 之后重新加载,别删)\ninclude "/etc/ai-desk/nftables.nft"\n' >> /etc/nftables.conf
  fi
  systemctl enable -q ai-desk-firewall
  # reload 而不是 restart:desk 单元 Requires= 防火墙,restart 会连带重启所有工位;规则文件本身是先删后建的原子事务
  systemctl reload-or-restart ai-desk-firewall
  echo "install: 防火墙已加载(nft list table inet ai_desk)"
fi

# 主机杂项
install -d -m 755 /etc/systemd/journald.conf.d /etc/systemd/resolved.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/ai-desk.conf
printf '[Resolve]\nLLMNR=no\n' > /etc/systemd/resolved.conf.d/ai-desk.conf
printf '# 工位截图 7 天清理\ne /home/desk-*/data/shots - - - 7d\n' > /etc/tmpfiles.d/ai-desk.conf
systemctl restart systemd-journald systemd-resolved 2>/dev/null || true
echo "INSTALL_OK"
