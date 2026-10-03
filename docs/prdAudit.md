# LITTO V3 要求核查

核查日期：2026-10-03。代码基线：`5a3929c`。当前阶段为要求与实现核查，不实施整套 V3。

## 依据与可见范围

- 原始对话：[分析AI塑料感原因](https://chatgpt.com/c/6ac0cafb-d9e0-83e8-bb95-aedd36a71600)。应用读取工具返回最后 6 轮，无更早分页；浏览器未登录，不能核实开头到结尾的全部内容。
- 已完整读取用户本地 `Downloads/LITTO_PRD_V3.0.md`，500 行。对话结尾明确指定 V3.0 替代 V1 / FINAL，并确认 Music Film 为一级核心模块。
- [仓库 PRD](prd.md)来自上述 V3 文件；仅将仍残留的首行 FINAL 标题改为对话最终确定的「LITTO｜里头 PRD V3.0」，其余正文保留。
- 原下载文件 SHA-256：`0893c4db308c6df58962c450971ef479627bfcdcd63aee8734783ec0520ec181`。
- 本核查以 V3 文本和可见对话结尾为依据，不能声称覆盖此前对话中未纳入 V3 的额外要求。

## 结论

**当前产品未满足 V3 黄金路径和 Music Film 验收。** 已有 Toonflow 画布生成引擎、LITTO 平台与领域后端原型、自有电影/广告/连续性技能；但当前前端仍主要操作文件画布，未接通领域制片链路。

复用 Toonflow 底座本身合理；主要问题是 LITTO 的领域数据、编译、参考路由、任务和审批没有成为当前生成入口的真实业务来源。修改品牌、入口名称或补写技能无法代替这些功能。

本轮没有调用付费图片、视频或音乐服务，没有验收真实成片质量；以下「已有」表示检查到相应代码，不能等同于真实服务端到端通过。

## 两条生成链路尚未统一

当前页面：

`首页创建工作目录与画布 JSON → 图片/视频节点 → nodeAi → /api/ai/media/generate → generateMedia → 媒体供应商脚本 → 工作区文件`

证据：[首页](../apps/web/src/pages/home/index.vue)、[节点请求](../packages/nodeScaffold/src/nodeAi.ts)、[媒体接口](../apps/server/src/routes/ai/media/generate.ts)、[执行与保存](../apps/server/src/utils/media/generation.ts)。该接口等待生成完成才返回，监听请求关闭并取消；没有创建持久化 GenerationJob。

云端领域链路：

`/cloud production API → Project/World/Asset/Shot → compileShot → Router → enqueue → Keyframe/Take → Promote/Approve → Continuity/QC → Assembly`

证据：[表结构](../cloud/src/db.ts)、[领域路由](../cloud/src/routes/production.ts)、[编译器](../cloud/src/domain/compiler.ts)、[生命周期](../cloud/src/domain/lifecycle.ts)、[任务队列](../cloud/src/jobs.ts)。云端已挂载且启动 worker，但当前前端及节点请求未使用这条制片链路；模型接入向导也未使用它的 Provider/Model/Credential Registry。

## 图片与视频要求

| V3 要求 | 当前状态与证据 | 尚缺什么 |
| --- | --- | --- |
| Prompt 从 ShotSpec、Skill、Adapter 编译 | 云端 `compiler.ts` 存在；当前节点提交自由文本 | 页面生成必须绑定真实 Shot ID，读取领域规格并编译，不能仅靠 Agent 写长 Prompt |
| World / Look / Asset 独立持久化 | 云端有表及接口；页面保存文件画布；电影技能建议写 Markdown | 将当前项目映射到云端 Project，接入设定、资产与镜头编辑；同步坐标与领域 ID |
| Reference Role 与 LOCK / CONTROL / ALLOW / RANDOM | 云端编译器有角色能力映射；节点有参考输入；自有技能有文字规范 | 页面需持久化用途、权重、锁定级别并显示降级；实际 Adapter 发送的输入必须与能力声明一致 |
| 图片身份、服装、产品、空间与影调一致 | continuity/cinema 技能已覆盖部分规则；云端有锁定与状态代码 | 用真实多视图资产与引用驱动生成，输出后核验；尚无当前页面的自动画面一致性闭环 |
| 多个关键帧，选择 Hero Frame，再生成多个 Take | 云端 `lifecycle.ts` 有实现；页面只有节点媒体历史及手动定稿 | 镜头条需展示真实 Keyframe/Take 版本及审批状态；`shotFinalizedPath` 不等于领域 Promote/Approve |
| 已采用版本不可静默覆盖、可回滚 | 云端保留关键帧/Take 与审批事件；技能要求另建版本 | 节点输出、Agent 操作和领域审批之间需统一权限与版本保护；当前节点元数据勾选不能提供此门禁 |
| 刷新/退出后生成不丢，支持队列与失败恢复 | 云端队列存在；当前媒体接口绑定请求生命周期 | 页面与 Agent 都改为创建、订阅、取消持久化 Job；关闭连接与取消任务必须区分 |
| 按模型实际能力执行 | 当前节点配置动态读取；云端有 Router | 上游 `workflow` 第 23 行起却对定稿剧情的视频任务强制锁存 Seedance 2.0/2.5；须改为通用流程，模型专用规范仅在实际选用该模型时生效 |
| 有原因与 Repair Action 的 QC | 云端有规则型 continuity、QC、可选视觉观察 | 当前工作区没接入；`qc-vision.ts` 只对可读静态栅格图片观察，不能据此证明视频运动、口型、音画同步通过 |
| 多模型参考与首尾帧/运动/音频输入 | 节点按实际媒体配置支持部分模式；云端编译器包含这些 Role | 云端 OpenAI Adapter 视频分支主要发 START_FRAME，未完整发送所有声明支持的参考类型；参考不能只在编译结果标为 sent |
| 真实成本与 BYOK 凭据保护 | 页面有用量回执与返回 Key 掩码；云端有 AES-GCM Credential | 当前接入向导把 Key 保存到租户 settings.json，未启用静态加密；云端 OpenAI Adapter 与 webhook 路径还有 0.04/图、0.05/秒等兜底费用，不能当实际成本 |

重要区别：当前用量小条与旧云端账本是不同链路。上一轮「未配单价不编造金额」适用于新增用量回执，不能推广为整个云端成本系统都满足该要求。

## 技能来源与质量约束

- `canvas` 与 `workflow` 来源于 Toonflow，保留作者与上游出处；`workflow` 已有真人电影及 Seedance 提示词细则，但存在全局强制模型、硬隔离与「不做 MV 式快剪」等局部规则。
- `cinema`、`adfilm`、`continuity` 是 LITTO 自有技能，覆盖电影镜头、产品与跨镜一致性的一部分要求；目前没有完整的七岗位结构化技能协议。
- 当前 `cinema` 把生成执行交给旧 `workflow`，因此新增电影规则仍可能在执行阶段受旧规则覆盖；需要先拆清通用制片和模型专用规则的作用范围。
- 云端 `domain/skills.ts` 另有岗位逻辑与启发式分镜，`director.ts` 可选 LLM refine；这与文件技能是另一套体系。启发式固定时长/镜头补足不能作为高质量导演能力的验收证据。

电影质量不能靠更换入口名称保证。应以资产一致、可解释的摄影/光线、可信表演与物理、邻镜连续、真实输出检查作为验收对象。

## Music Film / MV

当前可上传/引用普通音频，有音频节点、云端 NLE 的音乐轨道与基础 Assembly 代码；这些不等于 V3 Music Film。

| V3 Music Film 验收 | 当前状态 |
| --- | --- |
| 独立 Music Film Project 与完整音乐/歌词输入 | 未见当前入口、项目类型和歌词导入链路；普通音频输入仅是基础 |
| BPM、tempo changes、beats、downbeats、bars、phrases、sections、能量/情绪分析 | 未见 MusicAnalysis 数据模型、分析 Adapter 或可编辑结果 |
| 无时间码歌词自动对齐、confidence 与 unmatched lines | 未见歌词对齐服务、歌词行/词表和低置信度界面 |
| 2–4 套方向，验收至少 3 套；Narrative / Mood / Hybrid / Experimental | 未见对应流程、方案审批或音乐视觉世界约束 |
| Music Timeline 与 Sequence/Shot 双向关联 | 只有通用 NLE，未见 Beat/Bar/Section/Lyrics 等轨道及 ShotMusicBinding |
| 六类同步模式与有意的不同步、乐句规划、副歌母题变化 | 未见相应生成规格、动作/摄影机时间绑定和剪辑逻辑 |
| Music Analyst / Lyrics Director / Music Film Director / Rhythm Editor | 产品的文件技能中尚无这四类音乐岗位技能 |
| 3–5 分钟作品按 Sections → Shots → Hero Frames → Takes → Assembly 制作 | 有通用片段能力，未接通完整歌曲覆盖、章节制作与导出验收 |
| 音乐专用 Provider Capabilities 与 QC | Registry 未包含 V3 新增的分析/对齐能力，未见音乐覆盖与视听关系检查 |
| 音乐项目持久化 | 现有 migration 无 V3 的 music_projects 等 14 类音乐表 |

**判定：MV 核心模块尚未实现，不能标记为完成。** 不能用「加一个 MV 按钮 + 上传 MP3 + 写音乐 Prompt」代替这一模块。

## 后续实施顺序

1. **统一生成与安全地基。** 当前项目、模型向导、凭据及节点/Agent 生成接入已有领域 Registry、加密 Credential 和持久化 Job；清除硬编码实际费用。确认合法的本地单用户模式边界。
2. **接通制片黄金路径。** World/Look、资产版本、ShotSpec、ReferenceRole、Hero Frame、Take 审批与状态继承在当前画布和镜头条真实可操作；区分人工验收、规则检查和视觉检查。
3. **校正技能执行范围。** 通用电影/广告/音乐流程输出结构化规格；Seedance 等规范仅约束对应模型 Adapter/编译策略，不全局覆盖用户目标。
4. **独立推进 Music Film。** 音乐/歌词输入 → 可编辑音乐分析与对齐 → 至少三套方向 → 时间轴与镜头绑定 → 分章节关键帧/Take → 全曲组装/QC/导出；先跑通一段代表性章节，再验收完整歌曲。

每步按用户明确指定阶段实施，复用既有后端与画布，不一次性大重构。仓库 AGENTS.md 禁止新增测试文件；验证采用类型检查、构建、已有检查入口和实际手动黄金路径，不按 PRD 的旧测试要求另建测试文件。
