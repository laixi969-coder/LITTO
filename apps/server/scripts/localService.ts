import { mkdir, writeAtomic, realpath } from "@toonflow/file";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";

if (process.platform !== "darwin") throw new Error("本地后台服务目前仅支持 macOS。");
const action = process.argv[2];
if (!["start", "stop", "status"].includes(action ?? "")) throw new Error("用法：bun apps/server/scripts/localService.ts start|stop|status");

const root = resolve(import.meta.dirname, "../../..");
const domain = `gui/${process.getuid!()}`;
const agentDirectory = join(homedir(), "Library/LaunchAgents");
const logDirectory = join(root, "data/logs");
const services = [
  { name: "littoServer", port: 3000, cwd: join(root, "apps/server"), health: "/cloud/health" },
  { name: "littoWeb", port: 5188, cwd: join(root, "apps/web"), health: "/@vite/client" },
];
const labelOf = (name: string) => `com.litto.${name}`;
const xml = (value: string) => value.replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);

function launchctl(...args: string[]) {
  return Bun.spawnSync(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
}

async function assertPortFree(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); reject(new Error(`端口 ${port} 已被占用，请先停止原服务，避免启动多个实例。`)); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`无法确认端口 ${port} 是否空闲。`)); });
    socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); error.code === "ECONNREFUSED" ? resolve() : reject(error); });
  });
}

if (action === "start") {
  const node = Bun.which("node");
  if (!node) throw new Error("未找到 Node.js，请先安装前端所需的运行时。");
  const nodePath = await realpath(node);
  const bunPath = await realpath(process.execPath);
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  // ACT: 直接使用 macOS 托管进程，不在应用内另建守护进程；两项服务固定对应本仓库。
  for (const service of services) {
    if (launchctl("print", `${domain}/${labelOf(service.name)}`).exitCode === 0) continue;
    await assertPortFree(service.port);
  }
  for (const service of services) {
    const label = labelOf(service.name);
    if (launchctl("print", `${domain}/${label}`).exitCode === 0) continue;
    const args = service.name === "littoServer"
      ? [bunPath, "--watch", "src/index.ts"]
      : [nodePath, join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(service.port), "--strictPort"];
    const environment = { NODE_ENV: "dev", TOONFLOW_DATA_DIR: join(root, "data"), PATH: [dirname(bunPath), dirname(nodePath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":") };
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(service.cwd)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>KeepAlive</key><true/>
<key>RunAtLoad</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logDirectory, `${service.name}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDirectory, `${service.name}.log`))}</string>
</dict></plist>
`;
    const path = join(agentDirectory, `${service.name}.plist`);
    await writeAtomic(path, plist, { mode: 0o600 });
    const result = launchctl("bootstrap", domain, path);
    if (result.exitCode !== 0) throw new Error(`启动 ${service.name} 失败：${result.stderr.toString()}`);
  }
  for (const service of services) {
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { ready = (await fetch(`http://127.0.0.1:${service.port}${service.health}`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await Bun.sleep(500);
    }
    if (!ready) throw new Error(`${service.name} 未就绪，请查看 ${join(logDirectory, `${service.name}.log`)}；服务仍由 launchd 管理，可运行 local:stop 停止。`);
  }
  console.log("本地后台服务已就绪：http://localhost:5188/#/workspace");
  console.log(`关闭终端后继续运行，退出后自动恢复；日志：${logDirectory}`);
} else if (action === "stop") {
  for (const service of services) {
    const target = `${domain}/${labelOf(service.name)}`;
    if (launchctl("print", target).exitCode !== 0) continue;
    const result = launchctl("bootout", target);
    if (result.exitCode !== 0) throw new Error(`停止 ${service.name} 失败：${result.stderr.toString()}`);
  }
  console.log("本次登录的后台服务已停止；下次登录 macOS 时会再次启动。");
} else {
  for (const service of services) {
    const result = launchctl("print", `${domain}/${labelOf(service.name)}`);
    console.log(`${service.name}（${service.port}）：${result.exitCode === 0 ? "已托管" : "未托管"}`);
    if (result.exitCode === 0) console.log(result.stdout.toString().split("\n").filter(line => /^\s*(state|pid|last exit code|last terminating signal|runs) =/.test(line)).join("\n"));
  }
}
