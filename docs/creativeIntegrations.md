# 创作能力整合

2026-10-11 接入四项能力，全部复用 LITTO 的故事工作台、Agent、镜头规格与文件入口。

| 来源 | 固定提交 | 接入方式 |
| --- | --- | --- |
| short-drama-factory | 0949e02b48cfee757e06edd4750a01ad4f56fa9a | story 短剧专项及工作台 serial 写作指引；MIT 见 shortDramaLicense.md |
| real-combat-director | ed3e262e092b6bf13f8a733c7757325c4db84f1d | 无明确 LICENSE，自行编写写实动作机制与多人调度资料 |
| xuanhuan-combat-director | 7a0567886d1137f2f54b6431793e3e36ccbbe948 | 无明确 LICENSE，自行编写能量尺度与终局接续资料 |
| frame-jev | b90729ba6acfebf22a3509d5bf65e8f36532574f | 复用精选文字画像、配色、画面来源与评分思路；界面适配 Vue，匹配使用用户已配置模型 |

## 视觉参考使用

故事工作台的“视觉参考”可浏览24位导演和282条画面来源，用当前创作模型评估故事/情绪/视觉三维适配；权重35%/35%/30%，聚焦筛选60分以上最多6个方向，探索筛选35分以上最多8个。该分数为主观建议，不是概率；仅评估文字画像，不声称分析了图片像素。没有配置模型仍可浏览与收藏。

收藏存入 storyProject.json 的 visualBoard（最多24条，每条唯一 frameId、用途和具体说明），沿用工作区授权、只读成员限制、版本冲突检查与原子保存。旧项目缺少该字段时默认为空。readVisualReferences 查询目录；readStoryProject 返回解析后的收藏，助手将采用方法落实到 Look 与镜头。导出使用工作区文件入口，仅写来源清单。

Frame 的 Next/React 页面、Jev 专有服务及密钥机制未搬入；不新增外部账号依赖。不得把画像匹配当图像分析，不自动下载电影图片、不将其当角色身份资产或生成输入。参考用途改变不自动改写已采用镜头。

## 图像与第三方范围

Frame 的 MIT 许可不覆盖电影图片、TMDB 数据、商标及其他第三方权益。图片浏览请求由客户端发送到 image.tmdb.org，来源链接指向 TMDB；电影画面权利属于各自权利人。收藏、导出和公开链接都不授予素材重用权。项目不由 TMDB 背书或认证。商业使用需核对实际提供方条款及图片权限：

- https://www.themoviedb.org/terms-of-use
- https://developer.themoviedb.org/docs/faq
- https://www.themoviedb.org/about/logos-attribution

书面画像与色板是编辑性解释，不是导演官方规范。LITTO 独立实现 Vue 工作台、校验与持久化，修改不由上游作者背书。

## 接入验证记录

服务端、前端与 sceneList 工具类型检查通过，三者构建通过。临时数据目录中的真实 HTTP 验证覆盖收藏保存与重读、重复/未知参考及空说明拒绝（400）、旧版本保存冲突（409）。模块和工具调用验证覆盖旧项目默认值、只读成员（403）、并发保存、仅收藏时独立场次表不被阻断、参考查询与故事交接、因果下游和事实/线索变化后的新预演失效、旧预演保留。内置技能在临时目录同步后可被 Agent 发现，新增资料链接可读取。

浏览器实际打开故事工作台、视觉参考、电影画面详情，确认图片加载与未配置模型时匹配入口禁用。两路只读对抗审查发现并修复收藏误触发故事门槛、重复参考错误状态、因果下游及事实变化仍复用预演的问题，复核无剩余阻断项。未创建测试文件；未调用收费模型或生成视频，匹配建议和动作成片质量仍需实际模型与素材检验。

## Frame MIT 许可原文

MIT License

Copyright (c) 2026 xwen111

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
