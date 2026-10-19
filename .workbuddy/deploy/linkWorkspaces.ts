/**
 * 部署适配脚本：在根 node_modules/@toonflow 补齐 workspace 包的软链。
 *
 * 背景：Bun 把 workspace 包链接进「各自依赖方」的 node_modules（例如
 * apps/server/node_modules/@toonflow 下有 10 个），根 node_modules/@toonflow
 * 只会留下根自身的依赖（本项目只有 @toonflow/file）。
 * 而 cloud/ 不在 package.json 的 workspaces 里（且 cloud/node_modules 被 gitignore），
 * 它按包名引用 `@toonflow/tool-media-generation/runtime` 之类时向上查找只能走到
 * /app/node_modules，于是全部解析失败：
 *     error: Could not resolve: "@toonflow/tool-media-generation/runtime"
 *     at /app/cloud/src/domain/workspaceProduction.ts:9:58
 *
 * 这里按 npm 的扁平布局在根补齐这批软链，使 workspace 之外的代码也能解析。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const root = "/app";
const outDir = join(root, "node_modules", "@toonflow");
const groups = ["apps", "packages", "packages/nodes", "packages/tools", "packages/teams"];

mkdirSync(outDir, { recursive: true });

let linked = 0;
let skipped = 0;
for (const group of groups) {
  const groupDir = join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relPath = `${group}/${entry.name}`;
    const manifest = join(root, relPath, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (!name?.startsWith("@toonflow/")) continue;
    const linkPath = join(outDir, name.slice("@toonflow/".length));
    if (existsSync(linkPath)) {
      skipped++;
      continue;
    }
    // outDir 是 <root>/node_modules/@toonflow，回到根需要上跳两级
    symlinkSync(`../../${relPath}`, linkPath, "dir");
    linked++;
  }
}

const total = readdirSync(outDir).length;
console.log(`[deployAdapt] 新建 ${linked} 个软链，已存在 ${skipped} 个，node_modules/@toonflow 现有 ${total} 项`);
