import { $ } from "bun";
import { cp, readdir, rm } from "@toonflow/file";
import { resolve } from "node:path";

const projectDir = resolve(import.meta.dirname, "../../..");

// ACT(部署适配): 上游用 `bun run --filter './packages/teams/*' build` 构建团队，
// 但 Bun 1.3.14 在 Linux 下 --filter 会误读小驼峰目录（packages/teams/storyboardTeam），
// 直接报 `error: ENOENT` 导致 build:server 整体失败。
// 与 buildStandalone.ts 中 nodes/tools 的处理方式保持一致，改为逐目录调用。
for (const entry of await readdir(resolve(projectDir, "packages/teams"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  await $`${process.execPath} run build`
    .cwd(resolve(projectDir, "packages/teams", entry.name))
    .env({ ...process.env, NODE_ENV: "production" });
}

await $`${process.execPath} run build`.cwd(resolve(projectDir, "packages/mcp"));
await $`${process.execPath} build src/index.ts --target=bun --minify --outdir ../../build/server`.cwd(resolve(projectDir, "apps/server"));
const skillsOutput = resolve(projectDir, "build/skills");
await rm(skillsOutput, { recursive: true, force: true });
await cp(resolve(projectDir, "packages/skills"), skillsOutput, { recursive: true });
const providersOutput = resolve(projectDir, "build/providers");
await rm(providersOutput, { recursive: true, force: true });
await cp(resolve(projectDir, "packages/providers/src"), providersOutput, { recursive: true });
