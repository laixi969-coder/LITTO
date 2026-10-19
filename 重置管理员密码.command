#!/bin/bash
# 重置超级管理员密码。双击运行，按提示输入新密码（至少 12 位）。
# 只写本机数据库，不上传；重置后所有旧登录态失效，需要重新登录。

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
DB="$ROOT/data/cloud/milimili.db"
EMAIL="66445039@qq.com"
BUN="$HOME/.bun/bin/bun"
[ -x "$BUN" ] || BUN="$(command -v bun)"

if [ -z "$BUN" ]; then echo "找不到 bun，请确认已安装 Bun 运行时。"; read -n 1 -s -r -p "按任意键退出"; exit 1; fi
if [ ! -f "$DB" ]; then
  echo "找不到数据库：$DB"
  echo "请先启动一次服务，或确认 data/cloud/milimili.db 存在。"
  read -n 1 -s -r -p "按任意键退出"; exit 1
fi

read -s -r -p "输入新密码（至少 12 位）：" PW; echo
read -s -r -p "再输一次确认：" PW2; echo

if [ "$PW" != "$PW2" ]; then echo "两次输入不一致，已取消。"; read -n 1 -s -r -p "按任意键退出"; exit 1; fi
if [ ${#PW} -lt 12 ]; then echo "密码至少 12 位，已取消。"; read -n 1 -s -r -p "按任意键退出"; exit 1; fi

NEWPW="$PW" DBFILE="$DB" MAIL="$EMAIL" "$BUN" -e '
import { scrypt } from "node:crypto";
import { Database } from "bun:sqlite";

const db = new Database(process.env.DBFILE);
const mail = process.env.MAIL;
const pw = process.env.NEWPW;

const row = db.query("SELECT id FROM users WHERE email=? AND deleted_at IS NULL").get(mail);
if (!row) { console.log(`数据库里找不到账号 ${mail}`); process.exit(1); }

// 与 cloud/src/auth.ts 完全一致：N=32768 r=8 p=1 keylen=64，salt 为 32 位 hex 字符串按 UTF-8 传入
const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
const key = await new Promise((res, rej) =>
  scrypt(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
const hash = `scrypt:${salt}:${key.toString("hex")}`;
const now = new Date().toISOString();

db.query("INSERT INTO user_passwords VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash, updated_at=excluded.updated_at")
  .run(row.id, hash, now);
const cleared = db.query("DELETE FROM sessions WHERE user_id=?").run(row.id);
db.close();
console.log(`已重置 ${mail} 的密码；清除了 ${cleared.changes} 个旧登录态。请用新密码重新登录。`);
'

echo
read -n 1 -s -r -p "按任意键关闭"
