import { lstat, mkdir, readFile, readdir, realpath, writeAtomic } from "@toonflow/file";
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
      } else if (info?.isFile()) files.set(relative, await readFile(path));
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
  await writeAtomic(statePath, JSON.stringify({ files: hashes, conflicts }, null, 2));
  if (conflicts.length) console.warn(`保留自定义 ${category}，未自动升级：${conflicts.join("、")}；详见 ${statePath}`);
  return { conflicts };
}
