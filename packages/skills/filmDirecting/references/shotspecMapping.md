# ShotSpec 落点

只使用现有字段。字段不存在时写入最接近的文本项，不发明 `stagingPattern`、`directorIdea` 这类新键。

## camera.design

| 字段 | 写入什么 |
| --- | --- |
| technique | 技术名，如 `I-pattern OTS`、`power contrast`、`dual push-in`。不用导演姓名代替技术 |
| purpose | 为什么此刻从这个位置看；固定机位也要写目的 |
| start | 触发前已在画内的站位、朝向、持物、墙和门。稍后入画写进时间线 |
| end | 行动后的真实落幅 |
| subjectPath | 人物从哪走到哪、何时转身、与谁交换位置 |
| cameraPath | 机位自己的路径；静止写「锁定」 |
| timing | 本镜局部秒数，从 0 到 duration |
| cut | 出入剪点：信息、反应或动作相位 |
| invariants | 墙、轴线一侧、钥匙在谁手里、屏幕方向 |
| acceptance | 观看时能判定的结果，例如「能分清谁在逼近、走廊尽头的门仍在画右」 |
| fallback | 模型做不到环拍或双推时的替代，例如「切成匹配景别的正反打」 |
| mode / timeline | 连续用 singleTake；镜内切用 multiShot，节拍写进 timeline |

## 与其他字段的分工

| 字段 | 本技能补充 |
| --- | --- |
| camera.shotSize / height / angle / lensMm / side / screenDirection / axisCrossing | 景别、高度、焦段、轴线一侧。力量对比时进攻者短焦略仰、另一方平视更长焦 |
| blocking | 俯视关系：I / A / L、面对面或肩并肩、谁在门边 |
| performance.eyeline / lookTarget | 视线离镜头的偏移；正视镜头仅在主观或有意震惊时使用 |
| action | 谁对谁要钥匙、靠近、转身、交出或拒绝 |
| narrativeFunction | 建立地理、揭示地位、反应、对比 |
| creativeBrief.intent / visualPayoff | 观众应理解的关系；必须看清的证据（手中钥匙、谁先低头） |
| lighting | 世界光源不随反打换边 |

## 编译检查

保存后看 compile 请求：是否同时把人物路径和相机路径写进画面动作；是否要求摄影机穿过已知墙壁；是否把两张脸叠成肥皂剧后脑勺构图。冲突先改原字段。
