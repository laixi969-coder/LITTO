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

/**
 * 资产模板：这三段是「一次生成就可用」和「反复返工」的分界。
 * 四视图的排版、纯白棚光、同一条水平线，缺一项模型就会给出四张不同的人。
 */
export function assetPrompt({ kind, name, description, wardrobe }: AssetRequest) {
  const look = wardrobe?.trim() ? `${description.trim()}。固定造型：${wardrobe.trim()}` : description.trim();
  if (kind === "character") {
    return [
      "【角色身份与外观】" + look,
      "【固定人物资产构图】16:9 横向设定板。画面左侧 60% 从左到右并排三张完整全身图：正面 0°、右侧 90°、背面 180°，三张等高、脚底落在同一条水平线上、间距均匀；画面右侧 40% 是一张正面头颈面部特写，从头顶到锁骨完整入画。四张图是同一个人在同一天的状态。",
      "【肤质、布光与成像】纯白无缝背景，大型柔光源在人物正面偏上方，下方反光板柔和补起眼下，保留鼻侧与下颌的自然体积；完整头部、发型、服装和鞋履清晰可辨。肤色干净均匀，保留既定肤色、年龄、自然血色和符合景别的细微纹理；底妆轻薄并与颈部自然衔接，额鼻控油、面颊与唇部保留克制高光。眉毛与睫毛清晰分束，妆色服从角色设定；发根清爽蓬松、碎发少量有序。不放大毛孔、绒毛、色斑、皱纹，不添疲态、厚粉分界、整脸油亮或塑料磨皮。",
      "【一致性要求】四张图的脸型、五官比例、发型、体型、服装与配饰完全一致；三张全身图里的身高与肩宽一致，鞋履是同一双。",
      "【负面约束】不要拼贴边框、不要图注文字、不要出现第五个人物、不要把某一张改成半身或坐姿。",
    ].join("\n\n");
  }
  if (kind === "scene") {
    return [
      "【场景身份】" + look,
      "【空间结构】交代入口、主要活动区域与背景纵深；固定机位，视线高度约在成人胸口。",
      "【光线与时间】单一实际光源，方向明确，地面与立面上有投影；写清时间与天气，人物若入场会站在哪一侧的受光区。",
      "【材质】地面、立面、植物与水面各自写清受光结果；保留真实使用痕迹，但整体干净完整。",
      "【构图】无人空镜，画面里不出现人物、动物与文字；构图留出人物活动的空间。",
      "【负面约束】不要出现人物与动物、不要文字水印、不要做旧脏污破损。",
    ].join("\n\n");
  }
  return [
    "【道具身份】" + look,
    "【呈现方式】单一物体居中偏侧，纯白或与材质相称的素色背景，交代尺寸参照（与手或常见物件的比例）。",
    "【光线与材质】单一主光，写清材料表面（木纹、金属、织物、玻璃）的受光结果与投影。",
    "【负面约束】不要多件重复、不要文字水印、不要做旧破损。",
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
