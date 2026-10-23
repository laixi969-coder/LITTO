import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { config } from "./config.ts";
import { startWorker } from "./jobs.ts";
import { seedProviders } from "./providers/registry.ts";
import { log } from "./util.ts";
import { sweepUploads } from "./routes/extra.ts";
import { seedSkills } from "./domain/market-seed.ts";
import { sweepWorkspacePurges } from "./storage.ts";

seedProviders();
seedSkills();
startWorker();
void sweepWorkspacePurges();
setInterval(() => void sweepWorkspacePurges(), 60_000).unref();
setInterval(() => sweepUploads(), 3600_000).unref();
const host = process.env.MILIMILI_HOST?.trim() || "127.0.0.1";
serve({ fetch: app.fetch, port: config.port, hostname: host }, (i) => log.info(`MILI MILI server on http://localhost:${i.port}  (data: ${config.dataDir})`));
