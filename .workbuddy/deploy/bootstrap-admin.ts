/**
 * LITTO 管理员引导脚本（容器内执行）
 *   docker cp bootstrap-admin.ts litto:/tmp/ && docker compose exec -T \
 *     -e BOOT_EMAIL=... -e BOOT_PASSWORD=... litto bun /tmp/bootstrap-admin.ts
 *
 * 为什么需要它：cloud 层默认走邮箱验证码登录，但邮件投递通道尚未接入
 * （cloud/src/auth.ts requestCode() 里注明 "Mail transport is pluggable"），
 * 生产模式下既不返回验证码也无法发信；而 setUserPassword() 全仓库没有调用方，
 * 没有 CLI 也没有 HTTP 接口能设密码 —— 只能在这里补上这一步。
 */
process.env.LITTO_DATA_DIR ??= process.env.TOONFLOW_DATA_DIR
  ? `${process.env.TOONFLOW_DATA_DIR}/cloud`
  : "/app/data/cloud";

const email = (process.env.BOOT_EMAIL ?? "").trim().toLowerCase();
const password = process.env.BOOT_PASSWORD ?? "";

if (!email) throw new Error("缺少 BOOT_EMAIL");
if (password.length < 12 || password.length > 256) throw new Error("BOOT_PASSWORD 需为 12-256 位");

const { loginUser, setUserPassword } = await import("/app/cloud/src/auth.ts");

// loginUser 首次会建号 + 个人工作区；isAdmin 由 LITTO_ADMIN_EMAILS 命中决定
const { user } = loginUser(email);
await setUserPassword(user.id, password);

console.log(`OK  账号=${user.email}  id=${user.id}  isAdmin=${user.isAdmin}`);
if (!user.isAdmin) {
  console.warn("!! 该邮箱不在 LITTO_ADMIN_EMAILS 中，isAdmin=false，将无法安装/修改插件与供应商");
}
