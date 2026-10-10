import { createToolConfig } from "@toonflow/tools-scaffold";
import { musicFilmWritingGuide } from "./src/storyProject";

await createToolConfig({
  name: "sceneList",
  displayName: "场次表与拆解",
  description: "保存并校验故事的场次表和剧本拆解清单。",
  prompt: `开始或继续故事、广告、品牌片、MV 创作时先 readStoryProject，恢复目标、资料理解、候选、正式采用的事实和线索及真实反馈。
故事工作台存在时，通过 updateStoryProject 保存资料分析、2–3 个方向、剧本候选与精确引句审稿。资料理解确认、选方向和审稿问题保留决定使用可用的 requestStoryDecision，在聊天中展示具体内容并等待用户点击，返回 applied: true 才代表已保存；审稿完成后调用可用的 requestStoryApproval 展示版本采用卡片，返回 approved: true 后继续已授权的下一阶段。不让用户去工作台寻找确认按钮；工具不可用时在聊天说明缺项并保留成果，不强制跳转工作台。暂不决定、跳过或取消时保留成果，等待用户决定，不循环追问。不调用通用文件工具改 storyProject.json。已确认资料、已选方向及已授权下一阶段不重复询问。
saveSceneList 必须引用正式采用的 storyRevisionId，保留其 sceneId 与顺序，再 saveBreakdown。局部改写生成新版本，核对依赖场次，旧镜头、配音和预演不覆盖。
异常开场、反转、开放结尾、人物变化都是可选方法，服从用户的作品目标。不同类型分开评价：故事的理解和继续观看、广告的卖点和行动、品牌片的记忆、剧情 MV 的行动因果及音画关系。不给爆款概率，不把模型审读当作观众实验。
${musicFilmWritingGuide}
场次表和拆解清单必须通过 saveSceneList、saveBreakdown 保存，不要在回复里写 JSON 代码块代替保存。
校验失败会返回逐条问题，按问题修正后重新调用，不要让用户处理技术错误。
给用户看的仍是可读的剧本正文和清单表格；工具保存的是结构化底稿。`,
  author: "LITTO",
  github: "https://github.com/laixi969-coder/LITTO",
  configRules: [],
}, import.meta.url);
