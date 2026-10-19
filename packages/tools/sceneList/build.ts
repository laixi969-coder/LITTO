import { createToolConfig } from "@toonflow/tools-scaffold";
import { musicFilmWritingGuide, shortDramaWritingGuide } from "./src/storyProject";

await createToolConfig({
  name: "sceneList",
  displayName: "场次表与拆解",
  description: "保存并校验故事的场次表和剧本拆解清单。",
  prompt: `开始或继续故事、广告、品牌片、MV 创作时先 readStoryProject，恢复目标、资料理解、候选、正式采用的事实和线索及真实反馈。
故事工作台存在时，通过 updateStoryProject 保存资料分析、2–3 个方向、剧本候选与精确引句审稿。资料理解确认、选方向和审稿问题保留决定使用可用的 requestStoryDecision，在聊天中展示具体内容并等待用户点击，返回 applied: true 才代表已保存；审稿完成后调用可用的 requestStoryApproval 展示版本采用卡片，返回 approved: true 后继续已授权的下一阶段。不让用户去工作台寻找确认按钮；工具不可用时在聊天说明缺项并保留成果，不强制跳转工作台。暂不决定、跳过或取消时保留成果，等待用户决定，不循环追问。不调用通用文件工具改 storyProject.json。已确认资料、已选方向及已授权下一阶段不重复询问。
saveSceneList 必须引用正式采用的 storyRevisionId，保留其 sceneId 与顺序，再 saveBreakdown。局部改写生成新版本，核对依赖场次，旧镜头、配音和预演不覆盖。
异常开场、反转、开放结尾、人物变化都是可选方法，服从用户的作品目标。不同类型分开评价：故事的理解和继续观看、广告的卖点和行动、品牌片的记忆、剧情 MV 的行动因果及音画关系。不给爆款概率，不把模型审读当作观众实验。
${musicFilmWritingGuide}
${shortDramaWritingGuide}
剧情创作逐场写清目标、阻力、行动与可见变化，并给完整对白、说话对象、语气、身体任务、相对站位与触发后的反应。对白应改变对方的选择或关系，不让人物轮流讲设定；先用行动和镜头证据表达，旁白只用于已定的叙事功能，不能解释掉应演出的过程。慢戏、空镜与沉默写明带来的信息或关系变化，合并重复信息，不靠增加切镜数假装紧凑。场次 text 保留表演和声音通道，speech 只存实际朗读文字。审稿对照这些内容给原文依据，定稿后逐句追踪到镜头对白计划，不能以字幕存在代替真实发声。无声、旁白体和非剧情作品沿用用户目标。
探索视觉方向用 readVisualReferences。readStoryProject 和 readSceneList 的 visualReferences 提供本项目收藏的构图、光线或色彩方法；依照具体用途落实到当前 Look 和镜头，不自动复制参考片剧情、人物或场景。文字画像匹配不代表看过图片，电影画面收藏不等于生成素材授权。用户明确选定后通过 updateStoryProject 的 visualBoard 保存 frameId、purpose、note，不能编造 ID 或替用户采用。
场次表和拆解清单必须通过 saveSceneList、saveBreakdown 保存，不要在回复里写 JSON 代码块代替保存。
校验失败会返回逐条问题，按问题修正后重新调用，不要让用户处理技术错误。
给用户看的仍是可读的剧本正文和清单表格；工具保存的是结构化底稿。`,
  author: "MILIMILI",
  github: "https://github.com/laixi969-coder/MILIMILI",
  configRules: [],
}, import.meta.url);
