export const castingGenders = ["男", "女"] as const;
export const castingAgeGroups = ["儿童", "少年", "青年", "中年", "老年"] as const;
export const castingAgeRanges = {
  儿童: "0–12 岁",
  少年: "13–17 岁",
  青年: "18–34 岁",
  中年: "35–59 岁",
  老年: "60 岁及以上",
} satisfies Record<typeof castingAgeGroups[number], string>;

export type CharacterCasting = {
  gender?: typeof castingGenders[number];
  ageGroup?: typeof castingAgeGroups[number];
};
