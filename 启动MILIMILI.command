#!/bin/bash
# MILIMILI 本地启动器：双击运行，服务没起就拉起，然后打开浏览器。
# 关闭这个终端窗口服务即停止；后台常驻请改用系统登录项。

cd "$(dirname "$0")" || exit 1

if lsof -ti :3000 >/dev/null 2>&1; then
  echo "服务已在运行（3000 端口）"
else
  echo "正在启动 MILIMILI…"
  cd apps/server || exit 1
  NODE_ENV=dev bun --watch src/index.ts
fi
