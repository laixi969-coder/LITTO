import { createToolConfig } from "@toonflow/tools-scaffold";
import { musicFilmWritingGuide, shortDramaWritingGuide } from "./src/storyProject";
import { storyLogicGuide } from "./src/storyLogic";

await createToolConfig({
  name: "sceneList",
  displayName: "场次表与拆解",
  description: "保存并校验故事的场次表和剧本拆解清单。",
  prompt: `开始或继续故事、广告、品牌片、MV 创作时先 readStoryProject，恢复目标、资料理解、候选、正式采用的事实和线索及真实反馈。
新故事先用 framework 保存标题、作品形式和可读框架（一句话故事、人物与锁定事实、主要段落、伏笔和结尾），再调用 requestStoryDecision(confirmFramework) 等待用户亲自确认并选择 sample、episodes 或 draft。未确认不写完整正文，自动决定不代替框架确认；框架或依据变化后重新确认。样稿与分集大纲用 expansion 保存，完整正文仍用 draft。已有定稿局改不重新起框架。每轮给少量具体下一步选择；用户只选一场或一集就只写该范围。电影不因“继续”变剧集，核对人物年龄、时间跨度、道具内容与数字，修改已定事实须说明。用户禁止存盘时，在聊天交框架后停下等确认。
故事工作台存在时，通过 updateStoryProject 保存资料分析、2–3 个方向、剧本候选与精确引句审稿。资料理解确认、选方向和审稿问题保留决定使用可用的 requestStoryDecision，在聊天中展示具体内容并等待用户点击，返回 applied: true 才代表已保存；保存候选后调用可用的 requestStoryApproval 展示版本采用卡片，返回 approved: true 后继续已授权的下一阶段。不让用户去工作台寻找确认按钮；工具不可用时在聊天说明缺项并保留成果，不强制跳转工作台。暂不决定、跳过或取消时保留成果，等待用户决定，不循环追问。不调用通用文件工具改 storyProject.json。已确认资料、已选方向及已授权下一阶段不重复询问。
工作台审稿按需进行，重点检查影响主要行动、理解或结局的问题，次要细节作为建议。已有审稿会在采用卡片展示；审稿未完成、模型结构错误或审美分歧不阻止用户或获授权代理采用。不要反复复核无关细节或重选已定方向。
saveSceneList 必须引用正式采用的 storyRevisionId，保留其 sceneId 与顺序，再 saveBreakdown。整场改写用rewrite；只改指定词句用patch：before传当前整场原文，edits传唯一原句与替换文字，对白同步speechEdits。程序拼接并保留其余文字与字段，不用整场重写代替精确修改。局部改写生成新版本，核对依赖场次，旧镜头、配音和预演不覆盖。
故事创作与审稿统一读取当前 story 技能及其创作资料；工具提示只说明保存与交接，不能另设创作标准。不同类型分开评价：故事的理解和继续观看、广告的卖点和行动、品牌片的记忆、剧情 MV 的行动因果及音画关系。不给爆款概率，不把模型审读当作观众实验。
纯文字交付且指定篇幅范围时用prepareStoryText核对不含标题的正文，withinRange为false须修改再核对；此工具不保存文件，不违反只交文字的要求。精确局改传原稿与edits后直接使用返回text，不能重新生成整篇。程序计数和精确替换不代表因果或文学质量已经通过。
${musicFilmWritingGuide}
${shortDramaWritingGuide}
${storyLogicGuide}
以上数量、规则与关系检查在故事工作台作为按需创作参考，不能作为保存候选或请求采用的强制门槛。
剧情创作与审稿依据当前 story 融合技能执行。场次 text 保存完整正文与声音通道，speech 只存实际朗读原句；采用稿交给镜头声音计划时逐句追踪，不能以字幕存在代替真实发声。
探索视觉方向用 readVisualReferences。readStoryProject 和 readSceneList 的 visualReferences 提供本项目收藏的构图、光线或色彩方法；依照具体用途落实到当前 Look 和镜头，不自动复制参考片剧情、人物或场景。文字画像匹配不代表看过图片，电影画面收藏不等于生成素材授权。用户明确选定后通过 updateStoryProject 的 visualBoard 保存 frameId、purpose、note，不能编造 ID 或替用户采用。
场次表和拆解清单必须通过 saveSceneList、saveBreakdown 保存，不要在回复里写 JSON 代码块代替保存。
校验失败会返回逐条问题，按问题修正后重新调用，不要让用户处理技术错误。
给用户看的仍是可读的剧本正文和清单表格；工具保存的是结构化底稿。`,
  author: "MILI MILI",
  github: "https://github.com/laixi969-coder/LITTO",
  configRules: [],
}, import.meta.url);
