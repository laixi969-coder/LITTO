# ai-shortfilm-prompts 对照研究

2026-11-06。目标：借鉴故事讲述、镜头语言、导演调度、运镜与声音组织，服务自然、整洁、材质和空间可信的真人影像；继续沿用当前人物、原稿、参考、模型与最大生成时长优先规则。

研究仓库：[jnMetaCode/ai-shortfilm-prompts](https://github.com/jnMetaCode/ai-shortfilm-prompts)，固定版本 `a893c5b360b4dc9359121fbdcdf6a372897401e1`。阅读 README、方法论、FAQ、失败案例、中英文 Skill、项目规划表、运镜库、类型片方法，以及亲情、萌宠、短剧、预告片、MV、产品、食物、旅行、时尚模板；核对 evals 的说明、用例和评审代码。没有运行外部技能、脚本或付费评测，没有把原始作品提示词搬入产品。研究判断如下；按用户授权实施与复核的结果见末节。

## 值得吸收的内容与现有入口

| 层面 | 有价值的方法 | MILIMILI 的应用与边界 |
| --- | --- | --- |
| 故事讲述 | 亲情模板通过反复出现的物件、空间和动作呈现时间与关系变化，省去部分解释性台词 | 复用 story 的场次因果、信息安排和资产状态。物件的意义可以变化，表面不必变脏变旧；不把离别、衰老、死亡或七镜结构套到所有故事。 |
| 戏剧推进 | 短剧模板用行动切入冲突，以新信息引出反应和悬念 | 场次 goal/obstacle/change 与 creativeBrief.intent 保存本次要推进的内容。钩子须来自原稿事实；不强迫两秒拍桌、每段反转、每句切镜或每段以悬念收尾。 |
| 镜头语言 | 遮挡、前中后景、过肩、物件特写、焦点变化可以决定观众何时看见信息 | 写入 camera.design.purpose/start/end、focus、blocking 与 visualPayoff。先定义观看对象和信息顺序，再选技法；不以三分法、浅景深或器材名称代替明确构图。 |
| 导演调度 | 人物行动、对方反应与镜头观看位置共同组织一场戏 | 复用 performance、subjectPath、blocking、interactions；对照实际身体任务、距离和受光。摄影机移动与人物移动分别设计，不能把人物戏缩成贴脸缓推。 |
| 运镜选择 | 按技法和观看效果检索，可用于跟随行动、揭示未知、保留观察距离或改变空间尺度 | 当前已有 searchTechniques 及约300项技法资料，不再导入另一份50项库。复用 techniques 的 purpose/execution 与现有摄影字段；固定机位保持有效，不按题材机械选焦段、滤镜或手持。 |
| 声音与剪辑 | 画外声可先建立未知信息；声画事件对齐、声音跨切点延续，可使空间和行动更可信 | 复用现有对白方案、soundCues、previewCut、soundBridge 和实际切点审阅。声音必须属于既定人物/物件和事件；音乐选择沿用用户方向，提示词不能证明精确同步。 |
| 材质和环境 | 食物、产品、服装与旅行案例把抽象质感拆成具体材料响应、接触过程、空间细节和感官线索 | 沿用 World/Look、资产材质、lighting 与 realism。按真实动作写布料垂坠、金属反射、接触影与环境声；不为“生活感”自动加蒸汽、灰尘、路人、乱发或破损。 |
| 段落组织 | 按节拍区分建立、行动、变化和结果，比堆形容词更可执行 | 继续使用唯一 camera.design.timeline 或 musicVideo.timeline，按实际模型优先组织15秒/30秒生成段。动作与反应不等分秒数，不因模板建议每镜5–10秒而拆短；内部切镜仍受真实模式能力约束。 |

主要来源：[亲情动作与物件](https://github.com/jnMetaCode/ai-shortfilm-prompts/blob/a893c5b360b4dc9359121fbdcdf6a372897401e1/templates/family-recipe-farewell.zh.md)、[短剧](https://github.com/jnMetaCode/ai-shortfilm-prompts/blob/a893c5b360b4dc9359121fbdcdf6a372897401e1/templates/micro-drama.zh.md)、[运镜库](https://github.com/jnMetaCode/ai-shortfilm-prompts/blob/a893c5b360b4dc9359121fbdcdf6a372897401e1/templates/camera-move-library.zh.md)、[多镜叙事](https://github.com/jnMetaCode/ai-shortfilm-prompts/blob/a893c5b360b4dc9359121fbdcdf6a372897401e1/templates/multi-shot-narrative.zh.md)、[食物声画](https://github.com/jnMetaCode/ai-shortfilm-prompts/blob/a893c5b360b4dc9359121fbdcdf6a372897401e1/templates/food-asmr.zh.md)。

## 不能成为默认值的规则

- Skill 的通用规则要求至少两处瑕疵，标准负面段还排斥完全干净的表面；与本项目的维护状态要求直接冲突。可学习材质差异与物理响应，不能新增伤斑、油污、掉漆、灰尘或衣服破损。
- 全局要求摄影机/镜头品牌、手持呼吸浮动、无配乐、克制结尾和最多15秒，均属于特定案例或模板偏好。相机型号不等于真实光学执行；收尾需服从原稿与剪接，片中间不必每段完整落定。
- project-planner 要求全片固定 Portrait 编号、影调逐字一致，并给出同侧出入画示例；其它模板又给出相反边缘的例子。稳定的是资产身份与世界关系，实际请求图号须随发送顺序重映射；屏幕方向须结合机位、路径与动作阶段判断。日夜、天气或光源事件变化时允许有依据的光色变化。
- 动作戏不用参考图、文字写100%一致、先做首镜和末镜、每镜单独5–10秒及多次抽卡，都不能覆盖当前身份参考、真实接戏依赖、最大时长优先和预算。动作内容可以自由生成时才讨论无参考探索；本项目指定角色必须保留实际身份输入。
- 模板负面段中的 soft focus、干净表面、固定机位、硬切等词不能一律排斥。合理虚焦、整洁场景、静机位和正常硬切均可服务当前作品。模型参数与负面字段能力继续读取已配置的真实供应商和适配器，不复制仓库型号表作为能力声明。

依据：[实际 Skill 硬规则](https://github.com/jnMetaCode/ai-shortfilm-prompts/blob/a893c5b360b4dc9359121fbdcdf6a372897401e1/skills/shortfilm-prompt/SKILL.md)、[项目规划表](https://github.com/jnMetaCode/ai-shortfilm-prompts/blob/a893c5b360b4dc9359121fbdcdf6a372897401e1/templates/project-planner.zh.md)。

## 对当前项目的具体价值

后厨谈判的既有收购书、笔、案板、停手与对视可以承担信息与关系变化。导演先判断原稿这一刻是试探、施压、拒绝还是让步，再决定展示物件、双方距离或听者反应；机位保持、跟随或移焦都须对应这个任务。这里仅说明方法，不新增或改写当前剧情、对白与动作。

最值得补强的是执行顺序与实际证据，而非再增加一套字段或五段式格式：

1. 在现有故事与摄影规格中，把本镜新增信息、人物行动造成的后果、观看重点与切镜理由对应起来；已有有效设计直接复用。
2. 授权批次中的代表段优先覆盖真正的质量风险，例如人物转向后的受光、衣料运动、人物与场景共享光源；不只检查静止正脸。检查合格后再扩展同类段落，不额外增加未授权试拍次数。
3. 对同一个实际片段同时看故事是否成立、镜头是否交代信息、声画接点是否正确、材质是否达到目标。用真实样片与参考并排判断，保留成功和失败版本，不用提示词格式评分替代结果。
4. 检查后期源素材与输出规格。当前基础 Probe 只返回时长、宽高和音视频存在性，未暴露位深及色彩标记；nle-render 当前输出 yuv420p。对现有10秒样片实际 ffprobe 得到 H.264、1280×720、yuv420p、8bit；这只说明该文件规格，不能据此认定所有模型都低位深，也不能证明它是脏旧画面的成因。后续可评估在既有检查结果中保留必要色彩信息、减少无意义反复编码，不把8bit转存10bit称为恢复真实细节。

现有入口：[故事方法](../packages/skills/story/references/storyCreation.md)、[摄影](../packages/skills/cinema/references/shotLanguage.md)、[参考与质量](../packages/skills/cinema/references/referenceQuality.md)、[素材探测](../cloud/src/media-tools.ts)、[剪辑输出](../cloud/src/domain/nle-render.ts)。

## 证据与使用范围

仓库的 [evals](https://github.com/jnMetaCode/ai-shortfilm-prompts/blob/a893c5b360b4dc9359121fbdcdf6a372897401e1/evals/run_evals.py) 是生成提示词后再用语言模型按文本清单评分，不调用视频模型或审看产物；清单还把相机品牌、呼吸浮动、瑕疵、15秒上限等作为评分条件。其格式/措辞回归方法可参考，得分不能证明人物、场景、动态或质感达到用户参考。实际评测未在本机运行，没有安装新框架或新增测试文件。

作者方法/模板与 Mx-Shell 原始作品提示词的许可范围不同，见 [NOTICE](https://github.com/jnMetaCode/ai-shortfilm-prompts/blob/a893c5b360b4dc9359121fbdcdf6a372897401e1/NOTICE.zh)。本记录与新增实现为独立归纳，没有复制完整模板、原始提示词或第三方脚本进入 MILIMILI。

## 授权实施与复核（2026-11-06）

用户要求“按你的建议调整，然后再复核效果如何”。此次直接修改现有链路，没有新增工作流、字段表、依赖或测试文件。

- 故事：story 1.18.0 与独立写作器共同按题材组织场面、行动后果、观众与角色的信息顺序、既有物件/动作的意义变化。移除写作器强制五场、强敌、绝境代价与决绝结尾的泛化，保留对抗题材的有力反制和高潮兑现。发现第二阶段原来未收到 writingMethod，已让两阶段接收同一实际读取的方法。没有改写或替换当前采用剧本。
- 摄影：现有 intent/visualPayoff、purpose、start/end、主体/相机路径、唯一时间线和 cut/continuity.reason 分别承担信息、证据、观看位置、触发与剪点。首帧不能抢先完成揭示；固定机位、正常硬切、景深和静默按作品使用，不引入固定手持、品牌、瑕疵或5–10秒规则。
- 编译：修复 camera.design.purpose 保存后未进入最终生成提示词的断点。图片、普通视频及既有模型专用重排均继承 creativeIntent；没有 creativeBrief 的旧规格也能保留已有 purpose。跨镜切点与声音桥继续留给剪辑，不能让模型额外生成转场。
- 复核：现有 cameraPath 检查点同时对照摄影目的、视觉回报及实际信息出现时刻；视觉检查增加起态、揭示与遮挡判断，并保留抽帧不足的未知。更新相关检查版本，使旧通过记录不能冒充新标准复核；原媒体与采用选择保留。
- 素材：Probe、现有本地素材检测与最终文件检测保留 video 编码、pixelFormat、bitsPerRawSample、色彩范围/空间/传递/原色标记。未知保持 null；升级检测缓存版本以补齐旧记录。没有改变编码、分辨率、滤镜、调色或素材。

验证结果：

1. server、cloud、mediaGeneration 类型检查通过；server、mediaGeneration 构建通过；git diff --check 通过。
2. 在 SQLite 临时快照执行当前后厨镜头的真实 compileShot，使用已配置的星算云 r/seedance-2.0 与当前图片型号元数据：图片和视频提示词包含已保存 purpose，warnings 均为空；图片实际输入为 IDENTITY×2、ENVIRONMENT、LOOK×2。未调用生成模型。另验证仅有 purpose 的兼容规格仍带起帧约束，修改方向后旧检查指纹改变，静帧不获得动态通过。
3. 实际 loadProductionSkillContext、loadStoryWritingContext、buildSystemPrompt 与 loadTool 均读取新方法/工具，最大时长优先的 durationReason 仍保留。story/cinema 同步无冲突；build/data 的 mediaGeneration 工具哈希一致：`27840419650659e4b0b16a0ed21f250847d57f8ff6581ad963def4ecf1e8712f`。
4. 确认 QUEUED/RUNNING 任务为0后重启 launchd 后台；服务为 running，health HTTP200。此轮未修改前端组件，无需靠浏览器组件缓存更新生效；下一次制作请求读取新后台和已同步方法。
5. 用 probeFile 实读已有10秒样片，得到10.041667秒、1280×720、H.264/yuv420p、raw sample 8bit、无音轨，色彩标记缺失为null；不可读文件返回null。没有根据缺标记猜测BT.709，也没有将8bit视为脏旧原因。

效果判断与限制：实际查看旧样片等距抽帧，并与两张真实参考帧对照。可见人物从门口走近、停手与对视的状态变化，衣服和场景没有明显破败；但整体暖光占比高、暗部较重，人物与环境的光色关系仍距离目标参考有差距。参考本身包括暖室内与冷阴天，目标是对应光源下的肤色、材质与层次，不能把后厨改成参考地点或一律提白。抽帧不能证明完整运镜、动作因果、节奏、身份稳定或声画同步，旧片也不能证明本轮改动后的新效果。此次没有重生图片/视频、调用付费视觉审片或文字写作模型；已确认方法和请求链路生效，新输出是否达到目标仍须用新产物判断。

## 导演方法与禁脏噪要求补充（2026-11-06）

用户明确要求参考诺兰等导演的方法，禁止脏旧场景服化道、噪点、磨皮和塑料感。方法依据为诺兰关于视点、摄影/美术协作与互动实景光的 [ASC 访谈](https://theasc.com/article/christopher-nolan-on-oppenheimer/)、关于视觉叙事的 [BAFTA 访谈](https://www.bafta.org/media-centre/press-releases/a-life-in-pictures-christopher-nolan/)，以及摄影师狄金斯关于人物、布景与照明的 [ASC 访谈](https://theasc.com/article/deakins-blade-runner-2049/)。下述内容是针对 MILIMILI 的应用归纳，不代表这些导演使用或认可本系统，也不继承作品里的废墟、雾霾、颗粒或固定调色。

- 在现有摄影方法中补入：观众视点与信息顺序；门、桌、通道、演员任务与机位共同排练；人物和环境的光照随同一事件变化；动作改变画面；声画及剪点共同验证叙事。继续使用现有 World、Look、creativeBrief、blocking、lighting 和 camera.design，不新增工作流与字段。
- 移除真实感资料中“暗部可见细噪”和手机风格“每镜选择 2–3 项瑕疵”的默认要求；变形镜头也不隐含胶片颗粒。材质来自与景别相称的细节、反射和光照，不靠瑕疵配额或统一柔滑。
- 共享生图/视频基准明确默认不添加可见噪点、颗粒、彩噪、压缩块与随机纹理闪烁，同时保留自然纹理、年龄、肤色差异与合理阴影。用户最新明确限制优先于旧草案，不以模型自行添加的“剧情需要”制造例外。
- 视觉审查明确将无依据脏旧归入 creativeMismatch、违背当前影调的噪点归入 imaging_failure、蜡塑和磨皮归入 plastic_surface；都是现有高严重度缺陷。自然毛孔/织纹不当作噪点，抽帧不证明时域稳定，看不到保持未验证。允许有动机的画外光源，不要求灯具必须入画。视觉检测缓存升级为 visualTarget7。
- 已依照本轮聊天明确指令，通过现有制作决策函数保存当前后厨项目的维护状态、无噪点 grain 与自然肤色 skinTone；记录 agent:codex 执行来源和用户原文，不伪称新增界面确认或真实素材审看。9 个镜头的规格指纹随之变化；原媒体、采用选择、角色身份、夜景和故事不变。

验证：server、cloud、mediaGeneration 类型检查及 server/mediaGeneration 构建通过；SQLite 临时快照中，当前图片与星算云 r/seedance-2.0 的实际 compileShot 均包含无噪、无磨皮与禁污损要求、已保存摄影目的，warnings 为空。图片输入仍为 IDENTITY×2、ENVIRONMENT、LOOK×2；视频为已有首帧输入。临时快照使用明确标注的验证输入核对三类缺陷为 high，并被 requireReviewed 以 qc_blocked 拒绝采用；这不是对实际素材的缺陷判断。临时目录已清理，无新增测试文件或付费模型调用。

cinema 2.5.1、continuity 1.2.1、workflow 2.17.1 已无冲突同步到 data/skills，实际 loadProductionSkillContext 读取到新的导演与成像方法；工具加载正常。确认无 QUEUED/RUNNING 任务后重启后台，health 为 HTTP200。新标准与执行链路已生效，但本轮未生成新图片或视频，不将编译通过等同于画面已达到参考质感；新产物仍须在原尺寸及完整播放下判断。


## 15秒样段实测修正（2026-11-06）

用户授权使用已上传的沈叙、林映四视图重生后厨关键帧，并用星算云 r/seedance-2.0 生成15秒片段、对照两个视频复核。当前图片编辑配置实际路由到 Atlas Cloud 的 google/nano-banana-2.1/edit，保留 IDENTITY×2、ENVIRONMENT、LOOK×2。生成四张关键帧候选，三张未采用并保留实际缺陷记录，最后一张用于视频。

实测发现并修正现有编译器的两个问题：Look 的 shadowBehavior、bloom、texture、sharpnessPhilosophy 原来保存后未完整进入提示词，现已补齐；有明确 camera.design.start 的图片任务仍接收未来叙事结果，模型抢先画出抬眼/对视，现只传当前起态，完整意图与视觉回报留给视频。ENVIRONMENT 参考职责进一步限定为布局和材料，可移动道具位置与光色服从当前镜头。没有更换人物资产、删减故事或强行把夜景改成白昼。

当前样段由10秒改为15秒，并同步行动、表演、连续性与时间线；修正抹布在起帧提前落到案板的矛盾。现场光调整为4200K工作区主光、前厅暖光局部存在。最新关键帧实际看图为男子在门口迈步、女子低头持刀与左手持布；整体仍偏暖，不宣称已经达到参考级质感。

cloud 类型检查、server 构建与 git diff --check 通过；实际入队提示词已核对新 Look 字段、4200K、左手持布与起态隔离。视频任务 01M6RZR1XJ5TR6FNBMNRMPK9XD 请求15秒1080P，星算云远程任务 task_ecddbe042582c92104cf5c93。最终实片复核另见 data/directorSample20261106/sampleReview.md（生成与审阅完成后保存）。

参考视频的自动审阅报告存在 audioRead=false 却评价同步、推断实拍来源等不可靠表述，这些判断不作为通过证据。画面观察、模型复核及未验证事项须分别记录。
