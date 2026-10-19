#!/usr/bin/env bash
# 设置 / 重置 LITTO 管理员登录密码（在服务器上执行）
# 密码由你交互输入：不回显、不落盘、不进 shell 历史、不进对话记录
#   bash set-admin-password.sh                      # 默认账号 66445039@qq.com
#   bash set-admin-password.sh other@example.com    # 指定账号
set -Eeuo pipefail

ROOT=/opt/litto
ADMIN_EMAIL="${1:-66445039@qq.com}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 执行（sudo -i 后再跑）"
[[ -f $ROOT/docker-compose.prod.yml ]] || die "未找到 $ROOT/docker-compose.prod.yml，请先跑 deploy.sh"
[[ -f $ROOT/bootstrap-admin.ts ]]      || die "缺少 $ROOT/bootstrap-admin.ts"

read -r -s -p "请输入 ${ADMIN_EMAIL} 的新密码（至少 12 位）: " P1; echo
read -r -s -p "请再输入一次确认: " P2; echo
[[ "$P1" == "$P2" ]] || die "两次输入不一致"
[[ ${#P1} -ge 12 ]]   || die "密码至少 12 位（应用侧强制 12-256）"

log "写入密码"
cd "$ROOT"
docker cp "$ROOT/bootstrap-admin.ts" litto:/tmp/bootstrap-admin.ts >/dev/null
docker compose -f docker-compose.prod.yml --env-file litto.env exec -T \
  -e BOOT_EMAIL="$ADMIN_EMAIL" -e BOOT_PASSWORD="$P1" -e LITTO_DATA_DIR=/app/data/cloud \
  litto bun /tmp/bootstrap-admin.ts
unset P1 P2

# 清掉部署时自动生成的初始密码，避免残留明文
if [[ -f $ROOT/.admin-password ]]; then
  shred -u "$ROOT/.admin-password" 2>/dev/null || rm -f "$ROOT/.admin-password"
  log "已清除初始密码文件 $ROOT/.admin-password"
fi

log "完成。用 ${ADMIN_EMAIL} + 你刚设置的密码登录即可。"
