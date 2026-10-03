// Usage: with the server running → `npm run seed` creates demo@filmflow.local with a ready-to-explore project
// (World/Look, approved assets, a script broken into shots, references bound). Generation is left for you to click.
const BASE = process.env.FILMFLOW_URL ?? "http://localhost:8787";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

let token = "";
async function call(method: string, path: string, body?: unknown, raw?: Buffer) {
    const r = await fetch(BASE + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(raw ? { "content-type": "image/png" } : body ? { "content-type": "application/json" } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
}

const email = process.env.DEMO_EMAIL ?? "demo@filmflow.local";
const { devCode } = await call("POST", "/auth/request-code", { email });
if (!devCode) throw new Error("server is in production mode; log in through the UI instead");
token = (await call("POST", "/auth/verify", { email, code: devCode, client: "api" })).token;

const p = await call("POST", "/projects", { name: "Night Letter (demo)" });
await call("PUT", `/projects/${p.id}/world`, { era: "present day", locationLogic: "rainy coastal city", architecture: "1960s concrete apartment block", weather: "heavy rain", time: "night", material: "concrete, worn wood, glass" });
await call("PUT", `/projects/${p.id}/looks/project`, { contrast: "high", saturation: "muted", palette: ["teal", "amber"], grain: "visible 16mm-like", highlightRolloff: "long, filmic" });
const media = await call("POST", `/media?projectId=${p.id}`, undefined, PNG);
const assets: Record<string, any> = {};
for (const [type, name] of [["Character", "Mara"], ["Character", "Eli"], ["Environment", "Apartment"], ["Prop", "Letter"], ["Prop", "Key"]] as const) {
    const ref = await call("POST", `/projects/${p.id}/references`, { kind: "image", name: `${name} reference`, mediaId: media.id });
    const sug = await call("POST", `/projects/${p.id}/assets/suggest`, { type, name });
    const a = await call("POST", `/projects/${p.id}/assets`, { type, name, references: [ref.id], invariants: sug.invariants, allowedVariations: sug.allowedVariations, forbiddenChanges: sug.forbiddenChanges });
    assets[name] = { asset: await call("POST", `/assets/${a.id}/approve`), ref };
}
const script = `INT. APARTMENT - NIGHT
Mara stands by the window, watching the rain. Eli enters the apartment, quiet.
Mara notices the Letter on the table. She picks up the Letter and turns it over.
MARA: You read it, didn't you?
ELI: I had to know.
Suddenly the lamp flickers. Mara drops the Letter and steps back, afraid.
EXT. STREET - DAY
Eli walks out and grabs the Key from his pocket. He stares at the door behind him.`;
const run = await call("POST", `/projects/${p.id}/director/run`, { script, mode: "director", minShots: 8 });
const shots = await call("GET", `/projects/${p.id}/shots`);
for (const sh of shots) for (const id of sh.assetIds) {
    const x = Object.values(assets).find((a: any) => a.asset.id === id) as any;
    if (!x) continue;
    const role = x.asset.type === "Character" ? "IDENTITY" : x.asset.type === "Environment" ? "ENVIRONMENT" : "GEOMETRY";
    await call("POST", `/shots/${sh.id}/bindings`, { referenceId: x.ref.id, role, lockLevel: role === "IDENTITY" ? "LOCK" : "CONTROL" });
}
console.log(`Demo ready: ${run.shotIds.length} shots. Log in as ${email} (dev code is printed by the server) and open project "${p.name}".`);
