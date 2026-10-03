import conf from "conf";
import { mkdirSync, realpathSync } from "@toonflow/file";
import { resolve } from "node:path";
import type { RemoteTeam } from "@/utils/teams";
import type { A2aSettings } from "@/agent/a2a/settings";
import type { desktopUpdateAttempt } from "@/types/desktop";

// LITTO ships no pre-installed text provider (the LITTO TF-Router seed was removed); users add their own.
const autoInstallProviders: { id: string; label: string; version?: string; apiUrl: string; protocol: string; models: unknown[] }[] = [];
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(import.meta.dirname, "../../../../../data");
mkdirSync(dataDirectory, { recursive: true });
const configDirectory = realpathSync(dataDirectory);
process.env.TOONFLOW_DATA_DIR = configDirectory;

const config = new conf<{ settings: Record<string, unknown>; toolConfigs: Record<string, Record<string, unknown>>; nodeConfigs: Record<string, Record<string, unknown>>; remoteConnections: Record<string, RemoteTeam>; a2a: A2aSettings; desktopUpdateAttempt: desktopUpdateAttempt }>({
  cwd: configDirectory,
  configName: "settings",
  configFileMode: 0o600,
  watch: true,
});

export function removeLegacySettings(settings: Record<string, unknown>) {
  let changed = false;
  // ACT: 只清理已废弃字段，保留其他设置和插件配置。
  for (const [record, key] of [[settings, "developerConfirmed"], [settings.general, "systemPrompt"], [settings.stores, "toonflow.developer"]] as const) {
    if (record && typeof record === "object" && !Array.isArray(record) && Object.hasOwn(record, key)) {
      Reflect.deleteProperty(record, key);
      changed = true;
    }
  }
  return changed;
}

const settings = config.get("settings", {});
if (removeLegacySettings(settings)) config.set("settings", settings);

// ACT: 仅初始化尚未配置的文本供应商；已有列表（包括用户清空的列表）保持原样。
if (!config.has("settings.customProviders")) {
  config.set("settings.customProviders", autoInstallProviders.map(({ id, label, version, apiUrl, protocol, models }) =>
    ({ id, label, version, apiUrl, protocol, models, apiKey: "" })));
}

// ── Multi-tenant settings ─────────────────────────────────────────────────
// Every call site does `conf.get/set(...)`. The default export is a proxy that routes each call to the *current workspace's*
// settings file (data/tenants/<workspaceId>/settings.json, mode 0600) so provider keys and preferences are never shared across tenants.
// Outside an authenticated request (startup, background work) or with LITTO_AUTH=off it falls back to the global data/settings.json.
import { currentTenant, authEnabled, tenantDir } from "@/utils/tenant";

type Settings = typeof config;
const tenantConfigs = new Map<string, Settings>();
function activeConfig(): Settings {
  const tenant = currentTenant();
  if (!tenant || !authEnabled()) return config;
  let c = tenantConfigs.get(tenant.workspaceId);
  if (!c) {
    const cwd = tenantDir(tenant.workspaceId);
    mkdirSync(cwd, { recursive: true });
    c = new conf({ cwd, configName: "settings", configFileMode: 0o600, watch: false }) as Settings;
    tenantConfigs.set(tenant.workspaceId, c);
  }
  return c;
}

const tenantConf = new Proxy(config, {
  get(_target, prop) {
    // `conf.path` identifies the *system* data directory (many helpers derive data/ from it), so it never switches per tenant.
    if (prop === "path") return config.path;
    const c = activeConfig();
    const value = Reflect.get(c, prop, c);
    return typeof value === "function" ? value.bind(c) : value;
  },
}) as Settings;


export default tenantConf;
