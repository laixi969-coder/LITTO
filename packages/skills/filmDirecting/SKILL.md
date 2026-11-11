---
name: filmDirecting
description: 把对白场面、人物调度、轴线覆盖、分镜平面图和导演意图写成可执行的 ShotSpec.camera.design。用于电影、短剧、剧情短片中的对话戏、走位、正反打、过肩、力量对比、一镜调度与先期视觉化；不替代 cinema 的覆盖表、表演指导或 masterShots 抽象运镜卡，不直接生成媒体。
metadata:
  version: "1.0.0"
  displayName: 电影导演调度
  author: MILI MILI
  status: simulated
---

# 电影导演调度

把一场戏拍成观众能读懂的空间关系：谁要什么、站在哪、看向谁、摄影机从哪一侧观看。方法来自已读的肯沃斯《大师镜头》三卷、卡茨《电影镜头设计》、贝格莱特《从文字到影像》、丹西格《导演思维》和邵恩《诺兰变奏曲》。图解无法从扫描件重建，执行写文字路径，不假装画出原书 blocking 图。

正式镜头落到现有 ShotSpec，不另造字段。声音归属与拆镜容量继续用 [对白覆盖](../cinema/references/coverage.md)；表演任务用 [表演指导](../cinema/references/performanceDirection.md)；抽象运镜名用 [镜头方法卡](../cinema/references/masterShots.md)。本技能补的是场面调度、双路径设计和导演意图如何驱动机位。

## 何时读取

- 对白、争执、亲密、走谈、多人会话需要机位与走位方案。
- 要决定 I / A / L 形态、正反打、过肩、越轴或三角覆盖。
- 要先画平面图、镜头表或缩略图，再写分镜。
- 用户要压迫感、力量对比、环拍紧张、长焦隔离、不拆墙的封闭空间。

无人产品、纯 MV 卡点、只需抽象推拉摇移名称时，不必加载本技能。

## 判断顺序

1. **导演思维**：这场要让观众相信什么。写成一句潜文本，再决定表演和摄影是否指向同一件事。详见 [丹西格](references/dancyger.md)。
2. **空间与墙**：门、墙、通道、光源在世界里的位置。摄影机不退到观众已知墙壁之外。详见 [诺兰](references/nolan.md)。
3. **平面图**：先写俯视文字——人物坐标、朝向、视线、机位编号。有 `POST /api/ai/media/blocking` 时用走位板核对跳轴。详见 [贝格莱特](references/begleiter.md)。
4. **形态与轴线**：双人先定 I 形态；三人以上才用 A / L。轴线在两人视线之间，三人以上轴线会移动。详见 [卡茨](references/katz.md)。
5. **编舞**：`subjectPath` 与 `cameraPath` 分开写。不为移动而移动；选错焦段，表演再好也白费。详见 [肯沃斯](references/kenworthy.md)。
6. **落盘**：按 [字段映射](references/shotspecMapping.md) 写入 `camera.design`、`blocking`、`performance`、`narrativeFunction`。固定机位同样有效。
7. **验收**：删掉这镜会损失什么？左右是否跳轴？两张脸是否同时正对镜头成肥皂剧构图？墙是否被拆掉？

每次只读当前场面需要的一张方法卡，不把五张卡叠进提示词。

## 按场面选卡

| 场面 | 先读 | 落到 |
| --- | --- | --- |
| 双人对峙、要东西、地位差 | 肯沃斯 1.1 力量对比、10.2 L 形隔离；卡茨 I 形态面对面 | technique、height、lensMm、subjectPath |
| 短对白、互相吸引或压迫推进 | 肯沃斯 10.1 双人同速推近 | cameraPath、timing、cut |
| 同框对白、避免正反打肥皂剧 | 肯沃斯 10.3 分享镜头；卡茨 面向观众 | blocking、performance.eyeline |
| 肩并肩、共同看画外物 | 肯沃斯 10.4；卡茨位置二 | lookTarget、start |
| 争执、扑近、绕圈 | 肯沃斯 11.1–11.8 | subjectPath、cameraPath、invariants |
| 环拍制造礼貌紧张 | 肯沃斯 2.1 | cameraPath 等半径，dolly 优于手持 |
| 走谈、楼梯、距离不变 | 肯沃斯 7.1、10.8 | 距离恒定、stabilizer |
| 亲密坐下后推近 | 肯沃斯 9.1 | height 随坐下下降，push 后停 |
| 长焦隔离或压缩前后景 | 肯沃斯 3 卷 1.1 / 1.2 | lensMm、focus、depth |
| 交代地点 | 卡茨 8.2 三种景别策略 | narrativeFunction=建立 |
| 三人以上 | 卡茨字母模式；轴线随新视线移动 | camera.side、axisCrossing |
| 先期视觉化、宫格、镜头表 | 贝格莱特三层：文字 / 平面图 / 图像 | storyboardGrid、blocking |
| 封闭房间、迷宫、建筑叙事 | 诺兰空间 | invariants 含墙、入口顺序 |

## 硬规则

- 演员路线和摄影机路线必须分开。写「镜头跟着走」不等于已经设计两条路径。
- 面向观众是为了让脸可读，不是让两人都正对镜头叠脑袋。
- 正反打的好处是看见私下反应和改变视点；同框持续镜头在调度够用时保留。
- 越轴必须先让观众看清地理，再用新视线、演员走过旧线、连续运镜或切出镜头建立新工作区。
- 给演员自由走位之前，先有稳定的机位方法。
- 导演思维、表演定调和镜头选择指向同一体验。称职的底线是故事清楚、镜头可剪；优秀才加潜文本。
- 原书左右页图解、字母阵位照片、斯坦尼康平面图不能从 OCR 还原。需要图时用走位板 API 或文字俯视，不编造原书插图。

## 交付

文字方案：平面图（文字）、覆盖意图、每镜 `camera.design` 必填项。  
正式制作：`productionSpec(shot/updateShot)` 保存后 `compile`，检查请求是否保留路径分离、轴线和墙。  
本技能不授权付费生成。

阅读入口见 [来源与阅读记录](references/source-notes.md)。试跑记录见 [走廊对峙](evals/trialDialogueCoverage.md)、[张总 S15–S16](evals/trialZhangZongS16.md)。
