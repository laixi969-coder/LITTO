#!/bin/bash
# MILI MILI 本地启动器：双击运行；服务未启动则拉起，然后打开浏览器。
# 关闭这个终端窗口服务即停止。
#
# 注意：数据目录必须显式传入。cloud 层用 MILIMILI_DATA_DIR ?? join(TOONFLOW_DATA_DIR, "cloud")
# 推导数据库位置，缺了它会连到 cwd 下的空库，表现为「密码不对 / 账号不存在」。

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"

if lsof -ti :3000 >/dev/null 2>&1; then
  echo "服务已在运行（3000 端口）"
  open "http://localhost:3000" 2>/dev/null
  exit 0
fi

echo "正在启动 MILI MILI…"
cd "$ROOT/apps/server" || exit 1
TOONFLOW_DATA_DIR="$ROOT/data" \
MILIMILI_DATA_DIR="$ROOT/data/cloud" \
NODE_ENV=dev \
bun --watch src/index.ts
