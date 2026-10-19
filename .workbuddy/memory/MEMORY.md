# LITTO 项目长期记忆

## 结构与工程约定
- Bun monorepo：`apps/web`（Vue）、`apps/server`（Bun+Express）、`cloud/`（Hono 多租户 SaaS，独立包 `litto-server`，npm+tsx）。
- 双轨生成：工作区链路 `apps/server/src/utils/media/generation.ts`（裸生成，可直接调）＋ cloud 制片链路 `cloud/src/domain/*`（有 compileShot/连续性/QC，模型多为 mock）。
- `db.ts` 的 `hydrate` 会把 JSON_COLS 里的 `data` 列**摊平到对象顶层**；其他 JSON 列（meta/findings）保留在各自键下。
- `scoped(ws).insert` 会给任何表强制加 `workspace_id`；注册全局表（providers/workspaces）必须用裸 `run()` SQL。
- 命名严格小驼峰；`cloud/src/domain` 下例外（如 `qc-vision.ts`）。
- **3000 端口跑的是源码 + bun --watch**（`lsof -p <pid> | grep -c '\.ts$'` 数量大即源码直跑），改 `apps/server/src/**` 无需 build。但热更**不可靠**，验证改动要看可观测输出（如错误文案）。
- 工具包 `packages/tools/mediaGeneration` 改后必须 `bun run build` + `cp build/tools/*.tool.js data/tools/`。新路由要 `bun run routes` 重生成 `src/router.ts`。

## 无 UI 驱动全片制作
- 鉴权绕行：往 `data/cloud/litto.db` 的 `sessions` 表插行（id/user_id/token_hash=sha256(token)/expires_at/created_at），用 `Authorization: Bearer` + `X-Workspace-Id` + `x-toonflow-workspace: 1`。
- 生成入口 `POST /api/ai/media/generate`（directory 绝对路径 + mediaType + providerId/modelId/prompt/purpose），返回 202 `{jobId}`，异步。结果路径在 `generation_outputs.meta.workspacePath`。
- 并发 4 job；`outputName` 相同且旧文件被占用会报「文件正在使用」，重试改名。
- 直连生成只落盘 `assets/generated/`，不写 `shots/assets` 表，画布不出现节点——老板开 UI 会觉得「没变化」，要提前说明。
- ffmpeg 在 `data/ffmpeg/darwin-arm64/ffmpeg`。

## 模型能力与实测
- 当前租户只有两个模型：`atlasCloud/openai/gpt-image-2/edit`（**编辑模型，必须给参考图**）与 `meta/MiniMax-H3`。
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
- 「超逼真」配方（老板给三张手机自拍参考）：①单一实际光源、方向明确、有投影 ②T 区鼻头油光、毛孔可见、眼下淡青、妆感可辨 ③碎发飞出、发根蓬松 ④面料自然褶皱但干净 ⑤环境有生活痕迹但干净≠样板间 ⑥自拍/生活视角轻广角，非长焦商业人像。

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

## 已接入的电影技能
`gavenDirectImagePrompts`（Dxx/Pxx/Cxx/Rxx 风格代码，补「作者感」）、`gavenScriptToVideo`（剧本→逐镜提示词）、`gavenQingluAllegory`（按需）。入口挂在 `workflow/SKILL.md` 的「按当前镜头内容选择专业资料」表。**冲突已处理**：22 期默认 Seedance 2.5 单条 30 秒，当前 H3 只有 4–15s，入口行已注明「以 listMediaModels 为准」。

## audio 选型（老板自找 API，不阻塞）
IndexTTS2（Apache-2.0，3s 克隆，**支持 0.5–2.0x 时长因子**，影视卡时长首选）；CosyVoice 2（4GB，最成熟）；GPT-SoVITS（MIT，音色最像）。接入三步：起 OpenAI 兼容 `/v1/audio/speech` → `data/providers/*.ts` 声明 `type:"audio"` 模型 → 配 apiKey 指向 `modelSelection.audio`。LITTO 的 audio schema / `generateAudio` / `lipSync.ts` 已就绪。

## 待补缺口
①UI 无 cast/shotSpec/styleReference 入口 ②语义质检（换脸/跑题/动作缺失）需视觉模型 ③台词配音无 audio 模型 ④自我校正回路 ⑤画布仍是旧节点 ⑥`compiled_prompt` 是入队快照，须保证编译在入队前。
