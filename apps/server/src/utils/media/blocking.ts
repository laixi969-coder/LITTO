import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import { dirname, join } from "node:path";
import { resolveWorkspacePath } from "@/utils/workspace/files";

/** 人：坐标以房间左上角为原点，单位米；facing 是朝向角度（0=右，90=下，顺时针）。 */
export interface BlockingPerson {
  name: string;
  x: number;
  y: number;
  /** 朝谁看；与 facing 二选一，给了 faceTo 就按对方位置算朝向 */
  faceTo?: string;
  facing?: number;
  note?: string;
}

/** 机位：站在哪、看谁、什么景别、前景挡着谁。 */
export interface BlockingCamera {
  id: string;
  x: number;
  y: number;
  /** 看向的人名或坐标 */
  target: string | [number, number];
  shotSize?: string;
  /** 前景是谁的肩/背，写人名 */
  foreground?: string;
  note?: string;
}

export interface BlockingScene {
  name: string;
  width: number;
  depth: number;
  people: BlockingPerson[];
  cameras: BlockingCamera[];
  /** 对轴线的两个人，默认取前两个人的连线 */
  axis?: [string, string];
  props?: { label: string; x: number; y: number; w: number; h: number; round?: boolean }[];
}

export interface AxisCheck {
  pair: [string, string];
  /** 每个机位在轴线的哪一侧：1 与 -1 互为反侧，0 表示骑在线上 */
  sides: { id: string; side: number }[];
  /** 有没有机位跨到另一侧——跨侧就是跳轴，观众会以为两人换了位置 */
  crossing: boolean;
}

const SCALE = 56;
const PAD = 40;

function pointOf(scene: BlockingScene, target: string | [number, number]): [number, number] {
  if (Array.isArray(target)) return target;
  const person = scene.people.find(item => item.name === target);
  if (!person) throw new Error(`机位看向的「${target}」不在这个场景的人物里`);
  return [person.x, person.y];
}

/** 叉积符号决定机位在轴线的哪一侧；这是判断跳轴的唯一依据。 */
function sideOf(axis: [[number, number], [number, number]], point: [number, number]) {
  const value = (axis[1][0] - axis[0][0]) * (point[1] - axis[0][1]) - (axis[1][1] - axis[0][1]) * (point[0] - axis[0][0]);
  if (Math.abs(value) < 0.05) return 0;
  return value > 0 ? 1 : -1;
}

export function checkAxis(scene: BlockingScene): AxisCheck {
  const pair = scene.axis ?? ([scene.people[0]?.name, scene.people[1]?.name] as [string, string]);
  const a = scene.people.find(item => item.name === pair[0]);
  const b = scene.people.find(item => item.name === pair[1]);
  if (!a || !b) throw new Error(`轴线要求 ${pair.join(" 与 ")} 都在人物列表里`);
  const axis: [[number, number], [number, number]] = [[a.x, a.y], [b.x, b.y]];
  const sides = scene.cameras.map(camera => ({ id: camera.id, side: sideOf(axis, [camera.x, camera.y]) }));
  const distinct = [...new Set(sides.map(item => item.side).filter(side => side !== 0))];
  return { pair, sides, crossing: distinct.length > 1 };
}

/**
 * 把一镜的机位翻译成可以直接写进提示词的空间描述。
 * 只给「主体在中央 + 前景在哪一侧 + 其余人在哪一侧」——把所有人平铺成左右会连主体一起算进去，读起来是错的。
 */
export function blockingText(scene: BlockingScene, camera: BlockingCamera) {
  const target = pointOf(scene, camera.target);
  const targetName = typeof camera.target === "string" ? camera.target : "";
  const angle = Math.atan2(target[1] - camera.y, target[0] - camera.x);
  // 相机自身的右向量：投影为正的人在画面右侧。
  const rightX = -Math.sin(angle);
  const rightY = Math.cos(angle);
  const others = scene.people
    .filter(person => person.name !== targetName)
    .map(person => ({ name: person.name, v: (person.x - camera.x) * rightX + (person.y - camera.y) * rightY }))
    .sort((left, right) => left.v - right.v);
  const side = (value: number) => value >= 0 ? "右" : "左";
  const parts = [`机位 ${camera.id}`];
  if (camera.shotSize) parts.push(`景别${camera.shotSize}`);
  if (targetName) parts.push(`${targetName}在画面中央`);
  if (camera.foreground) {
    const foreground = others.find(item => item.name === camera.foreground);
    parts.push(foreground
      ? `前景是${camera.foreground}的肩，虚焦压在画面${side(foreground.v)}侧`
      : `前景是${camera.foreground}的肩，虚焦压一条边`);
  }
  const rest = others.filter(item => item.name !== camera.foreground);
  if (rest.length) parts.push(rest.map(item => `${item.name}在画面${side(item.v)}侧`).join("、"));
  if (camera.note) parts.push(camera.note);
  return parts.join("；") + "。";
}

function svgOf(scene: BlockingScene, axis: AxisCheck) {
  const width = scene.width * SCALE;
  const depth = scene.depth * SCALE;
  const totalW = width + PAD * 2;
  const totalH = depth + PAD * 2;
  const px = (x: number) => PAD + x * SCALE;
  const py = (y: number) => PAD + y * SCALE;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif">`);
  out.push(`<rect width="100%" height="100%" fill="#12141a"/>`);
  out.push(`<rect x="${PAD}" y="${PAD}" width="${width}" height="${depth}" fill="#1b1e26" stroke="#3a4050" stroke-width="1.5"/>`);
  // 一米一格，方便读距离
  for (let x = 1; x < scene.width; x += 1) out.push(`<line x1="${px(x)}" y1="${PAD}" x2="${px(x)}" y2="${PAD + depth}" stroke="#262b36" stroke-width="1"/>`);
  for (let y = 1; y < scene.depth; y += 1) out.push(`<line x1="${PAD}" y1="${py(y)}" x2="${PAD + width}" y2="${py(y)}" stroke="#262b36" stroke-width="1"/>`);
  for (const prop of scene.props ?? []) {
    const rect = prop.round
      ? `<ellipse cx="${px(prop.x)}" cy="${py(prop.y)}" rx="${prop.w * SCALE / 2}" ry="${prop.h * SCALE / 2}" fill="#232833" stroke="#4a5266"/>`
      : `<rect x="${px(prop.x - prop.w / 2)}" y="${py(prop.y - prop.h / 2)}" width="${prop.w * SCALE}" height="${prop.h * SCALE}" rx="3" fill="#232833" stroke="#4a5266"/>`;
    out.push(rect + `<text x="${px(prop.x)}" y="${py(prop.y) + 4}" fill="#8b93a7" font-size="11" text-anchor="middle">${prop.label}</text>`);
  }
  const a = scene.people.find(item => item.name === axis.pair[0]);
  const b = scene.people.find(item => item.name === axis.pair[1]);
  if (a && b) {
    // 轴线用虚线穿过两人：机位必须全在同一侧，跨侧等于跳轴
    out.push(`<line x1="${px(a.x)}" y1="${py(a.y)}" x2="${px(b.x)}" y2="${py(b.y)}" stroke="${axis.crossing ? "#ff6b6b" : "#5a7cff"}" stroke-width="1.5" stroke-dasharray="6 5" opacity="0.8"/>`);
  }
  for (const camera of scene.cameras) {
    const [tx, ty] = pointOf(scene, camera.target);
    const angle = Math.atan2(ty - camera.y, tx - camera.x);
    const cx = px(camera.x);
    const cy = py(camera.y);
    const spread = 0.42;
    const reach = 46;
    const p1 = [cx + Math.cos(angle - spread) * reach, cy + Math.sin(angle - spread) * reach];
    const p2 = [cx + Math.cos(angle + spread) * reach, cy + Math.sin(angle + spread) * reach];
    out.push(`<line x1="${cx}" y1="${cy}" x2="${px(tx)}" y2="${py(ty)}" stroke="#ffb454" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/>`);
    out.push(`<polygon points="${cx},${cy} ${p1[0].toFixed(1)},${p1[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}" fill="#ffb454" opacity="0.9"/>`);
    out.push(`<text x="${cx}" y="${cy - 10}" fill="#ffb454" font-size="11" text-anchor="middle">${camera.id}</text>`);
  }
  for (const person of scene.people) {
    const cx = px(person.x);
    const cy = py(person.y);
    let facing = person.facing ?? 0;
    if (person.faceTo) {
      const other = scene.people.find(item => item.name === person.faceTo);
      if (other) facing = Math.atan2(other.y - person.y, other.x - person.x) * 180 / Math.PI;
    }
    const rad = facing * Math.PI / 180;
    out.push(`<circle cx="${cx}" cy="${cy}" r="15" fill="#2d3444" stroke="#8fa4ff" stroke-width="1.5"/>`);
    out.push(`<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(rad) * 22}" y2="${cy + Math.sin(rad) * 22}" stroke="#8fa4ff" stroke-width="2"/>`);
    out.push(`<text x="${cx}" y="${cy + 34}" fill="#e6eaf5" font-size="12" text-anchor="middle">${person.name}</text>`);
  }
  out.push(`<text x="${PAD}" y="${PAD - 14}" fill="#e6eaf5" font-size="14">${scene.name}　俯视走位（一格一米）</text>`);
  if (axis.crossing) out.push(`<text x="${PAD}" y="${totalH - 12}" fill="#ff6b6b" font-size="12">机位跨在轴线两侧：跳轴</text>`);
  out.push(`</svg>`);
  return out.join("\n");
}

/**
 * 场次走位板：一张俯视图 + 每镜的空间描述 + 跳轴判定。
 * 生成前先把人和机位摆定，关键帧才有依据；只靠提示词写「过肩」，模型每次给的左右都可能反。
 */
export async function buildBlocking(cwd: string, request: { scene: BlockingScene; outputDirectory?: string; save?: boolean }) {
  const axis = checkAxis(request.scene);
  const cameras = request.scene.cameras.map(camera => ({
    id: camera.id,
    blocking: blockingText(request.scene, camera),
    side: axis.sides.find(item => item.id === camera.id)?.side ?? 0,
  }));
  const outputDirectory = request.outputDirectory ?? "assets/blocking";
  let svg: string | null = null;
  let json: string | null = null;
  if (request.save !== false) {
    const target = await resolveWorkspacePath(cwd, join(outputDirectory, `${request.scene.name}.svg`), true);
    await mkdir(dirname(target.path), { recursive: true });
    await writeAtomic(target.path, svgOf(request.scene, axis));
    svg = join(outputDirectory, `${request.scene.name}.svg`);
    // 同时存一份结构化结果：后续生成可以直接取 blocking 文本，不必重新算一遍。
    const record = await resolveWorkspacePath(cwd, "assets/blocking.json", true);
    await writeAtomic(record.path, JSON.stringify({
      scene: request.scene, axis, cameras, generated: new Date().toISOString(),
    }, null, 1));
    json = "assets/blocking.json";
  }
  return {
    scene: request.scene.name,
    svg,
    json,
    axis,
    cameras,
    hint: axis.crossing
      ? "机位分在轴线两侧，剪起来观众会以为两人换了位置。把一侧机位挪到同一侧，或补一个换轴的过渡镜。"
      : "机位都在轴线同一侧，正反打可以对切。",
  };
}

export interface BlockingRecord {
  scene?: BlockingScene;
  axis?: AxisCheck;
  cameras?: { id: string; blocking: string; side: number }[];
  generated?: string;
}

/** 读已落盘的走位板；不存在返回 null，不抛错。 */
export async function readBlocking(cwd: string): Promise<BlockingRecord | null> {
  const resolved = await resolveWorkspacePath(cwd, "assets/blocking.json", true).catch(() => null);
  if (!resolved) return null;
  const content = await readFile(resolved.path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as BlockingRecord;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 按镜头号取走位描述，注入提示词。
 * 只做「没写就补」：作者自己写了 BLOCKING 就以作者为准，工具不覆盖。
 */
export async function blockingLine(cwd: string, shotId?: string): Promise<string> {
  if (!shotId) return "";
  const record = await readBlocking(cwd);
  const camera = record?.cameras?.find(item => item.id === shotId || shotId.startsWith(item.id));
  if (!camera?.blocking) return "";
  return `BLOCKING: ${camera.blocking}`;
}
