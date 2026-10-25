# 对白、旁白与对口型

工作区画布上方的「配音与口型」面板提供：角色固定音色、逐句对白/旁白、情绪和表演指令、语速、试听、配音版本选择、人物视频上传、逐句对口型、整段 WAV 合成。

多人项目默认先定配音，再同步口型，按整个项目的镜头统计说话人，正反打分镜也保持每个角色的固定声音。角色音色与每句语气分开保存。同一角色跨句复用同一个供应商、模型和音色；角色用 `assetId` 绑定人物资产，旧方案可按唯一名称关联。同一资产或名称不能重复建音色档案。修改台词、音色、语气或语速后，旧配音会标为过期，不能直接用于新口型或合成。

配音面板列出已配置且未停用的语音与专用口型模型，不再受全局音乐默认模型限制。角色配音请求传 `voiceLineId`，服务端校验它与已保存的角色供应商、模型、音色、原句、语速和表演完全一致，拒绝默认音色、额外参数覆盖或串用另一角色的已采用录音。没有充值的 APIMart 不作为本工作区可用渠道；不靠试生成检查余额，不自动换供应商。

生成只添加配音候选，须试听后明确选择采用版本，才能规划镜头或对口型。已有同规格候选直接试听复用，避免重复付费；已采用版本继续沿用，不逐句重复确认。聊天使用 `configureVoice` 保存角色和原句，`generateAudio{voiceLineId,...}` 生成后由服务端自动记录到该句 takes（不重复手工追加），再 `selectVoice` 采用；`planSpeech` 按角色、镜头和原句索引查当前声音。多句或多人同屏先拆出同长、单个说话人的发声片段，不能把单人口型结果当作多人整镜，也不能把音轨直接叠到成型视频上冒充同步。

方案保存为工作区 `voiceProject.json`，文件结构由 `@toonflow/tool-media-generation/voiceProject` 的 `voiceProjectSchema` 校验。音频、人物原片和口型结果保存在 `assets/speech/`。删除方案中的条目不删除素材文件。完整配置保存成功后才发送生成请求；保存失败会保留页面上的结果，须重试保存再离开。

## 按真实声音规划镜头

后期配音路线先采用整句声音，再定镜头屏时。对白、旁白都可关联「对应镜头」；相同角色在同镜重复说同一句时，用「对应台词」指定原句序号，底层为从0开始的 `dialogueLineIndex`，不重复生成声音。

聊天调用 `productionSpec(planSpeech)`，参数为 `{shotId,bindings?:[{lineIndex,path}]}`；或 `POST /api/ai/media/planSpeech` 的 `{directory,plan:{shotId,bindings?}}`。省略 bindings 时复用 `voiceProject.json` 当前有效的已选声音；旧素材可明确映射文件和原句索引。本地探测整句音轨，返回实测时长、逐句局部窗口、`suggestedDialogue`、`minimumDuration`、`coverageRequired` 和需要重新调度的原因，不调用生成模型或自动修改镜头。

导演须将原句的 `audio:{mediaId,text}` 及复核后的发声窗口存入 `creativeBrief.dialogue.lines`；画内对白的 `coverage:[{start,end,description}]` 须完整覆盖发声期，明确说话者完整嘴部的可见调度。本镜曾出现人物、未来会切回座舱或有一段人物特写，都不能代替整句覆盖。规划字段不能证明实际嘴形已同步。

容量不足时重排观看和表演，保留完整原句及动作因果；不把容量下限直接用作慢放、定格、循环或拉长打斗救援的指令，不加速、删句、叠说或把旧音轨移到邻镜凑时长。修改对白屏时须同时复核已有动作、摄影节拍、表演、时间线和生成长度；模型时长不足则保留待规划。生成前、任务入队、实际执行和最终采用均保留校验；旧规划不自动重试或换供应商。

重排时保留原动作顺序；旧主帧若已处在划击等后续阶段，应保留为待复核输入，不倒置闪避与攻击来迁就图片。对白与行动并行，不为延长镜头补造喷口恢复、额外承托或新的声音证据。只缩短完整录音之间不必要的空白；用本地静音检测核对文件内部停顿，不用字数或总长猜测。编译将历史接戏账本单列为上下文，当前起点、动作与可见嘴部覆盖仍须逐项复核，不能重演账本中的旧接触。

单人且无固定音色要求时默认原生声画同出；多人或固定音色路线不能为绕过配音容量检查而切换。只读编译仍可查看缺口，未经完整声音与口型看听的素材不能当作合格成片。

## 1. 开源配音：Qwen3-TTS

商业音频也可在「设置 → 媒体模型」配置。旧版本先点「更新内置适配器」，原文件会备份，已有模型与凭证保留；再点「同步并选择模型」，在「默认模型 → 配音与音频」选择平台和模型。目录查询不提交生成任务，也不代表账户已经开通调用权限。

- AtlasCloud：从实时目录同步语音、音乐及音效模型，选择后读取官方参数定义和音色。音乐额外参数通过 `audioParameters` 提交，例如 `lyrics`、`instrumental`、`duration`；仅允许模型参数定义中的标量字段。音乐不会混入角色配音的模型列表。
- EasyRouter：同步 GPT TTS 与 Gemini TTS。Gemini 使用原生 WAV 和默认语速；不把无法执行的格式、语速调整静默丢弃。
- 百炼：工作空间地址用于目录、Qwen-Audio-TTS、CosyVoice 与 MiniMax；Qwen-TTS 使用独立的同地域 DashScope 地址。CosyVoice 3.5 需要已创建的复刻或设计音色 ID。
- 火山引擎：方舟图片/视频支持目录同步；配音单独选择「火山引擎 · 豆包语音」，使用语音控制台创建的 API Key。语音资源与方舟目录独立，内置已适配资源，音色 ID 从语音控制台复制。

语音转录输出文字，不放进音频文件生成列表；已有音色的使用与创建新克隆音色是两个接口，不将上传参考音频伪装成已完成克隆。

采用官方 **Qwen3-TTS-12Hz-1.7B-CustomVoice**，通过 vLLM-Omni 的 `/v1/audio/speech` 调用。它提供 9 种固定音色，并通过 `instructions` 接收情绪/风格说明；说明与真正朗读的 `input` 分开，避免把“悲伤地说”读出台词。

本适配器没有实现声音克隆，也不将 0.6B 模型当作支持表演指令的 1.7B 模型。

在有兼容 GPU 的主机上，先按 [vLLM-Omni 安装文档](https://docs.vllm.ai/projects/vllm-omni/en/latest/getting_started/installation/) 完成安装，再运行官方 [Qwen3-TTS 部署方案](https://github.com/vllm-project/vllm-omni/blob/main/recipes/Qwen/Qwen3-TTS.md)：

```sh
vllm serve Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
  --omni \
  --deploy-config vllm_omni/deploy/qwen3_tts.yaml \
  --host 127.0.0.1 \
  --port 8091 \
  --trust-remote-code \
  --enforce-eager
```

安装方式、CUDA 版本和 GPU 内存要求以该版本的官方部署文档为准。模型权重在推理环境首次加载时下载，LITTO 不在后台自动安装 Python、CUDA 或权重。macOS 桌面可连接另一台已部署的 GPU 主机；不能把 Linux/CUDA 命令直接当作 macOS 本地安装方案。

在 LITTO 的「设置 → 媒体模型 → 添加内置供应商」选择「Qwen3-TTS · 开源配音」，填服务地址（默认 `http://127.0.0.1:8091`）。可填写服务令牌；不使用认证的本地服务留空。地址也接受末尾 `/v1`。

回到配音面板刷新模型，添加角色、选择模型和音色，然后添加台词。情绪可以选预设，表演说明可填写“语气克制，句尾放轻，第二句稍作停顿”等自然语言。每句独立生成，音色一致性不等同于表演已合格，仍需试听。

## 2. 开源对口型：MuseTalk 1.5

按 [官方 MuseTalk 安装和权重说明](https://github.com/TMElyralab/MuseTalk) 部署 Python、PyTorch、FFmpeg 和模型。此适配器对接官方 `app.py` 的 Gradio 4.44/5 命名 API：`check_video` 与 `inference`。

在 MuseTalk 仓库及其独立 Python 环境中启动：

```sh
python app.py --ip 127.0.0.1 --port 7860
```

FFmpeg 不在 PATH 中时，使用官方的 `--ffmpeg_path` 指定其目录。不要启用 `--share` 来代替正式的服务部署。LITTO 不会修改 MuseTalk 上游源码。

在媒体模型设置中添加「MuseTalk · 开源对口型」，填 Gradio 服务根地址（默认 `http://127.0.0.1:7860`，不加 `/gradio_api`）。刷新配音面板模型，并选为对口型模型。为每句对白上传人物原片，先试听和选定配音，再点击「为此句对口型」。旁白不提供口型按钮。

适配器先上传音频/视频，经 `check_video` 处理帧率，再调用 `inference`，等待真实完成事件，下载结果并保存到工作区。上传、模型、事件流或下载失败均返回错误，不返回成功占位视频。远端服务应允许 HTTP 长连接，配音默认最多等待 10 分钟，对口型最多等待 30 分钟。

MuseTalk 更适合单个、清晰可见的人脸。多人同时说话、侧脸、遮挡、夸张表情需要逐镜检查。原片比音频短时上游可能往返重复帧；LITTO 在提交前要求同长且规划完整的对应发声片段，容量不足须重排，不能截断对白或循环画面。此接口仅调整嘴部区域，不能保证改变全身表演。停止 LITTO 请求会停止等待/后续写入；Gradio 远端 GPU 任务不保证随断连取消，必要时在推理服务端停止。

官方示例内部使用共享临时输出文件；单个 MuseTalk 实例应保留单并发队列，不要擅自提高并发。增加吞吐时运行多个相互隔离的实例。

## 3. 部署边界与合成

- `127.0.0.1` 指 LITTO **服务端**所在主机。推理服务不在同一机器时，填实际可访问地址。
- 保留现有 SSRF 校验。单机桌面模式允许本机服务；多人服务默认拒绝用户配置内网地址。多人部署优先使用已鉴权的公开推理网关，不为接入此功能全局放宽内网访问保护。
- Qwen3-TTS 适配器支持 Bearer 服务令牌；MuseTalk 适配器面向可信部署，不实现 Gradio 账号登录或 Hugging Face 私有空间认证。不要将无鉴权的推理服务直接暴露在公网。
- 「按台词顺序合成 WAV」复用 LITTO 现有 FFmpeg 功能，把每句选定配音转为 24 kHz 单声道并顺序拼接，保留句后停顿。它不会自动把旁白混入视频，也不会覆盖镜头制作面板已经批准的 Take。生成的素材可继续用于剪辑。
- 助手可通过 `listMediaModels` 查到 `speechInstructions` / `lipSync` 能力，使用 `generateAudio` 的 `voice` 和 `instructions`，或向口型模型传入一段视频与音频。没有这些能力时明确报错，不将语气指令默默丢弃。

## 验证范围

应用类型检查、构建、接口输入校验与浏览器交互可在无 GPU 机器上验证。真实音色、情绪表现和口型效果必须连接部署好的模型后，用实际对白与人物视频完成试听/观看验收；接口适配验证不等于模型效果验收。

参考：[Qwen3-TTS 官方仓库](https://github.com/QwenLM/Qwen3-TTS)、[vLLM-Omni Speech API](https://github.com/vllm-project/vllm-omni/blob/main/docs/serving/speech_api.md)、[MuseTalk 官方 Gradio 入口](https://github.com/TMElyralab/MuseTalk/blob/main/app.py)。代码、权重及依赖的使用条件以各上游发布版本为准。
