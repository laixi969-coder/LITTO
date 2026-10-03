import type { AssetLite } from "./skills.ts";

/** One-click styles so users never have to fill 13 Look fields by hand. Every field stays editable under "advanced". */
export const LOOK_PRESETS = [
    { id: "film", name: "电影胶片", desc: "16mm 颗粒、柔和高光、青橙影调", look: { contrast: "high", saturation: "muted", palette: ["teal", "amber"], skinTone: "warm natural", blackLevel: "rich but not crushed", highlightRolloff: "long, filmic", shadowBehavior: "soft falloff", grain: "visible 16mm-like", halation: "subtle red halation on highlights", bloom: "", lensCharacter: "vintage spherical, gentle softness", texture: "organic", sharpnessPhilosophy: "natural, never over-sharpened" } },
    { id: "noir", name: "冷峻黑色", desc: "高反差、低照度、冷白与琥珀光", look: { contrast: "high", saturation: "desaturated", palette: ["black", "cold white", "amber"], skinTone: "pale, cool", blackLevel: "deep", highlightRolloff: "hard", shadowBehavior: "heavy, graphic", grain: "medium", halation: "", bloom: "", lensCharacter: "clean, contrasty", texture: "gritty", sharpnessPhilosophy: "crisp edges" } },
    { id: "fresh", name: "清新日系", desc: "高调、低对比、通透柔和", look: { contrast: "low", saturation: "natural", palette: ["soft white", "pale green", "sky blue"], skinTone: "light, neutral", blackLevel: "lifted", highlightRolloff: "gentle", shadowBehavior: "open", grain: "fine", halation: "", bloom: "soft bloom on windows", lensCharacter: "light, airy", texture: "smooth", sharpnessPhilosophy: "soft and clean" } },
    { id: "neon", name: "赛博霓虹", desc: "高饱和、洋红与青、湿润反光", look: { contrast: "high", saturation: "rich", palette: ["magenta", "cyan", "deep blue"], skinTone: "tinted by neon", blackLevel: "deep", highlightRolloff: "short", shadowBehavior: "coloured shadows", grain: "fine", halation: "", bloom: "strong neon bloom", lensCharacter: "anamorphic flares", texture: "wet, reflective", sharpnessPhilosophy: "sharp with glow" } },
    { id: "doc", name: "纪录写实", desc: "自然光、手持感、中性色彩", look: { contrast: "medium", saturation: "natural", palette: ["neutral"], skinTone: "true to life", blackLevel: "natural", highlightRolloff: "natural", shadowBehavior: "natural", grain: "light sensor noise", halation: "", bloom: "", lensCharacter: "neutral zoom", texture: "real", sharpnessPhilosophy: "as shot" } },
    { id: "warm", name: "温暖怀旧", desc: "暖黄、柔光、略微褪色", look: { contrast: "low", saturation: "muted", palette: ["amber", "cream", "faded brown"], skinTone: "warm", blackLevel: "lifted", highlightRolloff: "soft, creamy", shadowBehavior: "warm shadows", grain: "visible", halation: "warm halation", bloom: "soft", lensCharacter: "vintage", texture: "faded print", sharpnessPhilosophy: "soft" } },
] as const;

const HEADING = /^\s*(?:(INT|EXT|I\/E)[./ ]+|内景|外景|场景[:：]?)\s*(.+)$/i;
const STOP = new Set(["The", "And", "But", "She", "He", "They", "It", "His", "Her", "Their", "Suddenly", "Then", "When", "While", "INT", "EXT", "NIGHT", "DAY"]);
const DIALOGUE = /^([A-Z][A-Z .'\-]{1,24}|[一-龥]{1,6})\s*[:：]\s*(.+)$/;
const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Rule-based entity extraction so a pasted script becomes characters / locations / props without typing. */
export function extractEntities(script: string) {
    const lines = script.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const environments = new Map<string, { time: string }>();
    const characters = new Set<string>();
    const props = new Set<string>();
    const counts = new Map<string, number>();
    for (const l of lines) {
        const h = l.match(HEADING);
        if (h) {
            const [place, time] = h[2].split(/\s+[-–—]\s+/);
            const name = title(place.replace(/\./g, "").trim());
            if (name) environments.set(name, { time: /night|夜|dusk|黄昏/i.test(time ?? "") ? "night" : "day" });
            continue;
        }
        const d = l.match(DIALOGUE);
        if (d) { characters.add(/^[A-Z .'\-]+$/.test(d[1]) ? title(d[1].trim()) : d[1]); continue; }
        for (const m of l.matchAll(/\b(?:the|a|an|his|her|their)\s+([A-Z][a-z]{2,})/g)) props.add(m[1]);
        for (const m of l.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{2,})\b/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
        const first = l.match(/^([A-Z][a-z]{2,})\b/);
        if (first && !STOP.has(first[1])) counts.set(first[1], (counts.get(first[1]) ?? 0) + 1);
    }
    for (const [w, n] of counts) if (n >= 2 && !STOP.has(w) && !props.has(w) && ![...environments.keys()].some((e) => e.includes(w))) characters.add(w);
    for (const c of characters) props.delete(c);
    return { environments: [...environments].map(([name, v]) => ({ name, ...v })), characters: [...characters], props: [...props] } satisfies { environments: { name: string; time: string }[]; characters: string[]; props: string[] };
}
export type { AssetLite };
