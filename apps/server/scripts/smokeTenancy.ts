// Security smoke test for multi-tenant mode. Run against a live dev server:  cd apps/server && bun scripts/smokeTenancy.ts [http://localhost:3000]
// Checks: auth gate, per-tenant project roots, path escapes, per-tenant settings, key masking, admin-only plugin install, MCP/A2A off.
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const DATA = process.env.TOONFLOW_DATA_DIR ?? join(import.meta.dirname, "../../../data");
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };

type Who = { cookie: string; email: string };
const app = (who: Who | null, extra: Record<string, string> = {}) => ({ ...(who ? { cookie: who.cookie } : {}), origin: BASE, "x-toonflow-workspace": "1", ...extra });
async function api(who: Who | null, method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { ...app(who), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
async function login(email: string): Promise<Who> {
  const code = (await (await fetch(`${BASE}/cloud/auth/request-code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) })).json() as any).devCode;
  const r = await fetch(`${BASE}/cloud/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code, client: "web" }) });
  return { email, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
}

const stamp = Date.now().toString(36);
check("no session → 401 on /api", (await api(null, "GET", "/api/workspaces/list")).status === 401);
check("forged cookie → 401", (await api({ email: "x", cookie: "litto_session=forged" }, "GET", "/api/workspaces/list")).status === 401);
check("MCP/A2A not mounted in multi-tenant mode", [(await fetch(`${BASE}/mcp`)).status, (await fetch(`${BASE}/a2a`)).status].every((s) => s === 404 || s === 401));

const alice = await login(`alice-${stamp}@example.com`), bob = await login(`bob-${stamp}@example.com`);
const projA = (await api(alice, "POST", "/api/workspaces/createProject", { name: "Alice film" })).json.data.directory as string;
const projB = (await api(bob, "POST", "/api/workspaces/createProject", { name: "Bob film" })).json.data.directory as string;
check("each user gets a project inside their own tenant dir", projA !== projB && projA.includes("/tenants/") && projB.includes("/tenants/") && projA.split("/tenants/")[1].split("/")[0] !== projB.split("/tenants/")[1].split("/")[0]);
check("owner can list own project", (await api(alice, "GET", `/api/workspaces/files/list?directory=${encodeURIComponent(projA)}`)).status === 200);
const cross = await api(bob, "GET", `/api/workspaces/files/list?directory=${encodeURIComponent(projA)}`);
check("other tenant cannot list it", cross.status === 403, `status ${cross.status}`);
for (const dir of ["/etc", "/", DATA]) check(`outside root blocked (${dir})`, [403, 404].includes((await api(bob, "GET", `/api/workspaces/files/list?directory=${encodeURIComponent(dir)}`)).status));
const trav = await api(bob, "GET", `/api/workspaces/files/list?directory=${encodeURIComponent(projB)}&path=${encodeURIComponent("../../" + projA.split("/tenants/")[1].split("/")[0] + "/workspaces")}`);
check("path traversal out of own project blocked", trav.status === 403 || trav.status === 400 || trav.status === 404, `status ${trav.status}`);
const write = await fetch(`${BASE}/api/workspaces/files/write?directory=${encodeURIComponent(projA)}&path=x.txt`, { method: "PUT", headers: { ...app(bob), "content-type": "application/octet-stream" }, body: "pwn" });
check("other tenant cannot write into it", write.status === 403, `status ${write.status}`);

// settings: per-tenant + secrets masked
const SECRET = "sk-ALICE-SECRET-9876";
const saved = await api(alice, "PUT", "/api/settings/save", { settings: { customProviders: [{ id: "p1", label: `Mine-${stamp}`, apiUrl: "https://example.invalid/v1", protocol: "openai-completions", models: [], apiKey: SECRET }] } });
check("alice saves a provider key", saved.status === 200, JSON.stringify(saved.json).slice(0, 80));
const aliceView = JSON.stringify((await api(alice, "GET", "/api/settings/get")).json);
check("key is masked when read back", !aliceView.includes(SECRET) && aliceView.includes("••••9876"));
check("bob never sees alice's settings", !JSON.stringify((await api(bob, "GET", "/api/settings/get")).json).includes(`Mine-${stamp}`));
await api(alice, "PUT", "/api/settings/save", { settings: JSON.parse(aliceView).data });
const tenants = join(DATA, "tenants");
const files = readdirSync(tenants).map((d) => join(tenants, d, "settings.json")).filter((f) => { try { return readFileSync(f, "utf8").includes(`Mine-${stamp}`); } catch { return false; } });
check("echoing the mask back keeps the stored key", files.length === 1 && readFileSync(files[0], "utf8").includes(SECRET));
check("tenant settings file is mode 0600", files.length === 1 && (statSync(files[0]).mode & 0o777) === 0o600);

// SSRF: tenants choose upstream addresses, so internal ones must be refused everywhere they can be entered
const provider = (apiUrl: string) => ({ settings: { customProviders: [{ id: "p-ssrf", label: "ssrf", apiUrl, protocol: "openai-completions", models: [], apiKey: "" }] } });
for (const bad of ["http://127.0.0.1:3000", "http://169.254.169.254/latest/meta-data", "http://localhost:8080/v1", "http://[::1]:9000", "http://10.0.0.5/v1", "http://[::ffff:127.0.0.1]/v1", "ftp://example.com/v1"]) {
  const r = await api(alice, "PUT", "/api/settings/save", provider(bad));
  check(`settings/save rejects provider address ${bad}`, r.status === 400, `status ${r.status}`);
}
check("settings/save accepts a public https address (validation only, no request made)", (await api(alice, "PUT", "/api/settings/save", provider("https://api.openai.com/v1"))).status === 200);
check("fetch-models refuses internal address", (await api(alice, "POST", "/api/providers/models", { apiUrl: "http://169.254.169.254/v1", protocol: "openai-completions", apiKey: "" })).status === 400);
const leak = "sk-NEVER-ECHO-THIS-1234";
const testPrivate = await api(alice, "POST", "/api/providers/test", { kind: "text", apiUrl: "http://127.0.0.1:3000/v1", apiKey: leak });
check("connection test refuses internal address in plain Chinese", testPrivate.status === 200 && testPrivate.json.data.ok === false && /内网|本机/.test(testPrivate.json.data.message), testPrivate.json?.data?.message);
check("connection test never echoes the key", !JSON.stringify(testPrivate.json).includes(leak));
const testDns = await api(alice, "POST", "/api/providers/test", { kind: "text", apiUrl: "https://invalid.example.invalid/v1", apiKey: leak });
check("unresolvable host → friendly failure", testDns.json?.data?.ok === false && /无法解析|连不上/.test(testDns.json.data.message), testDns.json?.data?.message);
check("media test: unknown provider and too-short key are refused", [(await api(alice, "POST", "/api/providers/test", { kind: "media", providerId: "nope", apiKey: "x".repeat(20) })).json.data.ok, (await api(alice, "POST", "/api/providers/test", { kind: "media", providerId: "meta", apiKey: "abc" })).json.data.ok].every((v) => v === false));
check("tenants (non-admin) may use the connection test", testPrivate.status === 200);
await api(alice, "PUT", "/api/settings/save", { settings: JSON.parse(aliceView).data }); // restore alice's earlier settings

// plugin install is code execution: admin only
for (const p of ["/api/tools/install", "/api/nodes/install", "/api/providers/media/save", "/api/skills/install"]) check(`non-admin blocked: POST ${p}`, (await api(alice, "POST", p, {})).status === 403);
const admin = await login("admin@litto.local");
check("admin passes the gate (gets validation error, not 403)", (await api(admin, "POST", "/api/tools/install", {})).status !== 403);

console.log(failed ? `\n${failed} FAILED` : "\nall tenancy checks passed");
process.exit(failed ? 1 : 0);
