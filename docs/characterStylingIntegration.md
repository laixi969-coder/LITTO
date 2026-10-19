# 妆造与表演方法升级

## 2026-10-13：选角、角色生成与全局画面默认值

本次从 workflow → assets / visualDesign / characterStyling → Character、Wardrobe 与参考绑定 → workspaceMedia → compileWorkspacePrompt / compileShot → autoObserve 梳理现有链路。已有身份不变量、当前妆造、服装 wornBy、镜头状态和表演方法，继续复用，不新增表单、资产类型、供应商或审批阶段。

- 新增[选角与角色生成](../packages/skills/workflow/references/methods/characterCasting.md)：电影侧重角色任务与表演，MV 侧重音乐、身体与造型编排，广告侧重品牌、产品互动与观看层级。候选比较按需进行，已有明确人物直接复用，不自动增加出图或试镜次数。
- 结合本地 Casting Studio、Higgsfield、南鸢摄影方法和 Naga 连续性方法，分开身份、造型、摄影与当场状态；已采用的人物主参考用于核对身份，服装/妆发/构图参考不得换脸或覆盖未授权内容。来源版本、取舍和许可见[来源记录](../packages/skills/workflow/references/methods/characterCastingSources.md)。另外两份研究材料未取得完整根许可证，没有复制模板或脸型库，使用现有面部设计和资产状态能力满足对应需求。
- 在共享 visualDefaults.ts 中定义“干净、完整、清晰”和参考职责，接入普通生成及所有正式镜头编译分支；规则在模型专用重排后加入，补上 Vidu Q4 精简格式遗漏完好状态约束的问题。静帧、视频、Seedance MV 都保留规则；未改媒体模型选择。
- 明确例外只来自用户要求或已确认剧情/状态，限定对象与时段。夜景仍是夜景；旧皮箱不做旧衣服；指定年龄、自然纹理、景深和已成立的损伤不被磨平或复原。同步收紧摄影方法中自行增加颗粒的建议。
- autoObserve 复用同一默认规则，并传入资产、起始状态、计划变化与参考职责；角色权威参考进入实际图片输入，索引明确标识已发送/未发送。仍最多发送四张去重参考，超限引用标为未发送，不能宣称全量视觉核验；采样与真实观察局限保持。

验证：cloud 与 server 类型检查通过，server 构建通过；临时数据库内实际调用资产、镜头及编译 API，四种编译分支与四种普通请求均保留默认规则和原请求，夜景、局部磨损、服装归属与 MV 切点保留，源资产未被编译改写。观察入口通过本地执行器桩核对真实图片输入、身份参考索引和状态上下文，属于接线验证，不是模型视觉验收。六份方法文档的 67 个本地链接可解析。未新增测试文件，未调用付费生成或外部视觉模型，未修改真实用户配置。

构建技能副本与源码一致，git diff --check 通过；临时夹具修正后完成上述检查，异步派生图留下的临时目录也已清理。真实角色美感、服化道效果与动态试镜仍待实际生成验收。

## 2026-10-09：已有妆造与表演接入

2026-10-09，针对“LITTO 是否缺少妆造、情绪演技设计，缺少时从 GitHub 补齐”的要求实施。

## 取舍

现有 performanceDirection 已覆盖人物目标、潜台词、触发、倾听、群像与声音，不再建立重复的表演技能。缺口在妆发服饰的具体设计、与剧情状态的连接及实际生成约束，新增 [characterStyling](../packages/skills/workflow/references/methods/characterStyling.md)，通过 workflow / breakdown / cinema / musicfilm 按需读取。没有新建表单、依赖、服务或资产类型。

筛选 GitHub 后局部改编 starramble/design-transformation-video-skill 与 Litreily/codex-skill-eastern-beauty-director；已读取固定提交源码及 MIT 许可证，保留版权声明，详见[来源与许可](../packages/skills/workflow/references/methods/characterStylingSources.md)。未导入固定竖屏时长、性格绑定脸型、全系列强制换脸、固定东方女性审美等规则。另两个候选未查到覆盖目标内容的明确许可，未采用。

## 第一性检查与修复

造型需要回答“这个人物在这个时刻如何出现、为什么变化”，并进入真实生成请求。沿用 Character.attributes.styling、Wardrobe.attributes.wornBy、reference binding notes、action / performance / musicVideo.timeline 和 intendedStateDelta。attributes.styling 是内容约定，不是新增强类型校验或自动造型选择器；候选比较与全片状态表不写进会被全部编译的当前资产属性。

检查所有 compileShot 调用方，共用编译入口修正三处冲突：

1. 衣物结构一律跨帧不变，会抵消画内换装/开扣等明确动作。改为只在指定动作或时间点允许已计划变化，身份与未变化细节仍保持。
2. Seedance 2.5 MV 将起始状态放入 Immutable locks，会把“入场穿着什么”变成全程冻结。起始状态移入 Visual direction 并说明其时序意义，真正的不变量仍留在锁定栏。
3. Preserve 重复全部资产属性，会把旧妆再次锁定。改为身份与未变化细节；通用优先级明确当前连续状态优先于基础资产可变外观，但不能覆盖明确身份不变量和禁止变化项。

新增表演内容仅处理混合情绪如何变成可读行动、习惯与当场策略的区别、造型是否遮挡或限制表演。仍由既有字段和审批机制执行，不把花妆等同于悲伤或把静帧当作演技证明。

## 对抗审查与实际验证

逐项审查换唇色换脸、参考模特污染身份、后态配饰提前出现、多套候选同时输入、卸妆后切镜自动复妆、舞台装污染剧情线、变体丢伤痕、面纱遮口型及服装锁抵消动作。规则修复不等于模型已按规则生成。

使用一次性临时数据目录和内联 Bun 手动执行真实 workspaceProduction、资产与 compileShot 链路，完成：

- 当前妆造与服装归属读写、参考用途和表演字段编译保留。
- Seedance 2.5 的身份锁保持、起始服装不进入永久锁、Preserve 不重复旧妆、计划变化保留。
- 后镜继承计划擦妆结果，提示词明确连续状态优先；普通镜头和图片不误入 MV 时间轴模板。
- 缺图/不支持参考时显式降级，LOCK 参考未送入时拒绝继续。
- Approved 资产禁止覆盖，另建变体不修改原始妆造。批准记录仅为临时合成数据，不是媒体审查。

首次内联验证的项目夹具误填不存在的 data 列，未进入业务验证；移除错误字段后上述验证通过，临时目录已清理。未新增任何测试文件、框架或自动检查入口；未使用付费生成，真实妆造、演技与跨镜视频效果尚未验收。

cloud 与 mediaGeneration 类型检查通过；server（含团队/MCP/技能复制）与 mediaGeneration 构建通过。11 个相关 Markdown 文件的 84 个本地引用可解析，技能构建副本与源码一致；git diff --check 通过。本轮未改前端或 HTTP 路由，不重复无关检查。

## 后续修订：唱跳 MV 的多造型

按用户补充，唱跳/舞台/时尚表演 MV 可用音乐段落、舞蹈和剪点驱动多套妆发服饰，不要求换衣剧情。短片、电影及 MV 连续剧情仍按对应时空接戏；混合 MV 分线核对，身份跨造型保持，各套造型只在指定镜头或时间块内稳定。

同步修正 musicfilm、妆造方法、workflow、Seedance 规则，以及 continuity 的主入口、核对表和修复表，删除将发型服装无条件锁到全片、换装必须是剧本事件的冲突要求。既有 timeline 与参考 notes 可表达指定切点，无需新增代码字段；现有状态引擎按 sequence 继承，方法明确用独立单元隔离互不连续的状态，不声称 sceneId 会自动重置妆造。对抗核对覆盖唱跳计划换装、连续剧情无故换装、混合 MV 回切原状态与单段内指定造型切点。

本次仅修改技能与记录。server 构建通过，10 个相关文档的 66 个本地引用通过，技能打包内容与源码一致，git diff --check 通过；未新增测试文件，未执行媒体生成。
