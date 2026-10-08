# 大师镜头与运镜能力接入

## 十二项来源与落点

检索/实施日期：2026-10-08。Stars 是检索排序依据，不是本产品的选型分数。本次独立实现接口和方法卡，不打包第三方素材、模型权重或整套提示词。此前已融合的表演资料继续保留原有许可声明。

| 来源 | 吸收的能力 | LITTO 落点与边界 |
| --- | --- | --- |
| [DirectorSKILL](https://github.com/wuwangzhang1216/DirectorSKILL/tree/c65ae0d14457053efb1e354c7e7f7e120d97fad1) | 叙事目的先于风格，镜头/关键帧/视频分层 | cinema 的镜头卡、导演选方法、writer 填规格；不把大师姓名当可执行参数。原仓库 MIT，方法为独立表述 |
| [visual-skills](https://github.com/smixs/visual-skills) | 调度、蒙太奇与模型语法分离 | camera.design、剪点及失败退路；模型专用语法仍按实际选择读取。上游 CC BY 4.0，未复制其正文，未绑定浮动版本的模型承诺 |
| [higgsfield-ai-prompt-skill](https://github.com/OSideMedia/higgsfield-ai-prompt-skill/tree/70754977d1884794963ac0a748eaaa85b6e9c82a) | 目的、触发、倾听、余波 | 复用已有 performanceDirection.md 与许可；镜头卡验收补上表演与相机关系，不重复建立演员 Agent |
| [cinematic-video-prompt-skill](https://github.com/Rylaispirit/cinematic-video-prompt-skill/tree/389c193cecafa6118989a2938b7cedc49be2456b) | 具体摄影信息替代形容词 | 技术、主体路线、相机路线、起止状态与观看验收；不强制每镜移动。上游 MIT |
| [film-cinematography-master](https://github.com/mrg123/film-cinematography-master/tree/77c08e06e646d003455e2c699e72aebb2328c402) | 摄影术语与选择条件 | master shot、推拉、摇移、环绕、变焦、滑动变焦、焦点转移等独立方法卡。README 许可声明不足以授权复制素材，故不搬运 |
| [ai-shortfilm-prompts](https://github.com/jnMetaCode/ai-shortfilm-prompts) | 案例拆解与完整制作检查 | 以原文事实、方法选择、控制能力、实际输出四项核对；不复制保留权利的 Mx-Shell 案例正文 |
| [higgsfield-seedance2-jineng](https://github.com/beshuaxian/higgsfield-seedance2-jineng/tree/83dcb10ee38c9694ac0f455ec55a62f2be3b8a14) | 镜头类别与产品场景覆盖 | 产品轮廓/材质/功能/使用/品牌职责，按需选择；无明确 LICENSE，不复制正文，不默认切换 Seedance |
| [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft/tree/5ddbf521038b0a7accfb6dc1e0a9eb29c67277ab) | 产品镜头卡与预演思路 | adfilm 方法卡、既有导演台、动态分镜/FFmpeg；不引入 Remotion 运行时或外部素材。上游 Apache-2.0 |
| [Storyboarder](https://github.com/wonderunit/storyboarder) | 镜头顺序、时长与低成本 animatic | 复用 storyPreview 与 productionEdit/shotStrip；新增镜头卡可查看编辑。不嵌入另一套桌面编辑器，不复制其代码 |
| [MotionCtrl](https://github.com/TencentARC/MotionCtrl/tree/6242d55414d3f4ad690bf0934889660f78e81b6e) | 区分物体运动与相机运动 | subjectPath/cameraPath 分开、原生能力声明；本次不再安装第二套 GPU 后端。上游 Apache-2.0 |
| [CameraCtrl](https://github.com/hehao13/CameraCtrl/tree/af45a7a0dbeedb7f6ed66aac4a9e5411a279f0d2) | 显式相机参数而非方向词 | 相对外参、FOV、帧率、尺度与正交检查；不将其模型特有表示冒充通用轨迹。上游 Apache-2.0 |
| [GEN3C](https://github.com/nv-tlabs/GEN3C/tree/db2ffe12ced12ddafcec5e0422ee46ce8520746b) | 官方 JSON 相机控制服务 | 本次选用的可选数值轨迹供应商；图像与轨迹真实进入 seed/inference 请求。代码 Apache-2.0，权重另行遵守上游条款；本仓库不分发权重 |

## 使用链路

1. 主 Agent 读取当前运行环境的 workflow 与相关 cinema/adfilm/musicfilm/continuity；需要镜头方法时按需读取 `cinema/references/masterShots.md`。团队成员从各自授权的 `shotDesign.md` 获取共同规则。
2. 导演选有剧情依据的方法，writer 输出 camera.design 和既有摄影/表演/调度字段，reviewer 给出可反证的问题。镜头卡经 productionSpec 持久化，在「镜头制作 → 镜头规格」可编辑。编译器保留完整设计，修改会改变审阅指纹。
3. 先用既有 3D 导演台与动态分镜查看构图、运动和节奏，再根据真实模型能力选择文字、参考视频或数值轨迹。视频参考只标记 motionReference；不再冒充 cameraControl。
4. 原生轨迹：导演台选择不超过 5 秒且没有硬切的方案，点「导出轨迹」，或由主 Agent 调用 `readCameraTrajectory`。后者返回与生成工具一致的 `cameraTrajectory`。导出文件包含未校准标记，默认尺度 1 不代表物理尺度正确。
5. 在媒体设置安装/配置 GEN3C，明确将它选为默认视频模型；不会因能力可用自动换模型。镜头制作面板选择它、导入轨迹、校准平移尺度，并明确勾选仅图像与相机控制。Agent 请求亦须 `imageAndCameraOnly:true`。
   画布流程可将导演台 `readCameraTrajectory` 的结果交给视频生成节点 `setCameraTrajectory`，再按已授权配置生成；首帧、轨迹、声音开关和规格均通过实际节点请求传入供应商。
6. 先 compile，检查警告和参考；generate 使用同一轨迹、画幅、时长、模型及 fingerprint。已有主关键帧须先实际检查采用。轨迹和确认标记均进入请求指纹，修改后必须重新预览。

## GEN3C 服务与约束

按官方 [INSTALL](https://github.com/nv-tlabs/GEN3C/blob/db2ffe12ced12ddafcec5e0422ee46ce8520746b/INSTALL.md) 与 [GUI API 部署说明](https://github.com/nv-tlabs/GEN3C/tree/db2ffe12ced12ddafcec5e0422ee46ce8520746b/gui)部署独立 GPU 服务并下载权重。适配目标是该提交的 JSON API，拒绝旧 pickle API；本次不会安装 Python/GPU 环境或自动下载权重。所需路径为 GET `/metadata`、POST `/seed-model`、POST `/request-inference?sync=1`，不是自建的假接口。

首期有意限制为一个连续镜头、PNG 1280×704 首帧、121 帧、24fps、时长 `121/24` 秒、画幅 `20:11`。导演台采样点为 0 到 5 秒，短于 5 秒的方案在结尾保持；使用时长可以短于生成时长。应先匹配首帧构图，再校准尺度。相机坐标为 OpenCV 右/下/前；每帧行主序 3×4 camera-to-world，相对首帧，首帧单位矩阵。服务估计的种子相机、焦距、主点将用于重定位，绝不能把 Three.js 的列主序矩阵直接发送。

官方服务是有状态的单客户端服务，须分配独立端点，不能同时连接官方 GUI 或其他 LITTO 进程，也不要用多个域名别名连接同一服务。宿主按源站排他；HTTP 取消、网络错误或解析失败不能证明 GPU 停止，因此会保留占用。恢复前同时重启 GEN3C 与 LITTO；不要只重试 seed。认证模式继续遵守现有上游网络访问策略，不自动放开内网访问。

GEN3C 不接受逐请求文字提示词和声音。本地保留编译文本供审阅和溯源，模型只收到图像与轨迹；不能声称台词、演员动作、产品功能、真实光学或精确深度已受控。对轨迹执行也须观看实际输出，不能用接口成功代替几何/视觉质量验收。

## 升级和保护

启动时按技能/团队目录核对历史内置 SHA-256 和上次安装记录。未修改内置目录自动升级；未知版本、用户编辑或目录冲突保留原样，并在数据目录的 `skills/builtinVersions.json` / `agents/builtinVersions.json` 记录 conflicts。不会覆盖工作区同名自定义技能，不删除用户资源。团队按目录判断，避免新指令和旧权限清单混装。状态文件损坏、符号链接或写入失败直接报错，不伪装升级成功。

## 审查基准

第一性原理：镜头传递信息；坐标和时间决定运动；模型能力由接口事实决定；批准的素材与持久化状态不可被隐式改写。

对抗边界：短剧本不补八镜；建立镜头不重复动作；三人换话轮次不能改变同一人物方向；跨项目 sequence 拒绝；空草稿不能清空镜头；替换删除与创建在同一事务；已采用镜头的时长/对白修改须确认；模型润色不能改原文对白；相机矩阵拒绝镜像/缩放/NaN；轨迹时长匹配帧数；硬切拆镜；普通视频参考不能获得数值控制能力；未确认文字控制限制不能启动 GEN3C；返回请求编号、格式、尺寸和大小必须校验；自定义技能不得被升级覆盖。

验证结果与实际执行范围以本次提交说明为准。没有可用 GPU 服务时，协议、类型、构建和几何验证不能证明模型成片质量通过。

本次已执行：server/web/cloud/desktop、节点与工具相关类型检查；Web、server（含团队与 MCP）、导演台、视频生成节点、媒体工具构建；临时数据目录真实 HTTP 团队查询与安装验证；内联手动验证无填充、稳定多人方向、项目/场景边界、事务回滚、已采用规格保护和设计卡指纹；Three.js→OpenCV 方向、首帧单位变换、硬切/空轨迹/非刚体拒绝；供应商 VM 内 JSON 协议模拟、种子相机重定位、错任务编号与未确认拒绝；内置升级、自定义保护与系统路径/符号链接边界。未新增测试文件，未运行真实 GPU 推理，未声称检查过成片。

本机安装副本中，cinema/continuity/adfilm/workflow 与源码有差异，保留其正文并仅追加本次方法入口与新参考；其他无关自定义技能保留原样。源码升级策略仍保持遇冲突不覆盖，分镜团队已构建并安装。GEN3C 可选供应商已补齐，但没有替用户改变默认模型或 GPU 地址。
