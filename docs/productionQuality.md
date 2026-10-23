# 广告、MV、剧情的制作质量链路

目标是可信的真人材质和表演、稳定的资产与空间、可读的受力过程、连贯的剪辑和声音。分辨率只是交付规格，不能证明这些目标达成。

## 三类作品共用的实现

- 正式镜头使用已采用的资产。角色、服装、场景、产品、车辆的参考图须真正送入对应模型输入；容量或参考能力不足会阻断，不降级为文字后继续宣称一致。视频可继承已经检查的本镜主帧。
- 沿用世界、影调、资产不变量、镜头摄影和五类真实感字段。真人妆造、皮肤纹理、材质高光、空间光源及表演须写成可观察条件；不把写实标准强加给明确选择的动画媒介。
- `shot.interactions` 可描述关键接触事件：`assetIds/start/contactAt/end/approach/contact/force/support/release/endState`。参与者须属于本镜出镜资产，事件在生成时长内。动作改变时同次复核该字段；编译进入视频指令，审片追加接触窗口采样。复杂动作仍须完整播放，有限抽帧不能证明每帧正确。
- 剧情/广告的 `camera.design.timeline` 与 MV 的 `musicVideo.timeline` 共用动作与接触检查，不再漏读剧情时间线。动作戏的 `combat.beats.timelineIndex` 绑定唯一执行节拍；缺少有效绑定、镜头模式、起止状态、空间保持项、机位或世界光源时，编译列出缺项，正式生成由现有准备门禁拦下。旧草稿保留，由助手补齐，不让用户填写技术表单。
- `qualityReviewPlan.motionPlan.checkpoints` 按时间线、接触和攻防生成当前检查项。工具、聊天代理审阅、面板与后端统一接收 `motionReview:[{id,verdict:pass|revise,note}]`；完整播放后记录实际时间点与证据，缺项、重复/无关项、动作未通过或素材实际时长不足不能正式采用。仅抽帧可记录问题和工作版，不能冒充完整动态通过。旧的概括检查不能替代新增动作检查；素材不重生成，补看并记录即可。
- 每个视频候选都须完整播放，记录 surface、imaging、world、motion、cinematic 检查。旧的仅抽帧检查不能用于正式交付。草稿可继续用于讨论。
- `agentReview` 在已有自主审阅授权下记录实际观察。完整检查通过并提供 `observedStateDelta` 后调用既有正式采用流程，实际末态传递给后镜；未提供时只进入工作版。无状态变化明确传 `{}`，不能照抄计划当观察。镜头规格、歌曲或继承状态改变会使相关检查过期。
- 显式 `continuityFromShotId` 的生成依赖在编译层核验：前镜须有已采用视频、实际末态及当前有效检查；缺失时仍可预览方案，不能正式生成后镜。意象蒙太奇及无此依赖的独立镜头仍可并行，不把所有镜头串行化。
- 所有类型的定稿均要求当前序列的正式镜头视频和有效检查，不允许用自由素材或未解决的严重连续性问题绕过。明确的静态落版可用本镜已检查的主帧作为 media 图片片段；须关联镜头，且不能承载对白、演唱或视频技法，不能将其冒充运动画面。

## 类型差异

| 类型 | 导演设计 | 成片核验 |
| --- | --- | --- |
| 商业广告 | 复用 adDirection、真实参考分析、产品权威参考和先行样镜定标；产品参与因果，精确品牌文字使用获批后期素材 | 保留 inspectAdFilm 的实际抽帧审片、产品识别、情绪表达与品牌记忆检查 |
| MV | musicVideo 将乐句、段落、动作峰值、演唱和视觉母题对应到实际原曲；不机械按拍切镜 | 增加 musicAlignment、musicProgression；核对原曲同步与主副歌视觉发展 |
| 剧情/短剧/中剧 | 复用故事采用版本、分集序列、角色知情与状态账本、逐句对白规划和跨集接续 | 核对事件因果、表演、完整对白、说话人、画内口型与跨镜连续性 |

## 原曲实际进入剪辑

先 `importAudio`，将真实媒体 ID 写入 `musicVideo.sourceMediaId`，并填写 `sourceStart`。没有媒体或实测时长、越过歌曲末尾会阻止正式生成或交付。草稿可以先规划而不绑定歌曲。

自动排轨把每段视频的生成歌曲静音，在 A2 音乐轨按 `sourceStart + 画面入点` 排入同一原曲。连续镜头沿用连续源时间，不在切点回到歌曲开头；也支持手工铺一条连续主音轨。已有手工剪辑保留，定稿会检查错位、漏段、重叠和变速。修改老时间线后使用现有重新排轨/剪辑入口，不能把旧音乐当作已经自动跟随。

源音频绑定不等于生成模型收到该音频。需要模型音频参考时仍使用真实 AUDIO 绑定并核对能力；画内演唱必须实际同步看听，`audioReview.referenceMediaId` 对应当前原曲。原曲排轨本身不能修复不匹配的嘴形。

## 最终文件的证据与局部返修

定稿导出后 `inspectFinal` 返回实际文件检测、`plan.fields` 和 `plan.cuts`。三类作品共用构图、色调、材质、动作、光线、连续性、声音、叙事、表演、对白和剪辑检查；按类型追加产品或音乐项目。

每个真实剪点记录 `cutReview:{id,seconds,verdict,note}`，观察动作阶段、视线/屏幕方向、空间与光色、声音交接。没看过就保持 unverified；失败写具体时间码、缺陷和需保留的部分，再用既有 trim/set_cut/soundBridge/set_gain 或局部重生成修复，避免重做整片。改变剪辑、素材或规格后原验收失效。

制作面板可填写实际验收；代理在用户已授权自主审阅且真实完整看听之后使用 `agentReviewFinal` 保存相同字段，记录授权和操作人。用户“满意”单独保存为喜好反馈，不自动勾选技术通过。检查表和有限抽帧不构成自动视觉质量保证。

## 参考来源与边界

用户指定的五条效果参考已转为按片型执行的要求。网页助手按当前版块自动加载 `cinema/references/referenceQuality.md`：动作剧情强调空间、完整行动链与多人反应；双人剧情强调位置、接触、视线和情绪；生活方式广告强调产品参与的行动链；感官广告强调材质、景深与意象衔接；MV 按实际原曲组织叙事与表演。既定高难动作必须保留，不能靠删成静站通过验收。

这些约束落实了设计、编译和验收责任，不构成已达到参考片画质的证明；当前没有新付费成片验证。

参考 [seedance-tvc-director](https://github.com/nutllwhy/seedance-tvc-director) 的[产品动作受力链](https://github.com/nutllwhy/seedance-tvc-director/blob/main/seedance-tvc-director/references/product-actions.md)、[镜头与声音交接](https://github.com/nutllwhy/seedance-tvc-director/blob/main/seedance-tvc-director/references/shot-handoffs-and-sound-bridges.md)、[实片质检](https://github.com/nutllwhy/seedance-tvc-director/blob/main/seedance-tvc-director/references/delivery-and-qc.md)方法，按 LITTO 现有领域模型实现，没有复制第三方技能或安装其工作流。

未采用固定镜数、强制快切或永久指定某个 Seedance 版本/时长的做法。实际模型能力取自已配置供应商。代码检查只能验证约束和流程，最终真人质感仍须用选定模型、真实参考和实际作品看听验证；本改动没有调用付费模型生成样片。
