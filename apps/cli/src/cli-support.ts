import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CubismEditorClient,
  PuppetLoomError,
  type RuntimeControlManifest,
  type RuntimeControlResponse,
  type RuntimeControlServiceRequest
} from "@puppetloom/core";
import { CommanderError } from "commander";

export type OutputOptions = { json?: boolean };

export const defaultCubismTokenFile = join(process.env.LOCALAPPDATA ?? process.cwd(), "PuppetLoom", "cubism-editor-token.txt");
const defaultRuntimeManifest = process.env.PUPPETLOOM_CONTROL_MANIFEST ?? join("D:\\Tools", "PuppetLoom", "user-data", "runtime-control.json");

export function print(value: unknown, options: OutputOptions = {}): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function exitCode(error: unknown): number {
  if (error instanceof PuppetLoomError && error.code === "INVALID_INPUT") return 2;
  if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return 0;
  if (error instanceof CommanderError) return 2;
  return 3;
}

export async function launchDesktop(arguments_: string[]): Promise<void> {
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const desktopMain = resolve(cliDirectory, "../../desktop/dist/electron/main.js");
  if (!existsSync(desktopMain)) throw new PuppetLoomError("IO_ERROR", "桌面应用尚未构建，请先运行 npm run build。" );
  const electronModule = await import("electron");
  const electronBinary = String(electronModule.default);
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(electronBinary, [desktopMain, ...arguments_], { stdio: "inherit", windowsHide: false });
    child.once("error", rejectChild);
    child.once("exit", (code) => {
      if (code === 0) resolveChild();
      else rejectChild(new PuppetLoomError("IO_ERROR", `桌面应用退出，代码 ${code ?? "unknown"}。`));
    });
  });
}

export async function readOptionalText(path: string): Promise<string> {
  try { return (await readFile(path, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new PuppetLoomError("IO_ERROR", `无法读取文件：${path}`, { cause: error });
  }
}

export function finiteOption(value: string | undefined, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须是 ${minimum} 到 ${maximum} 之间的数字。`);
  return number;
}

export function positiveInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须是正整数。`);
  return number;
}

export function assignment(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function assignments(values: string[] | undefined, label: string): Record<string, number> | undefined {
  if (!values?.length) return undefined;
  const result: Record<string, number> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const id = separator > 0 ? value.slice(0, separator).trim() : "";
    const number = separator > 0 ? Number(value.slice(separator + 1)) : Number.NaN;
    if (!id || !Number.isFinite(number)) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须使用 id=数值 格式：${value}`);
    result[id] = number;
  }
  return result;
}

export async function runtimeControlUrl(explicit?: string): Promise<string> {
  const direct = explicit ?? process.env.PUPPETLOOM_CONTROL_URL;
  if (direct) return direct.replace(/\/$/, "");
  let manifest: RuntimeControlManifest;
  try {
    manifest = JSON.parse(await readFile(defaultRuntimeManifest, "utf8")) as RuntimeControlManifest;
  } catch (cause) {
    throw new PuppetLoomError("IO_ERROR", `找不到运行时控制清单：${defaultRuntimeManifest}。请先打开 PuppetLoom，或用 --url 指定服务地址。`, { cause });
  }
  if (manifest.version !== 1 || manifest.status !== "running" || !manifest.url) throw new PuppetLoomError("IO_ERROR", "PuppetLoom 运行时控制服务当前没有运行。" );
  return manifest.url.replace(/\/$/, "");
}

export async function sendRuntimeControl(request: RuntimeControlServiceRequest, explicitUrl?: string): Promise<unknown> {
  const url = await runtimeControlUrl(explicitUrl);
  let response: Response;
  try {
    response = await fetch(`${url}/v1/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5000)
    });
  } catch (cause) {
    throw new PuppetLoomError("IO_ERROR", `无法连接 PuppetLoom 运行时控制服务：${url}`, { cause });
  }
  const body = await response.json() as RuntimeControlResponse;
  if (!response.ok || !body.ok) throw new PuppetLoomError("INVALID_INPUT", body.error ?? `运行时控制请求失败：HTTP ${response.status}`);
  return body.result;
}

export async function connectCubism(url: string, tokenFile: string): Promise<CubismEditorClient> {
  const client = new CubismEditorClient(url);
  const tokenPath = resolve(tokenFile);
  const token = await client.register(await readOptionalText(tokenPath));
  if (token) {
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, token, "utf8");
  }
  return client;
}

export function cubismViewerPath(explicit?: string): string {
  const candidates = [
    explicit ? resolve(explicit) : undefined,
    process.env.CUBISM_VIEWER_PATH,
    "D:\\Software\\Work\\Live2D Cubism 5.3\\CubismViewer5.exe",
    "C:\\Program Files\\Live2D Cubism 5.3\\CubismViewer5.exe"
  ].filter((value): value is string => Boolean(value));
  const viewer = candidates.find(existsSync);
  if (!viewer) throw new PuppetLoomError("INVALID_INPUT", "找不到 Cubism Viewer。请用 --viewer 指定 CubismViewer5.exe，或设置 CUBISM_VIEWER_PATH。" );
  return viewer;
}

export async function openCubismViewer(model: string, viewer?: string): Promise<void> {
  const executable = cubismViewerPath(viewer);
  const modelPath = resolve(model);
  if (!existsSync(modelPath)) throw new PuppetLoomError("INVALID_INPUT", `找不到 Cubism 模型：${modelPath}`);
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    const child = spawn(executable, [modelPath], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", rejectLaunch);
    child.once("spawn", () => { child.unref(); resolveLaunch(); });
  });
}

export async function runWorkspaceTool(scriptName: string, arguments_: string[]): Promise<unknown> {
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(cliDirectory, "../../../scripts", scriptName);
  if (!existsSync(scriptPath)) throw new PuppetLoomError("IO_ERROR", `找不到工作区工具：${scriptName}`);
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [scriptPath, ...arguments_], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectChild);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectChild(new PuppetLoomError("IO_ERROR", stderr.trim() || `${scriptName} 退出，代码 ${code ?? "unknown"}。`));
        return;
      }
      try {
        resolveChild(JSON.parse(stdout));
      } catch (error) {
        rejectChild(new PuppetLoomError("IO_ERROR", `${scriptName} 没有返回有效 JSON。`, { cause: error }));
      }
    });
  });
}

export async function runPhotoshopRepairTool(recipe: string, output: string, showPhotoshop: boolean): Promise<unknown> {
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(cliDirectory, "../../../scripts/photoshop-psd-repair.jsx");
  const wrapperPath = resolve(cliDirectory, "../../../scripts/run-photoshop-psd-repair.ps1");
  if (!existsSync(scriptPath) || !existsSync(wrapperPath)) throw new PuppetLoomError("IO_ERROR", "找不到 Photoshop PSD 修复脚本。" );
  return new Promise((resolveChild, rejectChild) => {
    const arguments_ = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapperPath, "-Recipe", recipe, "-Output", output, "-Script", scriptPath, ...(showPhotoshop ? ["-ShowPhotoshop"] : [])];
    const child = spawn("powershell.exe", arguments_, { stdio: ["ignore", "pipe", "pipe"], windowsHide: !showPhotoshop });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectChild);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectChild(new PuppetLoomError("IO_ERROR", stderr.trim() || stdout.trim() || `Photoshop 自动化退出，代码 ${code ?? "unknown"}。`));
        return;
      }
      try { resolveChild(JSON.parse(stdout)); }
      catch (cause) { rejectChild(new PuppetLoomError("IO_ERROR", `Photoshop 自动化没有返回有效 JSON：${stdout.trim()}`, { cause })); }
    });
  });
}

export async function run(action: () => Promise<void>, options: OutputOptions = {}): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) process.stderr.write(`${JSON.stringify({ ok: false, error: message, exitCode: exitCode(error) })}\n`);
    else process.stderr.write(`PuppetLoom：${message}\n`);
    process.exitCode = exitCode(error);
  }
}
