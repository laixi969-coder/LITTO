import logger from "morgan";
import express from "express";
import cors from "cors";
import { dirname, resolve } from "node:path";
import { lstat, readFile, unlink, writeAtomic } from "@toonflow/file";
import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import buildRoute from "@/core";
import { error } from "@/lib/responseFormat";
import desktopRequest from "@/lib/desktop";
import { mountCloud, requireAdminForPlugins, requireSession, requireWriteRole } from "@/lib/cloud";
import { noStoreApi, rateLimit, securityHeaders, staticCacheHeaders } from "@/lib/security";
import { authEnabled } from "@/utils/tenant";
import initializePlugins from "@/utils/plugins/initialize";
import syncBuiltins from "@/utils/plugins/syncBuiltins";
import { languageRequest, resolveRequestLocale, runWithLocale, setLocaleFallback, translateError, translateMessage } from "@/lib/i18n";
import { detectLocale, normalizeLocale } from "@toonflow/i18n";
import { z } from "zod";
import { readRelayImage } from "@/utils/media/relay";

const autoInstallProviders = ["runningHub.ts", "apiMart.ts", "meta.ts", "agnes.ts", "volcengine.ts", "xingsuan.ts", "elevenLabs.ts", "volcSpeech.ts", "bailian.ts", "kling.ts", "vidu.ts", "atlasCloud.ts", "easyRouter.ts", "gen3c.ts", "tencentWand.ts", "token01.ts"];

export async function createApp({
  webRoot,
  dataDirectory,
  toolsRoot,
  nodesRoot,
  providersRoot,
  skillsRoot,
  agentsRoot,
  pluginRevision,
}: {
  webRoot: string;
  dataDirectory?: string;
  toolsRoot?: string;
  nodesRoot?: string;
  providersRoot?: string;
  skillsRoot?: string;
  agentsRoot?: string;
  pluginRevision?: string;
}) {
  // conf 由下方的路由动态加载，必须先确定整个进程共用的数据目录。
  if (dataDirectory) process.env.TOONFLOW_DATA_DIR = resolve(dataDirectory);
  const { default: conf } = await import("@/utils/conf");
  const { setBuiltinDirectory } = await import("@/utils/media/provider");
  setBuiltinDirectory(providersRoot ? resolve(providersRoot, "media") : undefined);
  // 移除旧安装遗留的供应商脚本，不会随新版再次安装。
  await unlink(resolve(dirname(conf.path), "providers/tfRouter.ts")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  setLocaleFallback(() => normalizeLocale((conf.get("settings", {}).ui as { language?: unknown } | undefined)?.language)
    ?? detectLocale([Intl.DateTimeFormat().resolvedOptions().locale]));
  if (dataDirectory && toolsRoot)
    await initializePlugins(resolve(dataDirectory, "tools"), toolsRoot, /^[a-z][a-zA-Z0-9]*\.tool\.js$/, pluginRevision ?? true);
  if (dataDirectory && nodesRoot) await initializePlugins(resolve(dataDirectory, "nodes"), nodesRoot, /^[a-z][a-zA-Z0-9]*\.umd\.js$/, pluginRevision ?? true);
  // ACT: 供应商只补缺失文件；技能/团队按内容指纹升级，保留用户编辑。
  if (dataDirectory && providersRoot) {
    const target = resolve(dataDirectory, "providers/xingsuan.ts");
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isFile() && !info.isSymbolicLink()) {
      const source = await readFile(target);
      const previous = createHash("sha256").update(source).digest("hex");
      // ACT: 只升级已知的旧版内置文件；用户修改过的供应商文件保留原样。
      if (["599660ab4dc4a8fe926fa9ededde7963c84a6052c2019c5eea4e7ebe4010411c", "1f5578360ddc77f8f125aa1e1e72f3c84080b666de6ec402c59e21f482c25ef0", "306fdafef99723d9f047b9c8beecbcaf835d2f4f29078ebb9d7b7f15579bcf02"].includes(previous)) {
        await writeAtomic(target, await readFile(resolve(providersRoot, "media/xingsuan.ts")));
      }
    }
    const runningHubTarget = resolve(dataDirectory, "providers/runningHub.ts");
    const runningHubInfo = await lstat(runningHubTarget).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (runningHubInfo?.isFile() && !runningHubInfo.isSymbolicLink()) {
      const previous = createHash("sha256").update(await readFile(runningHubTarget)).digest("hex");
      // ACT: 只升级已知内置版本，保留用户对供应商文件的修改。
      if (["4c98c9f66fbda37c0b9bfc113163f1b36e1bef3fc5a70d8e3dbd3bcc191f7240", "52158bab91d9bf0cb665f40eca632c26f8174b347ab29a60900648b26064830f", "c17ac72fdb79f25cb88cac5699a423f6cc5bc5cd8af8868850e3c57f1da8616b", "77769ef1563a5a327da84ffdb5baa2bbadf98c77fd858341aaf964ff0ccdcac0", "a5d28df1604119d708bfe75d95a1a05cf73f6e7ff1227be8aaf8d58c954fc79c"].includes(previous)) await writeAtomic(runningHubTarget, await readFile(resolve(providersRoot, "media/runningHub.ts")));
    }
    const atlasCloudTarget = resolve(dataDirectory, "providers/atlasCloud.ts");
    const atlasCloudInfo = await lstat(atlasCloudTarget).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (atlasCloudInfo?.isFile() && !atlasCloudInfo.isSymbolicLink()) {
      const previous = createHash("sha256").update(await readFile(atlasCloudTarget)).digest("hex");
      // ACT: 仅升级已知内置版本，已编辑过的模型和供应商代码由用户手动更新。
      if (["55852d16f37843d380c3ccfdf0d46b3c6a4ea2d87558518f3d1be0536b348ba0", "bd646c33ea48d87e34c076826455f2e1d365df3fbd41763b9868fae068c5af90"].includes(previous)) await writeAtomic(atlasCloudTarget, await readFile(resolve(providersRoot, "media/atlasCloud.ts")));
    }
    await initializePlugins(resolve(dataDirectory, "providers"), resolve(providersRoot, "media"), autoInstallProviders);
  }
  if (dataDirectory && skillsRoot) await syncBuiltins(resolve(dataDirectory, "skills"), skillsRoot, "skills");
  if (dataDirectory && agentsRoot) await syncBuiltins(resolve(dataDirectory, "agents"), agentsRoot, "agents");
  const app = express();
  app.disable("x-powered-by");
  // 只有部署在可信反向代理之后才采用 x-forwarded-for，否则客户端可伪造来源绕过限流。
  if (process.env.MILIMILI_TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(securityHeaders);
  // 临时素材链接携带访问令牌，不进入请求日志或账号会话中间件。
  app.get("/mediaRelay/:token", readRelayImage);

  if (process.env.NODE_ENV === "dev") {
    await buildRoute();
    app.use(logger("dev"));
  }
  // Same-origin by default; set MILIMILI_CORS_ORIGINS=a,b for split deployments.
  const trustedOrigins = (process.env.MILIMILI_CORS_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const trustedHosts = ["localhost", "127.0.0.1", "[::1]", ...(process.env.MILIMILI_TRUSTED_HOSTS ?? "").split(",").map(value => value.trim()).filter(Boolean)];
  if (trustedOrigins.length) app.use(cors({ origin: trustedOrigins, credentials: true }));
  app.use("/api", (req, res, next) => {
    const origin = req.get("origin");
    if (!authEnabled() && (!trustedHosts.includes(req.hostname)
      || (origin ? origin !== `${req.protocol}://${req.get("host")}` && !trustedOrigins.includes(origin) : req.get("sec-fetch-site") === "cross-site")))
      return res.status(403).json(error("页面来源校验失败，请从应用页面重试", null, 403));
    next();
  });
  app.use(languageRequest);
  await mountCloud(app);
  if (authEnabled()) app.use("/api", rateLimit(2400));
  app.use("/api", noStoreApi, requireSession);
  // ACT: 单进程最多同时缓冲两个 API 请求体；结束接收即释放，不占用长任务名额。
  let receivingBodies = 0;
  app.use("/api", (req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    if (receivingBodies >= 2) return res.status(429).json(error("正在接收其他请求，请稍后重试", null, 429));
    receivingBodies++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      receivingBodies--;
      req.off("end", release);
      res.off("close", release);
      res.off("finish", release);
    };
    req.once("end", release);
    res.once("close", release);
    res.once("finish", release);
    next();
  });
  app.use("/a2a", express.json({ limit: "2mb" }));
  app.use(["/api/workspaces/files/write", "/api/assets/save"], express.raw({ type: "application/octet-stream", limit: "100mb" }));
  app.use("/api", express.json({ limit: "100mb" }));
  app.use("/api", express.urlencoded({ extended: true, limit: "100mb" }));
  app.use("/api/desktop", desktopRequest);
  // 账号模式面向多人开放才需要限流；单机桌面模式只有本机一个用户。
  app.use("/api", requireWriteRole, requireAdminForPlugins);

  const router = await import("@/router");
  router.default(app);
  // MCP / A2A are single-instance, token-per-process control surfaces: off in multi-tenant mode (they would cross tenants).
  if (!authEnabled()) {
    const [{ createMcpRouter }, { getMcpTools }, { authorizeMcp }, { skillResources }] = await Promise.all([
      import("@toonflow/mcp"),
      import("@/utils/mcp/tools"),
      import("@/utils/mcp/control"),
      import("@/utils/mcp/resources"),
    ]);
    app.use("/mcp", createMcpRouter({ getTools: getMcpTools, authorize: authorizeMcp, resources: skillResources,
      runInRequest: (request, operation) => runWithLocale(resolveRequestLocale(request.get("accept-language")), operation),
      translate: translateMessage,
      translateError,
    }));
    const { createA2aRouter } = await import("@/agent/a2a");
    app.use("/a2a", createA2aRouter());
  }
  app.use(express.static(webRoot, { setHeaders: staticCacheHeaders }));

  // 错误处理
  app.use((err: Error & { status?: number }, request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(err);
    console.error(err);
    if (err instanceof z.ZodError) {
      return response.status(400).json(error("参数错误", err.issues.map(issue => ({ ...issue, message: translateMessage(issue.message) })), 400));
    }
    const code = (err as NodeJS.ErrnoException).code;
    const status = err.status || ({ ENOENT: 404, ENOTDIR: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403, EPERM: 403 }[code ?? ""] ?? 500);
    const message =
      {
        ENOENT: "找不到这个文件或文件夹，可能已被移动、删除，或者位置选错了。",
        ENOTDIR: "你选中的是文件，但这里需要选择文件夹。请重新选择。",
        EEXIST: "这个名称已经被占用了，请换一个名称。原来的内容不会被覆盖。",
        ENOTEMPTY: "这个文件夹里还有内容，不能直接删除。请先清空或移走里面的文件。",
        EACCES: "没有权限访问这个文件或文件夹。请检查权限，或换一个位置重试。",
        EPERM: "系统不允许这次操作。文件可能正在被其他程序使用，请关闭后重试。",
        EISDIR: "你选中的是文件夹，但这里需要的是文件。请重新选择具体文件。",
      }[code ?? ""] ?? translateError(err);
    response.status(status).json(error(message, code ? { code } : null, status));
  });

  return app;
}
