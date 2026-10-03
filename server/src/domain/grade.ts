import { z } from "zod";
import { bad } from "../util.ts";

/** Parametric colour grade. lift/gamma/gain are per-channel offsets (-1..1) for shadows / midtones / highlights. */
const rgb = z.tuple([z.number().min(-1).max(1), z.number().min(-1).max(1), z.number().min(-1).max(1)]);
export const gradeSchema = z.object({
    lift: rgb.default([0, 0, 0]), gamma: rgb.default([0, 0, 0]), gain: rgb.default([0, 0, 0]),
    saturation: z.number().min(0).max(3).default(1), contrast: z.number().min(0.5).max(2).default(1),
    temperature: z.number().min(-100).max(100).default(0), exposureStops: z.number().min(-4).max(4).default(0),
    lutCube: z.string().max(2 * 1024 * 1024).optional(),
}).strict();
export type Grade = z.infer<typeof gradeSchema>;

/** .cube validation: LUT_3D_SIZE N (2..65) followed by exactly N^3 rows of three floats. */
export function validateCube(text: string) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const size = lines.find((l) => l.startsWith("LUT_3D_SIZE"));
    if (!size) throw bad("invalid .cube: LUT_3D_SIZE missing (only 3D LUTs are supported)");
    const n = Number(size.split(/\s+/)[1]);
    if (!Number.isInteger(n) || n < 2 || n > 65) throw bad("invalid .cube: LUT_3D_SIZE must be 2..65");
    const rows = lines.filter((l) => /^[-+\d.eE]/.test(l));
    if (rows.length !== n ** 3) throw bad(`invalid .cube: expected ${n ** 3} rows, got ${rows.length}`);
    for (const r of rows) { const p = r.split(/\s+/); if (p.length !== 3 || p.some((x) => !Number.isFinite(Number(x)))) throw bad("invalid .cube: malformed data row"); }
}

export const parseGrade = (raw: unknown): Grade => {
    const r = gradeSchema.safeParse(raw ?? {});
    if (!r.success) throw bad("invalid grade", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    if (r.data.lutCube) validateCube(r.data.lutCube);
    return r.data;
};

export const isNeutral = (g?: Grade | null) => !g || (!g.lutCube && g.lift.every((v) => v === 0) && g.gamma.every((v) => v === 0) && g.gain.every((v) => v === 0) && g.saturation === 1 && g.contrast === 1 && g.temperature === 0 && g.exposureStops === 0);

/** ffmpeg filter chain (comma separated) for a grade; `lutPath` is where the caller wrote lutCube. Empty string = no-op. */
export function gradeFilters(g: Grade | null | undefined, lutPath?: string): string {
    if (isNeutral(g)) return "";
    const f: string[] = [];
    if (g!.lutCube && lutPath) f.push(`lut3d=file='${lutPath.replace(/'/g, "\\'")}'`);
    // temperature is folded into the midtone balance: warm = more red / less blue
    const t = g!.temperature / 250;
    const c = (v: number) => Math.max(-1, Math.min(1, v)).toFixed(4);
    const cb = [g!.lift[0], g!.lift[1], g!.lift[2], g!.gamma[0] + t, g!.gamma[1], g!.gamma[2] - t, g!.gain[0], g!.gain[1], g!.gain[2]];
    if (cb.some((v) => v !== 0)) f.push(`colorbalance=rs=${c(cb[0])}:gs=${c(cb[1])}:bs=${c(cb[2])}:rm=${c(cb[3])}:gm=${c(cb[4])}:bm=${c(cb[5])}:rh=${c(cb[6])}:gh=${c(cb[7])}:bh=${c(cb[8])}`);
    if (g!.exposureStops !== 0) { const m = 2 ** g!.exposureStops; f.push(`lutrgb=r='clip(val*${m.toFixed(4)},0,maxval)':g='clip(val*${m.toFixed(4)},0,maxval)':b='clip(val*${m.toFixed(4)},0,maxval)'`); }
    if (g!.saturation !== 1 || g!.contrast !== 1) f.push(`eq=contrast=${g!.contrast}:saturation=${g!.saturation}`);
    return f.join(",");
}
