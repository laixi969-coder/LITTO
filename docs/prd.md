# LITTO｜里头 PRD V3.1

**版本：V3.1｜Coding Agent 唯一真源｜2026-10｜V3.1 新增：创意入口、剧本拆解、导演 Agent 默认托管镜头规格**

## 0. GitHub 底座

主仓库：https://github.com/basketikun/infinite-canvas\
参考：https://github.com/BeatAPI/BeatDesign\
参考：https://github.com/saihhold-zhao/polox_ai

先 Fork 主仓库并锁定 commit SHA，完整跑通、建立 baseline tests
后再改造。优先复用无限画布、节点/Edge、图像/视频/音频生成、Canvas
Agent、MCP、Plugin SDK、自定义
API、导入导出、Undo/Redo。禁止推倒重写画布。新增领域对象必须有
schemaVersion；核心业务语义不得只存在 UI node metadata。

# 1. 产品定位

LITTO
是一个面向新一代影像创作的智能创作空间：把创意、Reference、角色/场景/服装/道具/产品资产、分镜、关键帧、视频
Take、音乐、状态、连续性和质检放进同一个持续存在的创作世界，从构想到成片。

核心价值：**让几十个 AI 镜头真正属于同一部影片。**

主链路：`创意入口 → 剧本/Treatment → 拆解 → World 与 Asset → 导演 Agent 出镜头规格 → Keyframe → Take → QC → 成片`。普通用户只表达创意与意图，专业镜头参数由导演 Agent 托管，专业用户可逐项覆盖。

不是单纯 Prompt、生图、视频聚合、ComfyUI、Storyboard 或 Premiere
替代品。

# 2. 三层架构

**Creative Intelligence Layer**：World、Look、Asset、Reference
Routing、Storyboard、Shot、Cinematography、Motion、Continuity、QC、Director
Agent、Skills。\
**Generation Infrastructure Layer**：Provider/Model/Capability
Registry、Credentials、Router、Queue、Retry、Timeout、Fallback、Storage、Cost、History。\
**SaaS Platform
Layer**：User、Workspace、Auth、Permission、Subscription、Credit、Billing、Admin、Security、Audit。

# 3. 产品原则

1.  Prompt 不是源数据；由 ShotSpec + Skill + Provider Adapter 编译。
2.  Reference 优先于文字幻想。
3.  Asset="它是谁"；State="它现在怎样"。
4.  每次生成明确 LOCK / CONTROL / ALLOW / RANDOM。
5.  Approved Asset/Hero Frame/Take 不得被 AI 静默覆盖。
6.  模型是可替换执行器，不写死在业务对象。
7.  无限画布是生产界面，Domain Model 才是产品地基。

# 4. 用户 / Workspace / 登录

数据层级：`User → Workspace → Project`。V1 自动建立 Personal
Workspace，未来扩 Team/Enterprise 不重构数据库。

P0：邮箱验证码、Session、登出、账号注销/数据删除。P2：Google/Apple/GitHub
OAuth、企业 SSO。

预定义 OWNER / ADMIN / EDITOR / VIEWER；V1 个人用户主要使用
OWNER。所有服务端查询必须校验
workspaceId。Project、Asset、Reference、Media、Shot、Take、GenerationJob、Credential、Ledger
等必须有 workspaceId，不得靠前端隐藏实现租户隔离。

# 4A. Creative Entry｜创意入口（V3.1 新增，产品第一入口）

新建 Project 的第一步是创意入口，不是空白 World。入口固定存在，用户从四条通道之一进入，任一通道的终点都是同一份 **SceneList**（场次/段落表）。

| 通道 | 用户带来 | 能力 | 中间产物 |
|---|---|---|---|
| 故事 | 一句话、想法、已有故事 | Story Writer（基于 hiccai-story） | 故事核 → 大纲 → 剧本 |
| 创意（广告/品牌） | brief、产品、卖点 | Creative Writer（基于 hiccai-creative / hiccai-insight） | 洞察 → 创意概念 → 广告脚本 |
| MV | 歌曲、歌词 | §14A Music Analysis / Lyrics Intelligence / Creative Direction | Treatment → 段落与节拍表 |
| 已有素材 | 现成剧本、参考片、参考图 | 导入、诊断、改稿 | 整理为统一结构 |

规则：
1. 已有剧本的用户走第四通道，等于跳过前两步；其余通道不得跳过用户确认。
2. 每一级产物（故事核、大纲、剧本/Treatment）都必须经用户确认后才进入下一级；上游修改会把下游标记为"待更新"，不得静默覆盖。
3. 支持局部改写（如只重写第 3 场），保留版本，禁止覆盖已确认版本。
4. MV 通道的中间产物是 Treatment，不是剧本；其音乐时间轴与段落绑定沿用 §14A，不另建流水线。
5. Story Writer 必须同时输出结构化 SceneList：`sceneId, order, location, timeOfDay, characters[], props[], wardrobe[], emotionBeat, narrativeFunction, durationHint`；正文与 SceneList 来自同一次生成，不得事后解析正文猜测。
6. 面向拍摄的约束：Story Writer 须考虑角色数量、场景数量与当前模型可稳定生成的范围，不写拍不出来的戏；剧本质检用固定清单（情感锚点、欲望、困境、因果、情绪可拍摄等），不向用户展示模型自评分数。
7. 数据：`story_drafts, script_versions, creative_briefs, scene_lists`，均带 workspaceId、projectId、schemaVersion。

实现状态（V3.1）：四条通道已由技能落地，`packages/skills` 下 `story`（故事通道与已有素材整理）、`adfilm`（创意/广告，上游为 `insight` 消费者洞察）、`musicfilm`（MV）、`breakdown`（§4B），首页创作入口按通道调用。确认环节复用 `askUser`；SceneList 与拆解清单暂存画布文本节点，上述数据表为后续迁移目标。MV 通道在音频分析、歌词对齐与 Music Timeline 工具就绪前，只交付到段落场次表与镜头规划，结构与节拍须标注为推断。

# 4B. Script Breakdown｜剧本拆解（V3.1 新增）

拆解是创意入口与生产层之间的枢纽：把 SceneList 变成可确认的资产清单与世界设定草案。

产出 `breakdown_items`：Character、Wardrobe、Environment、Prop/Product、Vehicle、Creature，每项记录出现的 sceneId 列表、首次出现、必须保持不变的特征（invariants 候选）、以及时间/情绪依赖。同时产出 World 草案（时代、地点逻辑、气候、材质、现实约束）与 Look 草案。

规则：
1. 拆解结果以"待确认清单"呈现，用户逐项确认、合并、拆分或删除；确认后写入 Asset Registry（§6）与 World/Look（§5），并保留回链到场次。
2. 资产可反查所在场次，供 Continuity（§10）使用。
3. 剧本改动后重新拆解只产生差异（新增/变更/移除），不覆盖已 Approved 资产。
4. 拆解不产生镜头；镜头由导演 Agent 在 §13 阶段生成。

# 5. Project / World / Look

Project 支持新建、复制、重命名、归档、软删除、恢复、永久删除；独立拥有
World、Look、Assets、References、Sequences、Shots、States、Generations、QC、Model
Policy。

World 与 Look 默认由 §4B 拆解草案推导，用户确认或修改，不再从空白表单开始。

World：Era、Location
Logic、Architecture、Culture、Weather、Time、Material、Physics、Realism、Environmental
Constraints。

Look：contrast、saturation、palette、skin tone、black level、highlight
roll-off、shadow behavior、grain、halation、bloom、lens
character、texture、sharpness philosophy、color
references。Sequence/Shot 可显式覆盖。

# 6. Asset Registry

类型：Character、Wardrobe、Environment、Prop、Product、Vehicle、Creature、Custom。

通用字段：`id, workspaceId, projectId, type, name, version, schemaVersion, references[], invariants[], allowedVariations[], forbiddenChanges[], approvalStatus, approvedVersion`

Character：脸部几何、身体比例、肤质、年龄、发际线/头发、手、多视图、中性光、表情、姿态。\
Environment：空间拓扑、门窗/朝向、家具关系、材质、Practical
Lights、时间/天气。\
Prop/Product/Vehicle：几何、真实尺寸、材质、Logo、标志细节、磨损、功能状态。\
Wardrobe：版型、面料、颜色、纹理、细节、穿着关系、允许/禁止变化。

Approved 后默认 LOCK；改变需新 variant/version。

# 7. Reference Routing / Freedom Map

Reference 来自图片、视频、音频、文本、已有节点或生成结果。用途由 Binding
决定：

`IDENTITY | GEOMETRY | WARDROBE | ENVIRONMENT | COMPOSITION | LIGHTING | LOOK | PERFORMANCE | CAMERA_MOTION | START_FRAME | END_FRAME | AUDIO`

ReferenceBinding 保存
`referenceId, role, weight, lockLevel, crop/segment, notes, providerCompatibility`。拖到
Shot 时选择"参考什么"；AI 可建议。模型不支持某 role 时必须显示降级策略。

Freedom Map： - LOCK：身份、Logo、产品几何、Approved
Wardrobe、关键空间结构 - CONTROL：构图、焦段、动作、运镜、灯光 -
ALLOW：自然褶皱、微表情、头发细微变化 -
RANDOM：尘埃、非关键背景、自然反射

目标是 Controlled Randomness。

# 8. Sequence / Scene / Shot

层级：`Project → Sequence → Scene → Shot`

ShotSpec 至少保存：
`id, sequenceId, order, narrativeFunction, assetIds, action, performance, blocking, camera, lighting, startStateId, intendedStateDelta, referenceBindings, freedomMap, constraints, status`

每镜支持 Shot Size、Camera
Position/Height/Angle、Lens、Focus、Depth、Camera
Motion/Motivation；Motivated Light、Key/Fill/Negative
Fill、Practical、Exposure；Foreground/Midground/Background；Emotion、Intensity、Eyeline、Gesture、Timing。

# 9. Storyboard / Keyframe / Take

Storyboard Director 必须理解
Establish、Reveal、Reaction、Contrast、Transition、Match、Rhythm，禁止按句号切镜。支持
Shot List、单镜修改、批量关键帧、9/16/25/32 宫格等视图。

Shot 可生成多个 Keyframe Variant；用户 Promote 为 Hero Frame，默认
LOCK。Hero Frame 进入 I2V，生成多个 Take；用户 Select Approved
Take。所有版本保留，禁止覆盖。

# 10. State / Continuity

每镜维护
CharacterState、WardrobeState、PropState、EnvironmentState、LightingState、MotionState、EmotionalState。

核心：`PreviousState → IntendedDelta → ResultState`，下一镜继承
ResultState。

Continuity
检查：Identity、Geometry、Material、Spatial、State、Lighting、Motion、Performance、Cinematic、Color。逐步支持
180° Rule、Screen Direction、Eyeline Match、Match on Action、Shot Size
Progression、Camera Motivation、Temporal/Spatial Logic。

# 11. Realism Stack

Surface：皮肤、头发、布料、玻璃、金属、木材、水。\
Imaging：曝光、动态范围、高光滚降、暗部、焦平面、DOF、光学缺陷、传感器噪声。\
World：重力、接触、遮挡、物体恒常、比例、空间因果。\
Motion：anticipation、重心、加减速、惯性、secondary motion、布料/头发。\
Cinematic：表演、Blocking、摄影机动机、镜头职责、剪辑逻辑。

禁止把 8K / ultra realistic / cinematic / perfect 当真实性方案。

# 12. 深度 Skills

**Visual Director**：Reference Deconstruction、Art
Direction、LookDev、视觉母题、Palette、Material Language。\
**Asset Director**：资产建立、多视图、Invariant/Variation、Identity
Lock。\
**Cinematographer**：Blocking、Composition、Lens、Camera、Exposure、Lighting、Optical
Behavior。\
**Story Writer**：故事核、大纲、剧本、局部改写，输出正文与 SceneList（§4A）。\
**Creative Writer**：洞察、创意概念、广告脚本（§4A）。\
**Script Breakdown**：SceneList → 资产清单、World/Look 草案（§4B）。\
**Storyboard Director**：SceneList + 已确认资产 → Sequence/Shot、Shot
Function、Axis、Eyeline、Match、Rhythm。\
**Motion Director**：Biomechanics、Center of
Mass、Contact、Inertia、Secondary Motion、Camera Inertia、Performance
Timing。\
**Continuity Supervisor**：全部跨镜连续性。\
**Failure Diagnostician**：失败原因与最低成本修复。

Skill 输出结构化 spec，不是只输出长 Prompt。

# 13. Director Agent / UX

流程：`理解目标 → World/Approved Assets → Sequence/Shot → Skills → Reference Plan → Freedom Map → Router → Generate → QC → Continuity → Repair`

**镜头规格默认由导演 Agent 托管。** Simple Mode 下用户只表达意图（如"这一镜要压迫感、人物显得渺小"），Agent 编译为完整 ShotSpec（Shot Size、Lens、Camera、Lighting、Blocking 等）；Director Mode 在 Inspector 中折叠展示全部专业字段，标注"AI 填写"，用户可逐项覆盖或锁定。覆盖/锁定过的字段不得被 Agent 静默改写。

提供 Simple Mode 与 Director Mode。涉及 LOCK、删除 Approved、改变核心
Shot 意图时必须确认。

UI： - 左：Project / Assets / Sequences / References -
中：无限画布、领域节点、语义 Edge、框选批处理 - 右：结构化 Inspector -
底：Shot Strip（Hero Frame / Approved Take / QC） - 顶：Director Command

领域节点：World、Look、Character、Wardrobe、Environment、Prop/Product、Reference、Sequence、Shot、Keyframe、Take、QC。

# 14. Provider / Model / API 中心

不得把模型名写死。

Provider
Registry：`providerId, name, baseUrl, authType, platformCredential, status, priority, concurrency, timeout, retryPolicy`

Model
Registry：`modelId, providerId, externalModelId, type, capabilities, limits, resolutions, aspectRatios, durations, price, status`

Capability
Registry：text2image、imageEdit、identityReference、multiReference、compositionReference、text2video、image2video、startEndFrame、motionReference、cameraControl、nativeAudio、max
inputs、duration、resolution、async/polling/callback、costClass、latencyClass。

继承：`System Default → Workspace Default → Project Default → Shot Override`

Router 根据 ShotSpec + ReferenceBindings + Cost/Latency/Quality Policy
选模型；用户可覆盖。

# 14A. Music Film｜音乐影像（V3.0 新增核心模块）

Music Film 是一级生产模式，不是"上传 MP3
后随机生成视频"的附加按钮。目标是让完整歌曲、纯音乐或歌词作品进入 LITTO
后，形成可导演、可修改、可保持资产一致性的完整音乐影像工程。

## 输入

支持 MP3/WAV/M4A；LRC/SRT/TXT/DOCX/PDF
歌词；只有音乐；无时间码歌词；已有时间码歌词；用户补充
Reference、角色/产品/场景资产。

## Music Analysis

建立可编辑 `MusicAnalysis`：duration、BPM/tempo
changes、beats、downbeats、bars、phrases、intro/verse/pre-chorus/chorus/bridge/drop/breakdown/outro、vocal
entry/exit、instrument changes、energy curve、emotion
curve、tension/release、climax/drop、silence/breath、recommended edit
points。结果必须进入时间轴，不只是文字总结。

## Lyrics Alignment

`Audio + Lyrics → Vocal/Lyric Alignment → Timed Lyrics`。保存 line
start/end、可用时的 word timing、confidence、unmatched
lines、instrumental regions。低置信度必须标记。

## Lyrics Intelligence

分析 literal meaning、subtext、metaphor、imagery、POV、character
relationship、emotional progression、recurring symbols、visual
motifs、narrative possibilities、non-literal
opportunities。禁止机械"唱到月亮就生成月亮"。

## Creative Direction

出分镜前默认提供 2--4 套明显不同方案：Narrative Film、Mood
Film、Hybrid、Experimental。每套给 concept、visual
thesis、world/look、character/location strategy、motif、camera
language、color/material、editing rhythm、与歌词/音乐关系、sample key
moments。批准后成为 Music Visual World 约束。

## Music Timeline

新增 MusicTimeline，与 Sequence/Shot 双向关联。轨道：Source
Audio、Beat/Bar、Section、Energy、Emotion、Lyrics、Vocal、Marker、Shot、Take、Transition。Shot
可绑定 beat/bar/lyric/section/energy/climax。禁止默认固定 5 秒切镜。

## Music-driven Storyboard

增加 Phrase-aware planning、Chorus visual identity、Repetition with
variation、Drop reveal、Build-up、Instrumental breathing space、Lyric
contrast、Visual refrain、Motif recurrence。副歌重复应"母题保持 +
镜头/表演/尺度升级"，不能机械复制。

## Beat / Lyrics / Motion Sync

Shot
同步策略：`BEAT_SYNC | BAR_SYNC | PHRASE_SYNC | LYRIC_SYNC | ENERGY_SYNC | FREE`。Motion
Director 将动作、Camera
acceleration/deceleration、Cut、Reveal、Impact、Transition、Secondary
Motion 与音乐事件建立关系；支持
on-beat、off-beat、anticipation、delay、sustain，禁止所有动作机械卡点。

## 完整作品

目标支持 3--5 分钟完整 Music Film/MV，但必须拆为
`Music Project → Sections → Sequences → Shots → Hero Frames → Takes → Assembly`，不得依赖单模型一次生成整片。复用
Asset Registry、Reference Routing、Freedom
Map、Realism、Cinematographer、Motion、Continuity、QC。

## 专属 Skills

**Music Analyst**：结构、节拍、段落、能量、情绪、高潮、编辑点。 **Lyrics
Director**：语义、隐喻、叙事、视觉母题。 **Music Film Director**：把
MusicAnalysis + Lyrics + World/Assets 转成 Creative
Direction、Sequence、Shot。 **Rhythm
Editor**：镜头长度、Cut、重复/变化、高潮释放。

## 数据模型

新增：`music_projects, music_sources, music_analyses, music_sections, music_beats, music_phrases, lyric_documents, lyric_lines, lyric_words, music_markers, creative_directions, music_timeline_tracks, music_timeline_items, shot_music_bindings`。

`ShotMusicBinding` 至少保存
shotId、startMs、endMs、syncMode、lyricLineIds、sectionId、beatIds、intent。

## UI

Project 创建入口增加 Film/Video Project 与 Music Film Project。Music
Film Workspace 增加底部 Music Timeline，但 V3 不做完整 DAW。画布可放
Audio Source、Lyrics、Music Analysis、Creative Direction、Assets、Music
Section、Shot、Keyframe、Take。点击歌词/Section/时间区间可定位关联
Shots。

## Provider Capability

增加
audioAnalysis、beatDetection、sectionDetection、vocalSeparation、lyricAlignment、speechRecognition、musicUnderstanding、audioConditionedVideo、nativeAudioVideo、durationLimit、audioReferenceLimit。全部通过
Adapter 接入。

## Music Film QC

增加 lyric alignment accuracy、section coverage、beat/phrase edit
quality、emotional progression、visual repetition、chorus
differentiation、music-motion relationship、narrative coherence、asset
continuity、audiovisual sync。允许故意不同步，不把卡点率当唯一指标。

## V3 验收

1.  上传完整 MP3/WAV，可选歌词文档；
2.  自动识别结构、Beat、Phrase、能量/情绪；
3.  无时间码歌词自动对齐并显示置信度；
4.  生成至少 3 套明显不同 Creative Direction；
5.  批准后生成完整 Shot Plan；
6.  Shot 与 Music Timeline 区间绑定；
7.  支持故事/情绪/混合/实验策略；
8.  生成 Hero Frames 与 Takes；
9.  继续复用角色/场景/服装/道具一致性；
10. 镜头长度不固定 5 秒；
11. 按 Section/Beat/Lyric/Emotion 检查视听关系；
12. Approved Takes 可组装覆盖完整歌曲并导出。

# 15. API Key / BYOK

支持 Platform Key、User/Workspace BYOK、Project Override（仅引用
credential，不复制明文）。

Key 必须服务端加密；UI 仅掩码；不得写日志、Prompt、前端
localStorage、Generation metadata。支持 Test
Connection、Enable/Disable、Last Used、Last Error。

优先级：`Project Credential → Workspace/User BYOK → Platform Credential`

# 16. Job Queue / Generation History

图片/视频/长任务全部异步 Job 化。

状态：`QUEUED → RUNNING → SUCCEEDED / FAILED / CANCELLED / TIMEOUT`

支持并发、Provider
限流、Timeout、Retry、Cancel、Polling、Callback/Webhook、幂等、失败恢复、Fallback。刷新/退出后任务不丢。

GenerationJob 保存
workspace/project/target/provider/model/version、compiledPrompt、parameters、inputRefs、seed、status、estimatedCost、actualCost、userCharge、duration、outputs、error、parentJobId。

# 17. Storage / Media

建立 Storage Adapter，支持 S3/MinIO 等。Media 保存
workspace/project、mime、size、hash、duration、width/height、source、storageKey、thumbnail、deletedAt。大文件不进数据库。支持上传进度、软删除、永久清理、生命周期、用户存储配额；P2
加分片上传、代理视频。

# 18. Cost / Credits / Billing

生成前尽量显示预计积分/成本；完成后记录实际成本。

不可变
Ledger：`CREDIT_GRANT / PURCHASE / GENERATION_HOLD / GENERATION_CHARGE / REFUND / ADMIN_ADJUSTMENT`

失败任务释放 Hold/退款。分离 Provider Actual Cost、Platform Internal
Cost、User Credit Charge。V1 可免费，但账本与成本结构从第一天存在。预留
Free/Monthly/Quarterly/Annual/Custom 套餐。

# 19. 超级管理员

Dashboard：用户、活跃、生成量、图片/视频量、Provider
成本、失败率、Queue、Storage。\
Users：搜索、状态、Workspace、积分、套餐、用量、生成历史、禁用/恢复。\
Providers：Base URL、Credential、连接测试、状态、优先级、并发、超时。\
Models：同步/新增、能力、上下架、价格、优先级、Fallback。\
Jobs：排队/运行/失败/超时、详情、取消、重试。\
Credits/Billing：流水、调账、赠送、退款。\
Storage：用量、异常文件、清理。\
System：注册开关、默认额度、并发、上传限制、默认模型、公告、维护模式。\
Audit：管理员敏感操作必须记录。

# 20. QC / Failure Diagnosis

QC 必须输出原因 + Repair Action，不只打分。

局部手/脸 → Inpaint/local edit；身份漂移 → identity ref/reference
replace；构图 → composition ref/regenerate；动作/物理 → motion
regenerate/reference；场景结构 → geometry/environment lock；轻微色差 →
look normalization/post；能力不匹配 → switch provider/model。

High Severity Continuity Issue 默认阻止 Approve Take；可
override，但记录原因。

# 21. 安全 / 审计

密钥加密、服务端 Workspace Scope、Signed URL、Rate
Limit、CSRF/XSS/输入校验、上传 MIME/尺寸校验、Admin RBAC、Audit
Log、Credential 不进入客户端日志、Prompt/Reference 权限继承
Project、Workspace 删除触发异步彻底清理。

# 22. 数据持久化

Canvas JSON 只负责坐标、尺寸、折叠、视觉连线。Domain Store 保存
Project/Asset/Shot/State/Generation/QC/Billing。Media Store 保存文件。

必须有 migration 与 `importLegacyCanvas()`；上游更新经 Adapter 层进入。

建议核心表：
`users, workspaces, workspace_members, projects, story_drafts, script_versions, creative_briefs, scene_lists, breakdown_items, worlds, looks, assets, asset_versions, references, reference_bindings, sequences, scenes, shots, shot_states, state_deltas, keyframes, takes, generation_jobs, generation_outputs, continuity_issues, qc_reports, repair_actions, providers, models, model_capabilities, api_credentials, workspace_model_policies, project_model_policies, media, credit_accounts, credit_ledger, subscriptions, audit_logs, system_settings`

业务表使用 UUID/ULID；关键表 createdAt/updatedAt；可删除实体 deletedAt。

# 23. API / 可观测性

API
分层：`/auth /workspaces /projects /assets /references /sequences /shots /generations /providers /models /media /credits /admin`

生成接口只创建 Job，不同步等待长视频；mutation 全部鉴权；关键写操作支持
idempotency key。

记录 API latency/error、Provider latency/error、Job wait/run、Model
success rate、Generation cost、Retry/Fallback、Storage、Queue
depth。日志不得含完整 API Key。

# 24. 优先级

**P0 地基**：Fork/Audit、Auth、Workspace、多租户、Domain
Schema、Migration、Storage、Credential、Provider/Model Registry、Job
Queue、Generation History、Admin 基础。\
**P1 黄金路径**：创意入口（故事/创意/MV/已有素材）、剧本拆解、World/Look、Asset Registry、Reference
Routing、Sequence/Shot、Storyboard、Keyframe/Hero、Take/Approve、State、Continuity
基础、QC、核心 Skills、Director Agent、Shot Strip、Cost Ledger。\
**P2 增强**：OAuth、团队 Workspace、完整 RBAC、更多 Reference
控制、自动模型路由/Fallback、代理视频、基础 Timeline、订阅支付。\
**P3 扩展**：高级 NLE、多人实时协作、企业 SSO、3D/Depth/360、专业
Color/Sound、Marketplace/第三方 Skill。

# 25. 开发阶段

**Phase 0 --- Fork & Audit**：锁 commit、跑通、测试，明确
node/edge/store/generation/agent/plugin 边界。\
**Phase 1 --- Platform Foundation**：User/Workspace/Auth、Domain
Store、Storage、Credentials、Provider/Model、Queue、Admin 基础。\
**Phase 1.5 --- Creative Entry & Breakdown**：创意入口四通道、Story Writer、SceneList、剧本版本与局部改写、Script Breakdown、确认门禁。\
**Phase 2 --- Production
Foundation**：World/Look、Asset、Reference、Sequence/Shot、Keyframe/Take、版本审批。\
**Phase 3 --- Intelligence**：深度 Skills、Director Agent、Capability
Router、Prompt/Parameter Compiler。\
**Phase 4 --- Continuity & QC**：StateDelta、Continuity、Failure
Diagnosis、Repair Actions、审批门禁。\
**Phase 5 --- Assembly**：Shot Strip、Sequence
Assembly、基础音频/字幕引用、导出；更强 NLE 后续参考 BeatDesign。

每 Phase 必须可运行、可测试、可回滚。禁止一次性大重构。

# 26. V3 黄金路径验收

1.  用户注册/登录，拥有独立 Personal Workspace。
2.  A 用户无法读取 B 用户 Project/Media/Credential。
3.  Admin 可配置 Provider/Model，测试连接、上下架模型。
4.  用户可使用平台 Key 或 BYOK。
5.  新建 Project，从创意入口输入一句话，生成故事核、大纲并经用户确认。
6.  确认并生成剧本与 SceneList，局部改写某一场后下游被标记为待更新。
7.  拆解出资产清单与 World/Look 草案，用户确认后创建至少 2 Character、1 Environment、2 Props 并 Approved。
7a. 导演 Agent 基于已确认资产生成至少 8 Shots，用户仅用意图描述即可，无需填写专业字段；专业字段可展开并覆盖。
7b. MV 通道与已有剧本通道可各自走通到同一份 SceneList。
8.  每 Shot 明确 Asset 与 ReferenceRole。
9.  生成多个 Keyframe 并 Promote Hero Frame。
10. 基于 Hero Frame 生成多个 Take 并 Approved。
11. Shot 2 继承 Shot 1 的人物/服装/道具/空间/状态。
12. Continuity 能发现明显身份、道具、光线、方向冲突。
13. QC 给具体 Repair Action。
14. 可回滚 Approved Asset/Hero/Take。
15. 更换 Provider 后 ShotSpec/资产关系不丢。
16. 任务刷新页面后仍继续。
17. 失败任务正确 Retry/Refund。
18. 关闭重开后 World/Asset/Shot/State/Reference/Generation 完整恢复。
19. Admin 能看到任务、成本、失败率、积分流水。
20. API Key 不出现在客户端日志/数据库明文字段。

# 27. V3 成功定义

V1 不是"生成按钮更多"，而是证明：

> **同一批资产 + 同一个世界状态 + 明确 Reference Routing +
> 结构化电影镜头 + 多模型生成 + 连续性监督 →
> 稳定产出属于同一部影片的高质量镜头。**

只要这条链路成立，再扩
Timeline、声音、调色、团队协作、云端项目、更多模型和 Skills。

# 28. Coding Agent 执行约束

1.  先读原仓库 README、package
    manifests、node/edge/store/generation/agent/plugin 代码再改。
2.  先写 ADR/implementation plan，再实施每个 Phase。
3.  不因 PRD 存在新概念就重写原画布。
4.  Domain 层与 UI 层解耦。
5.  Provider 通过 Adapter 接入。
6.  所有长任务 Job 化。
7.  所有 Approved 内容版本化。
8.  所有多租户读取服务端鉴权。
9.  所有 schema 变更有 migration。
10. 每完成一个 Phase，必须跑 lint/typecheck/test/build，并做黄金路径
    smoke test。
11. 未在 P0/P1 的功能不得阻塞黄金路径。
12. 遇到上游实现与本文冲突时：优先保持可升级性和数据兼容；记录
    ADR，不可静默偏离 PRD。
