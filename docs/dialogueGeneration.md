# 对白生成策略与供应商核对

核对日期：2026-10-25。范围为仓库内全部 11 个视频适配器，以及独立配音接口与视频接口的职责边界。

## 默认流程

- 单人且无需固定音色的画内对白默认 `creativeBrief.dialogue.mode: "native"`。说话人、原文、发声窗口、表演与完整嘴部覆盖进入视频提示词。当前选定模型必须声明 `nativeDialogue` 和声音输出能力；编译返回并保存 `generateAudio: true`，不能静默使用无声模型或后期叠对白。
- 多人项目按项目内全部镜头统计说话人，默认固定角色配音路线，分别拍摄的正反打也适用。每个角色在 `voiceProject.roles` 唯一绑定人物 `assetId`、语音供应商、模型和 `voice`，逐句关联角色及镜头原句索引；未采用配音前不提交视频。新配音只加入候选，明确采用后再实测、规划与专用口型处理；已采用声音直接复用。角色语音模型独立于音乐默认模型，仍只用已配置且未停用的供应商；不调用未充值的 APIMart。详见 [配音流程](voiceProduction.md)。
- 固定音色或已有采用配音使用 `post`：先确定、实测和绑定原句声音，再规划视频及专用口型处理。即使旧规格写 native，只要绑定了采用的声音，也按固定声音路线检查，不能重新随机生成音色。显式 post 缺声音、改词后的旧声音、配音超窗都会在提交前拦截。
- 旁白、音乐和环境声可以后期制作。画内对白不允许作为独立音轨直接叠加；固定声音的正式输出还必须关联真实口型任务、原视频、驱动声音及当前检查记录。
- `audioReference` 只表示能接收参考音频，不能证明能原生生成对白，也不能证明输出逐字保留某段录音。原生对白、音频参考、专用 `lipSync` 分别声明与检查。
- 生成和恢复都读取实际交付文件。要求有声却没有音轨时保留原文件、阻止采用及自动重试；已经落盘的恢复检查点也不能绕过检查。音轨存在仅是技术检查，台词、说话人及口型仍须完整看听。

## 适配器与参数

| 适配器 | 已接通的声音能力 | 传参及边界 |
| --- | --- | --- |
| Vidu | Q4 Preview 原生声画；多参考音频 | `audio`；参考模式的 `sounds`。单首帧模式不能冒充音频参考。 |
| 可灵 | Video 2.6 原生声画 | `sound: on/off`；有声需要 1080P 专业模式。当前适配器不接音频参考。 |
| 火山方舟 | Seedance 1.5 Pro / 2.5 原生声画 | `generate_audio`；当前已实现图片参考、首尾帧，音视频参考明确拒绝。 |
| 百炼 | Wan 2.6 文生视频、Flash 首帧视频原生声画 | 首帧模式 `parameters.audio`；文生模式固定有声。当前适配器未接入官方 `audio_url`，明确拒绝参考音频，不宣称已支持固定录音驱动。 |
| Atlas Cloud | 已核验 Kling 2.6、Seedance 1.5 Pro 家族的原生声画；Sync Lipsync v3 专用口型 | 原生模型按实际 schema 的 `sound`；Sync 使用 `video_url + audio_url`。未知动态模型即使有 sound 字段，也不推断能生成原生对白。 |
| APIMart | 已列出的 Seedance 2.x、Wan 3.0、H3 原生声画；多模态参考 | Seedance 使用 `generate_audio`；Wan 3.0 修复为 `audio`；H3 文档固定带音轨，没有 `generate_audio`，移除原来猜测的开关。参考音频经 `audio_urls` 发送；非参考模式传入音视频会在本地报错，不再丢弃。 |
| 秘塔 H3 | 原生声画、多模态参考 | 接口固定带音轨，能力修正为 `audio: true`；声音要求在 `content` 文本，参考声音使用 `reference_audio/audio_url`。不虚构声音开关。 |
| EasyRouter | 已核验 Seedance 1.5 / 2.0 / 2.5 与 PixVerse 5.5 / 5.6 / 6 的原生声画 | Seedance 使用 `metadata.generate_audio`，PixVerse 使用 `metadata.generate_audio_switch`。其他版本只按已经实现的能力声明，不由“支持音频”推断对白能力。 |
| MuseTalk | 专用口型 | 上传已选音频与原视频，依次执行 `check_video`、`inference`，不作为原生视频生成模型。 |
| GEN3C | 相机轨迹视频，无声音生成 | 明确拒绝声音及音频参考；不能承担原生对白。 |
| Agnes | 当前仅接通文生视频，未接通声音控制 | 明确拒绝音频开关和音频参考；不宣称原生对白。 |

独立音频供应商（包括火山语音、Qwen Speech 和各平台的 TTS）只生成配音；不会因为生成了声音就改变已有画面嘴形。固定音色继续复用已经选择的声音与专用口型模型，不擅自更换供应商。内置适配器升级时同步修正声音能力字段，保留密钥、默认模型选择、用户精度及历史结果。

## 主要核对来源

- [Vidu Q4 原生音频和 sounds](https://platform.vidu.cn/docs/api-reference/video-models/vidu-q4-preview/reference-to-video)
- [可灵 2.6 原生音频](https://kling.ai/quickstart/klingai-video-26-audio-user-guide)
- [Seedance 1.5 Pro 官方说明](https://seed.bytedance.com/en/seedance1_5_pro)、[方舟创建视频任务](https://docs.volcengine.com/docs/82379/1520757)
- [百炼 Wan 2.6 首帧接口](https://help.aliyun.com/en/model-studio/legacy-image-to-video-api-reference/)
- [APIMart Seedance](https://docs.apimart.ai/en/api-reference/videos/seedance-2-0/generation.md)、[Wan 3.0](https://docs.apimart.ai/en/api-reference/videos/wan3.0-video/generation.md)、[H3](https://docs.apimart.ai/en/api-reference/videos/minimax-h3/generation.md)
- [秘塔 H3 官方教程](https://metaso.cn/minimax-h3/guide)
- [PixVerse 5.6 原生声音](https://docs.pixverse.ai/PixVerse-V5-6-User-Guide-2fe3e99bf350806f86adc8a55de3c3a7)、[模型能力表](https://docs.platform.pixverse.ai/model-capability-map-2394982m0)
- [MuseTalk 官方实现](https://github.com/TMElyralab/MuseTalk)

## 实际验证

未新增测试文件、测试框架或检查入口；通过直接执行的 TypeScript、临时配置和本地媒体核验，不调用真实付费生成接口。

- 32 个实际适配器请求截获场景：有声/无声开关、台词、9:16 与参考音频映射；另核验 Sync、MuseTalk 的原视频与驱动声音传递。
- 隔离数据库中验证默认 native、没有音频参考槽的原生声画、音频参考不能冒充原生对白、固定声音复用及旧台词绑定拦截，不改真实项目。
- 本地真实短片验证有声收取、缺音轨拦截、横屏恢复拦截、明确无声素材收取；重复恢复仍只有两个有效素材节点，原文件哈希不变。
- 临时配置验证 H3/Wan 能力升级，并核对默认选择、凭据、用户标签和精度保持；本机 8 个已安装内置适配器已备份更新，设置文件哈希不变。
- Providers、媒体工具、Cloud、Server 类型检查，以及媒体工具和 Server 构建通过。

参数截获和本地文件检查不冒充真实供应商的对白、音色及口型效果验收。正式结果仍需完整播放检查。
