import { z } from "zod";

const text = (max = 2000) => z.string().trim().min(1).max(max);
export const storyRuleSchema = z.strictObject({
  rule: text().describe("一条可观察效应及其触发/限制。不同能力分别列规则，不能用已有触发证明高潮才出现的新效应"),
  subjects: z.array(text(100)).min(1).max(10).describe("关键行动实际依赖的作用对象；只记录本篇需要核对的对象"),
  tests: z.array(z.strictObject({
    kind: z.enum(["trigger", "boundary", "payoff"]), subject: text(100),
    changedCondition: z.string().trim().max(1000).optional().describe("boundary必填：相比触发例改变了哪个条件；其他项可留空"),
    probeQuote: text(), outcomeQuote: text(),
    expected: text(1000), observed: text(1000),
    verdict: z.enum(["pass", "revise", "unverified"]), basis: text().min(10),
  })).min(1).max(30).describe("引用关键使用的实际行动与结果，不把猜测当验证；边界变化或高潮应用仅在正文涉及且需要核对时记录，不为填表增加实验场景"),
});
export const storyLogicSchema = z.strictObject({
  quantities: z.array(z.strictObject({
    claimId: z.string().regex(/^q\d+$/),
    mode: z.enum(["quotedText", "unshownText"]),
    countedText: z.string().max(12000).optional(), basis: text().min(10),
  })).max(100).default([]),
  rules: z.array(storyRuleSchema).max(10).default([]),
});
export type StoryLogic = z.infer<typeof storyLogicSchema>;
export const storyLogicGuide = `数量与规则审读使用完整正文（全部场次text按顺序以两个换行连接），不得只检查摘要。正文的“几个字/字符”用prepareStoryText逐字计算；它会返回quantities及claimId。有歧义用logic.quantities逐项给claimId、mode、countedText及basis；mode=quotedText须逐字引用同段或声明前后500字符内的正文，并说明该字串与数量声明的指代关系，不能用邻近无关文字凑数；超出范围、指代不明须保持未核实。unshownText只用于正文未展示全文的设定，不能回避已展示引文的明确计数错误。
异常规则的关键使用按实际需要记录 logic.rules，每条给 rule、subjects、tests，引用正文中的动作和结果。kind 用 trigger/boundary/payoff 标记已有证据的用途，不要求每篇、每个对象都有边界实验或高潮应用；同一次行动可同时支撑多个判断。boundary 说明实际改变的条件，未发生或无法核实的结果保持 unverified，不能填 pass。高概念不自动等同于超自然规则，不能因工具字段要求把现实故事改成奇幻。
ready:false 时核对实际数量或证据错误，保留用户的篇幅、人物和修改范围。正式 review 可保存同一版本的 logic，程序只检查已提交记录的引句、对象、状态与数量，不以元数据替代 skill 的逐场审读，也不靠固定试验数量评判故事。`;

export function requiresStoryRuleValidation(task: string) {
  return task.split(/[，,。；;\n]/).some(part => !/^(?:请)?(?:不要|不用|无需|不必|不|勿)/.test(part.trim()) && /异常规则|超常规则|超自然规则/.test(part));
}

function readChineseCount(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  if ([...value].every(char => digits[char] !== undefined)) return Number([...value].map(char => digits[char]).join(""));
  let total = 0, section = 0, digit = 0;
  for (const char of value) {
    if (digits[char] !== undefined) { digit = digits[char]!; continue; }
    const unit = units[char]!;
    if (unit === 10000) { total += (section + digit || 1) * unit; section = 0; }
    else section += (digit || 1) * unit;
    digit = 0;
  }
  return total + section + digit;
}

export function findStoryQuantityClaims(body: string) {
  const claims: { id: string; quote: string; context: string; nearby: string; declared: number; unit: string; inferredText?: string; direct: boolean }[] = [];
  // ACT: 只扫描明确的整数“字/字符”声明；否定、约数、范围不按相等关系验算。物件总量仍由语义审读核对。
  for (const match of body.matchAll(/([0-9零〇一二两三四五六七八九十百千万]+)(?:个)?(字符|字)(?![符体典])|(字符|字)[，,\s]+(?:共|总共|一共|只有)?([0-9零〇一二两三四五六七八九十百千万]+)个(?=\s*[:：])/g)) {
    const index = match.index!, prefix = body.slice(Math.max(0, index - 12), index), suffix = body.slice(index + match[0].length);
    if (/(?:第|头|首|末|最后|至|到|[.点—\-]|不是|并非|不止|不到|不足|超过|至少|至多|最多|最少|大约|大概|约|近|一个字|一字)$/.test(prefix) || /^(?:也|都)?(?:说|写|吐|挤|顶|印|读|念|发)?(?:不|没|未)|^(?:一个字|一字|一句|多|余|来|以上|以下|左右|上下|以内)/.test(suffix)) continue;
    const previous = body.lastIndexOf("\n\n", index);
    const start = Math.max(previous < 0 ? 0 : previous + 2, index - 500);
    const next = body.indexOf("\n\n", index);
    let end = Math.min(next < 0 ? body.length : next, index + 500);
    // ACT: 数量声明以冒号结尾时，紧邻下一段可承载被计数的原句；最多向后读取500字符。
    if (next >= 0 && /^\s*[:：]\s*$/.test(body.slice(index + match[0].length, next))) {
      const afterNext = body.indexOf("\n\n", next + 2);
      end = Math.min(afterNext < 0 ? body.length : afterNext, index + 500);
    }
    const context = body.slice(start, end), before = body.slice(start, index), after = body.slice(index + match[0].length, end);
    const quoted = [...before.matchAll(/[“「『"]([^”」』"\n]+)[”」』"]/g)];
    const last = quoted.at(-1);
    const remainder = last ? before.slice(last.index! + last[0].length) : "";
    const directBefore = !!last && /^[\s，,：:、]*(?:(?:这|那|是|共|总共|一共|只有|仅有|就|只|整整|正好)[\s，,]*)*$/.test(remainder);
    const following = after.match(/^[\s，,：:—-]*(?:是|写着|写的是|为)?[\s，,：:—-]*[“「『"]([^”」』"\n]+)[”」』"]/)
      ?? after.match(/^\s*[:：]\s*([^。！？\n]+)/);
    const inferredText = directBefore ? last![1] : following?.[1]
      ?? (quoted.length === 1 && remainder.length < 80 && !/[。！？]/.test(remainder) ? last?.[1] : undefined);
    // ACT: 跨段指代只提供前后各500字符的核对范围，不自动推断；更远引用须人工重审或改写。
    const nearby = body.slice(Math.max(0, index - 500), Math.min(body.length, index + match[0].length + 500));
    claims.push({ id: `q${claims.length + 1}`, quote: match[0], context, nearby, declared: readChineseCount((match[1] ?? match[4])!), unit: (match[2] ?? match[3])!, inferredText, direct: directBefore || !!following });
  }
  return claims;
}

export function inspectStoryLogic(body: string, logic?: StoryLogic, requireRules = false) {
  const issues: string[] = [], invalidEvidence: string[] = [];
  const claims = findStoryQuantityClaims(body);
  const checks = logic?.quantities ?? [];
  if (new Set(checks.map(check => check.claimId)).size !== checks.length) invalidEvidence.push("数量核对ID重复");
  for (const check of checks) if (!claims.some(claim => claim.id === check.claimId)) invalidEvidence.push(`数量声明${check.claimId}已变化，请重新核对正文`);
  const quantities = claims.map(claim => {
    const check = checks.find(item => item.claimId === claim.id);
    if (check?.mode === "unshownText" && !claim.direct) return { ...claim, actual: undefined, countedText: undefined, status: "unshownText", basis: check.basis };
    const countedText = claim.direct ? claim.inferredText : check?.countedText ?? claim.inferredText;
    const source = !claim.direct && check?.mode === "quotedText" ? claim.nearby : claim.context;
    if (!countedText || !source.includes(countedText)) {
      issues.push(`${claim.id}「${claim.quote}」尚未定位实际计数字串，须提供同段或前后500字符内的原文及指代依据，或说明全文未展示`);
      if (countedText !== undefined) invalidEvidence.push(`${claim.id}计数字串不在可核对的正文范围内，或为空`);
      return { ...claim, countedText, actual: undefined, status: "unverified", basis: check?.basis };
    }
    const actual = [...(claim.unit === "字" ? countedText.replace(/[\s\p{Punctuation}]/gu, "") : countedText)].length;
    if (actual !== claim.declared) issues.push(`${claim.id}数量不符：「${countedText}」实际${actual}${claim.unit}，正文声称${claim.declared}${claim.unit}`);
    return { ...claim, countedText, actual, status: actual === claim.declared ? "pass" : "revise", basis: check?.basis };
  });
  const rules = logic?.rules ?? [];
  if (requireRules && !rules.length) issues.push("异常规则正文缺少关键使用的证据记录，请引用实际动作及结果，不为填表增加实验场景");
  for (const [index, rule] of rules.entries()) {
    const label = `规则${index + 1}`;
    if (new Set(rule.subjects).size !== rule.subjects.length) invalidEvidence.push(`${label}关键对象重复`);
    for (const test of rule.tests) {
      if (!rule.subjects.includes(test.subject)) invalidEvidence.push(`${label}试验对象「${test.subject}」不在关键对象中，不能代证另一个对象`);
      for (const [kind, quote] of [["尝试", test.probeQuote], ["结果", test.outcomeQuote]] as const) {
        if (!body.includes(quote)) invalidEvidence.push(`${label} ${test.subject} ${test.kind}的${kind}引句「${quote.slice(0, 120)}」不在本版本正文中，请逐字核对`);
      }
      if (test.kind === "boundary" && !test.changedCondition) issues.push(`${label}边界验证未说明改变的条件`);
      if (test.verdict !== "pass") issues.push(`${label} ${test.subject} ${test.kind} 为${test.verdict}，不能把未核实的猜测用于解围`);
    }
    for (const subject of rule.subjects) {
      if (!rule.tests.some(test => test.subject === subject)) issues.push(`${label}缺少${subject}关键使用的正文证据`);
    }
    // ACT: 仅对记录明确声称逐字相同、原句独立成段且高潮引用完整对白的情况机械比较；其他指代仍由语义审读。
    for (const payoff of rule.tests.filter(test => test.kind === "payoff" && /一字不差|逐字相同|逐字一致|完全相同/.test(`${test.observed}${test.basis}`))) {
      if (!/^[“「『"][^”」』"\n]+[”」』"]$/.test(payoff.outcomeQuote)) continue;
      const paragraphs = new Set(body.split(/\n\s*\n/).map(paragraph => paragraph.trim()));
      const original = rule.tests.filter(test => test.kind === "trigger" && test.subject === payoff.subject
        && paragraphs.has(test.outcomeQuote)
        && body.indexOf(test.outcomeQuote) < body.indexOf(payoff.outcomeQuote));
      const normalize = (value: string) => value.replace(/[\s\p{Punctuation}]/gu, "");
      if (original.length && original.every(test => normalize(test.outcomeQuote) !== normalize(payoff.outcomeQuote))) {
        issues.push(`${label}高潮记录称原句逐字相同，但前文「${original[0]!.outcomeQuote}」与对白「${payoff.outcomeQuote}」的字词不一致`);
      }
    }
  }
  return { ready: !issues.length && !invalidEvidence.length, quantities, issues, invalidEvidence };
}
