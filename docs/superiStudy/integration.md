# 已学成果落地记录

范围：仓库当前已有的 53 篇学习记录，逐篇落实到 Milimili 内置制作技能和模板；不代表全站教程已学习完。每篇记录中的素材检查范围与未验证项继续有效。

## 实际接入

- [制作技能加载](../../apps/server/src/agent/skills/production.ts)：按作品类型和任务读取模板，沿用工作区覆盖和读取权限。
- [资产提示生成](../../apps/server/src/utils/media/assetSheet.ts)：人物、场景、道具分别按身份/结构/当前状态生成，统一默认设定板布局，尊重指定画风与版式。
- [制作流程](../../packages/skills/workflow/SKILL.md)：按任务路由到现有模板；已学内容复用既有镜头、资产、连续性与声音字段。
- [五块提示模板](../../packages/skills/videoPromptDirector/references/fiveBlockWriting.md)、[分段规划](../../packages/skills/videoPromptDirector/references/segmentPlanning.md)、[完整示例](../../packages/skills/videoPromptDirector/references/examplePrompt.md)：实际能力、参考编号、时序和声音容量共同决定生成规格。
- [连续性验收](../../packages/skills/continuity/references/shotChecklist.md)、[失败修复](../../packages/skills/videoPromptDirector/references/failureRepair.md)、[状态与交付](../../packages/skills/workflow/references/stateAndDelivery.md)：按实际证据定位问题，修订传播到受影响镜头，不把文字审核当成片验收。

## 逐篇对应

以下每项均已写入所链接的执行模板；其中方法的效果仍需具体项目实片验证。

| 学习记录 | 已落实内容 | 主要落地位置 |
|---|---|---|
| [2603｜室内光线：来源、衰减与反射路径](lessons/lesson2603.md) | 实体光源、衰减与反射路径 | [执行模板](../../packages/skills/workflow/references/methods/colorAndLight.md) |
| [2604｜镜头“发现”与延迟跟随：可选纪实语法](lessons/lesson2604.md) | 发现式跟拍按目的选择，不默认抖动 | [执行模板](../../packages/skills/cinema/references/shotLanguage.md) |
| [2607｜UGC首尾帧接续：端点、持物、表演和声音一起检查](lessons/lesson2607.md) | UGC首尾帧与中间动作、持物、声音共同核对 | [执行模板](../../packages/skills/adfilm/references/creativeTranslation.md) |
| [2621 环境决定真实（正文及图片核对）](lessons/lesson2621.md) | 天气、环境接触与材质状态有依据 | [执行模板](../../packages/skills/workflow/references/methods/colorAndLight.md) |
| [2634｜从动作清单到状态流](lessons/lesson2634.md) | 状态流保留过程因果，不删关键动作 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [2637｜AI 微表情的精准控制](lessons/lesson2637.md) | 表演强度按景别与情境选择 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [2647 明暗、冷暖与虚实（正文及图片核对）](lessons/lesson2647.md) | 明暗、冷暖、虚实分别服务观看职责 | [执行模板](../../packages/skills/workflow/references/methods/colorAndLight.md) |
| [2753｜全景虚拟影棚：固定母图取方向，不等于重建三维场地](lessons/lesson2753.md) | 全景母图只提供投影方向，不保证三维平移 | [执行模板](../../packages/skills/workflow/references/methods/visualDesign.md) |
| [2769｜双人K-pop MV：音乐、资产、分镜与多次生成剪辑](lessons/lesson2769.md) | 原曲、乐句、唱跳身份、动作相位与音乐字段 | [执行模板](../../packages/skills/musicfilm/references/musicVideoDirection.md) |
| [2771｜光影重构：先说明受光结果，必要时去光再重布](lessons/lesson2771.md) | 去光作为可选处理中间态，不冒充albedo | [执行模板](../../packages/skills/workflow/references/methods/colorAndLight.md) |
| [2785 角色语气、语速与音色（正文及画面抽样，声音待听）](lessons/lesson2785.md) | 声音身份与逐句表演分开，未听不声称已验收 | [执行模板](../../packages/skills/cinema/references/coverage.md) |
| [2793｜角色活人感的三种提示方法](lessons/lesson2793.md) | 注意对象与身体任务驱动活人感 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [2794 视频提示词优化三法（正文及素材抽样）](lessons/lesson2794.md) | 消解同段冲突，明确时序与参考职责 | [执行模板](../../packages/skills/videoPromptDirector/references/fiveBlockWriting.md) |
| [2797｜从面部、肢体和环境声音塑造表演](lessons/lesson2797.md) | 面部、肢体、道具与声音共同表达 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [2829｜画面结构拆解：观察、改编与真实执行分开](lessons/lesson2829.md) | 观察、推断、改编与真实执行分开 | [执行模板](../../packages/skills/cinema/references/shotLanguage.md) |
| [2832｜用户指定目标：人物处境与可见反应](lessons/lesson2832.md) | 人物处境、目的、触发与可见反应 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [2836 从角色创建到电影镜头（正文及素材抽样）](lessons/lesson2836.md) | 运动、身份与空间分别检查 | [执行模板](../../packages/skills/cinema/references/shotLanguage.md) |
| [2838｜自然动作：起终、身体任务与角色回应](lessons/lesson2838.md) | 起终状态与身体行动联动 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [2841｜四种环境一致方法：先建立采用空间，再选可用视角](lessons/lesson2841.md) | 按已有空间和可用视角选一致性方法 | [执行模板](../../packages/skills/workflow/references/methods/visualDesign.md) |
| [2843｜用妆造提升 AI 角色质感](lessons/lesson2843.md) | 妆造状态、身份依据、当前采用与回滚版本 | [执行模板](../../packages/skills/workflow/references/methods/characterStyling.md) |
| [2899｜五种打光：从光源、受光区到暗部与补光](lessons/lesson2899.md) | 照明维度按用途组合，不机械互斥 | [执行模板](../../packages/skills/workflow/references/methods/colorAndLight.md) |
| [2901｜原创脸部设计：结构关系、参考用途与可变妆造](lessons/lesson2901.md) | 身份结构协调与可变妆造分开 | [执行模板](../../packages/skills/workflow/references/methods/visualDesign.md) |
| [2907｜角度、距离与观看关系：别把焦段当情绪按钮](lessons/lesson2907.md) | 相机位置、距离与焦距独立描述 | [执行模板](../../packages/skills/cinema/references/shotLanguage.md) |
| [2909｜资产体系：按有效信息建档，按实际像素验收](lessons/lesson2909.md) | 按实际有效信息建资产，不把视图数量当完整度 | [执行模板](../../packages/skills/workflow/references/methods/visualDesign.md) |
| [2916｜复古服装品牌片：参考职责、局部触感与镜头选择](lessons/lesson2916.md) | 服装展示参考与剧情执行分开 | [执行模板](../../packages/skills/workflow/references/methods/visualDesign.md) |
| [2917｜俯视调度图：把场地、站位、人物与相机路线分开](lessons/lesson2917.md) | 人物路径与相机路径分开 | [执行模板](../../packages/skills/cinema/references/shotLanguage.md) |
| [2922｜三种动作戏提示词](lessons/lesson2922.md) | 支撑、持物、接触和腾手过程 | [执行模板](../../packages/skills/cinema/references/combatDesign.md) |
| [2955｜从点子到可拍剧本：因果、信息与采用版本](lessons/lesson2955.md) | 目标、阻力、代价、因果与信息变化；采用版本与提案分开 | [执行模板](../../packages/skills/story/references/core-methodology.md) |
| [2966｜图片纹理与油腻感：先定位污染来源](lessons/lesson2966.md) | 先定位肤面污染与纹理来源 | [执行模板](../../packages/skills/workflow/references/methods/colorAndLight.md) |
| [2967｜多段视觉统一：参考、生成约束与真实调色链](lessons/lesson2967.md) | 色板分组、生成约束与实际调色分开 | [执行模板](../../packages/skills/workflow/references/methods/colorAndLight.md) |
| [2978｜深度九宫格：参考职责与动作版本不能混淆](lessons/lesson2978.md) | 深度参考与动作版本分别绑定，核实真实输入通道 | [执行模板](../../packages/skills/cinema/references/referenceQuality.md) |
| [3005｜声音设计：以最终剪辑为依据，分清规划与混音](lessons/lesson3005.md) | 分轨、实际剪辑时间映射与声画接点 | [执行模板](../../packages/skills/cinema/references/coverage.md) |
| [3009｜假人感：身份、空间与行为必须同时成立](lessons/lesson3009.md) | 身份、空间和行为同时成立 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [3011｜30 秒超真实人物对话短片](lessons/lesson3011.md) | 双人交接先接重再松手，保留回应 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [3024｜真实感旅行 Vlog 的资产、镜头与剪辑](lessons/lesson3024.md) | 旅行Vlog摄像机来源、腾手、场地与剪辑 | [执行模板](../../packages/skills/travelWeddingDirector/references/cameraActionMethods.md) |
| [3026｜用图片制作餐厅推广视频](lessons/lesson3026.md) | 餐厅推广依据真实场地和商品事实 | [执行模板](../../packages/skills/adfilm/references/creativeTranslation.md) |
| [3028｜微表情特写：身份输入与表演节奏分开](lessons/lesson3028.md) | 特写身份与触碰、释放节奏分开 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [3033｜长视频一致性：资产职责、状态与空间坐标](lessons/lesson3033.md) | 长片固定空间与状态继承 | [执行模板](../../packages/skills/workflow/references/methods/visualDesign.md) |
| [3037｜青梅饮料TVC：动作母题、情感识别与粗剪声画](lessons/lesson3037.md) | 关系广告母题、产品关系、落版与真实剪辑音点 | [执行模板](../../packages/skills/adfilm/references/creativeTranslation.md) |
| [3038｜提示词的信息预算：关键因果明确，自然过程适度放开](lessons/lesson3038.md) | 按信息职责去重，关键因果明确 | [执行模板](../../packages/skills/videoPromptDirector/references/fiveBlockWriting.md) |
| [3042｜表演过度：角色策略比情绪动作清单更有用](lessons/lesson3042.md) | 掩饰是有依据的角色策略，不默认情绪动作 | [执行模板](../../packages/skills/cinema/references/performanceDirection.md) |
| [3097｜电影构图参考与自有角色场景](lessons/lesson3097.md) | 借参考构图，保留自有角色、场景与天气 | [执行模板](../../packages/skills/cinema/references/shotLanguage.md) |
| [3098｜从人物拼搭到动作参考](lessons/lesson3098.md) | 动作拼搭参考不自动等于可执行控制 | [执行模板](../../packages/skills/cinema/references/referenceQuality.md) |
| [3101｜Anerneq：动作目标、遮挡与道具后果共同形成真实感](lessons/lesson3101.md) | 目标、遮挡、道具后果与预演 | [执行模板](../../packages/skills/cinema/references/combatDesign.md) |
| [3102｜多人站位：预演简化、真实编号与逐段状态](lessons/lesson3102.md) | 多人站位预演、采用稿冲突与真实编号 | [执行模板](../../packages/skills/cinema/references/referenceQuality.md) |
| [3105｜产品运镜预演：几何、材质与运动参考的职责](lessons/lesson3105.md) | 白模产品运镜只承担已验证的几何与运动职责 | [执行模板](../../packages/skills/adfilm/references/creativeTranslation.md) |
| [3107｜同一客厅四种氛围：光源区域、行为与时长联动](lessons/lesson3107.md) | 人物位置变化与受光区联动 | [执行模板](../../packages/skills/workflow/references/methods/colorAndLight.md) |
| [3109｜整套角色设计：概念群像与视频资产分阶段](lessons/lesson3109.md) | 群像世界观与单角色可执行资产分阶段 | [执行模板](../../packages/skills/workflow/references/methods/visualDesign.md) |
| [3110｜场景剖面参考：补空间信息，不把示意图当三维真值](lessons/lesson3110.md) | 剖面补空间信息，不当三维真值 | [执行模板](../../packages/skills/workflow/references/methods/visualDesign.md) |
| [3111｜家庭动画广告：误会机制、资产状态与执行稿同步](lessons/lesson3111.md) | 动画家庭广告误会机制与产品状态同步 | [执行模板](../../packages/skills/adfilm/references/creativeTranslation.md) |
| [3113｜群战 Skill：从具体失败提炼可迁移规则](lessons/lesson3113.md) | 群战分层、残留状态；特效不能补动作因果 | [执行模板](../../packages/skills/cinema/references/combatDesign.md) |
| [3115｜从《潮汐修理铺》剧本到人物、场景、道具](lessons/lesson3115.md) | 功能驱动结构与状态；采用变更传播 | [执行模板](../../packages/skills/workflow/references/methods/visualDesign.md) |
| [3116 从资产到视频分镜与生成实操（正文及素材抽样）](lessons/lesson3116.md) | 逐段实际图号、接戏状态、动作与修改传播 | [执行模板](../../packages/skills/videoPromptDirector/references/fiveBlockWriting.md) |

## 验证边界

本次不改变模型本身，不把教程参数当通用接口能力，不声称模板改写已量化提升成片质量。内置资源沿用启动同步机制，自定义技能发生冲突时保留用户版本；部署或重启后才会进入对应运行环境。

## 本次实际验证

- apps/server：bun run typecheck、bun run build 均通过。
- 临时规范化数据目录中实际执行内置技能同步及加载：人物表演、MV、广告、灯光、群战、声音剪辑、Vlog、修复、继续，共9类任务通过。
- 无制作工具、无读取权限、工作区同名覆盖、自定义模板同步保护均通过；验证目录已清理，未改真实用户配置。首次临时目录使用macOS符号路径被工作区边界校验拒绝，规范化目录后通过，未放宽安全校验。
- 实际调用人物、场景、道具 assetPrompt 及参考分支通过；未发起媒体生成。
- 修改文档及本页274个本地链接有效，修改技能与build/skills产物内容一致，git diff --check通过。
- 未新增任何测试文件或检查入口；未部署、未完成实片声画验收。

## 全建议复核补齐

首轮没有完成全部建议：专项题材规则、模板的原创例/反例、部分自动读取入口以及实片对比存在遗漏。本轮补齐情况：

| 建议 | 处理与执行位置 |
|---|---|
| 点子、剧本、因果和信息 | 故事方法已有目标/阻力/代价/信息/采用版本；补原创场次与失败例 |
| 角色、妆造、空间、道具及画风 | visualDesign、characterStyling增加自动预读；原有资产生成函数继续承接；专项媒介不覆盖项目设定 |
| 光线与调色 | colorAndLight承接受光/材质与grade边界；专项园林修正阴影人物与阳光背景不能共存的错误 |
| 摄影、表演、互动与打斗 | shotLanguage按摄影任务加载；清除H3、四秒、固定脸占比、2–3信号等未经验证的硬断言；保留接触/支撑状态链 |
| 参考与预演 | 保留真实输入、sent/容量/降级检查；增加原创编号反例，白模/剖面预读视觉设计 |
| 提示词、分段与连续性 | 接戏/续接/长镜头直接读取分段与服装连续性；唯一时间线、前镜实际采用与修订传播沿用现有实现 |
| 广告、MV、旅拍 | 各模板增加原创正反例；广告创意可同时加载故事方法；旅拍删除默认每镜两秒及手持固定值 |
| 小清新、园林、东方奇境 | 正文和配套参考同步纠正固定镜数、动作配额、单光源、构图配额及未经验证的语序机制；接入按需自动读取 |
| 声音、剪辑、质量与修复 | 覆盖、连续性与修复补输入/原创例/反例/验收；未看听不记录通过 |
| 所有模板的六项内容 | 18份相关执行模板补适用输入、原创写法、失败反例、约束例外、实际验收与最小修复；不新增平行模板体系 |
| 编译与实际读取 | 临时目录调用真实编译：表演、接触、人物/相机路径、光源进入视频；首帧不执行后续表演；无实际前镜采用时返回警告。新增9类自动加载和去重检查通过 |
| 真实输出对比 | 用户指定Vidu Q4，现有《成交之前》两段、每组固定首帧/台词/参数/seed的4条均已生成；[实际结果与限制](validation.md)：耳语台词覆盖改善，接触和切镜仍不能全部通过 |

本轮没有新建测试文件或测试入口。编译验证使用隔离临时数据库，未伪造媒体、采用状态或质检通过；验证码登录不可用时改在隔离目录调用真实领域函数，没有改动生产认证。
