# 选角与摄影方法来源

2026-10-13 核对。按 LITTO 当前资产、镜头与参考接口重写局部方法，不整体安装上游，不运行外部脚本，不引入固定生成模型或外部账号。本文记录研究范围，不代表上游对 LITTO 成图效果背书。

| 来源 | 固定版本/范围 | 取舍 |
| --- | --- | --- |
| 本地 character-casting-studio | 本次读取的 SKILL.md、original-spec.md、material-reference-library.md | 参考分工、面部辨识度、多人差异和完好摄影呈现；不复制图片库，不引入强制素材数量、默认单图或重复皮肤补丁；沿用 LITTO 已有三视图约定 |
| [O-Side Media / higgsfield-character-design](https://github.com/OSideMedia/higgsfield-ai-prompt-skill/blob/70754977d1884794963ac0a748eaaa85b6e9c82a/skills/higgsfield-character-design/SKILL.md) | MIT；角色设定及试镜部分；人物框架由上游注明参考 Vinca 的 Character Design 方法 | 借鉴角色目标、矛盾和按能力设计试镜；删除完整世界构建前置、平台锁定、固定台词数及默认胶片颗粒。表演实现复用 LITTO 原有方法 |
| [南鸢 nuyoah / nuyoah-xiezhen-prompt](https://github.com/nuyoah-ai-works/nuyoah-xiezhen-prompt/tree/7482a14074bcffb9fed8eb8fe2ddcdc4ac2e980b) | MIT；SKILL.md 与 references/prompt-logic.md | 改编身份/表情/摄影分工、光源与机位关系、成像层次和回到原始参考核对；移除默认年轻女性、无身份图时放弃同脸检查、摄影图自动接管全部妆造等规则 |
| [Naga Codex / Maurice Holda — character-continuity](https://github.com/Nagacash/character-continuity-skill/blob/97757802b607dbd1c1e850aca3ed1b1c9f362624/skills/character-continuity/SKILL.md) | 文档 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，代码 MIT；本次只借鉴文档 | 改编回到人物主参考检查累积漂移、区分连续帧与身份基准；不采用固定候选数量、固定片长、多视图绝对禁令、默认伤疤与强制重生 |
| [snowfrost / ai-character-designer](https://github.com/snowfrost/ai-character-designer/tree/7d93d78098154ca912a8740a83555f74d4f03d51) | 本次未取得根许可证 | 仅研究比较，不复制其脸型库、分类体系、模板或代码；面部维度与候选比较使用 LITTO 已有 visualDesign 及用户需求独立组织 |
| [character-scene-design-skills](https://github.com/khanhhuyenngo985-sys/character-scene-design-skills/tree/f050a8736035277e453ca281ed79cfc28ff15e86) | README 声称 MIT，本次未取得完整根许可证 | 仅研究比较，不复制长表格、类型包或提示词；比例、道具与造型关联继续复用现有资产和状态引擎 |

修改位置：characterCasting.md、characterStyling.md、资产与 workflow 入口，以及共享生成/观察规则。所有上游的脏旧、欠曝或颗粒建议，只有用户明确采用对应效果才限域使用；全局默认干净、完整、清晰由本次用户需求确定。没有图片或视频实测时不将方法推荐写成已验证效果。

## MIT 声明

以下许可适用于本次局部改编的 O-Side Media 与南鸢方法，分别保留版权声明：

```text
MIT License

Copyright (c) 2026 O-Side Media
Copyright (c) 2026 南鸢 nuyoah

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
```
