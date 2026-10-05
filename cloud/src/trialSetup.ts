// 开启或关闭实验 1 的平台试用（见 docs/prdAudit.md「实验 1」）。直接写 cloud 数据库，无需管理员登录，服务运行中也可执行。
// 开启：LITTO_TRIAL_KEY=<平台 Key> npm run trial:setup
// 只换模型、沿用已保存的 Key：省略 LITTO_TRIAL_KEY，例如 LITTO_TRIAL_MODEL=agnes-2.5-flash npm run trial:setup（地址须与已保存的一致）
// 可选：LITTO_TRIAL_BASE_URL（默认 https://api.deepseek.com）、LITTO_TRIAL_MODEL（默认 deepseek-chat）、
//      LITTO_TRIAL_MODEL_NAME、LITTO_TRIAL_CREDITS_PER_1K（默认 1）；关闭：LITTO_TRIAL_DISABLE=1 npm run trial:setup
import { resolve } from "node:path";

// 与内嵌在主服务里时使用同一个数据目录，否则写入的凭据无法被服务解密。
process.env.LITTO_DATA_DIR ??= resolve(import.meta.dirname, "../../data/cloud");
const { all, get, setSetting } = await import("./db.ts");
const { addCredential, upsertModel, upsertProvider } = await import("./providers/registry.ts");

if (process.env.LITTO_TRIAL_DISABLE === "1") {
    setSetting("platformTrial", { enabled: false });
    console.log("平台试用已关闭");
    process.exit(0);
}

const key = process.env.LITTO_TRIAL_KEY?.trim();
// 在写入任何记录之前校验，避免 Key 不合格时供应商和模型已被改写一半。
if (key !== undefined && key.length < 8) throw new Error(`Key 只有 ${key.length} 位，明显不完整；请确认剪贴板里是完整的 Key 后重试`);
const previous = get("SELECT id, base_url FROM providers WHERE name='平台试用'");
const baseUrl = process.env.LITTO_TRIAL_BASE_URL ?? (key ? "https://api.deepseek.com" : previous?.base_url);
if (!key) {
    if (!process.env.LITTO_TRIAL_MODEL) throw new Error("只换模型时请用 LITTO_TRIAL_MODEL 指定模型名");
    if (!previous || previous.base_url !== baseUrl) throw new Error("请通过环境变量 LITTO_TRIAL_KEY 提供平台 Key（只换模型时，地址须与已保存的一致）");
    if (!get("SELECT 1 FROM api_credentials WHERE provider_id=? AND scope='platform' AND enabled=1 AND deleted_at IS NULL", previous.id)) throw new Error("还没有保存过平台 Key，请通过 LITTO_TRIAL_KEY 提供");
}
const externalModelId = process.env.LITTO_TRIAL_MODEL ?? "deepseek-chat";
const creditsPer1kTokens = Number(process.env.LITTO_TRIAL_CREDITS_PER_1K ?? 1);
if (!(creditsPer1kTokens > 0)) throw new Error("LITTO_TRIAL_CREDITS_PER_1K 必须大于 0");

// 重复执行时复用同一个平台供应商与模型，只追加新凭据（取用时用最新的一条）。
const provider = upsertProvider(previous?.id ?? null, { name: "平台试用", adapter: "openai-compatible", baseUrl, status: "active" });
// 换了服务地址，原来登记的模型名在新服务上不一定存在，全部停用；同一地址下可以叠加多个模型做对比。
// 不带 Key 时视为切换模型：指定模型成为唯一启用的试用模型。
if (previous && (previous.base_url !== baseUrl || !key)) {
    for (const row of all("SELECT id FROM models WHERE provider_id=? AND external_model_id<>?", provider.id, externalModelId)) upsertModel(row.id, { status: "disabled" });
}
const existingModel = get("SELECT id FROM models WHERE provider_id=? AND external_model_id=?", provider.id, externalModelId);
upsertModel(existingModel?.id ?? null, { providerId: provider.id, type: "text", externalModelId, name: process.env.LITTO_TRIAL_MODEL_NAME ?? externalModelId, status: "active" });
if (key) addCredential("platform", null, { providerId: provider.id, secret: key, label: "platform trial" });
setSetting("platformTrial", { enabled: true, creditsPer1kTokens });
console.log(`平台试用已开启：${baseUrl} · ${externalModelId} · 每 1000 token 扣 ${creditsPer1kTokens} 积分`);
// 终端隐藏输入时粘贴偶尔会吞掉开头几个字符，打印长度与末 4 位供当场核对。
if (key) console.log(`已保存的 Key：${key.length} 位，开头 ${key.slice(0, 3)}…，末 4 位 ${key.slice(-4)}`);
else console.log("沿用已保存的平台 Key，其他试用模型已停用");
