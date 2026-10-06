import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { audioGenerationSchema, imageGenerationSchema, listMediaModelsSchema, videoGenerationSchema } from "./runtime";

const configSchema = z.strictObject({
  allowImage: z.boolean().default(true),
  allowVideo: z.boolean().default(true),
  allowAudio: z.boolean().default(true),
});

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ media, config }) {
    if (!media) return [];
    const permissions = configSchema.parse(config);
    const generationTools = ([
      { name: "generateImage", mediaType: "image", enabled: permissions.allowImage, label: "生成图片", parameters: imageGenerationSchema, description: "根据提示词和可选的工作区参考图生成图片。" },
      { name: "generateVideo", mediaType: "video", enabled: permissions.allowVideo, label: "生成视频", parameters: videoGenerationSchema, description: "根据提示词和可选的工作区图片、视频、音频、首尾帧生成视频。按模型能力设置生成模式、时长、分辨率和音频。lipSync=true 的模型专用于对口型，传一个人物视频和一段已确定配音，不传画幅、分辨率和时长。" },
      { name: "generateAudio", mediaType: "audio", enabled: permissions.allowAudio, label: "生成音频", parameters: audioGenerationSchema, description: "根据文本或提示词和可选的工作区参考音频生成音频。按模型能力设置音色、语速、音量和格式。情绪与表演要求放 instructions，仅用于 speechInstructions=true 的模型，不能混入 prompt 台词。同一角色复用 voice。" },
    ] as const).filter(operation => operation.enabled);
    if (!generationTools.length) return [];
    const listTool: ToolDefinition = {
      name: "listMediaModels",
      label: "查询媒体模型",
      description: "查询已允许生成的媒体模型，返回 providerId、modelId、类型、模式及支持的画幅、时长、分辨率或音色。生成前先查询，不能猜测模型 ID。",
      parameters: z.toJSONSchema(listMediaModelsSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        listMediaModelsSchema.parse(params);
        signal?.throwIfAborted();
        const result = (await media.listModels()).filter(model => generationTools.some(operation => operation.mediaType === model.type));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    };
    const productionSchema = z.object({ operation: z.enum(["read", "world", "look", "asset", "sequence", "shot", "updateShot", "binding", "compile"]), data: z.record(z.string(), z.json()).default({}) });
    const productionTools: ToolDefinition[] = media.production ? [{
      name: "productionSpec", label: "制片规格", executionMode: "sequential",
      description: "读写当前项目的真实领域规格。先 read。world/look 更新世界或影调；asset 创建含 type/name/description/invariants 的资产草稿；sequence 创建 name/script；shot 创建 sequenceId/title/narrativeFunction/assetIds/action/performance/blocking/camera/lighting/realism{surface,imaging,world,motion,cinematic}/duration/intendedStateDelta/freedomMap；updateShot 带 shotId 修改草稿；binding 带 shotId/referenceId/role/weight/lockLevel 绑定已有参考。不能替用户做视觉检查或批准资产/Hero/Take，需用户在镜头制作面板查看。",
      promptSnippet: "电影制作必须先用 productionSpec 保存领域规格。compile 输入 shotId/kind/request（含实际 providerId/modelId/prompt 和模式规格），读取 warnings/degradations；生成时传 shotId 和返回的 fingerprint 作为 productionFingerprint，服务端会使用编译结果替代自由提示词。",
      parameters: z.toJSONSchema(productionSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        const parsed = productionSchema.parse(params);
        const result = await media.production!(parsed.operation, parsed.data, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }] : [];
    return [listTool, ...productionTools, ...generationTools.map<ToolDefinition>(operation => ({
      name: operation.name,
      label: operation.label,
      description: `${operation.description}providerId 和 modelId 必须来自 listMediaModels。引用素材的 path 及 outputDirectory 均为工作区相对路径；省略输出目录使用默认媒体目录。等待生成完成后返回已保存的文件路径，不返回 Base64。`,
      promptSnippet: "生成媒体前先查询 listMediaModels，复用实际模型和工作区参考素材。",
      parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const result = await media[operation.name](operation.parameters.parse(params), signal);
        const text = result.map(asset => {
          const url = asset.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
          const preview = asset.mediaType === "image" ? `![生成图片](<${url}>)` : `[${asset.mediaType === "audio" ? "播放生成音频" : "查看生成视频"}](<${url}>)`;
          return `${preview}\n工作区文件：${asset.path}`;
        }).join("\n\n");
        return { content: [{ type: "text", text }], details: result };
      },
    }))];
  },
};

export default plugin;
