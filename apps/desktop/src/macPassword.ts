import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PATHS, Utils } from "electrobun/main";
import type { prepareShareWindow } from "@toonflow/server/app";

const execute = promisify(execFile);

async function passwordDialog(script: string, message: string) {
  try {
    const { stdout } = await execute("/usr/bin/osascript", ["-e", `on run argv
      set promptText to item 1 of argv
      ${script}
    end run`, message]);
    return stdout.replace(/\n$/, "");
  } catch (error) {
    if ((error as { stderr?: string }).stderr?.includes("(-128)")) return;
    throw error;
  }
}

export async function chooseMacPassword(message: string) {
  const enter = 'text returned of (display dialog promptText default answer "" with hidden answer buttons {"取消", "继续"} default button "继续" cancel button "取消" with title "MILI MILI")';
  let prompt = message;
  for (;;) {
    const password = await passwordDialog(enter, prompt);
    if (password === undefined) return;
    if (password.length < 12 || password.length > 256) { prompt = "请使用 12 至 256 个字符。"; continue; }
    const repeated = await passwordDialog(enter, "再次输入同一密码以确认保存。");
    if (repeated === undefined) return;
    if (password === repeated) return password;
    prompt = "两次输入不同，请重新设置密码。";
  }
}

let recovering = false;
export async function recoverMacPassword(save: (password: string) => Promise<void>) {
  if (recovering) return;
  recovering = true;
  try {
    try {
      await execute(resolve(PATHS.VIEWS_FOLDER, "../desktopTools/verifyMacOwner"));
    } catch (error) {
      if ((error as { code?: number }).code === 1) return;
      throw new Error("这台 Mac 暂时无法验证身份。请检查 macOS 的登录密码或 Touch ID 设置。");
    }
    const password = await chooseMacPassword("为这个工作台设置新的本机密码。请输入 12 至 256 个字符。");
    if (password === undefined) return;
    await save(password);
    return password;
  } finally {
    recovering = false;
  }
}

export async function openShareSession(access: ReturnType<typeof prepareShareWindow>, save: (password: string) => Promise<void>) {
  if (!access.passwordRequired) return access.open();
  let message = "输入你为这个工作台设置的打开密码。";
  for (;;) {
    const entry = await passwordDialog(`set entry to display dialog promptText default answer "" with hidden answer buttons {"退出", "忘记密码", "打开"} default button "打开" cancel button "退出" with title "MILI MILI"
      if button returned of entry is "忘记密码" then return "reset"
      return "open" & (text returned of entry)`, message);
    if (entry === undefined) return;
    const password = entry === "reset" ? await recoverMacPassword(save) : entry.slice(4);
    if (password === undefined) continue;
    try {
      return await access.open(password);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 429) message = "尝试次数过多。可以选择「忘记密码」验证 Mac 身份后重设，或稍后再试。";
      else if (status === 401) message = "本机工作台密码错误。请重新输入，或选择「忘记密码」。";
      else throw error;
    }
  }
}

export async function recoverFromMacMenu(save: (password: string) => Promise<void>) {
  try {
    if (await recoverMacPassword(save) !== undefined) await Utils.showMessageBox({ type: "info", title: "已重设本机密码", message: "现在可以使用新密码登录原来的工作台。" });
  } catch (error) {
    await Utils.showMessageBox({ type: "error", title: "无法重设本机密码", message: error instanceof Error ? error.message : "请稍后重试。" });
  }
}
