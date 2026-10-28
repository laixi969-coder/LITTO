import { join } from "node:path";
import { existsSync, mkdir, readFile, writeAtomic } from "@toonflow/file";
import { resolveWorkspacePath } from "@/utils/workspace/files";

export type AssetKind = "character" | "scene" | "prop";

interface AssetRequest {
  kind: AssetKind;
  name: string;
  description: string;
  wardrobe?: string;
  /** 已有定妆或参考图，作为图生图的输入；没有就只能走文生图 */
  reference?: string;
  ratio?: string;
}

/** 资产展示与剧情执行分开；模板表达设计意图，生成结果仍须核对身份与结构。 */
export function assetPrompt({ kind, name, description, wardrobe, reference }: AssetRequest) {
  const look = wardrobe?.trim() ? `${description.trim()}。固定造型：${wardrobe.trim()}` : description.trim();
  const basis = reference ? "已提供的参考只约束本次采用的身份、造型或结构；展示背景和视图数量不作为剧情内容。" : "按本次描述设计，不虚构已存在的参考图或采用版本。";
  if (kind === "character") {
    return [
      `【角色身份与外观】${name}：${look}。${basis}`,
      "【固定人物资产构图】一张设定板，画幅以实际请求为准。未另指定版式时，左侧为正脸妆造特写，右侧依次为正面0°、右侧90°、背面180°完整全身；三张全身等高、头脚完整，特写为同一角色而非额外人物。用户描述已指定其他版式时沿用指定版式。",
      "【肤质、布光与成像】沿用指定画风与物种，简洁背景、中性展示光、自然比例，必要身份与服饰结构清晰。真人保持既定年龄与肤色，细微纹理匹配景别，肤面与衣料有不同反光，不通过粗毛孔、疲态或磨皮证明真实；妆发按本次设定。动画、动物与机械角色保持自身媒介、解剖和材质，不强加真人妆面。",
      "【一致性要求】各视角保持同一身份、同一当前造型、自然比例与配饰结构；只表现已指定的状态，不自行加入污损、换装或剧情表演。",
      "【负面约束】不添加无关边框、图注或额外角色；默认全身视图不得裁断头脚，明确指定的其他版式与姿态除外。",
    ].join("\n\n");
  }
  if (kind === "scene") {
    return [
      `【场景身份】${name}：${look}。${basis}`,
      "【空间结构】按本次用途选择主视角，交代已有出入口、固定地标、主要活动区、通道和前后层次；不凭空增加建筑、家具或遮挡通道。",
      "【光线与时间】沿用指定时段、天气和实际光源位置，区分主要受光区、暗部与环境反射；光源数量、软硬和曝光服务场景，不强制单光源或明显投影。",
      "【材质】按既定媒介区分各表面本色、纹理尺度、反光与透光，保留指定状态；无依据不加使用痕迹、积水、雾尘或破损。",
      "【构图】无人场景资产，留出既定人物活动空间；明确要求的场内标识保留，不添加图注或额外故事角色。",
      "【负面约束】不加入人物与故事动物、无关文字水印或未指定的做旧脏污破损；明确要求的标识与状态保留。",
    ].join("\n\n");
  }
  return [
    `【道具身份】${name}：${look}。${basis}`,
    "【呈现方式】未另指定版式时用一张2×2参考板，左上正面、右上右侧90°、左下背面、右下关键结构细节；各格是同一物件的视图，不是多个剧情实例。已指定单图或其他版式时沿用。",
    "【功能与结构】交代已描述的用途、尺寸关系、连接与开合部件，保持产品标识及当前状态；结构应能支持指定操作，不为展示擅加手、人物或额外工具。",
    "【光线与材质】沿用指定媒介，在简洁背景中区分各表面本色、反光和透光；保证结构与已有标识可读，不把所有材料处理成同一光泽。",
    "【负面约束】无无关文字水印、结构增减、错误标识与未经指定的破损；各视图结构和状态一致。",
  ].join("\n\n");
}

/** 角色四视图落成可用角色卡：references 有内容、quality 不是 draft，才算进流程。 */
export async function registerAsset(cwd: string, { kind, name, description, wardrobe }: AssetRequest, files: { path: string; mimeType: string }[]) {
  const paths = files.map(file => file.path);
  if (kind === "character") {
    const target = await resolveWorkspacePath(cwd, `assets/cast/${name}.json`, true);
    await mkdir(join(target.path, ".."), { recursive: true });
    const previous = await readFile(target.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    }).then(text => JSON.parse(text) as Record<string, unknown>);
    const references = [...new Set([...(Array.isArray(previous?.references) ? previous!.references as string[] : []), ...paths])];
    await writeAtomic(target.path, JSON.stringify({
      name,
      identity: description.trim(),
      wardrobe: wardrobe?.trim() ?? "",
      references,
      quality: "ready",
      // 四视图是角色卡的完成标志：单张定妆只能锁脸，管不住下半身与背面。
      fourView: true,
      updatedAt: new Date().toISOString(),
    }, null, 2));
    return { kind, name, path: `assets/cast/${name}.json`, references };
  }
  const folder = kind === "scene" ? "assets/scenes" : "assets/props";
  const target = await resolveWorkspacePath(cwd, `${folder}/${name}.json`, true);
  await mkdir(join(target.path, ".."), { recursive: true });
  const markdown = `${folder}/${name}.json`;
  await writeAtomic(target.path, JSON.stringify({
    name, kind, description: description.trim(), references: paths, updatedAt: new Date().toISOString(),
  }, null, 2));
  return { kind, name, path: markdown, references: paths };
}

/** 场景与道具在 flow 里按图片计数，生成结果要真的落到对应目录。 */
export async function copyToAssetFolder(cwd: string, kind: AssetKind, name: string, source: string) {
  if (kind === "character") return source;
  const extension = source.split(".").pop() ?? "png";
  const folder = kind === "scene" ? "assets/scenes" : "assets/props";
  const target = await resolveWorkspacePath(cwd, `${folder}/${name}.${extension}`, true);
  await mkdir(join(target.path, ".."), { recursive: true });
  const data = await readFile(source === target.path ? source : join(cwd, source));
  await writeAtomic(target.path, data);
  return `${folder}/${name}.${extension}`;
}

export function assetSheetExists(cwd: string, kind: AssetKind, name: string) {
  const folder = kind === "character" ? "assets/cast" : kind === "scene" ? "assets/scenes" : "assets/props";
  return existsSync(join(cwd, folder, `${name}.json`));
}

/**
 * 导入已有角色：用户手上有图，就不该再花一次额度重新生成。
 * 登记后 cast 与生成链路完全一致——分镜图、视频都用同一份 references。
 */
export async function registerImported(cwd: string, input: { kind: AssetKind; name: string; description?: string; wardrobe?: string; images: string[] }) {
  const { kind, name } = input;
  const paths: string[] = [];
  for (const image of input.images) {
    await resolveWorkspacePath(cwd, image);
    if (!/\.(png|jpe?g|webp)$/i.test(image)) throw Object.assign(new Error(`导入的素材必须是 png/jpg/webp：${image}`), { status: 400 });
    paths.push(image);
  }
  if (kind === "character") {
    const target = await resolveWorkspacePath(cwd, `assets/cast/${name}.json`, true);
    await mkdir(join(target.path, ".."), { recursive: true });
    const previous = await readFile(target.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    }).then(text => JSON.parse(text) as Record<string, unknown>);
    const references = [...new Set([...(Array.isArray(previous?.references) ? previous!.references as string[] : []), ...paths])];
    await writeAtomic(target.path, JSON.stringify({
      ...previous,
      name,
      identity: input.description?.trim() ?? previous.identity ?? "",
      wardrobe: input.wardrobe?.trim() ?? previous.wardrobe ?? "",
      references,
      quality: "imported",
      // 图片数量不能证明视角覆盖，保留已有四视图记录。
      fourView: previous.fourView === true,
      updatedAt: new Date().toISOString(),
    }, null, 2));
    // 只有一个角度时，下半身没有依据，蹲下起身这类动作必然自己补，这里直接说清该补什么。
    const hint = references.length < 2
      ? "只登记了 1 张：身份够用，但全身动作（蹲下、起身、走远）会缺下半身依据。建议再补一张完整全身（含鞋），或用 assetSheet 以这张图为参考补出四视图。"
      : "已登记多角度参考，分镜图与视频生成时用 cast 传入该名字即可，不需要再生成。";
    return { kind, name, path: `assets/cast/${name}.json`, references, hint };
  }
  const folder = kind === "scene" ? "assets/scenes" : "assets/props";
  const target = await resolveWorkspacePath(cwd, `${folder}/${name}.json`, true);
  await mkdir(join(target.path, ".."), { recursive: true });
  // 直接登记已校验的工作区路径，避免同扩展名的多张参考互相覆盖。
  const landed = paths;
  await writeAtomic(target.path, JSON.stringify({
    name, kind, description: input.description?.trim() ?? "", references: landed, quality: "imported",
    updatedAt: new Date().toISOString(),
  }, null, 2));
  return { kind, name, path: `${folder}/${name}.json`, references: landed, hint: "已登记为可用资产，分镜与生成时按名字引用即可。" };
}
