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
    const listTool: ToolDefinition = {
      name: "listMediaModels",
      label: "查询媒体模型",
      description: "查询当前选定且可用的媒体模型；all:true 可列出供用户在聊天中选择的全部已配置模型，返回 providerId、modelId、类型、cameraTrajectory（原生数值轨迹）、promptControl（文字控制限制）、模式及支持的画幅、时长、分辨率或音色。生成前先查询；没有默认值或用户要换模型时，用 requestProductionDecision(selectModel) 在聊天中选择并保存，不要求用户前往设置页。all:true 的列表不授权自行切换模型。",
      parameters: z.toJSONSchema(listMediaModelsSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        const { all } = listMediaModelsSchema.parse(params);
        signal?.throwIfAborted();
        const result = (await media.listModels(all)).filter(model => generationTools.some(operation => operation.mediaType === model.type));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    };
    const productionSchema = z.object({ operation: z.enum(["read", "readQuality", "setQuality", "agentReview", "importKeyframe", "world", "look", "asset", "reference", "sequence", "shot", "updateShot", "binding", "compile", "readEdit", "inspectFinal", "render", "readVoice"]), data: z.record(z.string(), z.json()).default({}) });
    const productionTools: ToolDefinition[] = media.production ? [{
      name: "productionSpec", label: "制片规格", executionMode: "sequential",
      description: "读写当前项目的真实领域规格。先 read。readQuality 读取当前项目按模型保存的精度；用户已明确指定精度时，setQuality{kind:image|video,providerId,modelId,value} 直接保存，不再弹确认。没有选择时用 requestProductionDecision(selectQuality)。importKeyframe{shotId,path} 把工作区中的干净单格图登记为该镜头候选，返回 keyframe id；重复导入同图复用，随后 requestKeyframeApproval 可一次采用整批。world/look 更新世界或影调；asset 创建含 type/name/description/attributes/invariants/allowedVariations/forbiddenChanges 的资产草稿，attributes 可保存当前妆造，不能混入多套候选；sequence 创建 name/script；shot 创建 sequenceId/title/narrativeFunction/assetIds/action/performance/blocking/camera/lighting/realism{surface,imaging,world,motion,cinematic}/duration/intendedStateDelta/freedomMap；updateShot 带 shotId 修改草稿；reference 带 mediaId/name? 将 read 返回的项目媒体登记为参考，返回的 id 才是 referenceId，重复登记复用原记录；binding 带 shotId/referenceId/role/weight/lockLevel/notes 绑定已有参考，notes 限定身份、妆发或服装用途。主关键帧用 requestKeyframeApproval；其余资产、定妆、视频、规格变更、剪辑、配音和成片验收用 requestProductionDecision，在聊天中预览并保存决定。readEdit 传 sequenceId 读取剪辑轨道与片段；inspectFinal 传 renderId 检测成片；render 传 sequenceId/options 导出已授权的剪辑；readVoice 读取配音方案。不能代填用户检查，不要求跳转面板或重复确认。",
      promptSnippet: "用户明确授权自主选片时，可用 agentReview{targetType:keyframe|take,targetId,authorization:用户授权原意,note:实际观察依据,frameTimes:视频实际抽帧秒数数组,observations:[{kind,note}]}。必须先查看真实输出；静帧保存代理检查并采用Hero，视频只选入可渲染工作版，不写人工采用或最终验收。视频须至少两个实际抽帧时间，完整运动与声音未核验须说明；严重问题不选入。不能默认用户授权，不得伪造检查。data 直接放规格字段，world/look 不包裹同名子对象。shot 创建不传 shotId（返回真实 ID 后复用），narrativeFunction 仅 Establish|Reveal|Reaction|Contrast|Transition|Match|Rhythm；performance 是 {emotion,intensity:0.5,eyeline,lookTarget,gesture,timing}，blocking 是 {foreground,midground,background}，camera 是 {shotSize,position,height,angle,lensMm:35,focus,depth,motion,motivation,side:A|B|none,screenDirection:left|right|none}，lighting 是 {worldSource,key,fill,negativeFill,practicals:[],exposure,keyDirection:left|right|front|back|top|none,timeOfDay,colorTemp}，intendedStateDelta 是对象，freedomMap 是 {LOCK:[],CONTROL:[],ALLOW:[],RANDOM:[]}；这些字段不能用一段字符串代替。world/look 可用字段以 read 返回的现有规格为准，不传记录 ID 等元数据。电影制作必须先用 productionSpec 保存领域规格。MV 另存 musicVideo{audioMode:sourceTrack|generated|silent,audioDirection,sourceStart,timeline:[{start,end,description}]}；原曲须填 sourceStart，timeline 用本段秒数从0连续覆盖 generationDuration 或 duration，可用 null 清除。故事与音画写进 description，勿只放自由 prompt。compile 输入 shotId/kind/request（含实际 providerId/modelId/prompt 和模式规格），camera.design 持久化 technique/purpose/start/end/subjectPath/cameraPath/timing/cut/invariants/acceptance/fallback。可选音频模型上 generated 须 generateAudio:true，silent 须 false。数值轨迹仅发给 cameraTrajectory 模型；GEN3C 须显式 imageAndCameraOnly:true。compile 与 generate 使用完全相同的轨迹与规格。读取 warnings/degradations；生成时传 shotId 和返回的 fingerprint 作为 productionFingerprint，服务端会使用编译结果替代自由提示词。",
      parameters: z.toJSONSchema(productionSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        const parsed = productionSchema.parse(params);
        const result = await media.production!(parsed.operation, parsed.data, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }] : [];
    if (media.requestProductionDecision) {
      const schema = z.strictObject({ operation: z.enum(["selectModel", "selectQuality", "approveAssets", "selectReference", "selectCandidate", "approveTake", "reviewOutput", "world", "look", "updateShot", "updateAsset", "rollbackAsset", "removeBinding", "publishAsset", "importAsset", "libraryReference", "editTimeline", "reviewFinal", "selectVoice", "configureVoice"]), data: z.record(z.string(), z.json()), reconsider: z.boolean().optional() });
      productionTools.push({
        name: "requestProductionDecision", label: "确认制作选择", executionMode: "sequential",
        promptSnippet: "editTimeline 的 ops 每项含 type：set_cut{leftId,rightId,sourceOut,sourceIn,leftMediaId?,rightMediaId?}；bridge_audio{leftId,rightId,mode:jCut|lCut|crossfade|none,duration}；map_segments{mediaId,segments:[{shotId,in,out}]}；add_clip{clip:{trackId,type:shot|media,shotId?,mediaId?,start,duration?,in?,speed?,label?}}；move_clip{id,start?,trackId?}；trim_clip{id,in?,out?,start?,duration?,ripple?}；split_clip{id,at}；delete_clip{id,ripple?}；set_transition{id,transition:{type:cut|dissolve|fade_black,duration}}；set_gain{id,gainDb?,fadeIn?,fadeOut?}；set_speed{id,speed}；add_track{kind:video|audio,name?,role:dialogue|music|sfx}；update_track{id,name?,role?,muted?,locked?,gainDb?}；add_marker{t,label}；remove_marker{id}；reorder{shotIdA,shotIdB}；set_duck{duck:null|{underRole:dialogue|music|sfx,amountDb}}；set_sequence_grade{grade:null|{lift?,gamma?,gain?,saturation?,contrast?,temperature?,exposureStops?,lutCube?}}，颜色 lift/gamma/gain 是三个 -1 至 1 的数。时间单位为秒，所有 ID 来自 read/readEdit。",
        description: "所有制作选择在聊天里展示、确认并保存，不让用户跳到面板。selectQuality{kind:image|video} 让用户直接选择当前模型支持的精度并保存到项目，已选且仍有效时复用；用户主动改选时传 reconsider:true。用户已在消息或首页指定精度则用 productionSpec(setQuality) 直接保存，不能再询问同一选择。selectModel{kind:image|video|audio,providerId?,modelId?} 列出可用模型并保存用户选择；指定模型时直接展示该模型的选择卡，不先 askUser 再重复确认。其他操作先 productionSpec read 获取真实记录。approveAssets{assetIds}；selectReference{assetId,mediaIds} 比较当前项目图片并同时采用资产设定与定妆，无需预建候选池；selectCandidate{candidateIds,asHero?} 比较同一资产的定妆图；approveTake{takeIds,overrideReason?} 比较同镜头的视频并由用户填写检查和实际末态；reviewOutput{targetType:keyframe|take,targetId} 在聊天记录问题或排除旧告警；world/look{变更字段}；updateShot{shotId,patch}；updateAsset{assetId,patch}；rollbackAsset{assetId,version}；removeBinding{bindingId}；publishAsset{assetId}；importAsset{libraryId}；libraryReference{libraryId,mediaId}；editTimeline{sequenceId,ops} 先 readEdit，ops 沿用剪辑操作；reviewFinal{renderId} 先 inspectFinal；selectVoice{lineId,takeIds} 先 readVoice；configureVoice{project} 提交完整配音方案供确认。已生效的决定直接返回 applied:true，不重复询问；仅用户明确要求改选或重新验收时传 reconsider:true。跳过和暂不决定不授权后续，不循环追问。不要先 askUser 再调用本工具重复确认。",
        parameters: z.toJSONSchema(schema, { io: "input", target: "draft-07" }),
        async execute(id, params, signal) {
          const result = await media.requestProductionDecision!(id, schema.parse(params), signal);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }
    if (media.requestKeyframeApproval) {
      const schema = z.strictObject({ keyframeIds: z.array(z.string().min(1).max(128)).min(1).max(60) });
      productionTools.push({
        name: "requestKeyframeApproval", label: "确认采用主关键帧", executionMode: "sequential",
        description: "在聊天中展示真实关键帧图片，等待用户确认后保存各镜头的主关键帧。先 productionSpec read 取得 keyframes 的真实 id，按用户选择传 keyframeIds，每镜一张；可将多个镜头合并为一张确认卡，避免逐镜重复提问。已采用且检查有效的帧不再询问。approved: true 才代表已保存；暂不采用、跳过或取消时等待，不循环追问。不要让用户去镜头制作面板寻找按钮，不自动猜选最新图片。",
        parameters: z.toJSONSchema(schema, { io: "input", target: "draft-07" }),
        async execute(id, params, signal) {
          const { keyframeIds } = schema.parse(params);
          const result = await media.requestKeyframeApproval!(id, keyframeIds, signal);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }
    return [...(generationTools.length ? [listTool] : []), ...productionTools, ...generationTools.map<ToolDefinition>(operation => ({
      name: operation.name,
      label: operation.label,
      description: `${operation.description}providerId 和 modelId 必须来自 listMediaModels。引用素材的 path 及 outputDirectory 均为工作区相对路径；省略输出目录使用默认媒体目录。等待生成完成后返回已保存的文件路径，不返回 Base64。`,
      promptSnippet: "生成媒体前先查询 listMediaModels 和 productionSpec(readQuality)。用户已指定的精度用 setQuality 保存；尚未选择时用 selectQuality 在聊天中选择。已有有效选择沿用，不自动采用最低档或最高档。compile 返回 request 为实际规格快照，generate 复用该 request。用户要求多格分镜时先读 cinema 的 storyboardGrid 资料，使用 purpose=storyboard 生成总览，复用 FFmpeg 拆格与 importKeyframe 登记，再逐镜生成和剪辑交付。复用实际模型和工作区参考素材。正式分镜先保存 productionSpec 并 compile，生成传 shotId/productionFingerprint；不可用独立文生图绕过同批 Look 与角色/场景参考。写实约束同时覆盖人和环境的材质、光源、曝光、接触与空间层次；整洁、精神好不等于磨皮或去龄。参考须真实发送且按用途说明，文本描述不能冒充已传图片。",
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
