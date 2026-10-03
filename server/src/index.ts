import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { config } from "./config.ts";
import { startWorker } from "./jobs.ts";
import { seedProviders } from "./providers/registry.ts";
import { log } from "./util.ts";
import { sweepUploads } from "./routes/extra.ts";

seedProviders();
startWorker();
setInterval(() => sweepUploads(), 3600_000).unref();
serve({ fetch: app.fetch, port: config.port }, (i) => log.info(`FilmFlow server on http://localhost:${i.port}  (data: ${config.dataDir})`));
