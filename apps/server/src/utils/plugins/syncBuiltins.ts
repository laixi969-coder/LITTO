import { lstat, mkdir, readFile, readdir, realpath, unlink, writeAtomic } from "@toonflow/file";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import baseline from "./builtinBaseline.json";

async function pathInfo(path: string) {
  const parent = dirname(path);
  if (parent !== path) await pathInfo(parent);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info?.isSymbolicLink()) throw new Error(`内置资源同步拒绝符号链接：${path}`);
  return info;
}

// ACT: 按技能/团队目录整体判断是否可升级，避免新成员指令搭配旧权限清单。
// 仅启动时单进程执行；不删除用户文件，不强制迁移未知历史版本。
export default async function syncBuiltins(target: string, source: string, category: "skills" | "agents") {
  const entries = await readdir(source, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (!entries.length) return { conflicts: [] as string[] };
  // macOS 的 /var 等系统父目录允许规范化，资源根本身与其内部仍拒绝链接。
  await mkdir(dirname(target), { recursive: true });
  target = join(await realpath(dirname(target)), basename(target));
  source = join(await realpath(dirname(source)), basename(source));
  await pathInfo(target);
  await pathInfo(source);
  await mkdir(target, { recursive: true });
  const statePath = join(target, "builtinVersions.json");
  await pathInfo(statePath);
  const previous = JSON.parse(await readFile(statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  })) as { files?: Record<string, string> };
  const hashes = { ...previous.files };
  const conflicts: string[] = [];
  const digest = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");
  for (const entry of entries.filter(entry => entry.isDirectory())) {
    const files = new Map<string, Buffer>();
    async function collect(relative: string) {
      const path = join(source, relative);
      const info = await pathInfo(path);
      if (info?.isDirectory()) {
        for (const name of await readdir(path)) await collect(`${relative}/${name}`);
      } else if (info?.isFile()) {
        // SDK 按大小写识别技能入口，将仓库的小驼峰源文件映射到安装格式。
        const installed = category === "skills" && relative === `${entry.name}/skill.md` ? `${entry.name}/SKILL.md` : relative;
        if (files.has(installed)) throw new Error(`重复的内置资源：${installed}`);
        files.set(installed, await readFile(path));
      }
      else throw new Error(`内置资源不是普通文件：${path}`);
    }
    await collect(entry.name);
    let conflict = false;
    for (const [relative, content] of files) {
      const path = join(target, relative);
      const info = await pathInfo(path);
      if (!info) continue;
      if (!info.isFile()) { conflict = true; break; }
      const current = digest(await readFile(path));
      const legacy = (baseline as Record<string, string>)[`${category}/${relative}`];
      if (current !== digest(content) && current !== hashes[relative] && current !== legacy) { conflict = true; break; }
    }
    if (conflict) { conflicts.push(entry.name); continue; }
    for (const [relative, content] of files) {
      const path = join(target, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeAtomic(path, content);
      hashes[relative] = digest(content);
    }
  }
  // 原装入口并入父技能后退役。自定义内容继续保留。
  if (category === "skills") for (const [name, method, original] of [
    ["characterForge", "workflow/references/methods/characterForgeLibtv.md", "fecaccd85e43d0f252f698305c3746daa7f4af400cb0ab27c6970c461b341596"],
    ["screenCombat", "cinema/references/screenCombat.md", "ea6fd12a368d7b9730321ce99d864db4386dddccbc0d2672b392755e43e97222"],
    ["cinematicCg", "cinema/references/cinematicCg.md", "cf34090151419c8c538bb1d44becdaea408d83b5275a905bf12a72b01180b507"],
  ] as const) {
    const entry = `${name}/SKILL.md`;
    if (hashes[entry] !== original || method && (!hashes[method] || conflicts.includes(method.split("/")[0]!))) continue;
    const path = join(target, entry);
    if ((await pathInfo(path))?.isFile() && (await readdir(dirname(path))).length === 1 && digest(await readFile(path)) === original) await unlink(path);
    delete hashes[entry];
  }
  await writeAtomic(statePath, JSON.stringify({ files: hashes, conflicts }, null, 2));
  if (conflicts.length) console.warn(`保留自定义 ${category}，未自动升级：${conflicts.join("、")}；详见 ${statePath}`);
  return { conflicts };
}
