import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { chmod, constants, copyFile, createReadStream, mkdir, readdir, readFile, realpath, rename, rm, stat, statfs, writeAtomic } from "@toonflow/file";

type BackupManifest = { version: 1; createdAt: string; database: string; files: Record<string, string> };
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

async function filesOf(root: string, database: string) {
  const files: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isSymbolicLink()) throw new Error(`备份不跟随符号链接：${name}`);
      if (entry.isDirectory()) { if (name !== "logs") await walk(path); }
      else if (![database, database + "-wal", database + "-shm"].includes(name)) files[name] = await hashFile(path);
    }
  }
  await walk(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

/** 数据库快照与文件前后校验共同保证一致性；期间发生写入则放弃该次备份，保留上一份。 */
export async function createDataBackup(dataRoot: string, backupRoot: string, database = "cloud/milimili.db") {
  const root = await realpath(dataRoot);
  await mkdir(resolve(backupRoot), { recursive: true, mode: 0o700 });
  const backups = await realpath(backupRoot);
  if (inside(root, backups) || inside(backups, root)) throw new Error("备份目录必须与数据目录分离");
  const databasePath = resolve(root, database);
  if (!inside(root, databasePath) || databasePath === root) throw new Error("数据库必须在数据目录内");
  await mkdir(backups, { recursive: true, mode: 0o700 });
  await chmod(backups, 0o700);
  const destination = join(backups, "backup" + Date.now() + crypto.randomUUID().replaceAll("-", ""));
  const pending = destination + ".pending";
  await mkdir(pending, { mode: 0o700 });
  let db: Database | undefined;
  try {
    db = new Database(databasePath, { readonly: true });
    const revision = JSON.stringify(db.query("PRAGMA data_version").get());
    const files = await filesOf(root, database);
    let bytes = (await stat(databasePath)).size;
    for (const name of Object.keys(files)) bytes += (await stat(join(root, name))).size;
    const disk = await statfs(backups);
    if (disk.bavail * disk.bsize < bytes + 2 * 1024 ** 3) throw new Error("备份空间不足，须为完整副本和至少 2 GiB 余量预留空间");
    const snapshot = join(pending, "data", database);
    await mkdir(dirname(snapshot), { recursive: true, mode: 0o700 });
    db.query("VACUUM INTO ?").run(snapshot);
    for (const [name, hash] of Object.entries(files)) {
      const target = join(pending, "data", name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(root, name), target, constants.COPYFILE_FICLONE);
      await chmod(target, 0o600);
      if (await hashFile(target) !== hash) throw new Error("备份期间文件发生变化，请稍后重试");
    }
    if (revision !== JSON.stringify(db.query("PRAGMA data_version").get()) || JSON.stringify(files) !== JSON.stringify(await filesOf(root, database))) throw new Error("备份期间数据发生变化，请稍后重试");
    files[database] = await hashFile(snapshot);
    const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), database, files };
    await writeAtomic(join(pending, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    await verifyDataBackup(pending);
    await rename(pending, destination);
    return destination;
  } catch (error) { await rm(pending, { recursive: true, force: true }); throw error; }
  finally { db?.close(); }
}

export async function verifyDataBackup(directory: string) {
  const manifest: BackupManifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || !manifest.files || typeof manifest.database !== "string" || !manifest.files[manifest.database]) throw new Error("备份清单无效");
  const root = resolve(directory, "data");
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (isAbsolute(name) || !inside(root, resolve(root, name)) || name === "") throw new Error("备份清单路径无效");
    if (await hashFile(join(root, name)) !== hash) throw new Error(`备份文件校验失败：${name}`);
  }
  const db = new Database(join(root, manifest.database), { readonly: true });
  try { if (JSON.stringify(db.query("PRAGMA integrity_check").values()) !== '[["ok"]]') throw new Error("备份数据库完整性检查失败"); }
  finally { db.close(); }
  return manifest;
}

/** 仅恢复到不存在的新目录，不覆盖在线账号、项目或密钥。 */
export async function restoreDataBackup(backup: string, destination: string) {
  const manifest = await verifyDataBackup(backup);
  const root = resolve(destination);
  await mkdir(root, { mode: 0o700 });
  try {
    for (const [name, hash] of Object.entries(manifest.files)) {
      const target = join(root, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(backup, "data", name), target, constants.COPYFILE_FICLONE);
      await chmod(target, 0o600);
      if (await hashFile(target) !== hash) throw new Error("恢复文件校验失败");
    }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return root;
}

export function startDataBackups(dataRoot: string) {
  const backupRoot = process.env.MILIMILI_BACKUP_DIR || join(dirname(dataRoot), "dataBackups");
  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const dbPath = process.env.MILIMILI_DB || join(process.env.MILIMILI_DATA_DIR || join(dataRoot, "cloud"), "milimili.db");
      const destination = await createDataBackup(dataRoot, backupRoot, relative(dataRoot, dbPath));
      await writeAtomic(join(backupRoot, "status.json"), JSON.stringify({ ok: true, completedAt: new Date().toISOString(), backup: basename(destination) }), { mode: 0o600 });
      // ACT: 默认保留最近三份本机验证通过的备份；异地副本仍需运维配置。
      const previous = (await readdir(backupRoot)).filter(name => /^backup\d+[a-f0-9]+$/.test(name)).sort().reverse();
      for (const name of previous.slice(3)) {
        await verifyDataBackup(join(backupRoot, name));
        await rm(join(backupRoot, name), { recursive: true });
      }
    } catch (error) {
      console.error("数据备份失败：", error instanceof Error ? error.message : String(error));
      await mkdir(backupRoot, { recursive: true, mode: 0o700 })
        .then(() => writeAtomic(join(backupRoot, "status.json"), JSON.stringify({ ok: false, failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }), { mode: 0o600 }))
        .catch(cause => console.error("备份状态保存失败", cause));
    } finally { running = false; }
  }, 24 * 3600_000);
  interval.unref();
  return () => clearInterval(interval);
}
