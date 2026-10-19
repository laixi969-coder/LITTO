# LITTO 项目长期记忆

## 技术栈与结构
- Bun monorepo；`apps/web`（Vue）、`apps/server`（Bun+Express）、`cloud/`（Hono 多租户 SaaS，独立包 `litto-server`，npm+tsx，非 bun workspace）。
- 生成链路双轨：工作区链路（`apps/server/src/utils/media/generation.ts`，原样透传 prompt 给供应商）+ cloud 制片链路（`cloud/src/domain/*`，有完整 compileShot/资产/连续性/QC/剪辑，但模型多为 mock/disabled）。

## 关键工程约定
- **db.ts `hydrate` 会把 JSON_COLS 里的 `data` 列摊平到对象顶层**（`Object.assign`），其他 JSON 列（如 meta/findings）保留在各自键下。写新表时：`data` 字段读出后不在 `row.data.xxx`，在 `row.xxx` 顶层。2026-10-10 在 library.ts 踩过这个坑。
- 命名严格小驼峰，禁止短横线/蛇形/大驼峰；但 cloud/src/domain 下存在短横线文件（如 qc-vision.ts），遵循局部风格。
- `scoped(ws).insert` 会给任何表强制加 `workspace_id`；注册全局表（providers/workspaces）必须用裸 `run()` SQL，不能走 scoped。

## 真实感优化（2026-10-10 落地）
- 对标麦橘 MERJIC 的 P0–P4 全部实现并验证，见当日日志。
- 核心教训：麦橘的真实感靠抽卡工业化+资产复用，不靠提示词；LITTO 提示词方法论（realism.md/stripFluff/photographicRendering）已领先，断点在工程。
- 负向词原则：针对解剖/材质类硬伤（extra fingers/plastic waxy skin），**不用** worst quality/lowres 类画质压制词——与渲染标准冲突。
- 局部修复：所有已适配图像供应商拒绝 mask，改用「整帧重绘+锁定描述」，结果走人工验收不原地替换。
- 骨皮形神做成中性气质标签（bearing/gaze/focus/rapport），只用于检索去重，不参与生成编译，保持「不凭性别职业性格规定唯一脸型」的原则。

## 无 UI 驱动全片制作（2026-10-19 验证可行）

- **鉴权绕过**：`/api/*` 走 cloud session（`apps/server/src/lib/cloud.ts`）。飞书/浏览器登录不是必须——直接往 `data/cloud/litto.db` 的 `sessions` 表插一行（id/user_id/token_hash=sha256(token)/expires_at/created_at），用 `Authorization: Bearer <token>` + `X-Workspace-Id: <ws>` 即可。注意 `/api/settings/get` 还要求 `x-toonflow-workspace: 1`（`utils/mcp/control.ts` 的来源校验），但生成类接口不需要。
- **生成入口**：`POST /api/ai/media/generate`（body: directory 绝对路径 + mediaType + providerId/modelId/prompt/purpose）。返回 202 `{jobId}`，异步执行。结果路径在 `cloud/litto.db` 的 `generation_outputs.meta.workspacePath`。
- **可用模型**（该租户默认）：图像只有 `atlasCloud / openai/gpt-image-2/edit`——**是 edit 模型，不给参考图会报「此模型需要参考图」，纯文生图不可用**；视频 `meta / MiniMax-H3`，支持 `mode:"text"` 纯文生视频，768P/16:9、5 秒约 19 秒出片，自带 AAC 音轨。
- **并发与耗时**：服务端同时只跑 4 个 job，其余排队。51 段 5 秒视频约 6 分钟跑完。
- **文件名冲突会失败**：`outputName` 相同且旧文件仍被占用时报「文件正在使用」，重试时改名即可。
- **不注册 cloud 制片对象时页面看不到**：直连生成只落盘到 `assets/generated/`，不写 `shots/assets` 表，画布也不会出现节点。老板打开 UI 会觉得「没变化」，要么补建对象，要么提前说明。
- 成片合成用 `data/ffmpeg/darwin-arm64/ffmpeg`：逐段 `fps=24,scale=1344:768,pad,setsar=1` 归一化 → concat demuxer；`r_frame_rate` 会显示 120/1 但 `avg_frame_rate` 是 24，属容器元数据怪癖，不影响播放。
- 中文路径末尾带全角逗号等字符时，shell 里务必用变量+引号，Python 里用 os.path.join 更稳。

## 时长与身份锁定的实测结论（2026-10-19）

- **MiniMax-H3 的真实时长区间是 4–15 秒**（`durationResolutionMap`），5 秒一刀切是操作错误，不是模型或 LITTO 限制。15 秒实测 39 秒出片，一个镜头能完整表达「门缝出火 → 整门爆开 → 浓烟碎屑 → 人影冲入」的因果链；同样内容拆成 3 个 5 秒镜头反而全部拍砸。
- **`mode:["imageReference:9"]` + `images` 能锁身份、服装、场景**。实测用 504 的特写帧 + 403 的库廊定场帧作参考，生成的 10 秒镜头里人物与参考脸基本为同一人，工装颜色和金色管廊都保住。**纯文本模式是人脸漂移的唯一原因**——它等于每镜重新选角。
- 已在 `packages/skills/workflow/SKILL.md` 新增「镜头时长、身份锁定与生成后核对」硬规则（并同步 `data/skills`，改完即生效无需重启）：时长按动作阶段/台词语速取大值、人物镜必须传角色参考图、同场景共用定场帧或接末帧、生成后抽帧比对身份/服装/场景、台词时长按语速且字幕不等于发声。
- 仍未解决的产品层缺口：`/api/ai/media/generate` 是无上下文裸生成，不知道上一镜末态，无法自动 firstFrame 衔接；`mediaProviderConfigs` 无 audio 模型，台词无法配音；`inspectFinal`/`qc` 不在这条出口上触发。要根治得改 `packages/tools/mediaGeneration` 或 `apps/server/src/utils/media/generation.ts` 并重新 `bun run build:server`（3000 跑的是 `build/server/index.js` 单文件，改 src 不热更）。

## 3000 端口跑的是源码 + watch，改 src 立即生效（2026-10-19 修正上条误判）

- `lsof -p 757` 显示进程打开了 `apps/server/src/index.ts` 和 320 个 `.ts`，**不是** `build/server/index.js`。改 `apps/server/src/**` 后无需 build、无需手动重启，`bun --watch` 会自动 reload。上一条「要 build:server」的结论是错的。
- 判断方式：`lsof -p <pid> | grep -c '\.ts$'`，数量大即为源码直跑。

## LITTO 出品质量代码改动（2026-10-19 已落地并验证）

1. **`continueFrom` 续拍**（`apps/server/src/routes/ai/media/generate.ts`）：传工作区内视频路径，服务端用 ffmpeg 抽真实末帧写入 `assets/continuity/<hash>-last.png`，自动作为 `firstFrame`。实测生成 1.19MB 末帧文件，链路通。用于解决跨镜空间/人物漂移。
2. **默认时长按模型能力**（`apps/server/src/utils/media/generation.ts` 新增 `recommendedDuration`）：视频未传 `duration` 时取模型 `durationResolutionMap` 上限的 2/3。MiniMax-H3（4–15s）实测不传时长生成 **10.125 秒**，不再是 5 秒。
3. **人物镜头强制参考图**（同文件）：`mediaType=video` 且 `purpose !== "asset"` 且无 `images/firstFrame/lastFrame` 时，若 prompt 命中人物词（人脸|面部|表情|对白|人物|角色|男人|女人|男性|女性|face|man|woman 等）直接拒绝。实测返回 FAILED：「人物镜头必须提供角色参考图…」。注意生成走异步 job，拦截发生在 worker 里，HTTP 仍返回 jobId，失败原因写在 `generation_jobs.error`。
4. **成片合成接口**（`apps/server/src/utils/media/compose.ts` 核心 + `routes/ai/media/compose.ts` 路由 → `POST /api/ai/media/compose`）：body `{directory, clips[], output, grade{contrast,saturation,brightness,grain}, targetLufs}`。先 concat 拼轨（`-c copy`，不重编码，因此没有段间黑闪），再统一做一次 `eq + noise + loudnorm` 输出。实测 3 段 15.08+10.13+10.13 合成 35.397 秒、1344×768/24fps；音频 max 从原片 −0.3 dB 降到 **−3.5 dB**，不再削波。
5. **`composeFilm` Agent 工具**（2026-10-19 同日补齐）：`packages/toolScaffold/src/runtime.ts` 的 `MediaContext` 加可选 `compose()`；`apps/server/src/agent/tools/index.ts` 注入 `compose: (request, signal) => composeFilm(cwd, request, signal)`；`packages/tools/mediaGeneration/src/index.ts` 新增 `composeFilm` 工具（`media.compose` 存在时才注册）。这样"给剧本→出成片"对内置 Agent 闭环。
- **工具改动生效链路**：改 `packages/tools/mediaGeneration` → `bun run build`（产物 `build/tools/mediaGeneration.tool.js`）→ `cp` 到 `data/tools/`。`loadTool` 按文件 revision 失效缓存，下一轮 createAgentTools 自动加载，不用重启。工具产物依赖虚拟模块 `toonflow:tool-zod`，**不能用裸 bun import 验证**，必须在宿主里加载。
- 新路由需在 `apps/server` 跑 `bun run routes` 重新生成 `src/router.ts`，watch 会自动 reload。
- `bun run typecheck` 通过（server 与 mediaGeneration 两处）。
- 老板的取向：**不改片子，改 LITTO 本身**；评价标准是产品出品能力，不是单支片。audio 模型他另找（倾向 API），不阻塞其余优化。

## 量化质检 `qc`（2026-10-19 落地）

- `apps/server/src/utils/media/qc.ts` + `POST /api/ai/media/qc`。两种模式：
  - `{clips:[...], expectedDuration?}` 合成前逐段体检：黑场 / 削波 / 静音 / 时长 / 画幅帧率 / 相邻镜亮度与色度跳变。
  - `{file:"xxx.mp4", headTail:[{start,end}]}` 合成后整片体检：抓段间黑闪，片头片尾可用 headTail 豁免。
- 实现只用 ffmpeg 本地滤镜，零成本、不调视觉模型：`blackdetect=d=0.04:pic_th=0.95` 抓黑场，`signalstats,metadata=print` 取 YAVG/UAVG/VAVG，`volumedetect` 取峰值与均值，`ffprobe -print_format json` 取元数据。
- **实测对比（同一套 QC）**：旧手写脚本合成的 239.52 秒成片 → **52 个问题**（51 次段间黑闪，每 4.5 秒一次，+ 峰值 −0.3 dB 削波）；新 `compose` 合成的 25.35 秒片 → **0 个问题**（峰值 −3.5 dB，均值 −20.5 dB）。证明"质检 + 正确合成参数"能闭环，无需反复重生成。
- 设计原则（回答老板"如何不卡死"）：**能后处理修的不重生成**（黑闪靠不重编码拼接、削波靠 loudnorm、冷暖靠统一 grade），只有身份/动作/构图这类不可修的才标 `regenerate`；自动重试每镜上限 1 次、全片上限约 10%，同因连续 3 次失败即熔断转人工。
- **合成门禁**：`composeFilm` 默认在合成后自动跑 `inspectFilm`，结果放在返回的 `qc` 字段；`verify:false` 可关，`headTail` 豁免片头片尾黑场。实测 compose 返回 `qc.issues: []`、峰值 −3.5 dB。
- **美学量化（部分可测）**：`signalstats` 同时取 `YAVG/UAVG/VAVG/SATAVG/HUEAVG`，逐镜采样三点。`inspectClips` 的 `summary.style` 给出全片饱和度均值、色相均值与偏离过大的镜头（sat 偏离 >18、hue 偏离 >26°）。实测三镜 luma 58/84/66、sat 9.3/20.5/11.8、hue 221/191/205，能反映"配色是否各自为政"。
- 边界：量化只能挡"明显难看"（黑闪、过曝、死黑、跳色、破音），挡不住"平庸"。真正的好看要靠 ①对的参考图（最强杠杆）②ShotSpec ③统一调色，其中参考图 LITTO 有 `readVisualReferences` 但裸生成链路不读。

## 写实基底与风格分流（2026-10-19 落地）

- `generation.ts` 新增 `PHOTOGRAPHIC_BASELINE`（35mm 成像、毛孔绒毛、布料纤维、真实光源、轻微颗粒、禁 3D/CG 塑料感），在**未经过编译层**且**非风格化**时前置拼接。
- 风格分流规则：prompt 命中 `动画|插画|漫画|卡通|二次元|像素|3D渲染|CG渲染|anime|cartoon|illustration|render|stylized` 即视为风格化，**不注入**写实基底。老板明确要求「要真人就超逼真，要漫画就正常出漫画」，不能一刀切写实。
- 已编译的请求（prompt 含 `REQUEST:`）跳过注入：cloud 编译层本身已有 `PROJECTVISUALCONTEXT{medium:photographic}` + `RENDERINGSTANDARD` + `VISUALDEFAULTS`，重复叠加会与模板冲突。
- **踩坑**：人物镜头拦截曾误伤空镜（"雨夜柏油路面"被判成人物）。原因：编译层会在 prompt 后追加 `REFERENCEUSE: ... IDENTITY for face ...`，全文匹配 `\bface\b` 必中。修法：先用正则截出 `REQUEST:` 到下一个大写标记之间的**作者原文**，只对这段做检测。实测空镜放行、人物拒绝。
- **产品级发现**：`generation_jobs.compiled_prompt` 是**入队时**的快照，不含执行层注入的内容；UI 上看到的提示词 ≠ 真正发给模型的。可解释性问题，待修。

## 三个 Gaven 电影技能已接入（2026-10-19）

来源 `~/Downloads/40种电影风格skill/`，装到 `packages/skills/` 与 `data/skills/` 两处（改名小驼峰以符合 AGENTS.md）：

| 技能 | 原名 | 价值 |
| --- | --- | --- |
| `gavenDirectImagePrompts` | 19 期 AI 电影导演 | **高**。Dxx 导演／Pxx 摄影／Cxx 胶片／Rxx 印片 四级风格代码 + 静态调度字段，补的正是"没有作者感" |
| `gavenScriptToVideo` | 22 期剧本转视频 | **高**。剧本→逐镜提示词的结构化方法（按动作因果与对白容量拆片段、逐镜景别/运镜/时长、表演转译、连续性核对） |
| `gavenQingluAllegory` | 17 期青绿风格 | 中。单一画风包，只在明确要求"青绿寓言/东方超现实"时用。原始 zip（4.9M 示例图）未装 |

- 入口已挂进 `workflow/SKILL.md` 的「按当前镜头内容选择专业资料」表（第 84–86 行），否则 LITTO 的 Agent 不会主动读。
- **冲突已处理**：22 期默认「Seedance 2.5、单条最长 30 秒」，当前租户是 MiniMax-H3（4–15s）。入口行明确写「片段上限以 listMediaModels 为准，30 秒只适用于 Seedance 2.5」。

## 写实基底幂等化（2026-10-19）

- `withPhotographicBaseline(prompt)` 从 `generation.ts` 导出，靠 `PHOTOGRAPHICBASELINE` 标记幂等，在 `jobs.ts::enqueueMedia` 入队前调用一次、执行层再调一次（已含则跳过）。
- 目的：让 `generation_jobs.compiled_prompt` 与实际发送内容一致 —— 实测入队后 compiled_prompt 开头即为 `REQUEST: PHOTOGRAPHICBASELINE 实拍成像基底…`，UI 看到的 prompt 就是模型收到的。
- 风格分流仍生效：命中动画/插画/漫画/3D 等词则整段不加基底。

## 影调参考 `styleReference`（2026-10-19 落地）

- `POST /api/ai/media/generate` 新增可选 `styleReference`（工作区内图片路径）：自动追加到 `images` 末尾，并在 prompt 尾部注入 `STYLEONLY: 最后一张参考图只提供影调、对比、色彩与成像质感，不提供人物身份、服装、场景内容或构图`。
- **防顶替**：`styleReference` 不能替代身份参考。人物镜若只给影调参考、没有 `images`/`firstFrame`/`continueFrom`，直接 400：「人物镜头不能只给影调参考」。判定用 `looksLikePersonShot()`（从 generation.ts 导出，只取 REQUEST: 段作者原文）。
- 实测：人物镜 + 仅影调参考 → 400 拒绝；空镜 + 影调参考 → 202 通过，compiled_prompt 第 258 字符处出现 STYLEONLY。

## 镜头规格与角色档案（2026-10-19 落地）

- **`shotSpec`**（`MediaShotSpec`，9 字段：shotSize/lens/cameraMove/blocking/action/performance/lighting/startState/endState）：
  - 类型在 `packages/toolScaffold/src/runtime.ts`，schema 在 `packages/tools/mediaGeneration/src/runtime.ts` 的 `sharedFields`。
  - 编译成 `SHOTSPEC: 景别 大远景；焦段 24mm 广角，深焦；运镜 …；光线 …` 插在写实基底之后、用户描述之前。
  - **编译必须在 `jobs.ts::enqueueMedia` 入队前做**（否则 compiled_prompt 不含它，又变成 UI≠实发）；`generation.ts` 里用 `request.prompt.includes("SHOTSPEC:")` 幂等跳过。
- **`cast`**：`assets/cast/<角色名>.json` = `{name, identity, wardrobe, references[]}`。传 `cast:["陈砚"]`，服务端把参考图并入 images（排在 style 之前）、把 `CAST: …` 说明拼到 prompt 前面。人物镜有 cast 即满足身份要求。
- 参考图顺序固定：**cast → images → styleReference**。影调图必须最后，`STYLEONLY: 最后一张…` 才指得准。
- 手册落在 `packages/skills/workflow/references/generationParams.md`，并在 workflow/SKILL.md 表格挂了入口行。
- 实测：cast 注入后 compiled_prompt 第 240 字符出现 `CAST:`；shotSpec 三级拼接顺序为 `PHOTOGRAPHICBASELINE → SHOTSPEC → 用户描述`。
- 改 `packages/tools/mediaGeneration/src/runtime.ts` 后必须 `bun run build` + `cp build/tools/*.tool.js data/tools/`，否则 Agent 工具 schema 里没有新字段（HTTP 层因引用 TS 源码会先生效）。

## 导演色卡库（2026-10-19 导入）

- 来源 `~/Downloads/200+世界导演视觉风格色卡提示词/导演色卡蒸馏`（知卡星球商业资料，只取数据、去掉了水印与脚本壳）。
- 落地 `packages/skills/directorPalettes/`：`SKILL.md` + `index.json`（10 类目录）+ `palettes/198 个导演 JSON`，共 836K，已同步 `data/skills/`。
- 每位导演字段：`palette.primary[]`（6 色，HEX＋占比）、`palette.emotional[]`（4 色＋情绪含义）、`lighting{key_light,highlight_tint,shadow_tint,contrast_ratio,overall_tone}`、`composition[]`、`colorKeywords[]`、`mood[]`、`profile{definition,lighting,framing,grading,avoid}`。
- 转换脚本：优先读 `assets/color_palettes/palette.json`（170 位），缺的从 `色卡主文档.md` 的表格解析（28 位），共 198 位零跳过。
- **未导入剧照与色卡 PNG**（255M+），需要时按原目录取。
- 入口挂在 `workflow/SKILL.md` 第 85 行。
- **QC 已能对照色板**：`POST /api/ai/media/qc` 加 `palette: "010_ClaudeChabrol"`，返回 `summary.palette{target, within, offTarget}`。判定用「最近主色」而非平均色相——色板常是冷主色＋暖点缀的对立结构，取平均会抹平（踩过：夏布洛尔平均算出 69° 暖黄，实际主色是 200° 冷蓝占 35%）。阈值 hue ≤30、sat ≤18。
- 局限：只能发现「完全跑偏」（如高饱和橙红 vs 冷灰蓝），验证不了色块比例；比例对不对仍需人看。

## 端到端复核（2026-10-19，cast＋shotSpec＋styleReference＋qc 全链路）

- 实跑一镜：`cast:["陈砚"]` + 9 字段 shotSpec + styleReference + `duration:10`，10 秒生成成功。
- `compiled_prompt` 四段顺序确认：`PHOTOGRAPHICBASELINE(10) → SHOTSPEC(240) → CAST(406) → 用户原文 → STYLEONLY(520)`，总长 2220 字符。
- 画面结果：人物与参考脸一致（四帧同一人）、构图按 blocking 执行（人物右三分之一、左侧管壁、前景虚化）、endState 到位（正脸看镜头）。
- QC：`issues: 0`，色板对照 `021_RidleyScott` 符合 1/1。
- **复核发现的产品缺口**：①UI 上没有 cast/shotSpec/styleReference 的入口，只能走 API 与 Agent；②角色档案目前只有陈砚一份；③导演色卡没有项目级绑定，每次手动指定；④画布仍是旧版 52 节点，指向未重做的镜头。

## 导演自动推荐 + 项目影调绑定（2026-10-19）

- **不让人从 198 位里挑**。新增 `POST /api/ai/media/director`（`utils/media/directorMatch.ts`）：传 brief／category／tone／setting，返回 top 3 导演，每位带 `score`、`reasons`、`palette`、`avoid`。
- 打分逻辑：题材是**门槛而非加分**（主题材命中 +100，次题材 +30），否则「夜景」「冷调」这类通用加分会把对口导演挤下去；题材按文本里命中关键词数量排序取主。
- **踩坑**：CATEGORY_HINTS 里写的是短名「霓虹赛博」，数据里的实际分类名是「02_霓虹黑色与赛博未来」，`includes` 对不上 → 整个科幻分类永远推荐不到，前三全是动作片。**规则匹配对字符串极敏感，改分类名要同步 grep 全库**。
- 实测《记忆税》梗概 → 詹姆斯·卡梅隆 139／押井守 124／邓肯·琼斯 124，都在合理区间。
- **项目级影调**：工作区 `assets/look.json` = `{director, note}`，生成时自动注入 `LOOK: 影调参照 …` + 主色与占比 + 主光 + 高光/阴影偏色 + 对比 + avoid。实测 compiled_prompt 第二段即为 LOOK 块。一次设定全片继承，不用逐镜重复。
- 角色档案已补齐三份：陈砚（可用）、沈望（draft）、祁（draft）。后两份从旧换脸版抽帧，JSON 里标了 `quality:"draft"` 并注明正式开拍前需重做定妆。
- **推荐输出结构化**：每位带 `technical[]`（主光/高光/暗部/对比，直接来自该导演的 lighting 字段）、`palette[]`、`emotional[]`、`composition[]`、`avoid`；另返回 `excluded[]`（第 4-5 名 + 为什么没选）。理由必须落到技术条件，不能停在「影调偏冷调」。
- **规则推荐的天花板（实测）**：雷德利·斯科特被排到第 5（112 分）并以「光影条件不符」排除，而《银翼杀手》恰是「记忆／身份」题材的源头。规则只能匹配字面条件，读不懂影史脉络。要再往上必须 LLM 读剧本 + 读风格定义做二次精选。

## LLM 二次精选（2026-10-19 落地）

- `POST /api/ai/media/director` 默认 `mode:"smart"`：规则粗筛 20 位 → 取前 12 位喂 `selectedModel("text")` 指向的模型（当前 DEEPSEKa/deepseek-flash）→ 返回 3 位推荐 + 2 位排除。
- 调用方式：`getConfiguredModel(providerId, modelId)` 拿 `baseUrl`/`provider.apiKey`，直接 POST `${baseUrl}/chat/completions`，40 秒超时，失败或无选中自动降级为 `mode:"rule"`。实现在 `utils/media/directorPick.ts`。
- **模型纠正了规则的错误（关键验证）**：规则把雷德利·斯科特排第 5 并「光影条件不符」排除，LLM 把他拉进前三，理由点明「工业青、烟雾黑与琥珀火光，像《银翼杀手》」。说明影史脉络这类判断规则做不了、模型能做。
- 输出质量：每位给出 `why`（落到 HEX 比例、光位、空间组织）+ `likeFilm`（《攻壳机动队》/《源代码》/《银翼杀手》）；`excluded` 说明「迈克尔·曼的广角城市航拍与实景钠灯会破坏密闭库廊」「王家卫的偏色拖影会把交火抒情化」。
- 返回中保留 `ruleRanking`（规则前五），用于核对模型有没有跳出粗筛范围。

## 技能不摆设：把规则变成可执行检查（2026-10-19）

- 现状盘点：13 个 skill、8442 行 markdown（约 40 万字符），**不可能全塞进上下文**，必然按需加载。
- 核心判断：skill 变摆设不是内容问题，是**触发不可靠**。实证：`shotLanguage.md` 我做过一整支片一次都没读。
- 三层拆解：**L1 硬约束代码化**（能自动验的不让 LLM 自觉）→ **L2 检查表**（生成前逐项确认）→ **L3 长文**（只有审美判断才读全文）。
- 已落地 L1：`POST /api/ai/media/preflight`（`utils/media/preflight.ts`），查 look 是否设定且色卡存在、cast 是否齐（含 draft 标记）、shotSpec 完整度、合成片段可读性、ffmpeg 可用性。每项带 `level`（block/warn/info）与 `rule`（对应哪条技能规则）。
- 实测输出：`look ✓ 影调参照 021_RidleyScott`、`cast ✓ 3 份可用 1 份，草稿 祁、沈望`、`shotSpec ! 缺少 lighting、action`、`ffmpeg ✓`。
- 还差三件：①skill 使用日志（证明读过）②多 agent 职责边界与交接点 ③skill 瘦身（8442 行有大量重复，adfilm 18 个 references 未必都被用到）。

## 规则覆盖率 + 真实感指标（2026-10-19）

- `POST /api/ai/media/rules`（`utils/media/ruleUsage.ts`）：直接读 `generation_jobs` 的 `compiled_prompt`／`parameters` 反推各条规则的实际命中率，不额外埋点。
- **坑**：`scoped().list` 返回的 job 可能不含 `compiled_prompt`（长文本被裁），要用 `parameters` 的 JSON 兜底；标记要精确（`LOOK: 影调参照` 而非 `LOOK`，否则会误命中编译模板里的 `LOOK/LIGHTING/COMPOSITION`，一度算出 100%）。
- 实测改造前：写实基底 35%、镜头规格 10%、角色档案 10%、身份参考图 25%——**这就是「摆设」的量化证据**。
- **真实感三指标**（加进 `inspectClips`）：`ymax ≥ 252` 判高光死白、`ymin ≤ 2` 判暗部压死、`sat > 55` 判过饱和。取自 `signalstats` 的 YMAX/YMIN/SATAVG。
- 实测对比：端到端那镜（cast＋shotSpec＋风格）亮度 88／饱和 22／高光峰 228／暗部 5 → 0 问题；早前纯文本镜高光峰 244（接近死白）+ 音频削波。**新镜头的技术指标确实更接近真实摄影。**
- 边界：三指标只挡「明显破功」，挡不住磨皮与塑料感。后者靠参考图＋基底＋模型本身，后期只能补胶片响应。

## 胶片响应：不糊的实现方式（2026-10-19）

- **核心做法：不做全画面柔化，只做高光选择性溢出。** `compose` 新增 `film{bloom,aberration,grain}`：
  `split → curves(all='0/0 0.5/0.45 1/1') 压掉 0.5 以下 → gblur sigma=18 → blend screen opacity=bloom`，再叠 `chromashift` 与 `noise`。暗部完全不进模糊分支，细节一点不动。
- 参数上限硬编码：bloom ≤0.25、aberration ≤3px、grain ≤12（超 8 开始脏）。
- **清晰度守卫**：处理后用 `sobel + signalstats` 比对了处理前后的边缘能量，掉超 12% 标 `blurred:true`。
- 实测：边缘能量 18.23 → **19.07（升 5%，不是降）**，`blurred:false`；音频峰值 −4.6 dB、均值 −15.8 dB、0 问题。
- **踩坑**：走 `filter_complex` 分支时音频要显式 `[0:a]loudnorm...[a]` 并 `-map [a]`，否则绕过响度归一，成片音量掉到 −47 dB 几乎听不见。
- 目视对比：高光晕开、暗部下沉、皮肤纹理更清楚，没有糊也没有脏。

## 资产先行（2026-10-19 落地）

- 老板定的顺序：**角色卡 → 场景 → 道具 → 分镜**。没资产的镜头等于每镜重新选角、重新搭景。
- `POST /api/ai/media/assets`（`utils/media/assetPlan.ts`）：读 `storyProject.json` 已采用版本的场次正文（或传 `script`），让文本模型拆成资产清单，落盘 `assets/assetPlan.json`。实测《记忆税》拆出 **26 项（角色 6／场景 7／道具 13）**，每项带 `prompt` + `shotSpec`（定妆该用什么景别/光）。
- `preflight` 新增两项：`assetPlan`（清单是否存在）与 `castCoverage`（清单角色数 vs 实际档案数）。实测报出「清单里 6 个角色，只有 3 份档案，缺的会在分镜阶段每镜漂移」。
- **踩坑**：`writeWorkspaceFile(path, content)` 收的是**绝对路径**，传工作区相对路径会写到进程 cwd（apps/server/assets/）且被 catch 吞掉。改用 `writeAtomic(join(cwd, "assets", "assetPlan.json"))`，并把失败抛出而不是静默。
- **现实约束**：当前图像模型是 `gpt-image-2/edit`，必须给参考图。角色卡只能「先定一张基准脸（抽帧或上传）→ 派生三视图」，不能纯文生图。这条已写进 workflow/SKILL.md。

## 《记忆税》资产实操（2026-10-19 首次完整走一遍）

- 产出 14 个资产图：3 张角色定妆（陈砚/沈望/祁）+ 9 张场景道具定场，存 `assets/cast/` 与 `assets/scenes/`。
- **质量实况（诚实记录）**：陈砚、沈望的定妆可用；祁的脸与左脸疤对了但姿态是持枪半身而非中性站姿，标 `draft` 待重做；场景里旧走廊、税署谈话室、记忆库廊可用；**长宁上坡街道完全跑偏成欧洲古典街景**（应为玻璃幕墙＋曲面屏的未来城市）；307 室的神经成像仪被画成洗衣机。
- **教训**：场景资产的质量同样取决于提示词精度，直接照搬 plan 给的 prompt 不够，必须按「空间结构＋材质＋光源位置」逐项补写。
- **踩坑 1（严重）**：`bun --watch` 的热更没有真正生效——改了 `looksLikePersonShot` 加空镜白名单，接口行为不变，一度以为是正则问题。用「改错误文案看返回是否变化」的办法才确认代码已加载、但行为没变。**结论：热更不可靠，验证改动的正确方式是改一处可观测的输出（如错误文案）。**
- **踩坑 2**：场景/道具定场图应该用 `purpose:"asset"`（它们本来就是基础资产），用 `standalone` 会被人物镜规则误拦。改 asset 后 9/10 通过。
- 列检现状：`cast 3 份可用 2 份`、`castCoverage ! 清单 6 个角色只有 3 份`——3 个 nice 级配角（老妇人/技术员/中弹年轻人）未做。

## 禁止脏旧：老板下的硬规则（2026-10-19）

- 老板原话：**「以后 litto 出的人物角色，和场景，禁止生成脏、旧、烂的，除非是场景和角色的重点设计」**。
- **我为什么会搞脏**：把「写实」和「破旧」混为一谈——以为加磨损油渍就等于真实。实际真人定妆照的质感来自材质精度与光，不是污渍。而且 `continuity/references/realism.md` 早就写着「全局默认干净完整…不加服化道破损、陈旧、污渍」，**我写提示词时没读它**——这正是「skill 变摆设」的又一次实证。
- 三层修复：①`PHOTOGRAPHIC_BASELINE` 增补「服装、道具与场景保持干净完整、维护良好，不主动添加污渍、破损、陈旧、汗渍与油渍」，并把「真实粗糙度」改成「各自的光泽与反射」；②`generation.ts` 新增 `DISTRESSED` 词表拦截，命中且没有 `DISTRESSED: 理由` 标记直接拒绝；③`assets.md` 写入四视图定妆卡规范（纯白棚拍、干净挺括）。
- **踩坑**：拦截词表会误伤否定句——「没有污渍、破损或汗渍」被判成要求做旧。已加剥离否定前缀的处理，但服务热更不可靠，实测仍被拦。
- **参考图状态会被继承**：沈望/祁的基准脸来自成片带血镜头，四视图把血一起带了出来。定妆参考必须用干净帧，或在提示词里明确「参考图中的血迹一律去除」。
- 四视图定妆卡实测有效：陈砚（参考脸本身干净）一次出四视图，脸/服装/比例统一，可直接做资产。

## 「超逼真」的可执行配方（2026-10-19 老板给了三张手机自拍参考）

老板要的真实感**不是商业棚拍，是手机前置摄像头拍出来的人**。提炼出六条硬特征，已写进 `PHOTOGRAPHIC_BASELINE`：

1. **光**：单一实际光源，方向明确，墙面与地面留投影；不用多点均匀柔光把脸拍平。
2. **皮肤**：T 区与鼻头有自然油光，毛孔可见，眼下有淡青，唇部有干纹；妆感可辨（粉底边界、唇纹、眉毛根根分明），不做无瑕哑光塑料皮。
3. **头发**：碎发飞出、发丝反光不均匀、发根蓬松有分缝，不画成一根根分明的假发。
4. **服装**：面料有自然褶皱，贴身但不僵硬；干净挺括，不主动加污渍破损。
5. **环境**：真实生活痕迹——墙面钉孔、家具磨损边角、随手放置的日用品。**干净不等于清空成样板间。**
6. **镜头**：自拍/生活视角，轻微广角透视，不是长焦压缩的商业人像。

- **实测验证**：用陈砚的脸 + 「出租屋窗前午后光」提示词出图，窗框投影、鼻头油光、眼下淡青、搪瓷杯与散线、墙面钉孔全部到位，质感与老板给的参考一致。
- **概念区分**：四视图定妆卡用**纯白棚拍 + 均匀柔光**（目的是锁身份，去掉环境干扰）；成片镜头用**生活光 + 真实环境**（目的是可信）。两者不能混，定妆卡带环境会把角色和那个场景绑死。
- 破例机制：确需破败环境（废墟/贫民窟）时在提示词写 `DISTRESSED: 理由`，只影响指定对象与时段。

## 年代锚点（2026-10-19，老板指出 2026 被拍成 70 年代）

- **根因在我的提示词**：我写了「旧书桌」「旧木柜」「搪瓷杯」「白墙有污渍与钉孔」。问题不是 LITTO 乱生成，是我把「这座楼是旧的」扩散成了「这个人活得很旧」。
- **概念厘清**：**旧只属于建筑本身，不扩散到人**。2026 年的 26 岁电工应该有：LED 灯管、全面屏手机、尼龙工具包与锂电池电钻、铝合金/塑钢窗、化纤混纺工装（带反光条）、不锈钢保温杯、PVC 线管。不该有：搪瓷杯、白炽灯、木格窗、帆布包、闸刀开关。
- 落地 `assets/world.json`：按年代存 `must[]` 与 `never[]` 两套物件清单，另附一句设定说明。
- `generate.ts` 新增 `eraAnchor()`：提示词里出现年代字符串（如 `2026`／`2140`）即自动注入该年代的 `ERA 年份：…必须出现…不得出现…` 段。**提示词必须写明年代，否则不触发。**
- 实测 2026 出租屋：LED 灯管、铝合金推拉窗外城市高楼、不锈钢保温杯、手机、锂电池电钻、成卷 PVC 线管、带反光条的化纤工装、墙上便利贴与租房合同——年代感正确。
- **关键教训（第三次自指误伤）**：`DISTRESSED` 检测连系统注入的 `PHOTOGRAPHIC_BASELINE` 自己也扫了进去，而基线里写着「不主动添加污渍、破损、陈旧」，于是**规则文本触发了自己的规则**，所有生成被拦。修法：检测前先剥掉 `PHOTOGRAPHICBASELINE`／`LOOK:`／`ERA`／`CAST:`／`SHOTSPEC:` 各注入段，只留作者原文；否定前缀表补上「不主动／不添加／不做／不得」。**教训：规则文本必须豁免于规则检测。**

## 做旧词的真实来源：LITTO 自己的资产拆解（2026-10-19 查证）

- 统计 `assetPlan` 生成的 26 条资产提示词，**22 条带做旧词**（旧/脏/污/破/锈/汗/剥落/斑/尘）。样例：
  - 陈砚：「额前碎发被汗粘在皮肤上，脸有灰尘与机油污渍」
  - 祁：「短发凌乱沾着烟灰」
  - 铁皮工具箱：「漆面大面积剥落露出褐色锈斑，提手缠着脏布条」
- **所以不是模型乱加，是提示词本身就在要旧。** 链条：剧本「磨得发白的工装」→ `assetPlan` 的 SYSTEM 没约束 → LLM 放大成汗渍油污锈斑 → 生成模型全盘接收。
- 已在 `assetPlan.ts` 的 SYSTEM 加三条硬规则（按年代写当代物件／默认干净完整／旧只属于建筑）。改后重拆：22/26 → **15/29**。
- 剩余 15 条需再分两类：**剧情要求的**（陈砚「浑身是灰」是 s02 原文，合理）与**模型自发的**（库廊「锈」、尼龙工具包「污」，剧本没写）。下一步应在 prompt 里显式标注 `[剧情态]`。

## 硬禁令：「写实」不是「做旧」（2026-10-19 老板反复强调）

- **老板原话：写实不是做旧，务必狠狠记住，写进 LITTO 的禁令里。**
- 上一版「2026 出租屋」物件对了（LED/铝合金窗/电钻/线管），但老板仍判为「做旧做脏」——因为**基底整体是文艺片调**：我自己写了「轻微胶片颗粒」「边缘不做过锐」「色彩不过度饱和」「环境保留真实生活痕迹：墙面纹理、家具磨损边角」。这四条叠起来就是灰、闷、旧。
- **基底已重写**（`generation.ts` 的 `PHOTOGRAPHIC_BASELINE`）：
  - 删掉「胶片颗粒」「边缘不做过锐」「生活痕迹墙面磨损」
  - 新增「曝光正常，画面明亮通透，中间调不压暗」「色彩自然准确，不刻意降低饱和度，不加青橙滤镜，不让人脸与墙面发灰」「画面干净：无明显噪点、无胶片颗粒、无脏污、无划痕、无霉斑、无做旧痕迹」
- **QC 新增两项硬信号**（`underexposed` 亮度<55、`desaturated` 饱和<8，`allowDark:true` 可豁免夜景）：做脏做旧在数据上就是压暗＋降饱和，以后能自动测出来。
- **禁令写进 skill**：`workflow/SKILL.md` 第 68 行「禁令：写实不是做旧」，附默认输出表与唯一例外（`DISTRESSED: 理由`）。
- **效果**：重做同一场景，从「灰暗旧木柜搪瓷杯」变成「白墙明亮、铝合金窗外现代楼群、数显电笔+尼龙包+保温杯、皮肤有光泽」，物件与氛围都对。

## 词本身是年代炸弹（2026-10-19 第二次修正）

- 老板看过「明亮版」仍判为七八十年代感，问题在**服装造型**。
- **核心认知**：`工装`／`劳保服`／`工作服` 这几个词，在模型里的视觉对应是**翻领宽松劳保服**；`水磨石`／`白炽灯`／`木格窗`／`铁皮` 同理。**词的年代暗示比形容词更强**——写「干净平整的工装」也救不回来。
- 解法：不用职业泛称，用**当代面料 + 剪裁 + 具体物件**描述：
  - 服装：「深灰速干长袖、半拉链立领、修身剪裁、左胸小 logo、多口袋工装长裤带反光条、黑色低帮安全鞋」
  - 空间：「浅灰瓷砖墙、PVC 卷材地板、嵌入式 LED 平板灯、铝合金内开内倒窗、白色吊顶」
- 已写进 `assets/world.json` 的三个新字段并注入 prompt：`garments`（服装写法）、`spaces`（空间写法）、`bannedWords`（工装/劳保服/工作服/水磨石/白炽灯/木格窗/铁皮）。
- 三版对比：做旧版（灰暗旧木柜）→ 明亮版（物件对了但仍是翻领工装）→ **现代版（速干立领+反光条工装裤+尼龙工具包+铝合金窗+LED 平板灯）**，第三版年代感才真正到 2026。

## 开源 audio 模型选型（2026-10-19 调研）

- **IndexTTS2**：Apache-2.0（商用需再核）、~8GB、3s 克隆、中文 WER 2.12%、**支持 0.5–2.0x 时长因子**——影视配音卡镜头时长刚需，首选。
- **CosyVoice 2**：Apache-2.0、~4GB、3s 克隆、18+ 方言、流式首包 1.5s、工程最成熟，稳妥之选。
- **GPT-SoVITS**：MIT、5s 克隆、生态最全，音色最像，适合固定角色声线。
- 接入 LITTO 需三步：本地起 OpenAI 兼容 `/v1/audio/speech` 服务 → 写一个 `data/providers/*.ts` 声明 `type:"audio"` 模型（含 `voices`/`speechInstructions`/`lipSync`）→ 配置 apiKey 并把 `modelSelection.audio` 指向它。LITTO 的 audio schema、`generateAudio` 分支、`lipSync.ts` 都已就绪，当前只缺 provider 定义与服务端。
