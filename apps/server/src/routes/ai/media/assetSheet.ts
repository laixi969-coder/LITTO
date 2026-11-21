import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { copyToAssetFolder, assetPrompt, registerAsset } from "@/utils/media/assetSheet";
import { listMediaModels } from "@/utils/media/generation";
import { listProjectCharacters, readCastingReference } from "@/utils/media/projectCast";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { readMediaAspect } from "@/utils/media/quality";

const imageMime = (path: string) => /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg";

const assetFields = {
  directory: z.string().min(1).max(4096),
  kind: z.enum(["character", "scene", "prop"]),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(4).max(4000),
  wardrobe: z.string().trim().max(2000).optional(),
  reference: z.string().trim().max(2048).optional(),
  assetId: z.string().trim().min(1).max(120).optional(),
  providerId: z.string().trim().max(96).optional(),
  modelId: z.string().trim().max(256).optional(),
  ratio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
  // 同一份资产重做时必须显式给新 ID，否则会复用上一次的指纹与失败结果。
  regenerationId: z.string().uuid().optional(),
};

export default Router().post("/", validateFields(assetFields), async (req, res) => {
  const { directory, kind, name, description, wardrobe, reference, assetId, providerId, modelId, ratio, regenerationId } = z.object(assetFields).parse(req.body);
  const cwd = await u.workspace.resolveWorkspace(req, directory);

  // 资产必须用图像模型一次做对；没有可用图像模型就直接说清，别让人等到分镜阶段才发现没脸可用。
  const models = await listMediaModels();
  if (Boolean(providerId) !== Boolean(modelId)) return res.status(400).json(error("providerId 与 modelId 须同时提供", null, 400));
  const chosen = productModel(models, providerId, modelId);
  if (!chosen) return res.status(400).json(error("当前没有可用的图像模型：请先在设置里接入图片模型，再生成资产", null, 400));

  const actors = kind === "character" ? listProjectCharacters(cwd).filter(actor => actor.libraryId && (assetId ? actor.id === assetId : actor.name === name)) : [];
  if (assetId && !actors.length) return res.status(400).json(error("assetId 未匹配本项目已选演员", null, 400));
  if (actors.length > 1) return res.status(409).json(error("有多位同名演员，请传项目角色的 assetId", null, 409));
  const actor = actors[0];
  const images: { path: string; mimeType: string }[] = [];
  if (actor) {
    const image = await readCastingReference(cwd, actor.id, actor.referenceMediaId);
    images.push({ path: image.path, mimeType: image.mimeType });
  }
  if (reference && !images.some(image => image.path === reference)) {
    await resolveWorkspacePath(cwd, reference);
    images.push({ path: reference, mimeType: imageMime(reference) });
  }

  const needsReference = Array.isArray(chosen.mode) && chosen.mode.length > 0 && !chosen.mode.includes("text");
  if (needsReference && !images.length) return res.status(400).json(error(`当前模型 ${chosen.label} 需要参考图，请选演员或提供 reference`, null, 400));
  const prompt = assetPrompt({ kind, name, description, wardrobe, reference: images[0]?.path });
  let files;
  try {
    files = await u.mediaGeneration.generateMedia(cwd, "image", {
      providerId: chosen.providerId,
      modelId: chosen.modelId,
      prompt,
      images: images.length ? images : undefined,
      ratio: ratio ?? ((await readMediaAspect(cwd)).imageRatio || "16:9"),
      purpose: "asset",
      outputName: `${name}·${kind === "character" ? "四视图" : kind === "scene" ? "场景定场" : "道具图"}`,
      ...(regenerationId ? { regenerationId } : {}),
    });
  } catch (err) {
    return res.status(502).json(error(`资产生成失败：${err instanceof Error ? err.message : String(err)}`, null, 502));
  }
  if (!files.length) return res.status(502).json(error("模型没有返回图片", null, 502));

  // 场景与道具要进 assets/scenes、assets/props，flow 才数得到；角色卡直接写 references。
  const landed: { path: string; mimeType: string }[] = [];
  for (const file of files) {
    const path = await copyToAssetFolder(cwd, kind, name, file.path);
    landed.push({ path, mimeType: file.mimeType });
  }
  const registered = await registerAsset(cwd, { kind, name: actor?.name ?? name, description, wardrobe }, landed, actor);
  res.json(success({
    ...registered,
    next: kind === "character"
      ? "角色卡已可用：分镜与视频生成时用 cast 传入该名字，就不会再逐镜重选角"
      : "场景已落 assets/scenes：做分镜时把它作为场景资产绑定，不要每镜重新描述空间",
  }));
});

/** 优先用调用方指定；否则取第一个可用的图像模型，并避开只做编辑的专用模型。 */
function productModel(models: Awaited<ReturnType<typeof listMediaModels>>, providerId?: string, modelId?: string) {
  if (providerId && modelId) return models.find(model => model.type === "image" && model.providerId === providerId && model.modelId === modelId);
  return models.find(model => model.type === "image" && !model.lipSync) ?? null;
}
