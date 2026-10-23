import { resolve } from "node:path";
import { createDataBackup, restoreDataBackup, verifyDataBackup } from "../src/utils/dataBackup";

const [action, source, target, database] = process.argv.slice(2);
if (!source || !["create", "verify", "restore"].includes(action) || action !== "verify" && !target) throw new Error("用法：bun apps/server/scripts/dataBackup.ts create <数据目录> <备份目录> [数据库相对路径] | verify <备份> | restore <备份> <新目录>");
const result = action === "create" ? await createDataBackup(resolve(source), resolve(target), database)
  : action === "restore" ? await restoreDataBackup(resolve(source), resolve(target)) : await verifyDataBackup(resolve(source)).then(value => ({ valid: true, files: Object.keys(value.files).length, createdAt: value.createdAt }));
console.log(JSON.stringify(result));
