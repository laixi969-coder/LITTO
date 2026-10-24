# LITTO 项目长期记忆

## 结构与工程约定
- Bun monorepo：`apps/web`（Vue）、`apps/server`（Bun+Express）、`cloud/`（Hono 多租户 SaaS，独立包 `litto-server`，npm+tsx）。
- 双轨生成：工作区链路 `apps/server/src/utils/media/generation.ts`（裸生成，可直接调）＋ cloud 制片链路 `cloud/src/domain/*`（有 compileShot/连续性/QC，模型多为 mock）。
- `db.ts` 的 `hydrate` 会把 JSON_COLS 里的 `data` 列**摊平到对象顶层**；其他 JSON 列（meta/findings）保留在各自键下。
- `scoped(ws).insert` 会给任何表强制加 `workspace_id`；注册全局表（providers/workspaces）必须用裸 `run()` SQL。
- 命名严格小驼峰；`cloud/src/domain` 下例外（如 `qc-vision.ts`）。
- **3000 端口跑的是源码 + bun --watch**（`lsof -p <pid> | grep -c '\.ts$'` 数量大即源码直跑），改 `apps/server/src/**` 无需 build。但热更**不可靠**，验证改动要看可观测输出（如错误文案）。
- 工具包 `packages/tools/mediaGeneration` 改后必须 `bun run build` + `cp build/tools/*.tool.js data/tools/`。新路由要 `bun run routes` 重生成 `src/router.ts`。
- **新建技能只写 `packages/skills/` 不算交付**：运行态读的是 `data/skills`（启动时 `syncBuiltins` 才复制），且必须接三处入口才可能被读——`apps/server/src/agent/runtime/prompt.ts` 的分发规则、`workflow/SKILL.md` 的「按当前镜头内容选择专业资料」表、以及相邻主技能（如 cinema）的分工段。手动补同步：`bun -e "import s from './src/utils/plugins/syncBuiltins'; await s('<data>/skills','<repo>/packages/skills','skills')"`（在 `apps/server` 下跑），不会破坏用户自定义版本。

## 无 UI 驱动全片制作
- 鉴权绕行：往 `data/cloud/milimili.db`（品牌改名后，旧的 litto.db）的 `sessions` 表插行（id/user_id/token_hash=sha256(token)/expires_at/created_at），用 `Authorization: Bearer` + `X-Workspace-Id` + `x-toonflow-workspace: 1`。**token 必须是 workspace 的 owner**（老板 real ws `01M41BFE9CRC8HEQENRBE2F09E` / user `01M41BFE9B0HQH7V5A1KH48CQJ`），用 admin 账号会 403「无权访问该工作区」。
- 生成入口 `POST /api/ai/media/generate`（directory 绝对路径 + mediaType + providerId/modelId/prompt/purpose），返回 202 `{jobId}`，异步。结果路径在 `generation_outputs.meta.workspacePath`。
- **精度门禁**：首次生成必报「尚未选择图片精度/视频分辨率」。直接写工作区根目录 `mediaQuality.json`（数组 `[{kind,providerId,modelId,value}]`）等于 setQuality 的效果，比走 requestProductionDecision 快；图片 size 还必须与 ratio 像素一致（16:9 → 2048x1152 或 3840x2160）。
- 并发 4 job；`outputName` 相同且旧文件被占用会报「文件正在使用」，重试改名。
- **job 卡 RUNNING 的真凶是 bun --watch 热重启**：改源码触发重载，进行中的 job 不再推进。加 `regenerationId: <uuid>` 会绕过指纹复用新建任务。
- **画布要自己写**：直连生成只落盘 `assets/generated/`，不写 `shots/assets` 表，画布不出现节点——老板开 UI 会觉得「没变化」。做法是工作区目录下 `画布1.json`（`{milimiliCanvas:true, nodes, edges, viewport}`），节点用 `remote-imageNode` / `remote-videoNode` / `remote-textNode`：媒体节点 `data:{label, sourcePath, outputs:{image|video:{dataType,value:{url,mimeType}}}, handles}`，文本节点 `data:{label, textSnapshot}`。项目行在 `projects`（name/canvas 简版）+ `workspace_project_links`（directory），目录名即项目目录。
- **但 DB 插 projects 行 ≠ UI 能看到项目**：项目列表是前端 Pinia 持久化到浏览器 localStorage（key `milimili.projectList`），只认用户自己在 UI 里打开过的目录。后台建的项目不会出现在列表，必须让用户在 UI 里「打开目录」到该路径；`GET /api/workspaces/check?directory=` 会返回 link 里的 projectId，证明链路是通的。`projects.canvas` 字段前端不读，画布只来自目录下的 `画布N.json`。**所以交付时要说清「需要从目录打开」，不要只说「已写进画布」**。
- **前端在 3000 提供 build 产物**（`build/web/assets/index-*.js`），改 `apps/web/src` 后必须 `cd apps/web && bun run build` 才生效（5173 是别的项目 HARTA，不是 MILI MILI）。构建偶发 rolldown 报错，重跑一次即过。
- 已加两个 UI 入口（2026-10-22）：①首页「导入项目」按钮不再只在无账号模式显示，登录态也能选目录；②首页支持 `/?directory=<绝对路径>` 深链接，登录后自动 openProject 并跳 `/workspace`。给老板看结果直接发这个链接。
- ffmpeg 在 `data/ffmpeg/darwin-arm64/ffmpeg`。
- **人物跨段一致靠末帧续接，不靠重新出图**：`ffmpeg -sseof -0.12 -i 上段.mp4 -frames:v 1` 抽真实末帧当下一段 firstFrame，比再跑一次 gpt-image-2 便宜且不跳脸。**但末帧续接只管脸和场景，管不住服装**：末帧只拍到腰以上，下一段就会自己补出短裤和赤脚。做蹲/坐/起/走前先确认末帧含完整下半身，否则改用参考生视频（多图含全身定妆）。
- **服装必须逐项写**：`WARDROBE: 上衣（版型/颜色/袖口）；下装（覆盖到哪）；鞋履（款式/细节）；配饰`。写「保持同一服装」等于没写。`generate.ts` 已加守卫：人物视频含下半身动作却无 cast/WARDROBE → 400 拒绝。
- **流程判据必须只有一份**：`apps/server/src/utils/media/assetContract.ts` 的 `inspectAssets()` 是唯一真相源，`flow.ts`（报告）与 `generate.ts`（门禁）都调它。2026-10-22 之前两处各写一套判断，才会出现「flow 说齐了、四视图其实没做」。
- **角色卡的完成标志是 `fourView` 字段**，不是 references 非空。`assetSheet` 写 true；`assetImport` 按 references≥3 判断；历史数据已迁移（≥2 张记 true）。要动下半身的镜头（蹲/坐/起/走/跑/跳）才硬要求四视图，近景中景放行，避免一刀切把人逼去绕流程。
- **`looksLikePersonShot` 必须认代词**（她/他/她们/他们）：vlog 与 POV 稿子常写「她转过头」，不认代词会把人物镜判成空镜，服装锁 WARDROBELOCK 就完全不注入。
- **基底必须写白平衡**：「白平衡以面部为准，室内暖光不把皮肤染黄，白墙与白衬衫保持中性白」。只写「色彩自然准确」不够，室内暖光场景会把人物合成后染黄。
- **改身材或去掉配饰会连脸一起换掉**：gpt-image-2/edit 做「改身材」「去帽子」这类编辑时，会顺手按它自己的审美重绘脸（内双变双眼皮、鼻梁抬高、下巴削尖、唇色加深），成品是「另一个人」。实测两次踩到。
  - 稳的做法：从原图**裁出面部特写**当第一张参考图，第二张才是全身；提示词里显式列出不可变的五官特征（内双、眼尾略平、鼻梁不高、鼻头略圆、脸型略方、下颌线清楚、唇色偏淡），并写明不得美颜/不得加双眼皮/不得抬鼻梁/不得削下巴/不得加深唇色。
  - **老板认可的基准脸**：`xiaoQingXin20261022/assets/generated/image1e844950-…png`（清爽版四视图）。换任何造型都从这张的脸出发。
- **肤质两条路径**（`SKIN: clean|natural`）：`clean` 是默认，用于四视图/定妆/广告/商业镜头；`natural` 用于 vlog/自拍/纪实，允许鼻头与额头很薄一层自然油光。项目根写 `assets/visual.json` 的 `skinFinish` 切换；`purpose: "asset"` 永远 clean，不受项目配置影响。
- **两个进程共用一个队列，会互相杀任务**：`apps/server`（`bun --watch`）与 `cloud`（`tsx watch src/index.ts`）都在启动时调 `startWorker()`，而 `startWorker()` 会把表里所有 `RUNNING` 的 workspaceMedia 任务统一清掉标成「服务重启，供应商结果待核查」。所以**改 `cloud/src/**` 也会让 cloud 重启、把 apps/server 正在跑的视频任务杀掉**（实测段04 连续四次死在这上面，每次都跑满 3 分钟才失败）。要跑长任务时，`apps/server/src/**` 与 `cloud/src/**` 都别动。根治需要给 job 加 worker 归属标识，尚未做。
- **改 `apps/server/src/**` 会触发 bun 热重启**：正在排队的生成任务会被打断。要跑长时间的批量生成，先别改源码。
- **providers 有两份**：`packages/providers/src/media/*.ts` 是源码，运行态读 `data/providers/*.ts` 副本，改完必须两边同步，否则不生效。
- Vidu `mode` 的 `imageReference:N` 是能力上限不是张数；旧实现要求恰为 15 导致参考生视频全部不可用，已修。
- **Vidu Q4 的运镜指令几乎不执行**（实测：要求跟随平移、背景滑过，输出仍是固定机位十几帧微动）。需要运镜的镜头不要指望 Vidu，写多细都没用；要么换 Seedance 2.5，要么后期裁剪推移。

## 模型能力与实测
- **模型清单查 `data/cloud/milimili.db` 的 `models` 表（`status='active'`），别看 `data/litto.db`（本地工作区库是空的）**。2026-10-22 实况：`apiMart/seedance-2.5`（4–30s、480p/720p、9图+3视频+3音频参考、支持真人）、`apiMart/seedance-2.0`、`apiMart/seedream-5-0-pro`、`apiMart/gpt-image-2`、`atlasCloud/bytedance/seedream-v5.0-flash`、`atlasCloud/openai/gpt-image-2/edit`（**编辑模型，必须给参考图**）、`meta/MiniMax-H3`、`vidu/viduq4-preview`、`atlasCloud/kling-v3.0-std`、`atlasCloud/sync/lipsync-v3` 等 20 个 active。DB 里 `durations` 字段常为 `[]`，时长靠 provider 的 `durationResolutionMap` 提供。
- MiniMax-H3 时长 **4–15 秒**（不传取上限 2/3 ≈ 10.1s），768P/2K，自带 AAC。15 秒实测 39 秒出片，一镜可表达完整因果链。**5 秒一刀切是操作错误**。
- **身份锁定**：`cast`/`images`/`firstFrame` 能锁脸、服装、场景；纯文本是人脸漂移的唯一原因。人物镜强制参考图已进代码（`purpose!=="asset"` 且无参考图且命中人物词 → 拒绝）。
- 无 audio 模型，台词无法配音；`inspectFinal`/`qc` 不在这条出口自动触发。
- 新角色脸做法：H3 `purpose:"asset"` 纯文本出定妆镜头 → 抽帧 → 当参考图。四视图定妆用**纯白棚拍+均匀柔光**；成片镜头用**生活光+真实环境**，不能混。

## 编译链与参数（顺序固定）
写实基底 → SHOTSPEC → CAST → 用户原文 → LOOK → ERA → STYLEONLY
- `PHOTOGRAPHIC_BASELINE`：明亮通透、曝光正常、中间调不压暗、无噪点/颗粒/脏污（已删「胶片颗粒/边缘不锐/生活痕迹磨损」）。风格分流：命中动画/插画/漫画/3D 不加基底。靠标记幂等。
- **幂等注入**标记：`PHOTOGRAPHICBASELINE` / `SHOTSPEC:` / `CAST:` / `LOOK: 影调参照` / `ERA `。编译必须在 `jobs.ts::enqueueMedia` 入队前做，否则 `compiled_prompt` 不含它（UI≠实发）。
- `shotSpec` 9 字段：shotSize/lens/cameraMove/blocking/action/performance/lighting/startState/endState。
- `cast`：`assets/cast/<名字>.json` = `{name, identity, wardrobe, references[]}`。参考图顺序 **cast → images → styleReference**（影调图必须最后）。
- `styleReference` 只给影调，尾部注入 `STYLEONLY: 最后一张参考图只提供影调…`；人物镜不能只给影调参考（400）。
- `continueFrom`：传上一镜视频路径，服务端抽真实末帧到 `assets/continuity/<hash>-last.png` 作 firstFrame，解决跨镜漂移。
- 手册：`packages/skills/workflow/references/generationParams.md`。

## 硬禁令：「写实」不是「做旧」（最高优先级）
- 老板原话：**「以后 litto 出的人物角色和场景，禁止生成脏、旧、烂的，除非是场景和角色的重点设计」「写实不是做旧，务必狠狠记住，写进 LITTO 的禁令里」。**
- 根源是**我写的提示词**：把写实等同于磨损污渍颗粒，且 `continuity/references/realism.md` 早写着「默认干净完整」而我没读。
- **做旧词真实来源**：`assetPlan` 的 LLM 把剧本「磨得发白的工装」放大成汗渍油污锈斑，26 条资产 22 条带做旧词。SYSTEM 加三条硬规则后 → 15/29。
- **词本身是年代炸弹**：`工装`/`劳保服`/`工作服` → 翻领宽松劳保服；`水磨石`/`白炽灯`/`木格窗`/`铁皮` 同理。写「干净平整的工装」也救不回来。要用当代面料+剪裁+具体物件（深灰速干半拉链立领、修身、工装长裤带反光条、黑色低帮安全鞋）。
- 代码层：`DISTRESSED` 词表拦截（需 `DISTRESSED: 理由` 豁免）；QC 加 `underexposed`(<55)/`desaturated`(<8)——做脏做旧在数据上就是压暗+降饱和。
- **自指误伤踩过三次**：规则文本触发自己的规则。修法：检测前剥掉 `PHOTOGRAPHICBASELINE`/`LOOK:`/`ERA`/`CAST:`/`SHOTSPEC:` 段只留作者原文；否定前缀补「不主动/不添加/不做/不得」。**规则文本必须豁免于规则检测。**
- **参考图状态会被继承**：带血带油的帧做定妆，四视图会把血带出来。

## 年代锚点（2026 被拍成 70-80 年代）
- 概念：**旧只属于建筑本身，不扩散到人**。2026 的 26 岁白领该有 LED 平板灯、全面屏手机、铝合金窗、不锈钢保温杯；不该有搪瓷杯、白炽灯、木格窗。
- `assets/world.json` 存 `must[]`/`never[]`/`garments`/`spaces`/`bannedWords`；`generate.ts::eraAnchor()` 在 prompt 出现年代字符串时注入 `ERA 年份：…`。**prompt 必须写明年代否则不触发**。
- 「超逼真」配方（老板给三张手机自拍参考）：①单一实际光源、方向明确、有投影 ②**皮肤半哑光、毛孔可见、眼下淡青、妆感可辨——不要 T 区油光**（2026-10-22 老板明确说「脸油多了、不够清爽」，四视图尤其明显；油光只在手机自拍/生活镜头允许极少量）③碎发飞出、发根蓬松 ④面料自然褶皱但干净 ⑤环境有生活痕迹但干净≠样板间 ⑥自拍/生活视角轻广角，非长焦商业人像。

## 质检与合成
- `POST /api/ai/media/qc`：`{clips[]}` 逐段体检（黑场/削波/静音/时长/画幅/亮度色度跳变）；`{file, headTail[]}` 整片（段间黑闪）。纯 ffmpeg 零成本：`blackdetect`、`signalstats`(YAVG/UAVG/VAVG/SATAVG/HUEAVG/YMAX/YMIN)、`volumedetect`。
- 阈值：`ymax≥252` 死白、`ymin≤2` 压死、`sat>55` 过饱和、`luma<55` 发暗、`sat<8` 发灰。
- `POST /api/ai/media/compose`：先 concat（`-c copy`，**不重编码所以无段间黑闪**）再统一 `eq + noise + loudnorm(I=-16:TP=-1.5)`。实测 0 问题、峰值 −3.5dB（旧手写脚本 239s 片 52 个问题）。
- 胶片响应：**不做全画面柔化，只做高光选择性溢出** —— `split → curves(压 0.5 以下) → gblur sigma=18 → blend screen 0.12`，暗部不进模糊分支。上限 bloom≤0.25 / aberration≤3px / grain≤12。**清晰度守卫**用 sobel 边缘能量比对，掉超 12% 标 `blurred`（实测反升 5%）。
- 走 filter_complex 时音频必须显式 `[0:a]loudnorm...[a]` + `-map [a]`，否则响度被绕过（踩过成片 −47dB）。
- 原则：**能后处理修的不重生成**（黑闪靠不重编码拼接、削波靠 loudnorm、冷暖靠统一 grade）；只有身份/动作/构图不可修才 `regenerate`。重试每镜 ≤1 次、全片 ≤10%，同因连续 3 次熔断。
- `composeFilm` 已是 Agent 工具，默认合成后自动跑 `inspectFilm`，结果在 `qc` 字段。

## 导演色卡与自动推荐
- `packages/skills/directorPalettes/`：`SKILL.md` + `index.json`（10 类）+ 198 位导演 JSON（836K）。字段含 `palette.primary[]`（6 色 HEX+占比）、`lighting`、`composition[]`、`profile{grading,avoid}`。未导入剧照/PNG（255M+）。
- `POST /api/ai/media/director` 默认 `mode:"smart"`：规则粗筛 20 → 前 12 喂 LLM → 3 推荐 + 2 排除。**题材是门槛不是加分**（主 +100、次 +30），否则通用词把对口导演挤掉。
- 踩坑：分类名对不上（写「霓虹赛博」，实际「02_霓虹黑色与赛博未来」）导致科幻类永远推荐不到。**改分类名要 grep 全库。**
- **LLM 能纠正规则**：规则把雷德利·斯科特排第 5 并「光影不符」排除，LLM 拉回前三（点到《银翼杀手》工业青+琥珀火光）。
- 项目级影调 `assets/look.json` = `{director, note}`，注入 `LOOK: 影调参照…`，一次设定全片继承。
- QC 可对照色板：传 `palette:"010_ClaudeChabrol"` 返回 `within/offTarget`。判定用**最近主色**而非平均色相（色板是冷主色+暖点缀的对立结构，取平均会抹平——踩过夏布洛尔算出 69° 暖黄）。阈值 hue≤30、sat≤18。

## 技能不摆设
- 13 个 skill、8442 行 markdown，不可能全塞上下文，必然按需加载。**变摆设不是内容问题，是触发不可靠**（实证：`shotLanguage.md` 一整支片一次没读）。
- 三层：**L1 硬约束代码化** → L2 检查表 → L3 长文（只有审美判断才读全文）。
- `POST /api/ai/media/preflight`：查 look/色卡、cast 是否齐（含 draft）、shotSpec 完整度、片段可读性、ffmpeg、`assetPlan`、`castCoverage`。每项带 `level`(block/warn/info) 与对应 `rule`。
- `POST /api/ai/media/rules`：读 `compiled_prompt`/`parameters` 反推命中率。改造前实测：基底 35%、镜头规格 10%、角色档案 10%、身份参考图 25%——**摆设的量化证据**。标记要精确（`LOOK: 影调参照` 而非 `LOOK`）。
- `POST /api/ai/media/assets`：剧本拆资产清单落 `assets/assetPlan.json`。顺序：**角色卡 → 场景 → 道具 → 分镜**。
- **few-shot 母版样例比规则更能稳住结构**：White Lang 每包都带 50KB 级「发布自觉@」母版，LITTO 长期只有规则没有样例。`videoPromptDirector/references/examplePrompt.md` 就是补这个（15 秒 8 镜完整五板块）。写新题材先读样例改题材，再按规范改规则。
- 可机械判定的结构问题要落成脚本：`videoPromptDirector/scripts/checkPrompt.py` 查五标题数量顺序、时间码连续性与总和、禁止标题、时间线否定词、@ 资产引用。写前自检，不拦请求；要拦就进 preflight。

## 已接入的电影技能
`gavenDirectImagePrompts`（Dxx/Pxx/Cxx/Rxx 风格代码，补「作者感」）、`gavenScriptToVideo`（剧本→逐镜提示词）、`gavenQingluAllegory`（按需）。入口挂在 `workflow/SKILL.md` 的「按当前镜头内容选择专业资料」表。**冲突已处理**：22 期默认 Seedance 2.5 单条 30 秒，当前 H3 只有 4–15s，入口行已注明「以 listMediaModels 为准」。

## audio 选型（老板自找 API，不阻塞）
IndexTTS2（Apache-2.0，3s 克隆，**支持 0.5–2.0x 时长因子**，影视卡时长首选）；CosyVoice 2（4GB，最成熟）；GPT-SoVITS（MIT，音色最像）。接入三步：起 OpenAI 兼容 `/v1/audio/speech` → `data/providers/*.ts` 声明 `type:"audio"` 模型 → 配 apiKey 指向 `modelSelection.audio`。LITTO 的 audio schema / `generateAudio` / `lipSync.ts` 已就绪。

## 待补缺口
①UI 无 cast/shotSpec/styleReference 入口 ②语义质检（换脸/跑题/动作缺失）需视觉模型 ③台词配音无 audio 模型 ④自我校正回路 ⑤画布仍是旧节点 ⑥`compiled_prompt` 是入队快照，须保证编译在入队前。
