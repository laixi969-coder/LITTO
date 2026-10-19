#!/usr/bin/env bash
# 备案通过后，启用正式域名 + Let's Encrypt 证书。
#
#   bash enable-domain-tls.sh              # 完整流程（装 certbot → 签证书 → 切 443）
#   LITTO_TLS_PHASE=1 bash enable-domain-tls.sh   # 只做阶段一（开 80 端口供校验），用于先验证外部可达性
#
# 幂等：可重复执行。已签发的证书不会重签（除非传 --force-renew）。
set -Eeuo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=/opt/litto
NGINX_CONF=/etc/nginx/conf.d
DOMAIN=milimili.net.cn
WWW_DOMAIN=www.milimili.net.cn
WEBROOT=/var/www/certbot
EMAIL=66445039@qq.com
EXPECTED_IP=162.14.110.219
APP_PORT=13000
HTTPS_PORT_FALLBACK=18443

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 执行"

# ================================================================ 0. 前置检查
log "0/7 前置检查"
resolved=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
[[ "$resolved" == "$EXPECTED_IP" ]] || die "$DOMAIN 解析到 ${resolved}，期望 ${EXPECTED_IP}。请先在 DNSPod 添加 A 记录。"
resolved_www=$(getent ahostsv4 "$WWW_DOMAIN" | awk 'NR==1{print $1}')
[[ "$resolved_www" == "$EXPECTED_IP" ]] || warn "$WWW_DOMAIN 解析到 ${resolved_www:-空}，证书将失败"
curl -fsS -o /dev/null --max-time 10 http://127.0.0.1:${APP_PORT}/ || die "LITTO 容器未就绪（127.0.0.1:${APP_PORT}）"
log "DNS 正常：$DOMAIN → ${resolved}；LITTO 容器在跑"

# ================================================================ 1. certbot
log "1/7 安装 certbot"
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq certbot
fi
certbot --version

mkdir -p "$WEBROOT/.well-known/acme-challenge"

# ================================================================ 2. 阶段一：开 80
log "2/7 写入阶段一配置（仅 80 端口，供 HTTP-01 校验）"
cp -f "$SRC_DIR/nginx/00-litto-upgrade-map.conf" "$NGINX_CONF/00-litto-upgrade-map.conf"
cp -f "$SRC_DIR/nginx/litto.conf"                "$NGINX_CONF/litto.conf"
cp -f "$SRC_DIR/nginx/milimili.phase1.conf"      "$NGINX_CONF/milimili.conf"
rm -f /etc/nginx/sites-enabled/default
nginx -t || die "Nginx 配置校验失败"
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl reload nginx

# 自检：本机走 80 能拿到占位页，且 ACME 目录可写可读
curl -fsS -o /dev/null --max-time 8 http://127.0.0.1/ || die "Nginx 80 端口本地不可用"
echo "probe" > "$WEBROOT/.well-known/acme-challenge/.probe"
curl -fsS --max-time 8 "http://127.0.0.1/.well-known/acme-challenge/.probe" | grep -q probe \
  || die "ACME 校验目录不可通过 Nginx 访问（检查 root 路径与权限）"
rm -f "$WEBROOT/.well-known/acme-challenge/.probe"
log "本机自检通过：80 端口与 ACME 目录均可访问"
warn "若外网访问不了 80，certbot 一定失败 —— 请确认腾讯云安全组已放通 TCP 80。"

if [[ "${LITTO_TLS_PHASE:-0}" == "1" ]]; then
  cat <<EOF

────────────────────────────────────────────────────────
 阶段一完成。请从外部确认 http://$DOMAIN/ 能打开（应显示"站点正在启用 HTTPS"）。
 确认后执行完整流程：
   bash $SRC_DIR/enable-domain-tls.sh
────────────────────────────────────────────────────────
EOF
  exit 0
fi

# ================================================================ 3. 签证书
log "3/7 申请 Let's Encrypt 证书（HTTP-01 / webroot）"
if [[ -s /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]]; then
  log "已存在证书，跳过签发（如需强制重签：certbot renew --force-renewal）"
else
  certbot certonly --webroot -w "$WEBROOT" \
    -d "$DOMAIN" -d "$WWW_DOMAIN" \
    --email "$EMAIL" --agree-tos --no-eff-email \
    --deploy-hook "systemctl reload nginx" \
    --non-interactive \
    || die "证书签发失败。常见原因：① 安全组未放通 80；② 备案未真正生效（80 被运营商/云商拦截）；③ DNS 未生效。可先跑 curl -v http://$DOMAIN/ 看返回的是什么页面。"
fi
certbot certificates 2>/dev/null | grep -E "Certificate Name|Domains|Expiry" | head -6

# ================================================================ 4. 阶段二：切 443
log "4/7 切换到最终配置（80 跳转 + 443 反代）"
cp -f "$SRC_DIR/nginx/milimili.conf" "$NGINX_CONF/milimili.conf"
nginx -t || die "Nginx 最终配置校验失败"
systemctl reload nginx
log "Nginx 已监听 80 / 443（18443 兜底入口保留）"

# ================================================================ 5. 续期自检
log "5/7 自动续期自检"
if certbot renew --dry-run --quiet 2>&1 | tail -3; then
  log "续期演练通过（certbot 已由 systemd timer 自动续期）"
else
  warn "续期演练未通过，请检查 80 端口是否长期可达"
fi

# ================================================================ 6. 更新应用对外地址
log "6/7 更新 LITTO_PUBLIC_URL"
if grep -q '^LITTO_PUBLIC_URL=' "$ROOT/litto.env"; then
  sed -i "s|^LITTO_PUBLIC_URL=.*|LITTO_PUBLIC_URL=https://$DOMAIN|" "$ROOT/litto.env"
else
  echo "LITTO_PUBLIC_URL=https://$DOMAIN" >> "$ROOT/litto.env"
fi
grep '^LITTO_PUBLIC_URL=' "$ROOT/litto.env"
cd "$ROOT"
docker compose -f docker-compose.prod.yml --env-file litto.env up -d 2>&1 | tail -3

# ================================================================ 7. 自检
log "7/7 端到端自检"
for i in $(seq 1 20); do curl -fsS -o /dev/null "http://127.0.0.1:$APP_PORT/" 2>/dev/null && break; sleep 3; done
printf '  http://127.0.0.1/            → %s（期望 301）\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/)"
printf '  https://127.0.0.1/ (忽略证书) → %s（期望 200）\n' "$(curl -ks -o /dev/null -w '%{http_code}' --max-time 10 https://127.0.0.1/)"
printf '  https://%s/  → %s（期望 200）\n' "$DOMAIN" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/)"
printf '  证书链校验（--resolve 到本机）→ %s\n' "$(curl -s -o /dev/null -w '%{ssl_verify_result}' --max-time 15 --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/)"

cat <<EOF

────────────────────────────────────────────────────────
 正式域名已启用
 访问地址 : https://$DOMAIN
 兜底入口 : https://$EXPECTED_IP:${HTTPS_PORT_FALLBACK}（自签证书，仍可用）
 证书     : Let's Encrypt，自动续期（certbot.timer）
 日志     : /var/log/letsencrypt/ ・ sudo certbot certificates
────────────────────────────────────────────────────────
EOF
