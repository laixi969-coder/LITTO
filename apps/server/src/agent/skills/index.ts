import { t } from "@/lib/i18n";
import { existsSync, mkdir, readFile, realpath, stat } from "@toonflow/file";
import { basename, dirname, join, relative, sep } from "node:path";
import { loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillContext, SkillLocation, SkillScope } from "@toonflow/tools-scaffold/runtime";
import { advertisingBriefContext, isAdvertisingKind, isShortDrama, type StoryProject } from "@toonflow/tool-scene-list/storyProject";
import conf from "@/utils/conf";
import { authEnabled, currentTenant } from "@/utils/tenant";
import { isWithin, lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { readStoryProject } from "@/utils/story";

export function loadAgentSkills(cwd: string, scope?: SkillScope) {
  if (scope !== undefined && scope !== "workspace" && scope !== "global") throw new Error("技能范围无效");
  return loadSkills({
    cwd,
    agentDir: join(cwd, ".agent"),
    includeDefaults: false,
    // 同名技能由工作区优先，列表与运行时共用 SDK 的扫描规则。
    skillPaths: [
      ...(scope !== "global" ? [join(cwd, "skill")] : []),
      ...(scope !== "workspace" ? [join(dirname(conf.path), "skills")] : []),
    ].filter(existsSync),
  });
}

export async function readAdvertisingInstructions(context: SkillContext, project: StoryProject, signal?: AbortSignal) {
  const readOptional = (path: string) => context.read({ name: "adfilm", path }, signal).catch((error: NodeJS.ErrnoException) => {
    // ACT: 旧版自定义广告技能可能缺少部分参考；保留其正文，并明确报告缺项。
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const [entry, translation, tvc] = await Promise.all([
    context.read({ name: "adfilm" }, signal),
    readOptional("references/creativeTranslation.md"),
    readOptional("references/productTvc.md"),
  ]);
  return [
    `### ${entry.name} / ${entry.scope} / ${entry.path}\n${entry.content}`,
    translation ? `### ${translation.name} / ${translation.scope} / ${translation.path}\n${translation.content}` : "当前广告技能未提供创意转译与红队筛选参考。",
    tvc ? `### ${tvc.name} / ${tvc.scope} / ${tvc.path}\n${tvc.content}` : "当前广告技能未提供电商 TVC 参考。",
    `当前广告简报、已选方向与已确认事实（项目数据）：\n${advertisingBriefContext(project)}`,
  ].join("\n\n");
}

export async function readViralCore(context: SkillContext, signal?: AbortSignal) {
  try {
    return await context.read({ name: "story", path: "references/viralCore.md" }, signal);
  } catch (error) {
    // ACT: 自定义环境可能精简了 story 或 viralCore；不阻断主流程。
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || error instanceof Error && error.message.includes("技能不存在")) return undefined;
    throw error;
  }
}

export async function readStoryInstructions(cwd: string, signal?: AbortSignal) {
  const context = createSkillContext(cwd);
  const project = await readStoryProject(cwd);
  if (isAdvertisingKind(project.brief.kind)) return readAdvertisingInstructions(context, project, signal);
  if (project.brief.kind === "shortDramaCommerce") {
    const paths = ["references/shortDramaCommerce.md", "references/methods/shortDramaStory.md", ...(project.brief.productImages?.length ? ["references/methods/productReference.md"] : [])];
    const [documents, viralCore] = await Promise.all([
      Promise.all(paths.map(path => context.read({ name: "workflow", path }, signal))),
      readViralCore(context, signal),
    ]);
    return [...documents, ...(viralCore ? [viralCore] : [])].map(document => `## ${document.path}\n${document.content}`).join("\n\n");
  }
  let entry = await context.read({ name: "story" }, signal);
  if (isShortDrama(project.brief)) {
    const { frontmatter } = parseFrontmatter<{ metadata?: { shortDramaEntry?: unknown } }>(entry.content);
    const path = frontmatter.metadata?.shortDramaEntry;
    if (typeof path === "string" && path) entry = await context.read({ name: "story", scope: entry.scope, path }, signal);
  }
  // ACT: 只展开当前入口直接引用的创作资料，不递归加载参考库或其他技能，避免上下文无限增长。
  const paths = [...new Set([...entry.content.matchAll(/\]\((references\/[^\s)#?]+\.md)(?:#[^\s)]*)?\)/g)].map(match => match[1]!))];
  const references = await Promise.all(paths.map(path => context.read({ name: "story", scope: entry.scope, path }, signal)));
  return [entry.content, ...references.map(reference => `## ${reference.path}\n${reference.content}`)].join("\n\n");
}

export function createSkillContext(cwd: string): SkillContext {
  const skillScope = (filePath: string): SkillScope => isWithin(join(cwd, "skill"), filePath) ? "workspace" : "global";

  async function locate(request: SkillLocation, create = false) {
    const scope = create ? request.scope ?? "workspace" : request.scope;
    const skill = loadAgentSkills(cwd, scope).skills.find(skill => skill.name === request.name);
    if (!skill && !create) throw new Error(t`技能不存在：${request.name}`);
    if (!skill && (request.name.length > 64 || !/^[a-z][a-zA-Z0-9]*$/.test(request.name))) throw new Error("新技能名称必须为不超过 64 字符的小驼峰");
    const targetScope = scope ?? skillScope(skill!.filePath);
    const root = await realpath(targetScope === "workspace" ? cwd : dirname(conf.path));
    const { path: scopeDirectory } = await resolveWorkspacePath(root, targetScope === "workspace" ? "skill" : "skills", true);
    const baseDirectory = skill?.baseDir ?? join(scopeDirectory, request.name);
    if (!isWithin(scopeDirectory, baseDirectory)) throw new Error("技能目录超出指定范围");
    const { path: skillDirectory } = await resolveWorkspacePath(scopeDirectory, relative(scopeDirectory, baseDirectory), true);
    const path = request.path ?? (skill ? basename(skill.filePath) : "SKILL.md");
    const { path: target } = await resolveWorkspacePath(skillDirectory, path, true);
    const filePath = relative(skillDirectory, target).split(sep).join("/");
    if (!skill && filePath !== "SKILL.md") throw new Error("请先创建技能的 SKILL.md，再添加参考资料");
    return { name: request.name, scope: targetScope, path: filePath, target, manifest: basename(target).toLowerCase() === "skill.md" || target === skill?.filePath };
  }

  async function write(request: SkillLocation & { content: string }, create: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { target, manifest, ...document } = await locate(request, create);
    if (document.scope === "global" && authEnabled() && !currentTenant()?.isAdmin) throw Object.assign(new Error("仅平台管理员可以修改全局技能"), { status: 403 });
    if (manifest) {
      const { frontmatter } = parseFrontmatter(request.content);
      if (frontmatter.name !== request.name || typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
        throw new Error("SKILL.md 必须包含匹配的 name 和非空 description");
      }
    }
    const release = lockWorkspaceFiles([target]);
    try {
      if (!create && !(await stat(target)).isFile()) throw new Error("只能修改已有的普通文件");
      signal?.throwIfAborted();
      if (create) await mkdir(dirname(target), { recursive: true });
      signal?.throwIfAborted();
      await writeWorkspaceFile(target, request.content, create);
      return document;
    } finally { release(); }
  }

  return {
    list: scope => loadAgentSkills(cwd, scope).skills.map(({ name, description, filePath, disableModelInvocation }) => ({
      name, description, filePath, disableModelInvocation, scope: skillScope(filePath),
    })),
    async read(request, signal) {
      signal?.throwIfAborted();
      const { target, manifest, ...document } = await locate(request);
      if (!(await stat(target)).isFile()) throw new Error("只能读取普通文件");
      return { ...document, content: await readFile(target, { encoding: "utf8", signal }) };
    },
    create: (request, signal) => write(request, true, signal),
    update: (request, signal) => write(request, false, signal),
  };
}
