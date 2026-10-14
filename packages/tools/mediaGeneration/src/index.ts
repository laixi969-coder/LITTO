import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { agentReviewSchema, audioGenerationSchema, imageGenerationSchema, listMediaModelsSchema, videoGenerationSchema } from "./runtime";

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
    const productionSchema = z.object({ operation: z.enum(["adDirection", "readAdDirection", "readVisionModels", "analyzeReference", "inspectAdPilot", "inspectAdFilm", "read", "readQuality", "setQuality", "agentReview", "importKeyframe", "world", "look", "asset", "reference", "sequence", "shot", "updateShot", "binding", "compile", "readEdit", "inspectFinal", "render", "readVoice"]), data: z.record(z.string(), z.json()).default({}) });
    const productionTools: ToolDefinition[] = media.production ? [{
      name: "productionSpec", label: "制片规格", executionMode: "sequential",
      description: "广告序列使用 kind:adfilm|brandFilm。adDirection{sequenceId,direction} 保存整片导演方案，readAdDirection{sequenceId} 读取方案和样镜门禁；完整结构先读 adfilm 技能。analyzeReference{sequenceId,referenceId,model?} 对真实参考抽帧并保存带时间点的构图、色彩、用光、动作、产品、剪接观察及借鉴边界；inspectAdPilot{sequenceId,keyframeId,model?} 对样镜真实图片与产品参考检查，不代替采用；inspectAdFilm{sequenceId,renderId,model?} 在 inspectFinal 后检查实际成片的广告表达、产品、色调和邻镜。readVisionModels 读取已选语言模型；只有一个时检查默认复用。model 为已配置的视觉语言模型 {providerId,modelId}；不要填写图片生成模型，无可用视觉模型时停止检查并报告，不伪造通过。样镜须检查通过并采用后才能量产；每镜 advertising{beatId,productRead,cutToNext,sound,pilotKey?} 对应整片方案，pilotKey 仅指定少量先行样镜。读写当前项目的真实领域规格。先 read。readQuality 读取当前项目按模型保存的精度；用户已明确指定精度时，setQuality{kind:image|video,providerId,modelId,value} 直接保存，不再弹确认。没有选择时用 requestProductionDecision(selectQuality)。importKeyframe{shotId,path} 把工作区中的干净单格图登记为该镜头候选，返回 keyframe id；重复导入同图复用，随后 requestKeyframeApproval 可一次采用整批。world/look 更新世界或影调；asset 创建含 type/name/description/attributes/invariants/allowedVariations/forbiddenChanges 的资产草稿，attributes 可保存当前妆造，不能混入多套候选；sequence 创建 name/script；shot 创建 sequenceId/title/narrativeFunction/assetIds/action/performance/blocking/camera/lighting/realism{surface,imaging,world,motion,cinematic}/duration/intendedStateDelta/freedomMap；updateShot 带 shotId 修改草稿；reference 带 mediaId/name? 将 read 返回的项目媒体登记为参考，返回的 id 才是 referenceId，重复登记复用原记录；binding 带 shotId/referenceId/role/weight/lockLevel/notes 绑定已有参考，notes 限定身份、妆发或服装用途。主关键帧用 requestKeyframeApproval；其余资产、定妆、视频、规格变更、剪辑、配音和成片验收用 requestProductionDecision，在聊天中预览并保存决定。readEdit 传 sequenceId 读取剪辑轨道与片段；inspectFinal 传 renderId 检测成片；render 传 sequenceId/options 导出已授权的剪辑；readVoice 读取配音方案。不能代填用户检查，不要求跳转面板或重复确认。",
      promptSnippet: "广告先 readAdDirection，根据创意保存整片方案与情绪弧线，先完成指定样镜，随后量产。产品独立镜头也须 creativeBrief，kind 可用 product；没有对白时 dialogue:{mode:post,lines:[]}。正式人物镜头生成前必须保存 creativeBrief 并补齐每个角色 attributes.styling 的 makeup/hair/costume/accessories 字符串设计；具体结构先读 cinema/references/creativePreparation.md。这些由助手完成，不再向用户发专业表单。创作目标不能以字段齐全替代实际审美检查。creativeBrief.dialogue 保存原文、说话人、时间和口型计划，不能为简化动作删除对白。用户明确授权自主选片时，可用 agentReview{targetType:keyframe|take,targetId,authorization:用户授权原意,note:实际观察依据,frameTimes:视频实际抽帧秒数数组,creativeReview:{verdict:pass|revise,styling:实际造型与创作目标的对照依据,staging:实际构图或攻防与目标的对照依据},observations:[{kind,note}]}。必须先查看真实输出；静帧保存代理检查并采用Hero，视频只选入可渲染工作版，不写人工采用或最终验收。视频须至少两个实际抽帧时间，完整运动与声音未核验须说明；严重问题不选入。不能默认用户授权，不得伪造检查。data 直接放规格字段，world/look 不包裹同名子对象。shot 创建不传 shotId（返回真实 ID 后复用），narrativeFunction 仅 Establish|Reveal|Reaction|Contrast|Transition|Match|Rhythm；performance 是 {emotion,intensity:0.5,eyeline,lookTarget,gesture,timing}，blocking 是 {foreground,midground,background}，camera 是 {shotSize,position,height,angle,lensMm:35,focus,depth,motion,motivation,side:A|B|none,screenDirection:left|right|none}，lighting 是 {worldSource,key,fill,negativeFill,practicals:[],exposure,keyDirection:left|right|front|back|top|none,timeOfDay,colorTemp}，intendedStateDelta 按 characters/wardrobe/props/environment/lighting/motion/emotional 分组，人物变化示例 {characters:{真实资产ID:{position:镜尾位置}}}，不能把资产ID直接放根层或用字符串替代状态对象；realism 的 surface/imaging/world/motion/cinematic 均写具体材质、成像、物理、运动与摄影要求，不能留空后忽略编译告警。freedomMap 是 {LOCK:[],CONTROL:[],ALLOW:[],RANDOM:[]}；这些字段不能用一段字符串代替。world/look 可用字段以 read 返回的现有规格为准，不传记录 ID 等元数据。电影制作必须先用 productionSpec 保存领域规格。MV 另存 musicVideo{audioMode:sourceTrack|generated|silent,audioDirection,sourceStart,timeline:[{start,end,description}]}；原曲须填 sourceStart，timeline 用本段秒数从0连续覆盖 generationDuration 或 duration，可用 null 清除。故事与音画写进 description，勿只放自由 prompt。compile 输入 shotId/kind/request（含实际 providerId/modelId/prompt 和模式规格），camera.design 持久化 technique/purpose/start/end/subjectPath/cameraPath/timing/cut/invariants/acceptance/fallback；timing/action/combat 中时间均为本镜局部0到duration秒，不用整段全局时间；跨镜动作接续前镜真实末态。可选音频模型上 generated 须 generateAudio:true，silent 须 false。数值轨迹仅发给 cameraTrajectory 模型；GEN3C 须显式 imageAndCameraOnly:true。compile 与 generate 使用完全相同的轨迹与规格。读取 warnings/degradations；生成时传 shotId 和返回的 fingerprint 作为 productionFingerprint，服务端会使用编译结果替代自由提示词。",
      parameters: z.toJSONSchema(productionSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        const parsed = productionSchema.parse(params);
        // ACT: 工具 schema 保留顶层对象，兼容不识别顶层 oneOf 的模型；审阅仍按明确字段校验。
        const data = parsed.operation === "agentReview" ? agentReviewSchema.parse(parsed.data) : parsed.data;
        const result = await media.production!(parsed.operation, data, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }] : [];
    if (media.requestProductionDecision) {
      const schema = z.strictObject({ operation: z.enum(["adDirection", "selectModel", "selectQuality", "approveAssets", "selectReference", "selectCandidate", "approveTake", "reviewOutput", "world", "look", "updateShot", "updateAsset", "rollbackAsset", "removeBinding", "publishAsset", "importAsset", "libraryReference", "editTimeline", "reviewFinal", "selectVoice", "configureVoice"]), data: z.record(z.string(), z.json()), reconsider: z.boolean().optional() });
      productionTools.push({
        name: "requestProductionDecision", label: "确认制作选择", executionMode: "sequential",
    if (media.production) productionTools.push({
      name: "reviewProduction", label: "检查并采用工作版", executionMode: "sequential",
      description: "实际查看输出且已获得用户自主审阅授权后，记录一次技术与创意检查。优先使用此明确参数工具，避免在productionSpec的自由data中猜字段。无缺陷observations传[]；有creativeBrief时creativeReview必填，verdict仅pass/revise，styling和staging各至少10字。检查有效时复用；严重缺陷会保留并阻止采用，不自动重新生成。视频抽帧不能证明口型或声音同步。",
      parameters: z.toJSONSchema(agentReviewSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        const result = await media.production!("agentReview", agentReviewSchema.parse(params), signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
    if (media.generateShots && (permissions.allowImage || permissions.allowVideo)) {
      const schema = z.strictObject({ kind: z.enum(["image", "video"]), requests: z.array(videoGenerationSchema.extend({ shotId: z.string().min(1), size: imageGenerationSchema.shape.size }).omit({ productionFingerprint: true, regenerationId: true })).min(1).max(60) })
        .refine(input => new Set(input.requests.map(request => request.shotId)).size === input.requests.length, "同批每镜只能提交一次");
      productionTools.push({
        name: "generateShots", label: "批量推进镜头", executionMode: "sequential",
        description: "将已经就绪且已采用主帧的独立镜头批量推进生成。服务端逐镜编译真实规格并使用对应指纹，不需要模型抄写prompt或fingerprint；生成期间内部等待并显示真实完成计数，不调用模型轮询。requests每镜含shotId、providerId、modelId和所选模式/精度/时长；图片用size/ratio，视频用duration/resolution/generateAudio/mode。mode必须完整等于listMediaModels的一项，多参考不能只取子项。保留所有参考与检查门禁，严重缺陷记为blocked并继续其他镜头；已有请求复用，失败不重发。仅缺图镜头传kind:image，每镜一次，不自动新增候选或切换模型。",
        parameters: z.toJSONSchema(schema, { io: "input", target: "draft-07" }),
        async execute(_id, params, signal, onUpdate) {
          const input = schema.parse(params);
          if (input.kind === "image" && !permissions.allowImage || input.kind === "video" && !permissions.allowVideo) throw new Error("当前工具未获此类媒体生成权限");
          const shots = await media.generateShots!(input.kind, input.requests, signal, progress => onUpdate?.({ content: [{ type: "text", text: JSON.stringify({ progress }) }], details: {} }));
          const result = { progress: `已返回 ${shots.length}/${input.requests.length} 镜`, shots };
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }
        promptSnippet: "editTimeline 的 ops 每项含 type：set_cut{leftId,rightId,sourceOut,sourceIn,leftMediaId?,rightMediaId?}；bridge_audio{leftId,rightId,mode:jCut|lCut|crossfade|none,duration}；map_segments{mediaId,segments:[{shotId,in,out}]}；add_clip{clip:{trackId,type:shot|media,shotId?,mediaId?,start,duration?,in?,speed?,label?}}；move_clip{id,start?,trackId?}；trim_clip{id,in?,out?,start?,duration?,ripple?}；split_clip{id,at}；delete_clip{id,ripple?}；set_transition{id,transition:{type:cut|dissolve|fade_black,duration}}；set_gain{id,gainDb?,fadeIn?,fadeOut?}；set_speed{id,speed}；add_track{kind:video|audio,name?,role:dialogue|music|sfx}；update_track{id,name?,role?,muted?,locked?,gainDb?}；add_marker{t,label}；remove_marker{id}；reorder{shotIdA,shotIdB}；set_duck{duck:null|{underRole:dialogue|music|sfx,amountDb}}；set_sequence_grade{grade:null|{lift?,gamma?,gain?,saturation?,contrast?,temperature?,exposureStops?,lutCube?}}，颜色 lift/gamma/gain 是三个 -1 至 1 的数。时间单位为秒，所有 ID 来自 read/readEdit。",
        description: "adDirection{sequenceId,direction} 修改已有采用镜头的整片广告方案，结构同 productionSpec；方案变更使受影响的检查过期。所有制作选择在聊天里展示、确认并保存，不让用户跳到面板。selectQuality{kind:image|video} 让用户直接选择当前模型支持的精度并保存到项目，已选且仍有效时复用；用户主动改选时传 reconsider:true。用户已在消息或首页指定精度则用 productionSpec(setQuality) 直接保存，不能再询问同一选择。selectModel{kind:image|video|audio,providerId?,modelId?} 按类型保存模型选择，已有可用选择时直接复用并返回，不逐张出图或逐镜图生视频重复询问。仅首次选择、原模型不可用或用户要求更换时展示选择卡；主动改选传 reconsider:true。指定模型时不先 askUser 再重复确认。其他操作先 productionSpec read 获取真实记录。approveAssets{assetIds}；selectReference{assetId,mediaIds} 比较当前项目图片并同时采用资产设定与定妆，无需预建候选池；selectCandidate{candidateIds,asHero?} 比较同一资产的定妆图；approveTake{takeIds,overrideReason?} 比较同镜头视频，只问用户是否满意，可选填日常语言意见；满意时保存到工作版时间线，不伪造技术验收；reviewOutput{targetType:keyframe|take,targetId} 仅在需要用户新反馈时收集满意度与修改想法；已采用且检查有效的画面直接复用，此操作不写技术检查记录，不能用于解除 review_required 门禁，不让用户勾内部问题代码或填写专业检查表；world/look{变更字段}；updateShot{shotId,patch}；updateAsset{assetId,patch}；rollbackAsset{assetId,version}；removeBinding{bindingId}；publishAsset{assetId}；importAsset{libraryId}；libraryReference{libraryId,mediaId}；editTimeline{sequenceId,ops} 先 readEdit，ops 沿用剪辑操作；reviewFinal{renderId} 先 inspectFinal；selectVoice{lineId,takeIds} 先 readVoice；configureVoice{project} 提交完整配音方案供确认。已生效的决定直接返回 applied:true，不重复询问；仅用户明确要求改选或重新验收时传 reconsider:true。返回 feedback 时，直接按用户原话处理：想改一下或拿不准就由助手查看实际素材、判断问题并提出或执行已获授权的修改，不再追问用户专业分类。满意则沿用已保存选择继续剪辑与导出；reviewRequired 表示助手须处理已知问题，不能让用户替系统排除告警。用户满意不代表技术质检通过，实际末态、抽帧与声音检查仍由助手按真实证据完成。付费重生成仍遵守已授权范围。跳过和暂不决定不授权后续，不循环追问。不要先 askUser 再调用本工具重复确认。",
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
      promptGuidelines: ["正式镜头生成传 shotId、productionFingerprint 和模型规格即可；prompt 可省略，服务端自动使用编译提示词，不手抄长文本。修改画面须先更新镜头规格再编译，不能改自由 prompt 试错。相同规格默认复用已有任务和素材，跨会话继续也不重新出图。失败时停止重复调用并核查原因；仅明确授权重做或新增候选时使用新的 regenerationId，同一次重做始终复用该 UUID。"],
      // ACT: 图片和视频交给持久队列限流；音频仍走直连，保留串行。
      executionMode: operation.mediaType === "audio" ? "sequential" : "parallel",
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
