# 对白、旁白与对口型

工作区画布上方的「配音与口型」面板提供：角色固定音色、逐句对白/旁白、情绪和表演指令、语速、试听、配音版本选择、人物视频上传、逐句对口型、整段 WAV 合成。

角色音色与每句语气分开保存。同一角色跨句复用同一个供应商、模型和音色。修改台词、音色、语气或语速后，旧配音会标为过期，不能直接用于新口型或合成。重新生成不会覆盖旧文件。

方案保存为工作区 `voiceProject.json`，文件结构由 `@toonflow/tool-media-generation/voiceProject` 的 `voiceProjectSchema` 校验。音频、人物原片和口型结果保存在 `assets/speech/`。删除方案中的条目不删除素材文件。完整配置保存成功后才发送生成请求；保存失败会保留页面上的结果，须重试保存再离开。

## 1. 开源配音：Qwen3-TTS

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

MuseTalk 更适合单个、清晰可见的人脸。多人同时说话、侧脸、遮挡、夸张表情需要逐镜检查。原片比音频短时上游可能往返重复帧；请先裁好镜头。此接口仅调整嘴部区域，不能保证改变全身表演。停止 LITTO 请求会停止等待/后续写入；Gradio 远端 GPU 任务不保证随断连取消，必要时在推理服务端停止。

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
