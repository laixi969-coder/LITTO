const videoPromptTitles = ["故事前提与资产绑定", "画面质感与光影", "镜头与动作时间线", "对白、环境声与BGM", "负面提示词"];

export function isDirectorPrompt(prompt: string) {
  return /【(?:故事前提与资产绑定|镜头与动作时间线)】/.test(prompt);
}

/** ACT: 只检验导演五板块协议，不把结构检查当成画质验收，也不强制普通提示词采用此格式。 */
export function inspectVideoPrompt(prompt: string, duration?: number) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isDirectorPrompt(prompt)) return { applicable: false, errors, warnings };
  prompt = /REQUEST:\s*([\s\S]*?)(?=\n[A-Z][A-Z0-9]{3,}:|$)/.exec(prompt)?.[1] ?? prompt;
  const headings = [...prompt.matchAll(/^[ \t]*【([^】]+)】[ \t\r]*$/gm)];
  const top = headings.filter(item => videoPromptTitles.includes(item[1]!));
  if (top.map(item => item[1]).join("|") !== videoPromptTitles.join("|")) {
    errors.push("五个顶级标题必须完整、按规定顺序且各出现一次");
  }
  for (const heading of headings) {
    if (["素材职责", "人物", "视觉风格", "声音", "镜头", "正文"].includes(heading[1]!)) errors.push(`请移除额外顶级标题【${heading[1]}】`);
  }
  const blocks = new Map(top.map((heading, index) => [heading[1]!, prompt.slice(heading.index! + heading[0].length, top[index + 1]?.index ?? prompt.length).trim()]));
  for (const title of videoPromptTitles) if (blocks.has(title) && !blocks.get(title)) errors.push(`【${title}】不能为空`);
  const timeline = blocks.get("镜头与动作时间线") ?? "";
  const shots = [...timeline.matchAll(/【(?:镜头\s*\d+\s*[｜|]\s*)?(?:本段\s*)?(\d+(?:\.\d+)?)\s*秒?\s*[–—\-~～至到]\s*(\d+(?:\.\d+)?)\s*秒\s*[｜|][^】]+】/g)];
  if (!shots.length) errors.push("时间线须包含带起止秒数的镜头子标题");
  const timelineHeadings = [...timeline.matchAll(/^[ \t]*【[^】]+】[ \t\r]*$/gm)];
  if (timelineHeadings.some(heading => !shots.some(shot => shot[0] === heading[0].trim()))) errors.push("时间线存在无法解析的镜头子标题，请统一使用起止秒数");
  let end = 0;
  for (const [index, shot] of shots.entries()) {
    const start = Number(shot[1]);
    const next = Number(shot[2]);
    if (Math.abs(start - end) > 0.001 || next <= start) errors.push(`第 ${index + 1} 镜时间码不连续、重叠或时长非正数`);
    end = next;
  }
  const declared = /总时长\s*[:：]\s*(\d+(?:\.\d+)?)\s*秒/.exec(blocks.get("故事前提与资产绑定") ?? "");
  if (!declared) errors.push("第一板块须声明「总时长：N 秒」");
  else if (Math.abs(Number(declared[1]) - end) > 0.001) errors.push("时间线终点与声明总时长不一致");
  if (duration !== undefined && Math.abs(duration - end) > 0.001) errors.push(`时间线终点 ${end} 秒与请求生成时长 ${duration} 秒不一致`);
  if (/(不出现|不要|禁止|避免|不得|不能)/.test(timeline)) warnings.push("时间线含否定表达，建议改成可见的正向动作，限制集中到末段");
  if (/@[^\s＝=，。；]+/.test(blocks.get("故事前提与资产绑定") ?? "")) warnings.push("普通 @名称 不能证明已绑定；请核对实际图片、视频或首尾帧输入");
  return { applicable: true, errors, warnings };
}

/** 只用于风格/做旧启发式判断；原始正文与负面约束仍原样发送。 */
export function positivePromptText(prompt: string) {
  const authored = /REQUEST:\s*([\s\S]*?)(?=\n[A-Z][A-Z0-9]{3,}:|$)/.exec(prompt)?.[1] ?? prompt;
  return authored
    .split(/【(?:负面提示词|负面约束)】|^\s*(?:NEGATIVE(?:PROMPT)?|负面提示词)\s*[:：]/im)[0]!
    .replace(/(?:没有|无|不带|不要|不出现|禁止|避免|去除|不主动|不添加|不做|不得|不能|非(?=动画|插画|漫画|卡通|二次元|像素|3D|CG|写实|拼图))[^。；;\n]*/g, "")
    .replace(/\b(?:no|not|without|avoid|remove)\b[^.;\n]*/gi, "");
}
