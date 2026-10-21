import { mkdir, realpath } from "@toonflow/file";
import { join } from "node:path";
import { privateDataDirectory } from "@/utils/tenant";

export async function getAssetsDirectory() {
  const directory = join(privateDataDirectory(), "assets");
  await mkdir(directory, { recursive: true });
  return realpath(directory);
}
