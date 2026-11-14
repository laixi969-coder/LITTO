# 外围创作后端接通记录

2026-11-13，接续 `atelierPeripheralAudit.md` 中明确缺失的后端。新增画布入口「工作流 · 3D · 画质」与「生成式世界」，不是静态按钮或提示词替代。

## 已接通的能力

| 能力 | 实际链路 |
| --- | --- |
| RH 应用 | 从 WebApp ID 读取远端字段，渲染文本、整数/小数、布尔、选项及图片/视频/音频输入；重新校验当前定义后上传本地媒体、执行应用、查询、下载、取消。 |
| RH ComfyUI | 获取 API 格式工作流，只开放实际 primitive 输入；保留远端连线。媒体字段上传后替换为远端文件名，经原工作流执行并取回文件。 |
| 生成式 3D | Tripo H3.1 图片转 GLB，支持面数、几何/纹理质量、纹理和 PBR；关闭纹理联动关闭 PBR 并移除纹理参数。自包含 GLB 可旋转预览、下载、保存当前机位截图，截图接 IMAGE 下游，模型路径通过 STRING 输出。 |
| 专用超分 | Topaz Precision 专用端点；放大倍率、锐化、降噪、压缩修复实际进入请求，结果保存为工作区图片。 |
| 质感增强 | Topaz Redefine 专用端点，默认 1 倍原尺寸；创造性、纹理强度和可选质感方向进入真实图像处理请求。 |
| 生成式世界 | Abot World 0 官方 WebRTC/WMA 协议，首帧后开放 WASD、方向键和触控；起点图片经 Fal Storage 上传，更新/重置等待对应确认；截图、录制片段保存为图片/视频输出。 |

3D 当前交付自包含 GLB；没有宣称支持 Hunyuan 各变体或 FBX 导入。专用画质使用 Topaz，并非 Atelier 的即梦执行器。普通图片编辑尺寸、几何导演台与 GEN3C 视频没有被算作上述新增能力。

## 复用与持久化

- 凭证复用服务端 `settings.mediaProviderConfigs`、平台模型权限及加密配置。已有 RunningHub Key 直接使用；Fal 使用 `falCreative` 连接。密钥不写入画布或返回节点配置，远端工作流的凭证字段保留在远端、不展示默认值。
- 复用节点脚手架、上游引用、`useNodeGeneration`、Agent 工具、工作区文件入口、路径校验、下载 SSRF 防护和原子写入。没有新建服务框架或工作进程。
- 普通媒体生成队列只接受图片/视频及镜头生产约束，不能假装能执行任意 RH 工作流或模型资产。因此外围任务在服务端私有 `creativeTasks` 保存原请求与句柄，产物落入工作区 `assets/creativeTasks/<uuid>/`。按账户、项目和 requestId 隔离；重复同请求不重发，异参复用请求号返回 409。
- 刷新只查询原远端任务。提交结果未知时保存 `uncertain`，不自动重提；手动绑定原任务号由凭证管理员核验。管理员可在同工作区通过恢复接口的 `ownerId` 为原成员绑定，原成员继续查询自己的任务。
- 下载中断可继续查询；已有文件只在字节完全相同时复用，绝不覆盖不同本地内容。单文件最多 256 MB、批次最多 512 MB、最多 32 项；非媒体输出只下载，不执行。
- 世界会话单独使用受认证的窄代理，仅开放 Abot ICE、一次 SDP 协商及本请求所属会话心跳。浏览器取消协商同步中止上游，未知回执不重放。更新按确认串行；结束先释放连接再等待录制上传。切到其他画布/文档、重载或卸载会停止，切回与刷新不自动开始收费会话。
- 世界录制及截图固定开始时的工作目录；普通保存先等待录制落盘，避免关闭后的输出晚于画布最终保存。公共画布快捷键排除已聚焦的媒体控件，Tab 可正常离开世界画面。

## 实际验证

- Server、Web、两个新增节点的类型检查与构建通过；路由由 `bun run routes` 生成。新增依赖仅世界协议所需的固定版官方 `@fal-ai/client@1.11.0-alpha.6` 及其依赖，Three 沿用已有版本；保留 Web 原有大包/Vite 提示。未新增测试文件、框架或自动检查入口。
- RH 内联受控协议验证覆盖动态字段、必填、选项、整数/浮点、敏感字段过滤、媒体实际类型、上传替换、两类提交、查询、取消及不明回执。完整 HTTP 验证包括真实文件落盘、重开、幂等、异参、越权和下载中断后保留本地修改。
- Fal 受控验证覆盖三种专用端点的实际参数、原请求查询/取消、GLB 与预览图提取、伪造句柄和非法参数拒绝；不访问上游提供的任意查询 URL。
- 隔离多人 HTTP 验证覆盖匿名 401、VIEWER/模型白名单/凭证管理/跨目录拒绝、EDITOR 实际使用，以及凭证管理员给原成员恢复丢失回执。恢复后的 PNG 字节与上游一致，提交次数保持 1。
- 真实浏览器验收 RH 动态参数和 ComfyUI，pending 刷新仍只提交 1 次；Tripo 参数实际透传，GLB 落盘并通过 Three 预览，当前机位截图生成 20880 字节 PNG 并写 IMAGE。超分和质感的倍率、锐化/降噪、创造性/纹理强度分别被受控上游收到，图片保存并可预览；画布没有 API Key。
- 独立 headless Chrome 加真实 WebRTC peer 验收生产版世界节点：SDP、320×180 首帧、DataChannel、一次 configure、移动/释放、prompt/reset 与确认正常；起点图片完成 Storage initialize→PUT。截图 PNG 23777 字节、录制 WebM 52194 字节及节点输出实际落盘。
- 将录制上传延迟 800 ms，结束 120 ms 时 peer 已关闭、上传尚在进行，随后保存成功；切到文档时同一节点 DOM 保留，但 peer 关闭、流清空，录制 36529 字节落盘。切回及重载会话数仍为 1。Tab 实际转移到世界描述输入框，没有打开添加节点菜单，浏览器没有 JS 错误。
- 世界代理拒绝任意目标、其他模型、非本请求心跳和重复协商；协商取消的上游 signal 实际 aborted，私有记录保留 `uncertain`，再次协商返回 409。

以上上游均为隔离受控服务，WebRTC 是实际浏览器连接。没有调用真实付费模型，没有验证真实模型画质、外网 TURN 或供应商计费结果；没有修改用户原项目。所有临时服务、浏览器与数据均已清理。

## 官方协议依据

- [RH 应用字段](https://www.runninghub.ai/runninghub-api-doc-en/api-425761097)、[API 工作流](https://www.runninghub.cn/runninghub-api-doc-en/api-425761094)、[工作流执行](https://www.runninghub.ai/runninghub-api-doc-en/api-425761093)、[上传](https://www.runninghub.ai/runninghub-api-doc-en/api-425761099)、[输出](https://www.runninghub.ai/runninghub-api-doc-en/api-425761034)、[取消](https://www.runninghub.ai/runninghub-api-doc-en/api-425761095)。
- [Tripo H3.1](https://fal.ai/models/tripo3d/h3.1/image-to-3d/api)、[Topaz Precision](https://fal.ai/models/topaz/upscale/image/precision/api)、[Topaz Generative](https://fal.ai/models/topaz/upscale/image/generative/api)。
- [Abot World](https://fal.ai/models/alibaba/abot-world-0/api)、[AsyncAPI](https://fal.ai/api/apps/fal-ai/abot-world-0/asyncapi.json)；世界代理与上传同时按已安装固定版官方 SDK 的实际协议核对。
