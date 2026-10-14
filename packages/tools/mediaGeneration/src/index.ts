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
      { name: "generateImage", mediaType: "image", enabled: permissions.allowImage, label: "生成图片", parameters: imageGenerationSchema, description: "根据提示词和可选的工作区参考图生成图片。精修已有关键帧传 shotId 与 localRepair{keyframeId,kind,target:{assetId?,region},note?}；先 productionSpec compile，生成复用同一请求和指纹。原图作为唯一输入，目标写实际对象和部位，只产新候选；无蒙版不承诺区域外不变，仍须审看采用。" },
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
    const productionSchema = z.object({ operation: z.enum(["readAsset", "readLibrary", "favoriteAsset", "publishAsset", "importAsset", "adDirection", "readAdDirection", "readVisionModels", "analyzeReference", "inspectAdPilot", "inspectAdFilm", "read", "readQuality", "setQuality", "agentReview", "importKeyframe", "world", "look", "asset", "reference", "sequence", "shot", "updateShot", "binding", "compile", "readEdit", "readStoryImpact", "soundCues", "suggestCuts", "previewCut", "soundBridge", "inspectFinal", "render", "readVoice"]), data: z.record(z.string(), z.json()).default({}) });
    const productionTools: ToolDefinition[] = media.production ? [{
      name: "productionSpec", label: "制片规格", executionMode: "sequential",
      description: "广告序列使用 kind:adfilm|brandFilm。adDirection{sequenceId,direction} 保存整片导演方案，readAdDirection{sequenceId} 读取方案和样镜门禁；完整结构先读 adfilm 技能。analyzeReference{sequenceId,referenceId,model?} 对真实参考抽帧并保存带时间点的构图、色彩、用光、动作、产品、剪接观察及借鉴边界；inspectAdPilot{sequenceId,keyframeId,model?,reconsider?} 先在本地核对样镜简报与参考是否齐备，再对真实图片与产品参考检查；素材与规格未变时复用持久化结果，仅用户明确要求重审时传 reconsider:true。已采用主帧无需再次采用；inspectAdFilm{sequenceId,renderId,model?} 在 inspectFinal 后检查实际成片的广告表达、产品、色调和邻镜。readVisionModels 读取已选语言模型；只有一个时检查默认复用。model 为已配置的视觉语言模型 {providerId,modelId}；不要填写图片生成模型，无可用视觉模型时停止检查并报告，不伪造通过。样镜须检查通过并采用后才能量产；每镜 advertising{beatId,productRead,cutToNext,sound,pilotKey?} 对应整片方案，pilotKey 仅指定少量先行样镜。读写当前项目的真实领域规格。先 read。readQuality 读取当前项目按模型保存的精度；用户已明确指定精度时，setQuality{kind:image|video,providerId,modelId,value} 直接保存，不再弹确认。没有选择时用 requestProductionDecision(selectQuality)。importKeyframe{shotId,path} 把工作区中的干净单格图登记为该镜头候选，返回 keyframe id；重复导入同图复用，随后 requestKeyframeApproval 可一次采用整批。world/look 更新世界或影调；asset 创建含 type/name/description/attributes/invariants/allowedVariations/forbiddenChanges 的资产草稿，attributes 可保存当前妆造，不能混入多套候选；sequence 创建 name/script；shot 创建 sequenceId/title/narrativeFunction/assetIds/visibleAssetIds/action/performance/blocking/camera/lighting/realism{surface,imaging,world,motion,cinematic}/duration/intendedStateDelta/freedomMap；updateShot 带 shotId 修改草稿或镜头名称；尚无已采用视频时可直接首次补齐缺失的 creativeBrief，须沿用已确定创意，不增加剧情、对白或生成范围；只有返回 needs_confirmation 的实质变更才改用 requestProductionDecision；reference 带 mediaId/name? 将 read 返回的项目媒体登记为参考，返回的 id 才是 referenceId，重复登记复用原记录；binding 带 shotId/referenceId/role/weight/lockLevel/notes 绑定已有参考，notes 限定身份、妆发或服装用途。主关键帧用 requestKeyframeApproval；其余资产、定妆、视频、规格变更、剪辑、配音和成片验收用 requestProductionDecision，在聊天中预览并保存决定。readEdit 传 sequenceId 读取剪辑轨道、片段和 version。suggestCuts、previewCut 均传 {sequenceId,leftId,rightId,expectedVersion}，ID 与版本来自最新 readEdit；suggestCuts 只返回连续硬切的候选及源素材 ID，不自动采用；previewCut 返回接点前后带声音的预览媒体。soundBridge 传上述字段及 {mode:jCut|lCut|crossfade|none,duration}，在已授权剪辑范围内直接应用声音桥并返回新时间线；需要真实音轨和素材头尾余量，失败时先修入出点或使用独立声音，不反复重试。修改后重新 readEdit/previewCut，不复用旧版本；inspectFinal 传 renderId 检测成片；render 传 sequenceId/options 导出已授权的剪辑，options 可含 normalizeAudio、targetLufs、burnSubtitles、width、height。迭代期预览用 options.draft:true 草稿导出，直接展示给用户看片，不进入 inspectFinal、inspectAdFilm 或 reviewFinal；用户确认满意准备交付时定稿导出（省略 draft），再依次 inspectFinal（广告序列加 inspectAdFilm）与 reviewFinal 完成验收。草稿导出不能检测验收；定稿导出到 reviewFinal 结束期间不修改世界、影调、资产、参考绑定与剪辑，需要修改时改完重新定稿导出再验收。readVoice 读取配音方案。不能代填用户检查，不要求跳转面板或重复确认。",
      promptSnippet: "正式镜头先 read 复用已有规格、角色与有效检查。创意确定后一次保存 creativeBrief、角色当前 attributes.styling 和适用的广告方案，再检查样镜与生成。creativeBrief.dialogue 保留原文、说话人、时间与口型计划；无对白用 {mode:post,lines:[]}，不为省事删台词。完整字段结构读 cinema/references/creativePreparation.md；data 直接放规格字段，world/look 不再包同名对象。动作时间为本镜局部秒数。compile 传 shotId/kind/request，读取真实 prompt、inputs、warnings/degradations；generate 复用返回 request，传 shotId 与 fingerprint 作为 productionFingerprint。画布节点同样须传 production:{shotId,productionFingerprint}；自由 prompt 不能代替领域规格。generated 声音方案需要支持音频的模型，silent 关闭音频；数值轨迹只用于支持 cameraTrajectory 的模型。已有角色从 readLibrary 搜索并 importAsset 导入；选定的定妆用 publishAsset 收藏，生成调用实际参考图片。代理审阅用明确参数工具 reviewProduction，检查有效时复用；真实输出的观察不能由字段齐全或格式通过替代。",
      promptGuidelines: [
        "默认 read 只返回本项目当前资产；需要历史版本时 readAsset{assetId} 按需读取，不把旧版本当当前设定。跨项目角色先 readLibrary{q?,favorite?,type?,tags?} 搜索已有演员或歌手；用户要求调用时 importAsset{libraryId}，要求收藏已采用角色时 publishAsset{assetId}，favoriteAsset{libraryId,favorite} 切换收藏。相同角色在同项目重复导入返回原资产，不重建脸。新角色可外部上传或内部生成图片，reference 登记图片、asset 建档，再用 selectReference 选定定妆并采用，publishAsset 保存独立角色库副本。库只带长期身份、说话与行为习惯，不继承上一项目的人物关系；导入后按本项目角色安排妆造和表演。",
        "角色资产 attributes.characterDirection{speech,behavior,relationships} 保存长期档案，导演只把当场相关策略转成 performance，把正在发声者的说话习惯转成 dialogue.delivery；configureVoice 的 roles[].speechStyle 沿用 speech。不将小传、关系和习惯清单重复贴入画面字段。visibleAssetIds 是 assetIds 的出镜子集，纯画外说话人只留对白；省略沿用 assetIds。camera.design.start 只写首帧已发生的状态，稍后入镜写进 timing。shot/updateShot 的 source 传 {sceneId}，服务端保存已采用剧本的真实正文/对白/知情快照。knowledge 供导演区分角色与观众所知，反应不得早于证据；完整账本不放入媒体执行文本。",
        "跨场返回明确沿用某镜末态时，shot/updateShot 传 continuityFromShotId（同序列更早镜头），摄影提示词会继承人物位置、朝向和道具状态。时间跳跃或倒叙不要自动沿用最后一个同名场景；在 intendedStateDelta 记录实际结果。",
        "全片声音按叙事作用安排进入、退出、主次与必要静默。readEdit 取得轨道与 version；soundCues{sequenceId,expectedVersion,cues:[{trackId,mediaId,shotId?,start,duration,in,gainDb,fadeIn,fadeOut,purpose}],duck?} 将已登记的真实声音一次写入时间线并可撤销。purpose 写声音改变了什么信息或情绪。缺素材先生成/导入，不伪造媒体 ID；对白来源用 readVoice。已有声音调整或局部静默用 editTimeline 的 split_clip/set_gain/trim_clip，不重复铺一层配乐。",
        "改剧本前后用 readStoryImpact 读取源场次、相关镜头、配音与时间线区间；readEdit 的 storySource 和 dialogue 提供实际剪辑中的对应关系及对白被截断标记。没有来源记录的旧镜头不能宣称自动完成追踪。先分清剧本、表演设计、生成缺陷、剪辑或混音原因，只修改相应数据/片段；不要将核验、剪辑或混音问题直接变成付费重生成。",

        "自动合成仅产出 draft:true 粗剪。完整制作默认先 readEdit，按主视频轨时间顺序逐个 previewCut 查看接缝；需要改善的连续硬切先 suggestCuts 比较候选，再用 editTimeline 的 set_cut 保存入出点，必要时 soundBridge 处理声音，修改后重新预览。候选分数不代表动作、对白或视线匹配，不自动采用第一名，不统一添加淡入淡出。已有合理硬切可保留。保护完整对白、关键动作及既定总时长，素材无余量时保留问题，不偷加付费生成。",
        "接缝预览生成成功不等于已看听。复用当前素材和时间线的有效观察，仅复查改动影响的接点；用户要求直接看粗剪时先交付粗剪，不阻塞预览。接缝处理并实际看听、准备交付后，显式 render 导出定稿（draft:false 或省略 draft），再走最终验收。不能把自动粗剪标为定稿或已验收；工具或媒体不可读取时说明缺项。",
      ],
      parameters: z.toJSONSchema(productionSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        const parsed = productionSchema.parse(params);
        // ACT: 工具 schema 保留顶层对象，兼容不识别顶层 oneOf 的模型；审阅仍按明确字段校验。
        const data = parsed.operation === "agentReview" ? agentReviewSchema.parse(parsed.data) : parsed.data;
        const result = await media.production!(parsed.operation, data, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }] : [];
    if (media.production) productionTools.push({
      name: "inspectProduction", label: "批量基础质检", executionMode: "parallel",
      description: "对已有素材执行本地解码、尺寸、时长和持续黑场检查，按素材版本复用结果，不调用生成模型。可与其他镜头生成并行调用，一次传入所有待检查素材。返回分级检查计划；普通镜头集中预览一次，重点镜头查看关键画面，声音只看听 speechRanges。自动检测不代表审美或口型通过，发现问题只影响该镜，不重生成、不逐镜询问用户。",
      parameters: z.toJSONSchema(z.object({ targets: z.array(z.object({ type: z.enum(["keyframe", "take"]), id: z.string().min(1) })).min(1).max(100) })),
      async execute(_id, params, signal) {
        const result = await media.production!("inspectQuality", params as Record<string, unknown>, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
    if (media.production) productionTools.push({
      name: "reviewProductions", label: "批量记录检查并采用工作版", executionMode: "sequential",
      description: "集中预览后一次提交多镜真实观察，不逐镜请求确认。每项独立保存；失败只阻塞该镜，已有有效检查复用。对白/演唱传实际 reviewedSegments 和 audioReview，不能自动填通过。最终交付仍需验收。",
      parameters: z.toJSONSchema(z.object({ reviews: z.array(agentReviewSchema).min(1).max(60) }), { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        const input = z.object({ reviews: z.array(agentReviewSchema).min(1).max(60) }).parse(params);
        const results = [];
        for (const review of input.reviews) {
          signal?.throwIfAborted();
          try { results.push({ targetId: review.targetId, result: await media.production!("agentReview", review, signal) }); }
          catch (error) { results.push({ targetId: review.targetId, error: error instanceof Error ? error.message : String(error) }); }
        }
        return { content: [{ type: "text", text: JSON.stringify(results) }], details: results };
      },
    });
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
    if (media.requestProductionDecision) {
      const schema = z.strictObject({ operation: z.enum(["adDirection", "selectModel", "selectQuality", "approveAssets", "selectReference", "selectCandidate", "approveTake", "reviewOutput", "world", "look", "updateShot", "updateAsset", "rollbackAsset", "removeBinding", "publishAsset", "importAsset", "libraryReference", "editTimeline", "reviewFinal", "selectVoice", "configureVoice"]), data: z.record(z.string(), z.json()), reconsider: z.boolean().optional() });
      productionTools.push({
        name: "requestProductionDecision", label: "确认制作选择", executionMode: "sequential",
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
      promptGuidelines: ["批量制作将 generateShots 与 inspectProduction 并行安排，先处理可生成镜头，不等待其他镜头质检结束；旧素材只检测不重生成。集中预览后使用 reviewProductions 一次记录真实观察；已有自主审阅授权不再逐镜确认。普通镜头按分级轻量检查，异常只阻塞对应镜头，最终成片另行验收。", "生成前一次性检查编译后的实际提示词、参考用途、人物动作、镜头时间线和模型能力冲突；修正规格后再提交。相同规格的有效检查沿用，只有变更影响的部分重新检查。等待任务由工具自动完成，不另起模型轮询。生成后仍须一次真实结果验收；提示词通过不能证明画面或口型通过。单镜失败不清空画布、不删除其他结果。", "正式镜头生成传 shotId、productionFingerprint 和模型规格即可；prompt 可省略，服务端自动使用编译提示词，不手抄长文本。修改画面须先更新镜头规格再编译，不能改自由 prompt 试错。相同规格默认复用已有任务和素材，跨会话继续也不重新出图。失败时停止重复调用并核查原因；仅明确授权重做或新增候选时使用新的 regenerationId，同一次重做始终复用该 UUID。"],
      // ACT: 图片和视频交给持久队列限流；音频仍走直连，保留串行。
      executionMode: operation.mediaType === "audio" ? "sequential" : "parallel",
      async execute(_id, params, signal, onUpdate) {
        signal?.throwIfAborted();
        const result = await media[operation.name](operation.parameters.parse(params), signal, progress => onUpdate?.({ content: [{ type: "text", text: JSON.stringify({ progress }) }], details: {} }));
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
