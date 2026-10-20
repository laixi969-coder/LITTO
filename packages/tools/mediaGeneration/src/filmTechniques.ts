export const techniqueVersion = 1;
export const techniqueStages = ["image", "video", "edit", "audio", "story", "look"] as const;
export type TechniqueStage = typeof techniqueStages[number];
export type TechniqueSelection = { id: string; purpose: string; execution: string; start?: number; end?: number };
type TechniqueGroup = {
  category: string; stages: TechniqueStage[]; parameters: string; checks: string; limits: string;
  motion?: "static" | "moving"; timeEffect?: boolean; entries: string;
};

// 分类及术语索引参考 https://grokfilm.app/；执行描述、边界与检查规则由本项目编写，不复制其定义、提示词或样片。
// ACT: 同类条目共享参数与边界，每项保留自己的可见结果；目录是可检索数据，不把300项塞进生成提示词。
const groups: TechniqueGroup[] = [
  { category: "camera", stages: ["image", "video"], parameters: "主体、观看位置、环境占比、视线与遮挡", checks: "主体大小、空间关系与关键动作是否按计划可读", limits: "景别服务本镜信息，不按固定远中近循环；焦段数字不保证模型真实光学控制", entries: `
Aerial Shot|航拍|从高处斜看主体与地理关系，保留必要地标。
Bird's Eye View|鸟瞰|从主体正上方交代平面位置与路线。
Close-Up Shot|近景|让脸部或主要对象占据画面重点，保留必要动作空间。
Dutch Angle|荷兰角|画面水平线有意倾斜，主体仍可辨识。
Establishing Shot|建立镜头|交代人物、目标、障碍与出口的空间关系。
Extreme Close-Up|大特写|只突出一个决定性的局部细节。
Extreme Long Shot|大远景|以环境尺度说明主体处境，主体位置仍可定位。
Eye-Level Shot|平视|从主体视线附近观察，不额外制造俯仰关系。
Head-On Shot|正面机位|主体主要运动或朝向对着机位，保留纵深。
Helicopter Shot|直升机视点|高空斜向观看地貌和运动路线，不凭名称添加飞行器。
High Angle Shot|俯拍|机位高于主体，说明其与下方空间的关系。
Insert Shot|插入细节|突出已有道具或接触点，不新增剧情线索。
Long Shot|远景|完整呈现身体行动与周边空间。
Low Angle Shot|仰拍|从主体下方观看，保持体型与空间比例。
Master Shot|主镜头|建立全场人物位置与行动关系，作为覆盖基准。
Medium Shot|中景|同时看清人物任务、手部动作与互动对象。
Over-the-Shoulder Shot|过肩|用前景肩部建立听者与说话者的关系，不遮挡关键表演。
Overhead Shot|顶拍|垂直俯视动作区域，保持方位与接触可读。
P.O.V. Shot|主观视点|画面来自已建立角色的观看位置和视线。
Two-Shot|双人镜头|同框呈现两人的距离、朝向和互动。
Three-Shot|三人镜头|让三人的位置与不同任务均可辨识。
Cowboy Shot|牛仔景别|从大腿附近向上取景，保留手与腰间动作。
Medium Close-Up|中近景|看清面部判断，并保留胸肩与相关手势。
Choker Shot|紧面部近景|紧贴面部取景，避免裁掉关键口型或视线。
Canted Frame|倾斜构图|有目的地倾斜水平线，保持空间识别。
Worm's Eye View|贴地仰视|从地面附近向上观察主体及支撑关系。
American Shot|美式中远景|保留大腿以上与手部活动范围。
Full Shot|全身景|完整保留头脚、支撑点与身体位移。
Head Shot|头部特写|突出头部表演，发声时保留完整嘴部。
Italian Shot|眼部特写|只突出眼睛与视线变化，不要求该画面证明口型。
Profile Shot|侧面镜头|从侧向呈现面部或运动轮廓。
Reverse Angle|反向机位|改变观看方向但保持人物轴线、视线和世界光源。
Trunk Shot|箱内视点|从已存在的容器内部向外观察，不凭技法新增容器。
Wide Shot|广景|呈现主体全身与必要环境，交代相对位置。` },
  { category: "camera", stages: ["video"], parameters: "触发、起点、路径、主体速度、停止点、焦点", checks: "机位运动是否有起止、是否跟上动作且保留接触与结果", limits: "文字轨迹是视觉意图，不保证原生数值控制；不得等待运镜而拖慢人物行动", motion: "moving", entries: `
Dolly Shot|轨道移动|移动机位改变观看距离或遮挡关系，区别于原地变焦。
Handheld Shot|手持|让机位对具体身体行动产生适度响应，保持主体可读。
Steadicam Shot|稳定跟随|连续穿越空间并维持稳定观看关系。
Tracking Shot|移动跟拍|跟随主体真实位移，速度由行动决定。
Pan Shot|横摇|从固定位置水平转动观看方向，按触发到达目标。
Crane Shot|摇臂升降|沿明确升降路线揭示空间与主体关系。
Tilt Shot|俯仰摇镜|从固定位置上下转动观看方向。
Whip Pan|甩镜|快速转向一个已确定目标，落定后恢复可读画面。
Zoom Shot|变焦|机位保持原位，仅改变取景范围。
Push In|推进|靠近主体以突出新信息，不默认缓慢推进。
Pull Out|拉远|远离主体以揭示其周边关系。
360-Degree Shot|整周环绕|绕主体一周，保持方向、地标与动作连续。
Crash Zoom|急变焦|短促改变取景范围后停在明确的信息点。
Snorricam|身体绑定机位|保持机位相对角色躯干的关系，让背景体现位移。
Impossible Shot|非常规机位路径|只执行已明确且可实现的路径；不默认穿透封闭实体。
Arc Shot|弧线移动|沿指定弧线改变人物关系与背景透视。
Boom Shot|垂直升降|移动机位高度而不把升降误作人物动作。
Dolly-In|推轨|移动机位靠近目标，保留空间透视变化。
Dolly-Out|拉轨|移动机位退离目标，揭示周边空间。
Follow Shot|尾随跟拍|从主体后侧跟随实际行动路线。
Jib Shot|小摇臂|沿短距离升降弧线重新组织前后景。
Pedestal Shot|垂直移机|机位整体垂直移动，区别于原地俯仰。
Smooth Tracking Shot|平稳追踪|平稳匹配主体速度，保留动作重心与背景参照。` },
  { category: "camera", stages: ["video"], parameters: "起始焦点、触发、目标焦点、落点及速度", checks: "焦点是否按证据顺序转移，目标信息是否清楚", limits: "不能同时要求全程极浅景深和所有层次清晰；不保证模型真实焦距控制", entries: `
Rack Focus|拉焦|从一个已有对象转到另一个已有对象，注意力随剧情证据转移。
Vertigo Effect|眩晕变焦|反向协调机位与变焦，主体大小相对稳定、背景透视变化。
Dolly Zoom|推拉变焦|指定移机与反向变焦的起止，保持主体大小相对稳定。` },
  { category: "camera", stages: ["image", "video"], parameters: "固定观看位置、构图、焦点、允许的主体行动", checks: "机位是否稳定，人物是否仍完成计划行动", limits: "固定摄影机不等于冻结人物或丢失动作", motion: "static", entries: `
Static Shot|固定机位|保持观看位置，让表演与行动在画面中自然完成。
Locked-Down Shot|锁定机位|机位和取景固定，保留物体真实运动。` },
  { category: "camera", stages: ["video"], parameters: "连续观看路线、人物路径、焦点与遮挡交接", checks: "连续行动是否完整，是否出现无计划切镜、重置或瞬移", limits: "长镜不等于慢动作；技术限制不能靠跳过动作结果解决", entries: `
One-er (Oner)|一镜到底|在连续镜头内通过调度或有动机的跟随组织多个相连节拍。` },
  { category: "camera", stages: ["edit"], parameters: "双方位置、视线、切点、声音归属", checks: "正反打是否保持空间、动作阶段与对白完整", limits: "使用实际时间线；不强制每句一切，不以反应镜掩盖未同步的可见嘴部", entries: `
Shot-Reverse-Shot|正反打|根据说话、倾听与关系变化选择两侧覆盖，而非机械轮流。` },
  { category: "camera", stages: ["video"], parameters: "明确的局部开始与结束、叙事理由、恢复实时的节点", checks: "只在指定区间改变时间，接触与结果连续，声音同步不被改写", limits: "不能用于填满时长或默认放慢打斗救援；不得覆盖对白或演唱同步窗口", timeEffect: true, entries: `
Slow Motion|慢动作|只放慢明确指定的关键节拍，结束后恢复实时。` },
  { category: "lighting", stages: ["image", "video"], parameters: "世界光源、对象位置、方向、软硬、明暗关系、变化触发", checks: "光源位置、阴影和材质响应是否连贯，关键动作是否看得清", limits: "沿用场景光源与Look，不因技法新增灯具、改变时间天气或默认压暗", entries: `
Three-Point Lighting|三点布光|区分主光塑形、补光控影与背光分离，按需求取用。
Key Light|主光|用主要光源突出当前观看对象的形体。
High-Key Lighting|高调|保持明亮且阴影可读，保留材质层次。
Low-Key Lighting|低调|用有限亮区组织注意力，关键行动仍可读。
Chiaroscuro|明暗对照|通过明确亮暗区域组织形体与关注点。
Rembrandt Lighting|伦勃朗光|侧上方光在背光侧脸颊形成可辨的亮区。
Silhouette|剪影|通过背景明度分离主体轮廓，避免依赖看不见的表情。
Golden Hour|金色时段|仅在既定时段允许时使用低角度暖光。
Blue Hour|蓝调时段|仅在场景时间允许时组织冷色环境光。
Practical Lighting|实景光|用已有画内灯具或发光物解释受光。
Hard Light|硬光|以较清晰的阴影边缘塑造形体。
Soft Light|柔光|以渐变阴影过渡塑形，保留材质差异。
Uplighting|下方打光|从已有低位光源向上照射主体。
Side Lighting|侧光|从主体侧面塑造形体与纹理。
Lens Flare|镜头耀斑|只有实际强光与机位关系需要时出现局部耀斑。
Butterfly Lighting|蝴蝶光|正上方主光在鼻下形成短小阴影。
Fill Light|补光|控制阴影可读性，不抹平所有层次。
Backlight|背光|从主体后方照射并保持面向机位一侧必要信息。
Bounce Light|反射补光|让已有反射面提供合理的柔和回光。
Cross Lighting|交叉布光|从不同侧向分离互动主体，保持世界方向。
Kicker Light|侧后轮廓光|局部强调侧后缘而非给全身描边。
Motivated Lighting|有来源用光|每个主要受光关系都能对应场景光源。
Ambient Light|环境光|维持场景整体光底与空间层次。
Available Light|现场光|利用既有光源，不擅自增加灯具。
Split Lighting|分割光|让一侧受光、另一侧保留有意阴影。
Loop Lighting|环形鼻影光|侧上方光形成与脸颊阴影分离的短鼻影。
Broad Lighting|宽面光|照亮面向机位较宽的面部区域。
Short Lighting|窄面光|照亮背向机位较窄的面部区域。
Color Temperature|色温关系|区分光源色温与白平衡，保持中性物体及肤色逻辑。
Day for Night|日拍夜|仅作为明确的昼夜转换方案，维护既定剧情时间。
Night for Night|夜拍夜|依照夜间实际光源组织可见性，不等于一律欠曝。
Dappled Light|斑驳光|由已有遮挡物形成稳定且合理的光斑。
Edge Light|边缘光|用局部边缘分离主体与背景。
Eye Light|眼神光|让眼部反光对应可解释的光源。
Gobo Lighting|遮光图案|由明确遮挡形状形成有规律的投影。
Accent Light|重点光|强调当前信息点，避免无关区域抢眼。
Cucoloris|树影遮光|让不规则遮挡投影服务场景已有结构。
Diffusion|柔化光源|扩大有效光源的柔和感，不把细节磨平。
Firelight|火光|仅在已有火源附近表现受光和有限波动。
Frontal Lighting|正面光|从机位附近照亮主体，保留必要体积。
Hair Light|发光分离|局部分离头发与背景，保留发丝真实亮度。
Mood Lighting|情境光|以具体明暗关系表达既定意图，不随每句台词换灯。
Neon Lighting|霓虹光|由已有彩色发光源产生局部综合色彩。
Rim Lighting|轮廓光|按可读性需要分离局部轮廓，不默认全身发光。
Top Lighting|顶光|由上方光源建立头顶与向下投影。
Underwater Lighting|水下光|受水面方向、衰减和遮挡影响，保留深度线索。
Volumetric Lighting|体积光|只有既定介质支持时呈现光束，不凭空加烟雾。` },
  { category: "composition", stages: ["image", "video"], parameters: "观看重点、画内位置、前后景、焦平面、运动留白", checks: "关注点与信息顺序是否准确，重要动作和口型是否被遮挡或裁切", limits: "不为形式改变既定空间或角色本色；构图不能替代动作与表演", entries: `
Rule of Thirds|三分构图|把主要信息放在有意的三分区域，保留关系空间。
Symmetry|对称|通过对称关系表达秩序或对峙，偏离时有剧情依据。
Leading Lines|引导线|利用已有空间线条引向观看重点。
Framing Within Frame|框中框|利用现有门窗或物体边界组织层次。
Negative Space|留白|把空处留给注意、威胁方向或关系变化。
Shallow Focus|浅焦|隔离指定主体，关键背景线索仍按计划可辨。
Deep Focus|深焦|让承载信息的前后层次同时可读。
Mise-en-Scène|场面调度|组织已有角色、物件、光源和路径之间的关系。
Golden Ratio|黄金比例|以比例关系组织关注点，不能牺牲行动空间。
Depth of Field|景深|指定哪些空间层次需要清晰，避免矛盾清晰度要求。
Foreground Interest|前景层次|用已有前景增加空间感，不遮挡关键接触。
Balancing Elements|元素平衡|以明暗、面积和位置平衡画面重点。
Diagonal Lines|斜线组织|利用已有斜向关系传达方向与张力。
Triangular Composition|三角构图|用三个已有关注点建立关系与重心。
Centered Composition|中心构图|将关键对象置中，控制周边信息竞争。
Headroom|头顶留量|保留适合景别的头顶空间，不无意裁头。
Lead Room|运动留量|向视线或运动方向保留所需空间。
Visual Weight|视觉重量|按信息重要性分配面积、亮度和色彩吸引力。
Repetition and Pattern|重复与图案|利用既有重复关系建立秩序或突出差异。
Figure-Ground Relationship|主体背景分离|让主体轮廓与关键动作从背景中可辨。
Contrast|视觉对比|以亮度、颜色或尺度差异突出已有信息。` },
  { category: "editing", stages: ["edit"], parameters: "相邻素材、源入出点、动作阶段、切点理由、连续声音", checks: "用真实接点预览核对因果、方位、动作阶段与完整声音", limits: "只作用于已授权实际时间线，不把剪辑名词当单镜生成指令；不靠转场掩盖跳动作或口型错位", entries: `
Cross-Cutting|交叉剪辑|在已有并行动作间切换，保留各自时间与因果。
Jump Cut|跳切|只省略已允许的时间段，不删掉必要接触或完整台词。
Match Cut|匹配剪辑|按已有动作、形状或视点建立明确匹配点。
Dissolve|叠化|用有限重叠表达已确定的时间或关系转换。
Fade In/Out|淡入淡出|在有意段落边界调整画面，不裁去有效动作结果。
Montage|蒙太奇|组合已确定的事件，不用剪接创造未授权事实。
L-Cut|声音后出|上镜声音延续到下镜，保持明确声源与完整对白。
J-Cut|声音先入|下镜声音提前进入，保持明确声源和预定画外关系。
Smash Cut|突切|在明确的信息或力度对比点直接切换。
Long Take|长镜组织|保留连续行动，只在真实信息边界决定切点。
Split Screen|分屏|同时呈现已有并行画面，各自时轴明确。
Continuity Editing|连续性剪辑|维护方位、视线、动作阶段与场景时间。
180-Degree Rule|轴线规则|保持已建立的左右关系，有动机时才越轴。
30-Degree Rule|机位差异|相邻同主体机位有足够观看差异，避免无意跳接。
Match on Action|动作匹配|切在同一动作阶段，后镜接续而非重做动作。
Eyeline Match|视线匹配|被看对象与角色目光方向、位置相符。
Cutting on Look|视线触发切镜|以角色已发生的注视引出既有对象。
Reaction Shot|反应镜头|在真实触发后保留对关系有影响的反应。
Cutaway|切离镜头|切到相关已有对象，声音仍保持归属。
Cut-In|切入细节|进入当前动作的必要细节，再保留结果关系。
Wipe|划像|只在明确需要时使用实际转场，不额外增加生成动作。
Iris|圆形开合|用有意遮罩组织段落边界，保持主体可读。
Soviet Montage|组合表意|用已授权镜头组合传达关系，不能篡改事实。
Intellectual Montage|观念蒙太奇|并置已有意象表达明确观念，不新增剧情事件。
Metric Montage|长度节奏|在动作和声音完整前提下组织时长，不平均分秒。
Rhythmic Montage|动作节奏|切点服从实际动作节律与有效信息。
Invisible Cut|隐形切点|利用已有遮挡或运动接续，不能隐藏身份与几何突变。
Parallel Editing|平行剪辑|明确并行线索的时间关系与回到原线的状态。
Crossfade|交叉淡化|在实际轨道完成有限过渡，核对双声叠加与对白可懂度。` },
  { category: "editing", stages: ["edit"], parameters: "局部开始与结束、叙事理由、原素材时轴及恢复点", checks: "时间效果只在指定区间，必要动作因果和声音同步完整", limits: "必须通过实际剪辑工具且遵守对白原速与完整窗口门禁；不能用时间效果填满素材", timeEffect: true, entries: `
Freeze Frame|定格|只冻结指定图像瞬间，不能冒充角色行动完成。
Time-Lapse|延时|只压缩允许省略的过程，关键因果仍完整。
Fast Motion|快动作|只加快明确允许的无同步段落，不强制压缩台词。
Reverse Motion|倒放|只在明确叙事意图允许时反向播放，不能伪装正常物理过程。` },
  { category: "sound", stages: ["audio"], parameters: "声源、真实素材、父镜头、落点、完整窗口、音量与前后余量", checks: "实际听音核对声源、节拍、遮蔽及同步，可见发声另验口型", limits: "不新增台词，不把TTS混音当口型完成；只用现有声音入口和时间线，保持对白原文原速", entries: `
Diegetic Sound|画内世界声音|声音对应故事中真实存在的源头与空间。
Non-Diegetic Sound|画外叙事声音|明确区分配乐或叙述层与人物现场所闻。
Foley|拟音|把真实接触声与对应动作对齐，避免重复或提前。
Sound Bridge|声音桥|跨镜保留有归属的声音，使用实际轨道与余量。
Leitmotif|主导音型|仅复用已选主题声音，与人物或信息关系一致。
Stinger|短促重音|把已授权短音效放在准确的信息或动作节点。
Silence|声音留白|有意降低非必要声音，不能静音或删掉既定对白。
Ambient Sound|环境声|延续场景空间感，跨镜不无故重启。
Room Tone|空间声底|保留相同场所连续的底噪与混响关系。
Sound Effects (SFX)|动作音效|音效对应真实事件，不凭空增加爆炸或碰撞。
Walla|人群声底|仅在已有群体场景使用不可混淆为新增对白的背景声。
ADR (Automated Dialogue Replacement)|后配对白|保留原句与音色，按真实片段完成配音、口型和检查。
Score|配乐|沿用用户已选音乐方向，不遮盖对白或关键动作声。
Needle Drop|现成音乐入点|用已有获准音乐的具体片段与实际入点。
Mickey Mousing|动作拟合音乐|让已有音乐重音对应动作，不改变必要动作因果。
Sound Motif|声音动机|复用已有声音线索，避免每次出现都堆叠效果。
Audio Transition|声音转场|按真实源片余量处理跨镜声音，不截断句子。
Acousmatic Sound|隐匿声源|只在既定剧情需要时让声源暂不入画。
Sonic Worldbuilding|声音空间设计|用既定环境与物体构建一致的声场。
Audio Ducking|自动压低声底|对白出现时适度降低配乐或音效，保留句头与句尾。` },
  { category: "story", stages: ["story"], parameters: "已采用事实、角色知情、观众知情、触发与后果", checks: "信息揭示与反应次序符合剧本，没有新增事件或倒置因果", limits: "叙事方法只辅助已授权故事，不作为视频执行动作；不凭技法新增人物、线索、对白或结局", entries: `
Flashback|回忆|仅重组已确定过去事件，明确回到当前的状态。
MacGuffin|目标载体|使用剧本已有目标物推动行动，不凭空新增道具。
Red Herring|误导线索|只运用已确定的误导，保留真实可追溯事实。
Foreshadowing|伏笔|安排已有信息的可见性，不新增证据。
Dramatic Irony|戏剧反讽|区分观众与人物已知信息，反应不提前。
Breaking Fourth Wall|打破第四面墙|只在已确定表达允许时建立对观众的注视或讲话。
Unreliable Narrator|不可靠叙述|保持已设叙述视角与真实事件的区别。
In Medias Res|行动中开场|从已确定事件中途进入，必要因果随后仍可追溯。
Cliffhanger|悬念收束|停在既有选择或后果边界，不强制每场悬停。
Flashforward|预叙|仅展示已授权的未来片段，明确其叙述层次。
Non-Linear Narrative|非线性叙事|重组已确定事件但保留因果与时间标识。
Parallel Storylines|并行故事线|分别维护已有线索的目标、状态与交汇关系。
Frame Narrative|框架叙事|区分当前讲述层与被讲述事件。
Voiceover Narration|旁白|只使用已采用的旁白原文，不替代关键表演或动作。
Deus Ex Machina|突入解围|仅检查剧本已明确的外力解围，不为解决阻碍自动添加。
Plant and Payoff|铺垫回收|核对已有铺垫与后果，避免提前显示结果。
Three-Act Structure|三幕组织|用目标与局势变化检查已有结构，不硬套固定时点。
Inciting Incident|触发事件|突出已经发生且改变处境的触发。
Character Arc|人物变化|通过既有选择与代价呈现变化，不靠新增独白解释。
Subplot|副线|保持已授权副线与主线的信息关系。
Motif|视觉母题|复用既有形象或行为关系，不机械重复镜头。
Symbolism|象征|以已有事物表达关系，不改变其现实功能。` },
  { category: "effects", stages: ["image", "video"], parameters: "作用对象、范围、真实入口与支撑、材质、起止状态", checks: "几何、遮挡、接触和物体连续性是否保留，关键动作是否仍可见", limits: "只描述既定事件的可见结果，不宣称真实制作设备或后台技术已使用；复杂效果须实看", entries: `
CGI|数字效果|明确已有对象应出现的效果与边界，而非泛称CGI。
Practical Effects|实物效果质感|让既定效果保留重量、接触与环境响应。
Green Screen|抠像合成|指定已有前景与背景的透视、边缘和受光匹配。
Motion Capture|动作捕捉意图|描述实际身体动作与重量，不宣称模型真实执行动捕。
Stop Motion|逐格动画|在已选媒介下保持逐格运动规律与物体连续。
Bokeh|焦外形态|仅在计划失焦区域表现光斑，不遮掉线索。
Matte Painting|绘景合成|保持已有空间透视、光向与运动层次。
Miniatures|微缩质感|维护明确尺度、重力和景深关系。
Forced Perspective|强制透视|利用明确观看位置形成尺度关系，换机位仍需解释。
Rotoscoping|转描|保留已有动作轮廓与阶段，不改事件内容。
Wire Work|吊威亚运动|按既定动作说明力、路径与落地承托，不默认失重。
Prosthetic Makeup|特效妆|只采用已确认妆造，保持跨镜外形一致。
Squibs|命中效果|只表现剧本既定命中与后果，不新增伤势。
Split Diopter|分区焦平面|指定同时可读的近远对象和分界，避免全画面矛盾焦点。
Lens Distortion|镜头畸变|限定边缘光学变化，不扭曲身份或关键物体几何。
Aspect Ratio|画幅|用实际支持的画幅与构图，不用拉伸冒充改画幅。
IMAX|大画幅观看意图|以空间、细节和构图表达尺度，不宣称真实IMAX拍摄。
Anamorphic|宽银幕光学意图|在明确Look下选择有限光学特征，不叠加全部瑕疵。
Morphing|形态变换|只有既定事件允许时变形，说明起终态与连续过程。
Digital De-aging|年龄调整|只在明确采用年龄版本时改变外貌，不能漂移身份。
Virtual Production|虚拟场景融合|让前景受光、背景透视与反射保持一致。
Anamorphic Flares|横向耀斑|仅在具体强光与Look允许时使用有限横向耀斑。
Bloom Effect|高光扩散|只影响明确高亮区，不冲淡动作轮廓。
Chromatic Aberration|色差|仅在已选光学风格下局部使用，不降低关键细节。
Glow Effect|发光效果|发光来自既定对象，影响周边材质且保持形状。
Loop Animation|循环动作|只用于允许循环的动作，不能让打斗救援回到起点。
Motion Blur|运动模糊|模糊随真实速度出现，接触与结果仍可辨。
Parallax Effect|视差|前后景随观看位置产生不同位移，维护真实深度。
Particle Effects|粒子效果|只由既定事件产生，并保持尺度、运动和遮挡关系。
Reflections|反射|反射对象、位置和运动与真实空间一致。
Refractions|折射|按既定透明介质改变观看关系，不扭曲接触几何。` },
  { category: "effects", stages: ["look"], parameters: "统一基底、影响范围、肤色与识别色、跨镜参照", checks: "同场光色与材质一致，细节和观看重点未被处理遮盖", limits: "Look是共享外观，不改变资产本色、时段或剧情；不默认颗粒、暗调、脏旧或橙青", entries: `
Color Grading|调色|保持已选综合色彩与亮暗层次，区分光源与后期处理。
Desaturation|降低饱和|收敛指定范围色彩，保留肤色与识别线索。
Sepia Tone|棕褐影调|只在已确认风格层使用统一棕褐关系。
Film Grain|胶片颗粒|仅在Look明确需要时增加适量颗粒，不覆盖细节。
Color Correction|色彩校正|先统一曝光、白平衡与共同材质参照。
HDR Effect|亮部暗部层次|保留亮暗信息而非全局锐化与光晕。
Vignette|边缘压暗|有限引导视线，不遮掉边缘动作与出口。
Vintage Film Look|复古胶片外观|仅采用已确认年代与材质特征，避免默认划痕褪色。
White Balance|白平衡|以共同中性参照维护物体颜色，区别于灯光色温。` },
  { category: "genre", stages: ["look"], parameters: "已采用媒介、场景事实、构图与光色基底、允许的局部变化", checks: "风格是否统一且服务剧情，身份、物件、动作因果与声音未被类型词改写", limits: "类型名只作研究方向，使用下面具体视觉关系；不自动改时代、族群、服装、伤势、事件或音乐", entries: `
Film Noir|黑色电影|以遮挡、局部明暗和空间压力组织已有场景。
German Expressionism|德国表现主义|在已选媒介内使用有意形变的环境线条与强明暗，保持人物身份。
Cinema Vérité|真实电影|以有观看对象的现场观察和受控机位响应表达真实感。
French New Wave|法国新浪潮|在既定叙事中选择轻便视点与有意剪接，不任意跳掉因果。
Surrealism|超现实|只表现已授权的不现实关系，不让正常动作无因变形。
Found Footage|拾得影像|保持既定持机者位置、录制动机与信息可见范围。
Spaghetti Western|意式西部|用远近对照和对峙空间组织既有人物，不自动换装或添枪。
Italian Neorealism|意大利新现实主义|强调已有日常空间、行为和可读自然光。
Dogme 95|道格玛观察|选择现场空间与克制摄影，不替用户删除既定音乐或灯光。
Mumblecore|日常低声对白|以已有对白和细微关系行动组织观看，不默认含糊台词。
Giallo|铅黄悬疑|在已选色盘内组织局部光色和视点悬念，不新增暴力。
Blaxploitation|类型片张力|研究明确构图与节奏关系，不推断人物族群或刻板行为。
Mockumentary|伪纪录|保持已设记录视点与人物对镜头的关系。
Poetic Realism|诗意现实|通过已有环境、人物距离和有意义停留建立情绪。
Slow Cinema|缓观电影|只在明确意图下保留有内容的持续观察，不自动放慢动作。
Hyperlink Cinema|多线网络叙事|视觉保持各线索识别，事件重排另由叙事方案决定。
Elevated Horror|心理惊悚|通过已有空间压力与信息差表达不安，不新增怪物。
Maximalism|繁复美学|在已确认资产中组织密度与层次，保持关注点。
Minimalism|简约美学|减少无关视觉竞争，不删除必要道具和动作。
Exploitation Film|类型刺激表达|仅强化已采用内容的具体视觉力度，不扩展暴力或尺度。
Arthouse|作者表达|选择具体视点与形式关系，不用艺术片标签替代行动。
Neo-Noir|新黑色电影|以已选当代光色与空间对比表达压力。
Wuxia|武侠|以既定兵器、身法与招架因果表达武侠，保持接触与支撑。
Amber Phosphor CRT|琥珀屏幕外观|仅对已存在显示区域使用有限琥珀色与扫描质感。
Silent Slapstick|无声肢体喜剧|以可读身体行动和既定物理后果组织喜剧，不自动删对白。
Screwball Comedy|机锋喜剧|让已定对白、任务冲突与反应互相推进。
Technicolor Musical|鲜明歌舞色彩|使用已确认的明亮配色与音乐关系，不新增歌舞。
New Hollywood|新好莱坞视点|以人物选择、真实空间和有动机摄影呈现既有故事。
Conspiracy Thriller|阴谋惊悚|通过遮挡、视线和已有信息差组织压力。
Grindhouse|粗粝放映外观|只有明确Look要求时使用有限旧片特征，不默认损伤画面。
Gothic Horror|哥特氛围|利用已有建筑、深度和明暗关系，不新增古堡或怪物。
Body Horror|身体异化|仅执行已授权的身体变化，保持明确起终态与边界。
J-Horror|日式恐怖观察|利用已有负空间、遮挡和线索出现顺序，不新增灵异事件。
Southern Gothic|南方哥特氛围|从既定场所和人物关系组织压迫，不改变地理事实。
Film Soleil|明亮黑色氛围|在既定日光下用空间与关系表达压力，不默认夜色。
Acid Western|迷幻西部意图|只在采用风格下组合空间与主观感受，不新增幻觉事件。
Neo-Western|新西部空间|以既有地貌、距离和人物任务组织冲突。
Samurai Cinema|武士片覆盖|强调既定兵器、距离、时机和真实命中后果。
Heroic Bloodshed|英雄动作表达|用既定选择、攻防与后果建立力度，不默认慢动作或新增枪战。
Kaiju Cinema|巨兽尺度|通过已有环境参照呈现体量，维护质量、接触和破坏因果。
Bollywood Masala|多情绪类型表达|在已定事件和音乐计划内组织明确情绪转换，不新增歌舞。
Cinéma du Look|光色造型电影|用已确认色盘、反射与空间层次组织视觉重点。
Magical Realism|魔幻现实|仅让已确定的异常自然存在，正常世界物理仍连贯。
Afrofuturism|非洲未来主义研究|采用明确参考中的设计关系，不推断人物身份或擅换文化资产。
Cyberpunk|赛博空间|仅利用已存在的技术设施与光源，不能默认加霓虹雨夜。
Synthwave Retrowave|合成复古色彩|只有已选Look允许时组织有限色彩关系，不自动改音乐。
Steampunk|蒸汽机械美学|保留已确认机械资产的材质和功能，不凭标签新增齿轮。
Space Opera|太空史诗尺度|通过既有环境和人物任务表达尺度，不新增飞船或爆炸。
Painterly Anime Pastoral|绘画动画田园|沿用已选二维材质与环境层次，不转成摄影皮肤。
Stop-Motion Aesthetic|定格动画外观|保留选定材质与逐格运动逻辑，不冻结既定行动。
Coming-of-Age Indie|成长独立电影|通过已有选择、日常任务与关系变化表达成长。
Nordic Noir|北欧冷峻氛围|在已有环境中选择克制色彩与负空间，不自动改天气或拖慢节奏。` },
];

const techniqueId = (name: string) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-zA-Z0-9]+/g)!
  .map((part, index) => index ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : part.toLowerCase()).join("");

export const filmTechniques = groups.flatMap(({ entries, ...group }) => entries.trim().split("\n").map(row => {
  const [name, label, instruction] = row.split("|") as [string, string, string];
  return { ...group, ...(["Vertigo Effect", "Dolly Zoom"].includes(name) ? { motion: "moving" as const } : {}), id: techniqueId(name), name, label, instruction };
}));
const byId = new Map(filmTechniques.map(item => [item.id, item]));
export const findFilmTechnique = (id: string) => byId.get(id);
const intentMatches = [
  { words: /打斗|搏斗|攻防|格挡|fight|combat/i, ids: ["masterShot", "fullShot", "mediumShot", "trackingShot", "matchOnAction", "continuityEditing", "foley"] },
  { words: /救援|救起|承托|伤者|伤员|rescue/i, ids: ["fullShot", "twoShot", "trackingShot", "figureGroundRelationship", "matchOnAction", "foley"] },
  { words: /对白|对话|倾听|dialogue|conversation/i, ids: ["twoShot", "overTheShoulderShot", "reactionShot", "shotReverseShot", "roomTone"] },
  { words: /揭示|发现|线索|注意力|reveal|discovery/i, ids: ["rackFocus", "insertShot", "leadingLines", "cuttingOnLook"] },
];

export function searchFilmTechniques(input: { query?: string; category?: string; stage?: TechniqueStage; limit?: number }) {
  const query = (input.query ?? "").trim().toLowerCase();
  const terms = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(query)].filter(part => part.isWordLike).map(part => part.segment);
  // ACT: 少量意图同义词只影响检索排序，不自动选技法、改剧情或判定质量；其余查询仍按目录文字检索。
  const preferred = new Set(intentMatches.filter(item => item.words.test(query)).flatMap(item => item.ids));
  const ranked = filmTechniques.filter(item => (!input.category || item.category === input.category) && (!input.stage || item.stages.includes(input.stage)))
    .map(item => {
      const names = `${item.id} ${item.name} ${item.label}`.toLowerCase();
      const text = `${names} ${item.instruction} ${item.parameters} ${item.checks}`.toLowerCase();
      const hits = terms.filter(term => text.includes(term)).length;
      return { item, score: !query ? 1 : names.includes(query) ? 100 : preferred.has(item.id) ? 50 : hits === terms.length && hits > 0 ? 10 + terms.filter(term => names.includes(term)).length : 0 };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  return { version: techniqueVersion, total: filmTechniques.length, matched: ranked.length,
    categories: [...new Set(filmTechniques.map(item => item.category))],
    items: ranked.slice(0, Math.max(1, Math.min(input.limit ?? 8, 20))).map(({ item }) => item),
    note: "检索只返回设计候选，不自动应用、确认、切镜或生成。按剧情目的选少量技法，保存 techniques 的 id/purpose/execution 后编译；edit/audio/story 交对应真实流程，Look继承整片。" };
}

export function techniquePlan(shot: Record<string, any>, stage: TechniqueStage) {
  return ((shot.techniques ?? []) as TechniqueSelection[]).flatMap(selection => {
    const card = byId.get(selection.id);
    if (!card || !card.stages.includes(stage) && !(card.stages.includes("look") && (stage === "image" || stage === "video"))) return [];
    if (stage === "image" && selection.start !== undefined && selection.start > 0) return [];
    return [{ ...card, ...selection, window: selection.start === undefined ? "本镜" : `${selection.start}–${selection.end}s`,
      criterion: `${selection.purpose}；检查：${card.checks}；本镜要求：${selection.execution}` }];
  });
}

export function techniqueIssues(shot: Record<string, any>) {
  const selections = (shot.techniques ?? []) as TechniqueSelection[];
  const issues: string[] = [];
  const duration = Number(shot.generationDuration ?? shot.duration);
  const seen = new Set<string>();
  const motion: { value: string; start: number; end: number }[] = [];
  for (const selection of selections) {
    const card = byId.get(selection.id);
    if (!card) { issues.push(`未知镜头技法：${selection.id}，请先 searchTechniques`); continue; }
    if (seen.has(card.id)) issues.push(`镜头技法重复：${card.label}`);
    seen.add(card.id);
    const timed = selection.start !== undefined || selection.end !== undefined;
    const validRange = Number.isFinite(selection.start) && Number.isFinite(selection.end) && selection.start! >= 0 && selection.end! > selection.start! && selection.end! <= duration;
    if ((timed || card.timeEffect) && !validRange) issues.push(`${card.label}须指定本镜时长内完整的 start/end 区间，时间效果不能默认覆盖全场`);
    if (card.timeEffect && validRange) {
      const lines = shot.creativeBrief?.dialogue?.lines ?? [];
      if (lines.some((line: any) => line.start < selection.end! && line.end > selection.start!) || shot.musicVideo?.lipSyncRequired
        || shot.musicVideo?.audioMode === "sourceTrack") issues.push(`${card.label}与对白或原曲同步区间冲突，不能改变既定声音、口型时轴`);
    }
    if (card.motion) motion.push({ value: card.motion, start: selection.start ?? 0, end: selection.end ?? duration });
  }
  if (motion.some(a => motion.some(b => a.value !== b.value && a.start < b.end && b.start < a.end))) issues.push("同一区间不能既锁定机位又移动机位；请按真实阶段拆分区间");
  if (motion.some(item => item.value === "moving") && /^(?:static|locked|fixed|固定|静止)$/i.test(shot.camera?.motion?.trim() ?? "")) issues.push("移动技法与 camera.motion 固定机位冲突，请同步修正规格");
  return [...new Set(issues)];
}

export function compileTechniqueDirection(shot: Record<string, any>, kind: "image" | "video") {
  return techniquePlan(shot, kind).map(item => `${item.label}：${item.instruction} 本镜执行（${item.window}）：${item.execution}${item.timeEffect ? "；只作用于指定区间，区间结束恢复实时；不得改写声音或口型时轴" : ""}`).join("\n");
}
