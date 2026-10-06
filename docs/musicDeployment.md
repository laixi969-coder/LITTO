# MV 开源转写部署

LITTO 的旋律与节拍分析在浏览器本地运行；听歌识词由独立 Speaches 服务运行 faster-whisper。下面的配置仅扩展现有 Docker 部署，不替代账号、数据库、邮件、HTTPS 等部署配置。

## CPU 服务器

在仓库根目录运行：

```sh
docker compose -f compose.yaml -f composeSpeech.yaml config --quiet
docker compose -f compose.yaml -f composeSpeech.yaml up -d --build
docker compose -f compose.yaml -f composeSpeech.yaml ps
docker compose -f compose.yaml -f composeSpeech.yaml logs --tail=100 speaches
```

默认使用多语言 `Systran/faster-whisper-small`、CPU int8、4 个 CPU 线程，LITTO 同时只接受 1 个服务器转写任务，忙时返回 429，不在内存排队保存歌曲。模型下载到 `speechModels` 持久卷，重建容器不会重新下载已有模型。首次启动需要能访问模型源，并留出下载时间；健康检查宽限 15 分钟，LITTO 等待 Speaches 健康后启动。下载失败时先查看日志、修复网络或模型配置，再重启 Speaches。

这是便于部署的默认模型，并不保证中文歌声、伴奏或长音的识别准确率。建议先用真实歌曲评估识词与时间戳，再决定是否换大模型。CPU 推理可能较慢；首次模型下载与加载也会增加等待时间。

## NVIDIA GPU 服务器

先安装 NVIDIA 驱动及 NVIDIA Container Toolkit，再运行：

```sh
export LITTO_SPEECH_MODEL=Systran/faster-whisper-large-v3
docker compose -f compose.yaml -f composeSpeech.yaml -f composeSpeechGpu.yaml config --quiet
docker compose -f compose.yaml -f composeSpeech.yaml -f composeSpeechGpu.yaml up -d --build
```

GPU 配置使用 float16；显存需求需按模型、音频长度和并发实际评估。更新与重启时继续使用同一组 Compose 文件和模型变量，避免退回 CPU 或 small 模型。

## 运行方式与配置

进入「拍一支 MV → 听歌识词 → 服务器开源转写」。新配置默认选择服务器模式，原来明确保存的自定义供应商仍保留。用户不需要填写商业模型密钥。

| LITTO 服务端环境变量 | 用途与默认值 |
| --- | --- |
| `LITTO_SPEECH_URL` | 管理员指定的可信 API 基础地址；未设置则关闭服务器转写。Compose 中为 `http://speaches:8000/v1`。 |
| `LITTO_SPEECH_MODEL` | `Systran/faster-whisper-small`；由服务器决定，前端不能指定其他模型。 |
| `LITTO_SPEECH_API_KEY` | 可选，自建远程转写服务的认证密钥；仅保留在后端。 |
| `LITTO_SPEECH_TIMEOUT_MS` | 默认 `900000`（15 分钟），允许 30000–3600000。 |
| `LITTO_SPEECH_CONCURRENCY` | 默认 `1`，允许 1–16，限制当前 LITTO 进程内的服务器转写并发。 |

Compose 内 Speaches 不发布公网端口，默认不配置服务间密钥。如需服务间认证，在自己的部署覆盖文件中为 Speaches 设置 `API_KEY`，并为 LITTO 设置相同的 `LITTO_SPEECH_API_KEY`，不要提交真实密钥。远程部署可仅在 LITTO 设置上述变量，并自行部署带认证的 Speaches。

只有管理员环境变量指定的固定地址允许内网访问；普通用户填写的供应商地址仍使用原有 SSRF 校验。无需关闭登录，也无需设置 `LITTO_ALLOW_PRIVATE_UPSTREAMS=1`。上游重定向被拒绝，防止密钥或歌曲被转发到其他地址。前端状态接口不返回服务地址或密钥。

`GET /api/music/status` 返回配置状态，不执行健康探测，也不证明模型已经可用。`POST /api/music/transcribe?source=server` 使用现有会话认证，接受标准 16 kHz 单声道 PCM WAV；前端负责将 MP3 转换为该格式。仍保留最长 10 分钟、响应最大 2 MiB 的限制。

LITTO 前置反向代理须允许至少 20 MiB 的转写请求和大于转写超时的读取时间。例如默认 15 分钟推理超时对应 Nginx `client_max_body_size 20m; proxy_read_timeout 960s;`。这是转写接口要求，其他上传接口的大小设置沿用原部署配置。多副本 LITTO 各自拥有并发计数，扩容时需在推理网关统一限流；这份配置不提供跨副本任务队列。

## 部署验收

1. 确认 Speaches 为 healthy、模型下载成功。
2. 登录 LITTO，打开 MV 面板，服务器模式显示配置的模型。
3. 上传一小段含清晰中文歌声的 MP3，执行听歌识词，核对句级与词级时间戳。
4. 试听卡点并修正错词、漏词和时间偏移；配置已读取不等于识别准确。

本次代码通过类型检查、构建及模拟上游 HTTP 联调；真实 Speaches 容器推理、GPU 性能和歌曲准确率须在目标服务器验收。

参考：[Speaches 安装](https://speaches.ai/installation/)、[转写接口](https://speaches.ai/usage/speech-to-text/)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)。镜像摘要固定于本次适配时的 CPU/CUDA 镜像；升级前重新验证模型和时间戳响应。
