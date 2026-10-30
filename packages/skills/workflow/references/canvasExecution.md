# 画布执行

> **Seedance 使用边界：** 本文件负责真实画布参数与引用。已选 Seedance 时，先按 seedanceDirector.md 完成当前镜头设计与文本，再执行；配置回答沿用当前任务，不重置创作。执行中发现能力不匹配时回到受影响的规格修正，不临时补一套动作或模板。可读现场配置以确定能力，但不因配置询问替用户选择 Seedance。

只用本轮实际提供的工具操作当前 MILI MILI 画布。下面是当前合约；实时 `parameters` 是调用依据，宿主文档中的旧例不覆盖它。制作流程见入口，版本和结果记录见[状态与交付](stateAndDelivery.md)。

## 发现与绑定

`getCanvas({})` 只返回激活画布概览；需要类型或画布列表时传 `include: ["nodeTypes"]` 或 `["canvases"]`。用 `findCanvasNodes` 按名称、类型或选择状态定位目标；已知节点 ID 时直接用 `getCanvasNodes` 读取必要字段，`getCanvasEdges` 读取局部连接，`getNodeTools` 发现函数与完整 schema。节点类型可能带运行时前缀，不硬编码。

五个画布读取工具受条数和 64 KiB 体积限制，按 `hasMore` / `nextCursor` 继续分页；节点和连线每页最多扫描 2000 项，空结果但 `hasMore: true` 仍需继续。`totalNodes/totalEdges` 是画布总量而非命中数；`selectedOnly` 现场筛选，不是冻结快照。保持原查询参数，仅替换游标；游标失效重新查询。全图任务分批处理，上下文仅保留当前批次、摘要和游标。`getCanvasNodes` 默认只读 `label/type/position`，端口、正文和输出须显式选择 `ports/data/outputs`；`dataKeys` 仅在选择 `data` 时筛选字段。详情和函数查询的 `nodeIds` 每批最多 20 个，须先去重；移动、重命名、删除和连接每批最多 64 项。

顶层 `nextCursor` 仅用于保持原参数继续节点分页。处理节点任一 `truncated` 时，仅查询所属节点，使用该项路径及偏移，不携带原 `cursor`：`text` 用该项 `path` 和 `nextOffset` 作为 `textOffset` 续读；`entries` 改用 `valueOffset`，没有 `nextOffset` 表示该路径已到末尾。`depth/budget` 沿该项 `path` 缩小范围重新查询，不携带旧 `cursor`；对象/数组的 `valueLimit` 最多 100，字符串的 `textLimit` 最多 4000，正偏移必须指定 `path`。路径最多 64 层和 2048 JSON UTF-8 字节，每段最多 256 字符；`pathDepthLimit/pathBytesLimit/circular` 不可靠重复请求补齐，`keyTooLong` 可用返回的 `nextOffset` 作为 `valueOffset` 跳过该键继续，但被跳过的值仍未读取。不把截断内容当完整证据。

默认复用当前项目和目标画布。有既有台账时核对绑定；用户已明确切换目标则按其授权操作，含糊的“继续”遇到不同绑定先澄清。新建、切换、重命名成功后使用返回的绑定，不沿用旧 ID。

| 工具 | 当前参数形状 |
|---|---|
| `getCanvas` | `{include?:["canvases","nodeTypes"],cursor?,limit?,canvasId?}` |
| `findCanvasNodes` | `{query?,types?,selectedOnly?,cursor?,limit?,canvasId?}` |
| `getCanvasNodes` | `{nodeIds:[...],fields?:["label","type","position","ports","data","outputs"],dataKeys?,path?,valueOffset?,valueLimit?,textOffset?,textLimit?,cursor?,canvasId?}` |
| `getCanvasEdges` | `{nodeIds?:[...],direction?:"incoming"/"outgoing"/"both",cursor?,limit?,canvasId?}` |
| `getNodeTools` | `{nodeIds:[...],names?,cursor?,limit?,canvasId?}` |
| `publishVideo` | `{path, label?, canvasId?}`；真实工作区视频，自动放置独立节点，同路径复用，可播放与下载 |
| `addNode` | `{type, position:{x,y}, label?}` |
| `nodeTools` | `{nodeId, name:"node:函数名", args:{...}}` |
| `connectNodes` | `{connections:[{source,sourceHandle,target,targetHandle}]}` |
| `groupNodes` | `{nodeIds:[...],label:"镜头/片段名称"}`；本镜主帧、生成节点及视频结果归为一个可整体拖动的单元，跨镜共享参考留在素材区 |
| `moveNodes` | `{moves:[{nodeId,position:{x,y}}]}` |
| `renameNodes` | `{renames:[{nodeId,label}]}` |
| `deleteNodes` / `deleteEdges` | `{nodeIds:[...]}` / `{edgeIds:[...]}` |
| `addCanvas` / `switchCanvas` | `{name?}` / `{canvasId}` |
| `renameCanvas` | `{canvasId?,name}` |
| `fitCanvas` / `arrangeCanvas` | `{nodeIds?}` / `{}` |

批量修改按实际数量限制拆批。`addNode` 不接受任意 `data`、指定 ID 或正文；用返回的 `node.id` 查询 `getNodeTools`，再按完整 schema 用 `nodeTools` 填内容，新增回执不包含函数清单。不要调用旧版单数移动/重命名工具，不直接写画布 JSON。

结构操作的 ID 回执可能缩略为最多 100 项：`arrangeCanvas` 另给 `arrangedCount`，`fitCanvas` 给 `nodeCount`，`deleteNodes` 给 `removedEdgeCount`。`truncated` 只影响返回 ID 列表，不表示只完成预览部分，不为获取完整回执重复操作；改用只读工具核对。`nodeTools` 返回具体业务函数的结果，不受上述五个读取工具的 64 KiB 上限约束。

按现有布局从左到右放内容、资产、片段，同阶段纵向排列，避免覆盖用户节点。用 `fitCanvas` 展示本轮成果；`arrangeCanvas` 会整理全部顶层节点，只在整幅整理属于用户范围时调用。使用 groupNodes 把本片段的主帧、生成节点与结果组合为命名单元，组内位置相对 parentNode，移动组合框整体移动；共享参考放组外，避免一个素材被多个片段争用归属。

## 内容与素材节点

### 按空间要求启动 3D 预演

镜头需要从遮挡后揭示、绕行并保持人物空间关系、穿门绕柱，或用户指定多个机位路径时，助手主动安排 3D 预演；普通固定、简单推进和跟拍不强制预演。触发来自实际空间设计，不靠“电影感”“高级运镜”等词。已有授权覆盖预演文字模型调用时直接执行，新增费用仍遵守既有授权范围。

先发现并复用本镜的 3D 导演台节点；没有时按当前画布真实节点类型创建。发现其 `generatePlan({instruction})` 后，将明确的起幅、角色路径、相机路径、遮挡锚点、结束构图与时长交给它。它复用当前文字模型、场景及取景锚点并保存新方案，不改已有方案，不生成正式视频。返回 `planId`、`cameraFrames`、`modelPath` 和 `selected`；检查实际预演画面与起止构图，不能只看返回成功。导出数值轨迹时传返回的 planId 给 readCameraTrajectory，不依赖当前选中项，避免并发选择读错方案。

预演结果首先用于修正同一镜头的 camera.design 和执行时间线。数值控制仅在已选模型声明 cameraTrajectory、首帧和尺度已校准时，使用现有 readCameraTrajectory 与视频节点 setCameraTrajectory；当前轨迹导出只支持不超过5秒的连续方案，不能截短原剧情来绕过限制。普通模型不接受这条数值轨迹；只有真实导出预演视频且模型支持运动参考时才作为该用途引用。工具不可用、控制模式不支持或无法检查预演时明确报告限制，不自动换模型，不声称已经精确控制。

- 文本使用该节点实际注册的 `node:setText({text})`。成功后用 `getCanvasNodes({ nodeIds: [目标ID], fields: ["data"], dataKeys: ["textPath"] })` 回读路径，读取对应正文核对并登记；`setText` 当前只返回正文，不返回路径。需要查看当前内存正文时用 `getCanvasNodes` 的 `path: ["outputs", "text", "value"]` 分段读取；持久化画布 JSON 不保存这份内联正文，不能据此判断文本为空。
- 正文由节点编辑与保存，不直接写其 `textPath` 绕过界面。状态文件和版本快照用实际文本文件工具保存；快照不作为第二份可编辑正文。
- 素材通过发现的 `node:setImage`、`node:setVideo`、`node:setAudio` 挂载，当前通常为 `{path,mimeType}`。`path` 使用工作区相对路径，指向本工作区实际存在、可读取的文件，不能填写预期输出或外部尚未导入的路径。
- 新图以图片生成节点制作，已采用的图优先用图片素材节点固定。下一版使用新候选生成节点，保留已采用节点和连接；不为重生成替换仍被下游引用的源节点。
- 当前文本节点没有 Agent 可调用的 `generateText`，文字由助手完成后写入。文件工具不保证支持视频理解或二进制复制，具体边界见[交付](stateAndDelivery.md)。

## 真实引用与提示词

先用 `getCanvasNodes` 的 `ports` 检查源/目标端口的 ID、方向、类型，用 `getCanvasEdges` 检查已有连接。只把本段采用的媒体接给生成节点，不用连线表示阶段、批准或依赖索引。上游还在生成或未采用的候选不能成为正式参考。

正式镜头由 `productionSpec compile` 生成执行提示词和参考，节点保留镜头绑定，服务端复核后执行。独立素材通过 `node:setPrompt({prompt})` 写入提示词。完整剧本和分镜文本节点保留内容依据，不再用 STRING 连线重复挂到生成节点；独立素材会把相连文本全文追加到 prompt。现有无关 STRING 引用在已授权编辑范围内移除，否则说明影响后暂停该生成。

当供应商/画布接口实际使用 `{{ref N}}` 作为传输引用时，`{{ref N}}` 只能对应本次真实连接顺序与类型，不能把计划清单顺序当作真实顺序。**这属于执行层映射，不授权把 模型执行规则 已定稿 `Reference binding` 的原始节点/资产句柄改写成另一套用户可见提示词格式。** 当前需分批读取现场数据还原顺序，不存在 `getReferences` 工具：

1. 用 `getCanvasEdges({ nodeIds: [目标ID], direction: "incoming" })` 分页读取全部入边，保持返回顺序，筛选实际输入端口的边。用 `getCanvasNodes` 显式指定 `fields: ["ports", "outputs"]` 分批核对源节点，确认源端口存在且类型兼容，从 `outputs[sourceHandle]` 取实际内容，按截断信息补齐必要字段。
2. 用 `getCanvasNodes` 的 `fields: ["data"], dataKeys: ["referenceOrder"]` 读取目标排序。以 `encodeURIComponent(JSON.stringify([source,sourceHandle]))` 为键，按 `data.referenceOrder[目标端口]` 中的位置稳定排序；没有列入的排最后并保留原入边顺序。仅在字段完整且确实不存在排序记录时按有效入边顺序。
3. 排序后第 N 项对应 `{{ref N}}`，不同类型共用编号。输出未就绪的输入仍占位并阻止生成，不能把空项删掉后继续套编号。节点/端口类型兼容性以运行时返回为准。

无法取得完整输入或证明顺序时保留提示词草稿并说明待核实项，不猜编号。

当前画布统一给引用编号，而部分供应商适配按图片、视频、音频重新组织请求。默认采用真实图片资产加已确认的原生声音方案；确需混合媒体时，必须核实画布顺序与实际模型/适配的对应关系。不能证明一致时停在“待引用映射确认”，说明具体冲突；不得静默丢掉指定音频、改模式或假称编号正确。

首帧、尾帧有明确语义，顺序变化可能交换作用。只有用户选择该路线且真实能力支持时使用，核对具体输入槽位；不强制所有片段抽尾帧。连接或参考来源变化后重新核对引用和提示词，原授权不自动覆盖变化后的执行方案。

## 配置询问不得截断 Seedance

- 先读取用户已选模型或现场节点的真实配置，已有型号与版本直接沿用；只有必要信息缺失才询问。不能替用户选模型，也不重复确认已生效的选择。
- 若宿主必须向用户确认 `ratio`、`resolution`、`mode`、`generateAudio`、provider 等执行参数，提问和用户回答都属于同一 Seedance 任务的执行参数补充。回答后继续使用 模型执行规则 已规划/定稿的提示词，不重新进入通用工作流。
- 若用户在配置回答中明确把模型改为 2.0/2.5，这属于目标模型变更：回到 模型执行规则 按新目标模型重新路由受影响的正式提示词，然后再回本文件执行；不得仅在节点配置层换模型而继续使用另一模型的提示词外壳。
- 若实时能力不支持 模型执行规则 目标模型，报告能力冲突；不得静默采用节点默认模型。

## 生成前准备

1. 调用当前节点的 `node:getConfig`，核实可用模型、模式、参考类型与数量、画幅、图片尺寸或视频时长/分辨率、原生声音及音频输入能力。图片和视频的规格分开判断，不沿用不相关的默认值。
2. 正式镜头先 `productionSpec compile`，按返回的 `request` 设置节点；视频 `node:setConfig` 同时传 `production:{shotId,productionFingerprint:fingerprint}`，参考与主帧由服务端读取，无须再复制为画布连线。独立素材先接好实际素材，再读取当前匹配模式。图片配置使用 `providerId/modelId/size/ratio`；视频使用 `providerId/modelId/duration/resolution/ratio/mode/generateAudio`。只传所需且支持的字段，`providerId` 与 `modelId` 成对提供，mode 使用实际返回值。
3. 写入完整提示词，再读配置与画布，核对实际 prompt、引用、规格和调用前 output。缺必要参考就停该生成并继续文稿；不能静默将图生图或多参改成无参考模式。
4. 固定本次方案：对象、数量、完整提示词、参数、参考文件与用途/顺序、执行次数；展示并沿用或取得具体消耗算力授权。算力无法查询时明确未知，不把对话 Token 当媒体消耗。
5. **临执行复核。** 用户回复后再次读取当前画布与配置，比对授权方案，包含节点、提示词、模式、声音、引用与数量。若发生变化，沿用仍匹配的对象；受影响对象重新展示差异并核对授权。不要以“已确认”执行界面后来被修改的配置。
6. 前置和授权满足时，经 `nodeTools` 调用实际 `node:generateImage` 或 `node:generateVideo`，正式镜头必须先 `productionSpec compile`，配置与返回的 `request` 一致，调用参数传 `{production:{shotId,productionFingerprint:编译返回的fingerprint}}`，服务端重编译并核对规格；不把编译文本复制到自由提示词后丢掉镜头关联。独立角色定妆传 `{purpose:"asset"}`，沿用中性光和简洁背景；其他独立画面传 `{purpose:"standalone"}`。精修使用支持 `localRepair` 的图片生成工具并复用同一编译请求，结果仍登记为原镜头的新候选。

读回与执行不是宿主提供的原子操作。复核后仍发生并发编辑时，本次输出不能仅凭当前 prompt 归因；保留尝试快照，标注依据待核实，不能承诺完全消除并发竞态。

## 生成中与结果回读

当前原生节点启动后立即返回 `{status:"generating"}`；`getConfig` 不提供任务终态。记录每次尝试及旧输出。同一已授权批次中，其他节点若不依赖待生成结果，可继续核对并启动；依赖基础图、变体或前段采用结果的节点必须等待，不把依赖链当作独立批次。

完成本轮可执行的独立启动和文字工作后，汇总生成中的节点及依赖待办，告诉用户完成后回复，保留当前画布。没有状态/等待能力时结束本轮，不伪造后台跟进、无限轮询或把旧文件当新结果。

用户报告完成后用 `getCanvasNodes` 读取相关节点的 `outputs` 和必要 `data`，核对新输出、实际文件以及用户是否期间手动生成或替换过素材。新路径只是证据之一，不能自动证明它属于本次方案；归属不清时询问这次输出对应哪次生成，先不下游采用。

本轮若实际提供了新的任务查询或等待工具，可按其真实合约读取完成、失败和结果，仍保留采用与质量检查。不得根据这段说明臆造 API、jobId 或自动唤醒。

生成失败、超时或取消先确认结果状态及原因。工具返回不明确时不盲重试，以免重复消耗算力；改变方案和额外尝试核对授权范围。用户切换画布、项目或关闭页面可能卸载节点并中止请求，恢复后重新发现状态，不保证后台继续。

结果能读取时按实际能力检查；视频采用和下一片段接戏见[状态与交付](stateAndDelivery.md)。只有实际确认采用的文件才固定为素材节点，引用能力不足或用户选择外部制作时，给最少必要导入要求，不强制外部平台。
