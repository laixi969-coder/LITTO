# 表演与电影调度资料：来源、修改和许可

核验日期：2026-10-06。星标来自当日 GitHub API；均为仓库总星标，合集内的单个技能没有独立星标。检索排除软件性能、角色扮演聊天和与影视表演无关的项目，不宣称覆盖 GitHub 全站。

| 上游 | 固定提交 | 星标 | 采用范围 |
| --- | --- | ---: | --- |
| [OSideMedia/higgsfield-ai-prompt-skill](https://github.com/OSideMedia/higgsfield-ai-prompt-skill) | `70754977d1884794963ac0a748eaaa85b6e9c82a` | 693 | skills/higgsfield-acting/SKILL.md：目标、策略、倾听、身体任务、目光与群像表演 |
| [nolanx-ai/nolanx.ai](https://github.com/nolanx-ai/nolanx.ai) | `595d86364377f654e24ddf2c9e875496d85e8246` | 1986 | skills/ 下 dialogue-performance-blocking、scene-blocking-and-staging、long-form-continuity-bible、world-asset-identity-lock、reference-driven-video-prompting、lighting-continuity-design、modular-film-prompt-bible 的 SKILL.md：对白、调度、状态连续性、参考分工与模块化设定 |
| [phileiny/h3-storyboard-skill](https://github.com/phileiny/h3-storyboard-skill) | `ce732bae6e05d2e4c4943e3e1fda2d515f9a2ff3` | 175 | skills/h3-storyboard/SKILL.md：景别对表演可见性的影响、减少单段任务、真实音画审看与局部剪辑修复经验 |

MILIMILI 于 2026-10-06 改写、删减并重组上述方法，形成 performanceDirection.md，以及 cinema/continuity 入口、shotLanguage.md 和导演规划提示词中的相关规则。固定版本方便复核；没有执行上游脚本或安装其平台工作流。许可证保留如下，上游作者不为本项目修改或生成效果背书。

## 适配取舍

- 保留用户剧本、台词、年龄、身体与声音身份；按人物动机设计当场行为。目标、情绪、策略只是规划方法，不能擅自新增冲突或隐藏经历。
- 删除固定字数、固定节拍数、固定镜头时长、所有角色必有小动作/眨眼配额、身份高低对应固定行为等要求。不把风格和人物经历映射成脏旧资产。
- 只在模型实际支持时使用音频、视频、口型和参考绑定；不将社区的特定模型经验当作跨模型硬限制，不承诺真实拍摄设备参数。
- H3 的对照样本属于作者在特定配置下的经验；不采用 PSNR 演技阈值、自动批量 seed 重试、强制增加对白、冻结帧代替自然表演等做法。
- NolanX 的动作轴线、资产锁定、光线与镜头职责在 MILIMILI 已有实现；只补充表演和调度缺口，不整套复制、不更换供应商。其固定开头钩子、持续升级、灰尘烟雾及默认禁用配乐等选项不作为 MILIMILI 默认。

2026-10-06 另核验 yuyolin/act-skill（当日 0 星、MIT）、MasterLeos/leos-six-department-directing-team-skill-v1（当日 137 星、未发现仓库许可证），当时均未复制入库。act-skill 的本次补充采用见下表；MasterLeos 继续仅保留历史评估记录。

## 2026-10-13 补充对照

本次评估范围为上表三个已有来源及下表三个新推荐仓库，共六个。只补充现有 performanceDirection.md 与 workflow 路由，不安装上游技能、脚本或知识库，不新增字段、数据库、运行依赖或独立表演系统。

| 上游与固定提交 | 实际处理 | 未采用部分 |
| --- | --- | --- |
| [yuyolin/act-skill](https://github.com/yuyolin/act-skill/tree/6752cec9efd5d4a71575192599fc0530db7351f8) | 参考 direct-ai-actor-performance/SKILL.md，以 MILIMILI 自有表述补充有依据的掩饰目标、摄影启动与停止时机、按需展开表演 | 固定信息配比、整库检索脚本、强制无声戏新增触发物；已有触发与反应规则不重复搬入 |
| [RICKY556677/ai-film-skills](https://github.com/RICKY556677/ai-film-skills/tree/dd9add981f04b914fc3355b7afed3953604261fa) | 对照 skills/acting/SKILL.md；未发现仓库级许可证，不复制其正文、模板或代码。角色习惯与当场行为沿用并澄清 MILIMILI 已有 O-Side 来源方法 | 固定英文长段、每场固定节拍数、强弱对应音量、所有习惯必须转换保留、以状态取代完整动作过程 |
| [Krenlis/director-craft-framework](https://github.com/Krenlis/director-craft-framework/tree/d6eb6443f643871247228998513071c458de3586) | 对照 SKILL.md 的表演与摄影协同，以自有表述补充反应可见性和剪点意图；大部分调度能力已存在 | 完整导演模板、器材参数堆叠、磨损等外观描述作为默认；保留上游 LICENSE 原文如下 |

电影、MV、广告的任务分流及单一时间线约束是 MILIMILI 针对现有接口的整合，不代表上游提供这些接口。生成前仍须检查真实编译请求，生成后检查实际媒体；本次没有用新视频验证效果。

### yuyolin：MIT

MIT License

Copyright (c) 2026 yuyolin

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

### Krenlis：上游 LICENSE 原文

该文件标题为 MIT License，但文本为删节版本，GitHub API 标识为 NOASSERTION；不将它记作标准 MIT 全文。

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

## O-Side Media：MIT

MIT License

Copyright (c) 2026 O-Side Media

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

## NolanX：MIT

MIT License

Copyright (c) 2026 NolanX

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

## Ray：MIT

MIT License

Copyright (c) 2026 Ray

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
