# LITTO 项目长期记忆

## 工程与运行
- Bun monorepo：`apps/web`（Vue）、`apps/server`（Bun+Express）、`cloud/`（Hono SaaS）。命名、组件标签/属性、文件操作及路由规范严格遵循 `AGENTS.md`。
- 3000 端口提供 `build/web` 产物；改 `apps/web/src` 后必须 `cd apps/web && bun run build`。`apps/server/src` 与 `cloud/src` 的热重启会中断生成任务，长任务期间不要改源码。
- 新路由后在 `apps/server` 执行 `bun run routes`；工具包构建后同步 `build/tools/*.tool.js` 到 `data/tools/`；providers 源码与 `data/providers` 副本须同步。
- 新技能除 `packages/skills` 外还需同步 `data/skills`，并接 prompt 分发、workflow 选择表及相邻技能入口。
- 前端项目列表存浏览器 localStorage，后台创建项目后仍需用户从目录打开；画布读取工作区目录的 `画布N.json`，不是 DB 的 `projects.canvas`。首页支持 `/?directory=<绝对路径>`。
- 模型以 `data/cloud/milimili.db` 的 active `models` 为准。ffmpeg 位于 `data/ffmpeg/darwin-arm64/ffmpeg`。

## 角色资产与连续性
- 角色档案：`assets/cast/<名字>.json` = `{name, identity, wardrobe, references[]}`；角色卡完成标志是 `fourView`，不是 references 非空。`assetContract.ts::inspectAssets()` 是资产判据唯一真相源。
- 参考图顺序：cast → images → styleReference（影调图最后）。人物镜禁止只靠纯文本；`continueFrom` 用上段真实末帧续接。
- 四视图主要服务含下半身动作的镜头；近景/中景可放宽。末帧续接只能锁脸和场景，不能补全身服装；全身动作优先多图参考。
- 服装必须逐项写明上衣、下装、鞋履、配饰；`looksLikePersonShot` 要识别她/他/她们/他们等代词。
- 编辑身材或去除配饰可能连脸一起改。应从老板认可的基准脸裁面部特写作首参考，并列明不可变五官与禁止美颜项。
- 肤质：`SKIN: clean|natural`；公司级资产默认 clean、半哑光清爽，生活自拍才允许极少量自然油光。

## 生成与提示词
- 编译顺序固定：写实基底 → SHOTSPEC → CAST → 用户原文 → LOOK → ERA → STYLEONLY；必须在入队前完成。幂等标记：`PHOTOGRAPHICBASELINE`、`SHOTSPEC:`、`CAST:`、`LOOK: 影调参照`、`ERA`、`STYLEONLY:`。
- `shotSpec` 九字段：shotSize/lens/cameraMove/blocking/action/performance/lighting/startState/endState。参数手册：`packages/skills/workflow/references/generationParams.md`。
- 项目配置：`assets/look.json` 管影调，`assets/world.json` 管年代与禁用物，`assets/visual.json` 管肤质。ERA 只有 prompt 明确年代才触发。
- 最高优先级禁令：写实不等于做旧。人物和场景默认干净、完整、明亮，禁止无设计理由的脏旧烂、油污、磨损、颗粒和压暗；确需做旧须 `DISTRESSED: 理由`。
- 年代词会污染人物与空间：避免无必要的工装/劳保服/白炽灯/木格窗等，用当代面料、剪裁和具体物件；旧只属于剧情要求的建筑，不扩散到人。
- 规则检测前剥除系统注入段，只检测作者原文，避免规则文本自指误伤。参考图的血污等状态也会继承到后续资产。
- 资产顺序：角色卡 → 场景 → 道具 → 分镜。`POST /api/ai/media/assets` 生成资产计划，`preflight` 查缺口，`rules` 反推规则命中。

## 模型实测与质检
- MiniMax-H3 支持 4–15 秒；Seedance 2.5 支持更长时长与多参考。Vidu Q4 运镜能力弱，需要运镜优先 Seedance 或后期。
- 新角色可先 `purpose:"asset"` 出定妆、抽帧为参考。四视图用纯白棚拍柔光；成片用真实环境生活光，不能混用。
- 合成先 concat `-c copy`，再统一调色与 loudnorm；走 filter_complex 必须显式映射音频。能后处理修复就不重生成，身份/动作/构图错误才重生。
- QC 阈值：luma<55 发暗、sat<8 发灰、sat>55 过饱和、ymax≥252 死白、ymin≤2 压死。`composeFilm` 默认合成后自动检查。
- 导演色卡在 `packages/skills/directorPalettes/`，项目影调可全片继承；改分类名要全局搜索调用方。

## 当前产品缺口
- 角色资产库已有工作区顶部入口，支持上传/生成角色设定图、版本与批准、收藏到跨项目角色库、检索及导入本项目；镜头制作内可维护 shotSpec、参考用途与锁定级别。2026-10-24 曾出现源码已有但页面缺失，原因是 3000 端口仍提供旧 build，重新构建后恢复。
- 其他缺口：语义视觉质检、音频模型与配音、自我校正回路、画布旧节点迁移。
