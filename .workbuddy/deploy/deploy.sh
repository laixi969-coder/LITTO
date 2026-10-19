#!/usr/bin/env bash
# LITTO 一键部署（腾讯云 162.14.110.219 / Ubuntu 24.04）
#   bash deploy.sh            首次部署 / 重建
#   bash deploy.sh --update   拉取最新代码后重建
# 幂等：可重复执行。物料与本脚本同目录。
set -Eeuo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=/opt/litto
REPO=$ROOT/repo
GIT_URL=https://github.com/laixi969-coder/LITTO.git
HTTPS_PORT=18443
APP_PORT=13000
ADMIN_EMAIL=66445039@qq.com

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# 可选参数：
#   --no-fetch  不拉取源码，直接用 /opt/litto/repo 里的现有代码（等同 LITTO_SKIP_FETCH=1）
for arg in "$@"; do
  case "$arg" in
    --no-fetch) LITTO_SKIP_FETCH=1 ;;
    -h|--help)  sed -n '2,10p' "$0"; exit 0 ;;
    *)          warn "忽略未知参数：$arg" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 执行"

# ================================================================ 1. 依赖
log "1/8 检查依赖"
if ! command -v docker >/dev/null 2>&1; then
  warn "未检测到 Docker，开始安装"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git nginx openssl
  install -m0755 -d /etc/apt/keyrings
  curl -fsSL https://mirrors.cloud.tencent.com/docker-ce/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.cloud.tencent.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "Docker 守护进程未就绪"

NEED_APT=0
command -v nginx   >/dev/null 2>&1 || NEED_APT=1
command -v git     >/dev/null 2>&1 || NEED_APT=1
command -v openssl >/dev/null 2>&1 || NEED_APT=1
if [[ $NEED_APT -eq 1 ]]; then
  apt-get update -qq
  apt-get install -y -qq nginx git openssl ca-certificates
fi
docker compose version >/dev/null 2>&1 || die "docker compose 插件缺失"
log "Docker $(docker --version | awk '{print $3}' | tr -d ,) / Nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"

# ================================================================ 2. 目录与物料
log "2/8 准备目录与部署物料"
mkdir -p "$ROOT" "$ROOT/data/workspaces/myProject" "$ROOT/nginx" /etc/nginx/ssl /etc/nginx/conf.d
# ACT(部署适配): data 是 bind mount，会盖掉镜像里 `chown -R bun:bun data` 的结果。
# 容器以非 root 用户 bun（uid/gid 1000）运行，宿主机目录必须同步给权限，
# 否则启动即报 `EACCES ... open '/app/data/settings.json.tmp-xxx'` 并无限重启。
chown -R 1000:1000 "$ROOT/data"
# 幂等搬运：源与目标不同才复制，避免 cp 同文件报错
for f in docker-compose.prod.yml set-admin-password.sh bootstrap-admin.ts deploy.sh Dockerfile.patched build.server.scripts.build.ts linkWorkspaces.ts; do
  [[ -f "$SRC_DIR/$f" ]] || die "缺少物料文件 $SRC_DIR/$f"
  [[ "$SRC_DIR/$f" -ef "$ROOT/$f" ]] || cp -f "$SRC_DIR/$f" "$ROOT/$f"
done
[[ "$SRC_DIR/nginx/litto.conf" -ef "$ROOT/nginx/litto.conf" ]] || cp -f "$SRC_DIR/nginx/litto.conf" "$ROOT/nginx/litto.conf"
chmod 700 "$ROOT/set-admin-password.sh" "$ROOT/deploy.sh"

if [[ ! -f $ROOT/litto.env ]]; then
  cat > "$ROOT/litto.env" <<EOF
LITTO_ADMIN_EMAILS=$ADMIN_EMAIL
LITTO_PUBLIC_URL=https://162.14.110.219:$HTTPS_PORT
LITTO_TRUST_PROXY=1
EOF
  chmod 600 "$ROOT/litto.env"
  log "已生成 $ROOT/litto.env"
fi

# ================================================================ 3. 代码
# 大陆访问 github.com:443 常被阻断（TCP 层直接超时），但 codeload.github.com 可达。
# 策略：先探测 github.com，通则 git clone（保留 .git 便于增量更新），不通则下载 codeload 归档。
GH_REPO=laixi969-coder/LITTO
GH_BRANCH=main

fetch_tarball() {
  local tariff=/tmp/litto-src.tar.gz
  local staging=/tmp/litto-src-stage
  local url="https://codeload.github.com/$GH_REPO/tar.gz/refs/heads/$GH_BRANCH"
  rm -f "$tariff"
  local ok=0
  for i in 1 2 3; do
    if curl -fL --connect-timeout 20 --max-time 900 -o "$tariff" "$url"; then ok=1; break; fi
    warn "下载源码第 $i 次失败，5 秒后重试…"; sleep 5
  done
  # 关键：下载失败时绝不破坏已有源码，否则一次网络抖动就把线上代码清空
  if [[ $ok -ne 1 || ! -s $tariff ]]; then
    if [[ -f $REPO/Dockerfile && -f $REPO/package.json ]]; then
      warn "拉取源码失败，但 $REPO 已有可用源码，继续沿用现有代码"
      return 0
    fi
    die "拉取源码失败，且本地无可用源码。请改用本机 update.sh 推送，或检查服务器出网。"
  fi
  # 先解压到暂存目录，成功后再替换，避免留下半成品
  rm -rf "$staging"; mkdir -p "$staging"
  tar -xzf "$tariff" -C "$staging" --strip-components=1 || die "解压源码失败"
  rm -rf "$REPO"; mkdir -p "$REPO"
  cp -a "$staging/." "$REPO/"
  rm -rf "$staging" "$tariff"
  log "已从 codeload 归档更新源码（分支 ${GH_BRANCH}，无 .git）"
}

log "3/8 同步代码 → $REPO"
if [[ "${LITTO_SKIP_FETCH:-0}" == "1" && -f $REPO/Dockerfile && -f $REPO/package.json ]]; then
  log "跳过拉取（复用已有源码，LITTO_SKIP_FETCH=1）"
elif timeout 8 bash -c "echo > /dev/tcp/github.com/443" 2>/dev/null; then
  log "github.com 可达，使用 git clone"
  rm -rf "$REPO"
  if git clone --depth 1 "https://github.com/$GH_REPO.git" "$REPO"; then
    log "当前提交：$(git -C "$REPO" log --oneline -1)"
  else
    warn "git clone 失败，回退 codeload 归档"
    fetch_tarball
  fi
else
  warn "github.com:443 不可达，改用 codeload 归档"
  fetch_tarball
fi
[[ -f $REPO/Dockerfile && -f $REPO/package.json ]] || die "源码不完整：缺 Dockerfile 或 package.json"
log "文件数：$(find "$REPO" -type f -not -path '*/.git/*' | wc -l)"

# ---------------------------------------------------------------- 3b. 大陆网络适配
# npm 官方源实测仅 ~200KB/s，npmmirror 可达 3.8MB/s；bun.lock 未硬编码 registry，切源有效。
log "3b/8 应用大陆网络适配补丁"
# (1) bun 依赖走 npmmirror（官方源实测仅 208KB/s，镜像 3.8MB/s；bun.lock 未硬编码 registry，切源有效）
cat > "$REPO/bunfig.toml" <<'EOF'
# 由 deploy.sh 生成：容器构建时走国内镜像，避免大陆直连 npm 官方源过慢
[install]
registry = "https://registry.npmmirror.com"
EOF
# cloud/ 不在 bun workspace 内，要单独 install，配置也得独立放一份（bunfig 不向上查找）
mkdir -p "$REPO/cloud"
cp -f "$REPO/bunfig.toml" "$REPO/cloud/bunfig.toml"

# (1b) 构建期适配脚本：在根 node_modules/@toonflow 补齐 workspace 软链，
#      否则 workspace 之外的 cloud/src 解析不到 `@toonflow/*`
mkdir -p "$REPO/deployAdapt"
cp -f "$SRC_DIR/linkWorkspaces.ts" "$REPO/deployAdapt/linkWorkspaces.ts"

# (2) Dockerfile：上游存在多处大陆环境/安全适配问题，用带版本标记的版本整体覆盖。
#     标记缺失或版本不符即覆盖；上游若自行修复，把 DEL_ADAPT_VER 改成其版本即可停止覆盖。
DEL_ADAPT_VER='LITTO-DEPLOY-ADAPT v5'
if ! grep -q "$DEL_ADAPT_VER" "$REPO/Dockerfile"; then
  cp -f "$SRC_DIR/Dockerfile.patched" "$REPO/Dockerfile"
  log "Dockerfile 已覆盖为适配版（${DEL_ADAPT_VER}）"
else
  log "Dockerfile 已是适配版（${DEL_ADAPT_VER}）"
fi

# (3) Bun 1.3.14 在 Linux 的 --filter 误读小驼峰目录，build:teams 会报 ENOENT
if grep -q 'run build:teams' "$REPO/apps/server/scripts/build.ts"; then
  cp -f "$SRC_DIR/build.server.scripts.build.ts" "$REPO/apps/server/scripts/build.ts"
  log "build.ts 已替换：逐目录构建 teams，规避 --filter 小驼峰 bug"
else
  log "build.ts 已是适配版本"
fi

grep -E 'mirrors.cloud.tencent.com|bun install' "$REPO/Dockerfile" | head -3

# ================================================================ 4. TLS 证书
log "4/8 TLS 证书"
if [[ ! -s /etc/nginx/ssl/litto.crt ]]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /etc/nginx/ssl/litto.key -out /etc/nginx/ssl/litto.crt \
    -subj "/CN=milimili.net.cn" \
    -addext "subjectAltName=DNS:milimili.net.cn,DNS:www.milimili.net.cn,IP:162.14.110.219" >/dev/null 2>&1
  chmod 600 /etc/nginx/ssl/litto.key
  warn "使用自签证书（浏览器首次访问需点「继续」）；备案完成后换正式证书"
else
  log "复用已有证书"
fi

# ================================================================ 5. 构建并启动
log "5/8 构建镜像并启动（首次预计 10-30 分钟）"
cd "$ROOT"
docker compose -f docker-compose.prod.yml --env-file litto.env up -d --build 2>&1 | tail -40

log "等待服务就绪（最多 15 分钟）…"
READY=0
for i in $(seq 1 90); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$APP_PORT/" 2>/dev/null; then READY=1; break; fi
  sleep 10
done
if [[ $READY -ne 1 ]]; then
  warn "服务未在预期时间内就绪，以下是最后 60 行日志："
  docker logs litto --tail 60 2>&1 || true
  die "启动失败，请把上面的日志发给小搭"
fi
log "服务已就绪"

# ================================================================ 6. Nginx
log "6/8 配置 Nginx 反代 + TLS"
# map 独立成文件（多个 server 块不能重复定义 map）
cp -f "$ROOT/nginx/00-litto-upgrade-map.conf" /etc/nginx/conf.d/00-litto-upgrade-map.conf
cp -f "$ROOT/nginx/litto.conf" /etc/nginx/conf.d/litto.conf
# 正式域名入口：证书已签发则装最终版；未签发则不动（保留阶段一/既有配置，避免打断线上域名）
if [[ -s /etc/letsencrypt/live/milimili.net.cn/fullchain.pem ]]; then
  cp -f "$ROOT/nginx/milimili.conf" /etc/nginx/conf.d/milimili.conf
  log "已安装正式域名配置（443 + Let's Encrypt）"
elif [[ -f /etc/nginx/conf.d/milimili.conf ]]; then
  log "正式域名入口保持现状（尚无 Let's Encrypt 证书）"
else
  cp -f "$ROOT/nginx/milimili.phase1.conf" /etc/nginx/conf.d/milimili.conf
  log "已安装阶段一配置（仅 80 端口，等待签证书）"
fi
rm -f /etc/nginx/sites-enabled/default
nginx -t || die "Nginx 配置校验失败"
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl reload nginx
log "Nginx 已监听 $HTTPS_PORT"

# ================================================================ 7. 管理员账号
log "7/8 初始化管理员账号"
if [[ ! -s $ROOT/.admin-password ]]; then
  # 仅用于打通「首次登录」验证；请随后用 set-admin-password.sh 换成你自己的密码
  openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-24 > "$ROOT/.admin-password"
  chmod 600 "$ROOT/.admin-password"
fi
ADMIN_PW="$(cat "$ROOT/.admin-password")"

docker cp "$ROOT/bootstrap-admin.ts" litto:/tmp/bootstrap-admin.ts >/dev/null
docker compose -f docker-compose.prod.yml --env-file litto.env exec -T \
  -e BOOT_EMAIL="$ADMIN_EMAIL" -e BOOT_PASSWORD="$ADMIN_PW" -e LITTO_DATA_DIR=/app/data/cloud \
  litto bun /tmp/bootstrap-admin.ts

# ================================================================ 8. 自检
log "8/8 端到端自检"
code_home=$(curl -ksS -o /dev/null -w '%{http_code}' "https://127.0.0.1:$HTTPS_PORT/" 2>/dev/null || echo "000")
code_login=$(curl -ksS -o /dev/null -w '%{http_code}' -X POST "https://127.0.0.1:$HTTPS_PORT/cloud/auth/password/login" \
  -H 'content-type: application/json' -H 'x-litto-csrf: 1' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\",\"client\":\"web\"}" 2>/dev/null || echo "000")
# 注意：这里不能用 curl -f，401 会被当成失败，输出会拼成 "401000"
code_me=$(curl -ksS -o /dev/null -w '%{http_code}' "https://127.0.0.1:$HTTPS_PORT/cloud/auth/me" 2>/dev/null || echo "000")

printf '  首页         → %s\n' "$code_home"
printf '  密码登录接口 → %s\n' "$code_login"
printf '  未登录访问   → %s（期望 401，说明鉴权生效）\n' "$code_me"

cat <<EOF

────────────────────────────────────────────────────────
 部署完成
 访问地址 : https://162.14.110.219:$HTTPS_PORT
 登录账号 : $ADMIN_EMAIL
 初始密码 : $ADMIN_PW
           （也存在 $ROOT/.admin-password）
 数据目录 : $ROOT/data（容器内 /app/data）
 查看日志 : docker logs -f litto
 重启服务 : cd $ROOT && docker compose -f docker-compose.prod.yml restart
 更新代码 : bash $ROOT/deploy.sh --update
 改密码   : bash $ROOT/set-admin-password.sh   ← 密码你自己输入，不回显
────────────────────────────────────────────────────────
EOF
