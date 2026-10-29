import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { agentReviewSchema, audioGenerationSchema, cameraDirectionPlanning, imageGenerationSchema, listMediaModelsSchema, videoGenerationSchema, videoSpeechPlanning } from "./runtime";

const configSchema = z.strictObject({
  allowImage: z.boolean().default(true),
  allowVideo: z.boolean().default(true),
  allowAudio: z.boolean().default(true),
});

const mediaPath = z.string().min(1).max(2048).refine(
  value => !/^[\\/]|[:\u0000-\u001f]/.test(value) && value.split(/[\\/]/).every(part => part && part !== "." && part !== ".."),
  "路径必须是工作区内的相对路径，不能包含 .. 或空路径段",
);

const composeFilmSchema = z.strictObject({
  clips: z.array(mediaPath).min(1).max(400).describe("按成片顺序排列的工作区视频路径，来自实际生成结果"),
  output: mediaPath.describe("成片输出路径，如 assets/generated/成片.mp4"),
  grade: z.strictObject({
    contrast: z.number().min(0.5).max(2).optional(),
    saturation: z.number().min(0).max(2).optional(),
    brightness: z.number().min(-1).max(1).optional(),
    grain: z.number().min(0).max(40).optional(),
  }).optional().describe("统一调色；grain 在调色之后叠加，超过 12 会明显噪"),
  targetLufs: z.number().min(-40).max(-5).optional().describe("整片响度目标，默认 -16 LUFS"),
  headTail: z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive() })).max(8).optional().describe("片头片尾黑场豁免区间，只影响自检判定"),
  verify: z.boolean().optional().describe("合成后是否自动跑整片自检，默认开启"),
});

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ media, config }) {
    if (!media) return [];
    const permissions = configSchema.parse(config);
    const generationTools = ([
      { name: "generateImage", mediaType: "image", enabled: permissions.allowImage, label: "生成图片", parameters: imageGenerationSchema, description: "根据提示词和可选的工作区参考图生成图片。角色资产默认一次生成一张正脸特写＋全身正、侧、背面设定图，用purpose=asset和outputName，不compile剧情关键帧，不自动拆图补图。精修已有关键帧传 shotId 与 localRepair{keyframeId,kind,target:{assetId?,region},note?}；先 productionSpec compile，生成复用同一请求和指纹。原图作为唯一输入，目标写实际对象和部位，只产新候选；无蒙版不承诺区域外不变，仍须审看采用。" },
      { name: "generateVideo", mediaType: "video", enabled: permissions.allowVideo, label: "生成视频", parameters: videoGenerationSchema, description: "根据提示词和可选的工作区图片、视频、音频、首尾帧生成视频。按模型能力设置生成模式、时长、分辨率和音频。lipSync=true 的模型专用于对口型，传一个人物视频和一段已确定配音，不传画幅、分辨率和时长。" },
      { name: "generateAudio", mediaType: "audio", enabled: permissions.allowAudio, label: "生成音频", parameters: audioGenerationSchema, description: "固定角色配音先 readVoice/configureVoice 保存角色与原句，必须传 voiceLineId，providerId/modelId/prompt 与保存的角色和原句一致；voice/speed/instructions 建议省略，服务端读取已保存的音色、语速和完整表演，不手工拼接指令。用 listMediaModels{all:true} 查询可用语音模型，角色选择独立于全局音乐模型；不用未充值或停用的供应商。服务端自动将候选记录到该句 takes，不手工重复追加，试听并 selectVoice 采用后才 planSpeech/专用口型。有效声音复用，不重复生成。情绪与表演放 instructions，仅用于 speechInstructions=true 的模型，不能混入 prompt；不支持时保留方案报告能力缺项，不能静默丢弃。音乐/音效仍使用全局已选模型。返回真实 duration，未知先 ffprobe，不能估算；生成配音不会修改旧画面口型。" },
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
    const productionSchema = z.object({ operation: z.enum(["searchTechniques", "readAsset", "readLibrary", "favoriteAsset", "publishAsset", "importAsset", "adDirection", "readAdDirection", "readVisionModels", "analyzeReference", "inspectAdPilot", "inspectAdFilm", "read", "planGeneration", "readQuality", "setQuality", "agentReview", "agentReviewFinal", "continuationFrame", "importKeyframe", "importAudio", "world", "look", "asset", "reference", "sequence", "shot", "updateShot", "binding", "compile", "readEdit", "readStoryImpact", "soundCues", "suggestCuts", "previewCut", "soundBridge", "inspectFinal", "render", "readVoice", "planSpeech", "syncSpeech", "prepareSpeech", "inspectSpeech", "importSpeech"]), data: z.record(z.string(), z.json()).default({}).describe("只放操作参数，不重复 operation。searchTechniques: {query?,category?,stage?,limit?:1..20}；updateShot: {shotId,techniques?,其他变更字段}，不包patch、不传confirm。需确认时另用requestProductionDecision的{operation:updateShot,data:{shotId,patch:{变更字段}}}。compile: {shotId,kind,request}，仅预览不生成，沿用已绑定主帧，无须另找images或重新采用。预览警告不解除生成门禁。") });
    const productionTools: ToolDefinition[] = media.production ? [{
      name: "productionSpec", label: "制片规格", executionMode: "sequential",
      description: "广告、MV、剧情/剧集统一锁定已采用的角色、妆造、产品和环境参考；每个视频须完整播放检查 surface/imaging/world/motion/cinematic。关键接触动作在 shot.interactions 保存 [{assetIds,start,contactAt,end,approach,contact,force,support,release,endState}]，秒数为镜头局部时间，参与者必须实际出镜；不要用空泛的高端、8K替代皮肤、成像、受力及表演设计。MV sourceTrack 须保存 musicVideo.sourceMediaId（importAudio 的真实 media.id）和 sourceStart；自动排轨按歌曲入点连续使用原曲并静音生成视频歌曲，剪辑修改后用 readEdit 检查歌曲对齐，不把写入ID当成模型已收到音频。inspectFinal 返回 plan.fields 和 plan.cuts。已获自主审阅授权且实际完整看听后，可 agentReviewFinal{renderId,authorization,review:{analysisId,fullPlayback:true,checks,cutReview:[{id,seconds,verdict:pass|fail|unverified,note}],techniqueReview:[],note,acknowledgements:[]}}，逐项使用 plan 的字段和切点；note写真实证据和局部修复范围，缺检查保持unverified，不伪造授权或观察；用户满意另用requestProductionDecision(reviewFinal)。planSpeech{shotId,bindings?:[{lineIndex,path}]} 先实测已选配音或明确映射的已有声音，返回逐句窗口、minimumDuration和coverageRequired；只规划不改镜头、不生成。保存返回audio:{mediaId,text}和导演复核后的coverage:[{start,end,description}]到creativeBrief.dialogue.lines；visible覆盖完整发声期，不能只写本镜有人。容量不足重新调度或拆有意义的表演单元，不能拉慢打斗救援、加速删句或跨镜挪音。先定真实声音屏时再定切点；模型时长不够则保留待规划。searchTechniques{query?,category?,stage?,limit?} 本地检索300项镜头技法，category为camera/lighting/composition/editing/sound/story/effects/genre，stage为image/video/edit/audio/story/look。按本场目的查询少量候选，选用后在shot/updateShot保存techniques:[{id,purpose,execution,start?,end?}]，不逐项询问用户。execution至少10字，写本镜具体对象、触发和结果；每镜最多8项。时间效果必须给本镜start/end，不得覆盖对白或原曲同步。摄影字段同步更新；edit/audio/story须交真实时间线、声音及故事流程，不能当单镜生成指令。reviewProduction的techniqueReview按检查计划逐项记录真实观察，未看听不填通过。广告序列使用 kind:adfilm|brandFilm。adDirection{sequenceId,direction} 保存整片导演方案，readAdDirection{sequenceId} 读取方案和样镜门禁；完整结构先读 adfilm 技能。analyzeReference{sequenceId,referenceId,model?} 对真实参考抽帧并保存带时间点的构图、色彩、用光、动作、产品、剪接观察及借鉴边界；inspectAdPilot{sequenceId,keyframeId,model?,reconsider?} 先在本地核对样镜简报与参考是否齐备，再对真实图片与产品参考检查；素材与规格未变时复用持久化结果，仅用户明确要求重审时传 reconsider:true。已采用主帧无需再次采用；inspectAdFilm{sequenceId,renderId,model?} 在 inspectFinal 后检查实际成片的广告表达、产品、色调和邻镜。readVisionModels 读取已选语言模型；只有一个时检查默认复用。model 为已配置的视觉语言模型 {providerId,modelId}；不要填写图片生成模型，无可用视觉模型时停止检查并报告，不伪造通过。样镜静帧适用项通过并采用后才能量产；以 readiness 与 assessment.blockingChecks 为准，advisoryChecks 默认接受且不自动修改，assessment.nextAction:continueProduction 时继续已授权制作，不再追问是否精修；未入镜产品不适用，editing 留待视频验证，不能为所有项 pass 反复重审、改规格或重生成；每镜 advertising{beatId,productRead,cutToNext,sound,pilotKey?} 对应整片方案，pilotKey 仅指定少量先行样镜。读写当前项目的真实领域规格。先 read。readQuality 读取当前项目按模型保存的精度；用户已明确指定精度时，setQuality{kind:image|video,providerId,modelId,value} 直接保存，不再弹确认。没有选择时用 requestProductionDecision(selectQuality)。continuationFrame{shotId,takeId,seconds?} 从明确接续的前镜真实视频取帧，返回可读的工作区path和候选keyframe；不自动批准，也不替代动态视频。前镜改变后拒绝旧接戏帧。需要换机位时用此帧和已采用身份/场景图编辑本镜新主帧，再生成真实动态镜头。importKeyframe{shotId,path} 把工作区中的干净单格图登记为该镜头候选，返回 keyframe id；重复导入同图复用，随后 requestKeyframeApproval 可一次采用整批。world/look 更新世界或影调；asset 创建含 type/name/description/attributes/invariants/allowedVariations/forbiddenChanges 的资产草稿，attributes 可保存当前妆造，不能混入多套候选；sequence 创建 name/script；shot 创建 sequenceId/title/narrativeFunction/assetIds/visibleAssetIds/action/performance/blocking/camera/lighting/realism{surface,imaging,world,motion,cinematic}/duration/intendedStateDelta/freedomMap；updateShot 带 shotId 修改草稿或镜头名称；尚无已采用视频时可直接首次补齐缺失的 creativeBrief，须沿用已确定创意，不增加剧情、对白或生成范围；只有返回 needs_confirmation 的实质变更才改用 requestProductionDecision；reference 带 mediaId/name? 将 read 返回的项目媒体登记为参考，返回的 id 才是 referenceId，重复登记复用原记录；binding 带 shotId/referenceId/role/weight/lockLevel/notes 绑定已有参考，notes 限定身份、妆发或服装用途。主关键帧用 requestKeyframeApproval；其余资产、定妆、视频、规格变更、剪辑、配音和成片验收用 requestProductionDecision，在聊天中预览并保存决定。readEdit 传 sequenceId 读取剪辑轨道、片段和 version。suggestCuts、previewCut 均传 {sequenceId,leftId,rightId,expectedVersion}，ID 与版本来自最新 readEdit；suggestCuts 只返回连续硬切的候选及源素材 ID，不自动采用；previewCut 返回接点前后带声音的预览媒体。soundBridge 传上述字段及 {mode:jCut|lCut|crossfade|none,duration}，在已授权剪辑范围内直接应用声音桥并返回新时间线；需要真实音轨和素材头尾余量，失败时先修入出点或使用独立声音，不反复重试。修改后重新 readEdit/previewCut，不复用旧版本；inspectFinal 传 renderId 检测成片；render 传 sequenceId/options 导出已授权的剪辑，options 可含 normalizeAudio、targetLufs、burnSubtitles、width、height。迭代期预览用 options.draft:true 草稿导出，直接展示给用户看片，不进入 inspectFinal、inspectAdFilm 或 reviewFinal；用户确认满意准备交付时定稿导出（省略 draft），再依次 inspectFinal（广告序列加 inspectAdFilm）与 reviewFinal 完成验收。草稿导出不能检测验收；定稿导出到 reviewFinal 结束期间不修改世界、影调、资产、参考绑定与剪辑，需要修改时改完重新定稿导出再验收。readVoice 读取配音方案；prepareSpeech{audio:{path,mimeType,start,duration}} 从现有声音准备片段；inspectSpeech{audioPath,videoPath,sourceVideoPath} 对当前口型结果核验真实音轨、偏移和原片时长，返回 key。完整看听后 importSpeech{shotId,audioPath,videoPath,sourceVideoPath,inspectionKey,fullPlayback:true,speech:pass,lipSync:pass,note} 登记候选，复用已有成功任务，不调用生成；inspectionKey 用本次检查的 key，note 写实际观察且至少10字。音轨匹配不能证明嘴形通过，未完整看听不得填通过。候选仍须 reviewProduction 检查人物、动作、接戏后采用，再 readEdit/render；这一步不重复询问已确认的配音选择。不能代填用户检查，不要求跳转面板或重复确认。",
      promptSnippet: "多人项目默认先固定每个角色的音色（跨镜头统计说话人），使用 post；readVoice 后 listMediaModels{all:true} 查已配置可用的语音和专用口型模型，不选音乐/音效模型，不使用未充值或已停用的 APIMart，不探测付费接口或自动换供应商。configureVoice 的 roles 每人唯一绑定 assetId、providerId、modelId、voice；lines 用 roleId、shotId、dialogueLineIndex 关联原句。generateAudio 必须传 voiceLineId 及保存的 providerId/modelId/prompt；省略 voice/speed/instructions 以读取已保存方案，生成只增加候选；试听后 selectVoice 采用，再 planSpeech 和专用口型。已采用且有效的配音直接复用，不重复确认或生成。单人且无固定音色要求时才默认 creativeBrief.dialogue.mode=native，选择 nativeDialogue=true 的模型同时生成声音和口型，generateAudio 未传时开启。固定音色或已有采用配音使用 post：先采用并实测完整配音，绑定 audio:{mediaId,text}，按真实声音设计时长和嘴部覆盖，再处理并检查专用口型。音频参考只表示参考能力，不保证原音逐字保留，不能冒充对口型。旁白、音乐、环境声可以后期制作。缺少能力时报告具体缺项，不自动换模型、删台词、改画外音或直接给成型视频叠对白。 正式镜头先 read 复用已有规格、角色与有效检查。创意确定后一次保存 creativeBrief、角色当前 attributes.styling 和适用的广告方案，再检查样镜与生成。creativeBrief.dialogue 保留原文、说话人、时间与口型计划；无对白用 {mode:post,lines:[]}，不为省事删台词。完整字段结构读 cinema/references/creativePreparation.md；data 直接放规格字段，world/look 不再包同名对象。动作时间为本镜局部秒数。compile 传 shotId/kind/request，读取真实 prompt、inputs、warnings/degradations；generate 复用返回 request，传 shotId 与 fingerprint 作为 productionFingerprint。画布节点同样须传 production:{shotId,productionFingerprint}；自由 prompt 不能代替领域规格。generated 声音方案需要支持音频的模型，silent 关闭音频；数值轨迹只用于支持 cameraTrajectory 的模型。已有角色从 readLibrary 搜索并 importAsset 导入；选定的定妆用 publishAsset 收藏，生成调用实际参考图片。代理审阅用明确参数工具 reviewProduction，检查有效时复用；真实输出的观察不能由字段齐全或格式通过替代。",
      promptGuidelines: [
        "后配对白镜头统一用 productionSpec(syncSpeech,{shotId}) 自动处理完整镜头：先 configureVoice、selectVoice、planSpeech 保存真实声音与窗口，再选入原视频工作版。syncSpeech 自动按每句实测声音裁片、专用对口型并按原时间合回，支持多句、多人轮流发声、延迟发声和句间停顿；不让用户手动拆片，不改变原句或镜头总时长。返回 assemblyId、mediaId、videoPath、audioPath、sourceVideoPath、inspectionKey。完整看听结果后 importSpeech 传 {assemblyId,shotId,videoPath,audioPath,sourceVideoPath,inspectionKey,fullPlayback:true,speech:pass,lipSync:pass,note}，pass 必须来自真实检查，不传 mediaId，登记候选后 reviewProduction 采用；自动模式用 observeAutoFilmVideo，登记后再次观察摄影清单。中断后重调同一 shotId 复用成功片段和原任务，不重新生成声音，不再重复铺A1对白。",
        cameraDirectionPlanning,
        "设计包含遮挡后揭示、绕行保持空间关系、穿门绕柱或用户指定多个机位路径时，主动使用已有3D导演台预演；普通固定、简单推近或跟拍不强制预演。先读取workflow/references/canvasExecution.md并发现节点工具，在已有生成授权内调用generatePlan；没有该入口或授权不足时说明缺项，不假装已预演。预演只用于修正镜头规格，参考视频或数值轨迹须按当前模型实际能力另行接入，不自动换模型。",
        "按片型执行 cinema/references/referenceQuality.md。动作戏的 combat.beats.timelineIndex 绑定唯一执行时间线；摄影覆盖与多人反应必须明确。完整播放后按 motionPlan.checkpoints 用 motionReview:[{id,verdict:pass|revise,note}] 记录实际动作、空间和接触，不把失败动作改成静站，不逐项向用户确认。批次确认前先 productionSpec(planGeneration,{requests:[{kind:image|video,count,quality?,duration?,mode?,referenceCount?,singleTake?}]}) 只读核对当前模型、精度和单段时长，集中处理缺项后展示一次具体生成方案。ready只代表所检查参数，参考必须实际核对，不能当成已授权。用户禁止生成时仅做规划和compile。单段超过能力不能把拼接称一镜到底。",
        "剧情、广告和MV均使用camera.design.mode=singleTake|multiShot。剧情广告的camera.design.timeline为[{start,end,description,transition?:continuous|cut}]，完整覆盖生成段；MV沿用musicVideo.timeline，同样支持transition，不同时写两份时间线。singleTake不允许cut。description写可见身体任务、接触结果、位移与构图；锁身份不锁坐姿或手势，不用微表情撑满时长。完整规则读取cinema/references/movementDirection.md。",
        "默认 read 只返回本项目当前资产；需要角色详情或实际参考图时 readAsset{assetId} 按需读取；referenceImages 返回可直接用于 read 和 generateImage.images 的 path、mimeType，沿用这些路径，不搜索历史生成目录或把媒体 ID 猜成路径；versions 只用于历史追溯。跨项目角色先 readLibrary{q?,favorite?,type?,tags?} 搜索已有演员或歌手；用户要求调用时 importAsset{libraryId}，要求收藏已采用角色时 publishAsset{assetId}，favoriteAsset{libraryId,favorite} 切换收藏。相同角色在同项目重复导入返回原资产，不重建脸。新角色可外部上传或内部生成图片，reference 登记图片、asset 建档，再用 selectReference 选定定妆并采用，publishAsset 保存独立角色库副本。库只带长期身份、说话与行为习惯，不继承上一项目的人物关系；导入后按本项目角色安排妆造和表演。",
        "角色资产 attributes.characterDirection{speech,behavior,relationships} 保存长期档案，导演只把当场相关策略转成 performance，把正在发声者的说话习惯转成 dialogue.delivery；configureVoice 的 roles[].speechStyle 沿用 speech。不将小传、关系和习惯清单重复贴入画面字段。visibleAssetIds 是 assetIds 的出镜子集，纯画外说话人只留对白；省略沿用 assetIds。camera.design.start 只写首帧已发生的状态，稍后入镜写进 timing。shot/updateShot 的 source 传 {sceneId}，服务端保存已采用剧本的真实正文/对白/知情快照。knowledge 供导演区分角色与观众所知，反应不得早于证据；完整账本不放入媒体执行文本。",
        "短剧和中剧每集用 sequence{name,kind:serial,episodeNumber,storyRevisionId} 创建独立序列，按集号顺序建集；复用同项目资产、定妆参考、Look 和角色音色。shot/updateShot 的 source:{sceneId} 关联采用剧本，自动读取集号并校验所属序列。跨集或跨场明确沿用某镜末态时传 continuityFromShotId（本项目更早序列或同序列更早镜头），摄影提示词继承人物位置、朝向、服装、伤势和持物状态。时间跳跃或倒叙不要自动沿用最后一个同名场景；在 intendedStateDelta 记录实际结果。上游修改会传播状态并使相关旧检查失效，逐集生成、看片、剪辑和导出，不把一整集塞进单次视频生成。",
        videoSpeechPlanning,
        "声音与画面共用 readEdit 的真实时间线，不按场次、镜头名或原定秒数另排一条声音时间线。importAudio{path,kind:speech|music|sfx} 登记工作区音频，kind 默认 speech，返回真实 mediaId/duration，重复导入复用。soundCues{sequenceId,expectedVersion,cues:[{trackId,mediaId,shotId?,videoClipId?,dialogueLineIndex?,start,duration,in,gainDb,fadeIn,fadeOut,purpose}],duck?} 写入声音。对白轨必须传 readEdit 的视频 clip.id、shotId 和 dialogue[].lineIndex；start 用 dialogue.start，duration 用整句实际音频时长，in=0。对白超过窗口立即报告具体冲突，不删词、重复铺轨、擅自加速或跨镜挪动。可见发声优先原生声画同出；固定配音须专用口型候选；两者均须实际完整看听，不用音频参考、混音成功或音轨相似度冒充同步。多句或延迟发声调用 syncSpeech 自动按窗口拆片并合回整镜，不让用户手动处理，不以单句短片替换整镜。原音轨与后配对白不能重复启用。对白项目的自由 FFmpeg 仅用于声音准备、抽帧或分析，所有视频导出走 render；未验收只用 draft:true，不能重命名为定稿。已有声音调整用 editTimeline，不重复铺一层。",
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
      description: "实际查看输出且已获得用户自主审阅授权后，记录一次技术与创意检查。优先使用此明确参数工具，避免在productionSpec的自由data中猜字段。无缺陷observations传[]；有creativeBrief时creativeReview必填，verdict仅pass/revise，styling和staging各至少10字。动作按 inspectProduction/read 返回的 motionPlan.checkpoints 填 motionReview:[{id,verdict:pass|revise,note}]，note 写实际时间点与观察，完整播放后才能 pass。检查有效时复用；严重缺陷会保留并阻止采用，不自动重新生成。视频抽帧不能证明口型或声音同步。",
      parameters: z.toJSONSchema(agentReviewSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        const result = await media.production!("agentReview", agentReviewSchema.parse(params), signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
    if (media.generateShots && (permissions.allowImage || permissions.allowVideo)) {
      const schema = z.strictObject({ kind: z.enum(["image", "video"]), requests: z.array(videoGenerationSchema.extend({ shotId: z.string().min(1), size: imageGenerationSchema.shape.size, quality: imageGenerationSchema.shape.quality }).omit({ productionFingerprint: true, regenerationId: true })).min(1).max(60) })
        .refine(input => new Set(input.requests.map(request => request.shotId)).size === input.requests.length, "同批每镜只能提交一次");
      productionTools.push({
        name: "generateShots", label: "批量推进镜头", executionMode: "sequential",
        description: "将已经就绪且已采用主帧的独立镜头批量推进生成。服务端逐镜编译真实规格并使用对应指纹，不需要模型抄写prompt或fingerprint；生成期间内部等待并显示真实完成计数，不调用模型轮询。requests每镜含shotId、providerId、modelId和所选模式/精度/时长；图片用size/ratio，视频用duration/resolution/generateAudio/mode。mode必须完整等于listMediaModels的一项，多参考不能只取子项。保留所有参考与检查门禁，严重缺陷记为blocked并继续其他镜头；已有请求复用，失败不重发。仅缺图镜头传kind:image，每镜一次，不自动新增候选或切换模型。",
        parameters: z.toJSONSchema(schema, { io: "input", target: "draft-07" }),
        async execute(_id, params, signal, onUpdate) {
          const input = schema.parse(params);
          if (input.kind === "image" && !permissions.allowImage || input.kind === "video" && !permissions.allowVideo) throw new Error("当前工具未获此类媒体生成权限");
          const shots = await media.generateShots!(input.kind, input.requests, signal, progress => onUpdate?.({ content: [{ type: "text", text: JSON.stringify({ progress }) }], details: {} }));
          const blocked = shots.filter(shot => shot.status === "blocked").length;
          const result = { progress: `已返回 ${shots.length}/${input.requests.length} 镜，成功 ${shots.length - blocked} 镜，失败或受阻 ${blocked} 镜`, shots };
          if (blocked) throw new Error(JSON.stringify(result));
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }
    if (media.requestProductionDecision) {
      const schema = z.strictObject({ operation: z.enum(["adDirection", "selectModel", "selectQuality", "approveAssets", "selectReference", "selectCandidate", "approveTake", "reviewOutput", "world", "look", "updateShot", "updateAsset", "rollbackAsset", "removeBinding", "publishAsset", "importAsset", "libraryReference", "editTimeline", "reviewFinal", "selectVoice", "configureVoice"]), data: z.record(z.string(), z.json()), reconsider: z.boolean().optional() });
      productionTools.push({
        name: "requestProductionDecision", label: "确认制作选择", executionMode: "sequential",
        promptSnippet: "editTimeline 的 ops 每项含 type：replace_source{id,mediaId} 原位替换视频源并保留片段ID及声音关联；set_cut{leftId,rightId,sourceOut,sourceIn,leftMediaId?,rightMediaId?}；bridge_audio{leftId,rightId,mode:jCut|lCut|crossfade|none,duration}；map_segments{mediaId,segments:[{shotId,in,out}]}；add_clip{clip:{trackId,type:shot|media,shotId?,mediaId?,start,duration?,in?,speed?,label?}}；move_clip{id,start?,trackId?}；trim_clip{id,in?,out?,start?,duration?,ripple?}；split_clip{id,at}；delete_clip{id,ripple?}；set_transition{id,transition:{type:cut|dissolve|fade_black,duration}}；set_gain{id,gainDb?,fadeIn?,fadeOut?}；set_speed{id,speed}；add_track{kind:video|audio,name?,role:dialogue|music|sfx}；update_track{id,name?,role?,muted?,locked?,gainDb?}；add_marker{t,label}；remove_marker{id}；reorder{shotIdA,shotIdB}；set_duck{duck:null|{underRole:dialogue|music|sfx,amountDb}}；set_sequence_grade{grade:null|{lift?,gamma?,gain?,saturation?,contrast?,temperature?,exposureStops?,lutCube?}}，颜色 lift/gamma/gain 是三个 -1 至 1 的数。时间单位为秒，所有 ID 来自 read/readEdit。",
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
    return [...(generationTools.length ? [listTool] : []), ...(media.compose ? [{
      name: "composeFilm",
      label: "合成成片",
      description: "把已生成的工作区视频按给定顺序合成为一支片子：先拼轨（不重编码），再统一做一次调色与响度归一。只编码一次，因此不会出现段间黑闪或音量跳变。",
      promptSnippet: "全部镜头采用之后再合成。clips 按成片顺序排列，路径取自实际生成结果，不猜路径。默认 grade 控制在对比 1.05、饱和 0.9、颗粒 4 以内，目标是电影感而不是做旧；targetLufs 默认 -16。合成只完成技术拼装，仍需实际完整看听再验收，不能把已合成当作已验收。",
      parameters: z.toJSONSchema(composeFilmSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        const parsed = composeFilmSchema.parse(params);
        const result = await media.compose!(parsed, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    } as ToolDefinition] : []), ...productionTools, ...generationTools.map<ToolDefinition>(operation => ({
      name: operation.name,
      label: operation.label,
      description: `${operation.description}providerId 和 modelId 必须来自 listMediaModels。引用素材的 path 及 outputDirectory 均为工作区相对路径；省略输出目录使用默认媒体目录。等待生成完成后返回已保存的文件路径，不返回 Base64。`,
      promptSnippet: "生成媒体前先查询 listMediaModels 和 productionSpec(readQuality)。用户已指定的精度用 setQuality 保存；尚未选择时用 selectQuality 在聊天中选择。已有有效选择沿用，不自动采用最低档或最高档。资产用purpose=asset直接生成，一次实际预览，轻微差异不自动重生；outputName填写角色名、场景名或片段名。正式镜头优先generateShots由服务端编译并复用请求，避免模型反复抄写；单独compile时复用返回request。用户要求多格分镜时先读 cinema 的 storyboardGrid 资料，使用 purpose=storyboard 生成总览，复用 FFmpeg 拆格与 importKeyframe 登记，再逐镜生成和剪辑交付。复用实际模型和工作区参考素材。正式分镜先保存 productionSpec 并 compile，生成传 shotId/productionFingerprint；不可用独立文生图绕过同批 Look 与角色/场景参考。写实约束同时覆盖人和环境的材质、光源、曝光、接触与空间层次；整洁、精神好不等于磨皮或去龄。参考须真实发送且按用途说明，文本描述不能冒充已传图片。",
      parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
      promptGuidelines: ["批量制作将 generateShots 与 inspectProduction 并行安排，先处理可生成镜头，不等待其他镜头质检结束；旧素材只检测不重生成。集中预览后使用 reviewProductions 一次记录真实观察；已有自主审阅授权不再逐镜确认。普通镜头按分级轻量检查，异常只阻塞对应镜头，最终成片另行验收。", "生成前一次性检查编译后的实际提示词、参考用途、人物动作、镜头时间线和模型能力冲突；修正规格后再提交。相同规格的有效检查沿用，只有变更影响的部分重新检查。等待任务由工具自动完成，不另起模型轮询。生成后仍须一次真实结果验收；提示词通过不能证明画面或口型通过。单镜失败不清空画布、不删除其他结果。", "正式镜头生成传 shotId、productionFingerprint 和模型规格即可；prompt 可省略，服务端自动使用编译提示词，不手抄长文本。修改画面须先更新镜头规格再编译，不能改自由 prompt 试错。相同镜头或角色资产请求默认复用已有任务和素材；只改outputName不会重生成。失败时停止重复调用并核查原因；仅明确授权重做或新增候选时使用新的 regenerationId，同一次重做始终复用该 UUID。"],
      // ACT: 图片和视频交给持久队列限流；音频仍走直连，保留串行。
      executionMode: operation.mediaType === "audio" ? "sequential" : "parallel",
      async execute(_id, params, signal, onUpdate) {
        signal?.throwIfAborted();
        const result = await media[operation.name](operation.parameters.parse(params), signal, progress => onUpdate?.({ content: [{ type: "text", text: JSON.stringify({ progress }) }], details: {} }));
        const text = result.map(asset => {
          const url = asset.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
          const preview = asset.mediaType === "image" ? `![生成图片](<${url}>)` : `[${asset.mediaType === "audio" ? "播放生成音频" : "查看生成视频"}](<${url}>)`;
          return `${preview}\n工作区文件：${asset.path}${asset.duration === undefined ? "" : `\n实际时长：${asset.duration} 秒`}${asset.timingWarning ? `\n${asset.timingWarning}` : ""}${asset.mediaType === "audio" ? "\n这是独立音频；尚未与视频排轨，也未完成可见口型同步。" : ""}`;
        }).join("\n\n");
        return { content: [{ type: "text", text }], details: result };
      },
    }))];
  },
};

export default plugin;
