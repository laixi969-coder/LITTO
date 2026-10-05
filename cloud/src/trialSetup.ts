// 开启或关闭实验 1 的平台试用（见 docs/prdAudit.md「实验 1」）。直接写 cloud 数据库，无需管理员登录，服务运行中也可执行。
// 开启：LITTO_TRIAL_KEY=<平台 Key> npm run trial:setup
// 可选：LITTO_TRIAL_BASE_URL（默认 https://api.deepseek.com）、LITTO_TRIAL_MODEL（默认 deepseek-chat）、
//      LITTO_TRIAL_MODEL_NAME、LITTO_TRIAL_CREDITS_PER_1K（默认 1）；关闭：LITTO_TRIAL_DISABLE=1 npm run trial:setup
import { resolve } from "node:path";

// 与内嵌在主服务里时使用同一个数据目录，否则写入的凭据无法被服务解密。
process.env.LITTO_DATA_DIR ??= resolve(import.meta.dirname, "../../data/cloud");
const { get, setSetting } = await import("./db.ts");
const { addCredential, upsertModel, upsertProvider } = await import("./providers/registry.ts");

if (process.env.LITTO_TRIAL_DISABLE === "1") {
    setSetting("platformTrial", { enabled: false });
    console.log("平台试用已关闭");
    process.exit(0);
}

const key = process.env.LITTO_TRIAL_KEY?.trim();
if (!key) throw new Error("请通过环境变量 LITTO_TRIAL_KEY 提供平台 Key");
const baseUrl = process.env.LITTO_TRIAL_BASE_URL ?? "https://api.deepseek.com";
const externalModelId = process.env.LITTO_TRIAL_MODEL ?? "deepseek-chat";
const creditsPer1kTokens = Number(process.env.LITTO_TRIAL_CREDITS_PER_1K ?? 1);
if (!(creditsPer1kTokens > 0)) throw new Error("LITTO_TRIAL_CREDITS_PER_1K 必须大于 0");

// 重复执行时复用同一个平台供应商与模型，只追加新凭据（取用时用最新的一条）。
const provider = upsertProvider(get("SELECT id FROM providers WHERE name='平台试用'")?.id ?? null, { name: "平台试用", adapter: "openai-compatible", baseUrl, status: "active" });
const existingModel = get("SELECT id FROM models WHERE provider_id=? AND external_model_id=?", provider.id, externalModelId);
upsertModel(existingModel?.id ?? null, { providerId: provider.id, type: "text", externalModelId, name: process.env.LITTO_TRIAL_MODEL_NAME ?? externalModelId, status: "active" });
addCredential("platform", null, { providerId: provider.id, secret: key, label: "platform trial" });
setSetting("platformTrial", { enabled: true, creditsPer1kTokens });
console.log(`平台试用已开启：${baseUrl} · ${externalModelId} · 每 1000 token 扣 ${creditsPer1kTokens} 积分`);
