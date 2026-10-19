#!/usr/bin/env bash
# LITTO 更新部署（在你自己 Mac 的终端里运行）
#
#   bash update.sh              部署「工作区当前内容」（含未提交改动，只推 git 跟踪的文件）
#   bash update.sh --head       部署「最后一次提交」的内容
#   bash update.sh --no-build   只推代码到服务器，不重建镜像
#
# 为什么不直接在服务器上跑 deploy.sh 拉代码：
#   大陆服务器访问 github.com:443 会被阻断，走 codeload 归档实测只有 31KB/s；
#   而本机上传到服务器实测 4.3MB/s（快约 140 倍）。所以更新一律「本机推」。
set -Eeuo pipefail

REPO_DIR="${LITTO_REPO_DIR:-$HOME/LITTO}"
DEPLOY_DIR="$REPO_DIR/.workbuddy/deploy"
SSH_KEY="${LITTO_SSH_KEY:-$HOME/.ssh/litto_tencent}"
HOST="${LITTO_HOST:-root@162.14.110.219}"
REMOTE_DIR=/opt/litto
SITE_URL="${LITTO_SITE_URL:-https://milimili.net.cn}"
TAR=/tmp/litto-update.tar.gz
LIST=/tmp/litto-update.files

MODE=worktree
NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --head)     MODE=head ;;
    --no-build) NO_BUILD=1 ;;
    -h|--help)  sed -n '2,12p' "$0"; exit 0 ;;
    *) printf '未知参数：%s\n' "$arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$HOST")
SCP=(scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

# ================================================================ 1. 本地检查
log "1/5 本地检查"
[[ -d "$REPO_DIR/.git" ]] || die "找不到 Git 仓库：${REPO_DIR}（可用 LITTO_REPO_DIR=... 指定）"
[[ -f "$SSH_KEY" ]]       || die "找不到 SSH 私钥：${SSH_KEY}（可用 LITTO_SSH_KEY=... 指定）"
"${SSH[@]}" 'echo ok' >/dev/null || die "SSH 连不上 $HOST"
log "仓库 $REPO_DIR ・ 密钥 $SSH_KEY ・ SSH 正常"

# ================================================================ 2. 打包代码
log "2/5 打包代码（模式：${MODE}）"
rm -f "$TAR"
if [[ "$MODE" == "head" ]]; then
  git -C "$REPO_DIR" archive --format=tar HEAD | gzip -9 > "$TAR"
  log "已打包提交：$(git -C "$REPO_DIR" log --oneline -1)"
else
  cd "$REPO_DIR"
  git ls-files > "$LIST"                       # 只含被 git 跟踪的文件，天然排除 node_modules
  # --no-xattrs / COPYFILE_DISABLE：macOS 会把 Apple 扩展属性写进 tar，
  # 服务器的 GNU tar 解压时会刷一屏 "Ignoring unknown extended header keyword" 警告
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TAR" -T "$LIST"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    warn "工作区有未提交改动，已一并打包（这些改动不会被 --head 模式包含）"
  fi
  log "已打包工作区 $(wc -l < "$LIST" | tr -d ' ') 个跟踪文件"
fi
[[ -s "$TAR" ]] || die "打包失败"
printf '  包大小：%s\n' "$(du -h "$TAR" | cut -f1)"

# ================================================================ 3. 上传代码
log "3/5 上传代码到 $HOST:$REMOTE_DIR/repo"
cat "$TAR" | "${SSH[@]}" \
  "rm -rf $REMOTE_DIR/repo && mkdir -p $REMOTE_DIR/repo && tar -xzf - -C $REMOTE_DIR/repo && test -f $REMOTE_DIR/repo/Dockerfile && test -f $REMOTE_DIR/repo/package.json" \
  || die "上传或解压失败"
log "代码已就位"

# ================================================================ 4. 同步部署脚本与配置
log "4/5 同步部署脚本 / 构建适配 / Nginx 配置"
# 注意：故意不同步 litto.env，避免把服务器上的线上配置（如 LITTO_PUBLIC_URL）覆盖回模板值
"${SCP[@]}" -q \
  "$DEPLOY_DIR/deploy.sh" \
  "$DEPLOY_DIR/set-admin-password.sh" \
  "$DEPLOY_DIR/enable-domain-tls.sh" \
  "$DEPLOY_DIR/bootstrap-admin.ts" \
  "$DEPLOY_DIR/Dockerfile.patched" \
  "$DEPLOY_DIR/linkWorkspaces.ts" \
  "$DEPLOY_DIR/build.server.scripts.build.ts" \
  "$DEPLOY_DIR/docker-compose.prod.yml" \
  "$HOST:$REMOTE_DIR/"
"${SCP[@]}" -q "$DEPLOY_DIR/nginx/"*.conf "$HOST:$REMOTE_DIR/nginx/"
"${SSH[@]}" "chmod 700 $REMOTE_DIR/deploy.sh $REMOTE_DIR/set-admin-password.sh; chmod 755 $REMOTE_DIR/enable-domain-tls.sh"
log "脚本与配置已同步（litto.env 保持服务器现状）"

if [[ $NO_BUILD -eq 1 ]]; then
  warn "--no-build：已跳过重建。需要生效时执行："
  printf '  ssh -i %s %s "LITTO_SKIP_FETCH=1 bash %s/deploy.sh"\n' "$SSH_KEY" "$HOST" "$REMOTE_DIR"
  exit 0
fi

# ================================================================ 5. 重建并重启
log "5/5 服务器重建镜像并重启（约 3-5 分钟，请勿中断）"
"${SSH[@]}" "LITTO_SKIP_FETCH=1 bash $REMOTE_DIR/deploy.sh" 2>&1 | tail -35
rc=${PIPESTATUS[0]}
[[ "$rc" -eq 0 ]] || die "部署失败（退出码 ${rc}）。服务器日志：${REMOTE_DIR}/deploy.log"

# ================================================================ 收尾自检
log "外站自检"
code_site=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$SITE_URL/" 2>/dev/null || echo "000")
printf '  %s → HTTP %s\n' "$SITE_URL" "$code_site"
[[ "$code_site" == "200" ]] || warn "站点未返回 200，请检查：ssh -i $SSH_KEY $HOST 'docker logs litto --tail 50'"

log "更新完成"
