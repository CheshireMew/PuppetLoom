import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface EnvironmentDoctorCheck { id: string; label: string; status: "passed" | "warning" | "failed"; message: string; value?: string }
export interface EnvironmentDoctorReport { version: 1; generatedAt: string; platform: string; ready: boolean; checks: EnvironmentDoctorCheck[]; paths: { toolsRoot: string; runtimeAssets: string; userData: string; updates: string } }

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function sha256(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function command(file: string, args: string[]): Promise<string | undefined> { try { return (await execute(file, args, { windowsHide: true, timeout: 8_000 })).stdout.trim(); } catch { return undefined; } }

export async function inspectWindowsEnvironment(workspaceDirectory = process.cwd(), options: { packaged?: boolean; resourcesPath?: string } = {}): Promise<EnvironmentDoctorReport> {
  const toolsRoot = resolve(process.env.PUPPETLOOM_TOOLS_ROOT ?? "D:\\Tools\\PuppetLoom");
  const paths = { toolsRoot, runtimeAssets: join(toolsRoot, "runtime-assets", "mediapipe"), userData: join(toolsRoot, "user-data"), updates: join(toolsRoot, "updates") };
  const checks: EnvironmentDoctorCheck[] = [];
  checks.push({ id: "windows", label: "Windows 平台", status: process.platform === "win32" ? "passed" : "failed", message: process.platform === "win32" ? "当前平台受支持。" : "当前验收只支持 Windows。", value: `${process.platform} ${process.arch}` });
  const nodeMajor = Number(process.versions.node.split(".")[0]); checks.push({ id: "node", label: "Node.js 24+", status: nodeMajor >= 24 ? "passed" : "failed", message: nodeMajor >= 24 ? "Node.js 运行时满足要求。" : "需要 Node.js 24 或更高版本。", value: process.versions.node });
  try { await mkdir(paths.userData, { recursive: true }); const probe = join(paths.userData, ".environment-doctor-write-test"); await writeFile(probe, `checked ${new Date().toISOString()}\n`, "utf8"); checks.push({ id: "tools-write", label: "D 盘工具目录", status: "passed", message: "运行时资产、用户数据和更新目录可写。", value: toolsRoot }); }
  catch (error) { checks.push({ id: "tools-write", label: "D 盘工具目录", status: "failed", message: error instanceof Error ? error.message : String(error), value: toolsRoot }); }
  const models = [
    ["face_landmarker.task", 3_758_596, "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"],
    ["pose_landmarker_lite.task", 5_777_746, "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"],
    ["hand_landmarker.task", 7_819_105, "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"]
  ] as const;
  const modelRoot = options.packaged && options.resourcesPath
    ? join(resolve(options.resourcesPath), "app.asar", "dist", "runtime-assets", "mediapipe")
    : paths.runtimeAssets;
  for (const [name, bytes, hash] of models) {
    const path = join(modelRoot, name); const present = await exists(path); const valid = present && (await readFile(path)).byteLength === bytes && await sha256(path) === hash;
    checks.push({ id: `model-${name}`, label: name, status: valid ? "passed" : "failed", message: valid ? options.packaged ? "安装包内置模型文件完整。" : "模型文件完整。" : present ? "模型文件大小或哈希不正确，请重新构建安装版。" : options.packaged ? "安装包缺少内置模型文件。" : "模型文件缺失，请运行桌面构建。", value: path });
  }
  const ffmpeg = await command("where.exe", ["ffmpeg.exe"]); checks.push({ id: "ffmpeg", label: "FFmpeg", status: ffmpeg ? "passed" : "warning", message: ffmpeg ? "可用于动态证据和格式转换。" : "未在 PATH 找到 FFmpeg；桌面 WebM 录制仍可用，但部分离线导出不可用。", ...(ffmpeg ? { value: ffmpeg.split(/\r?\n/)[0] } : {}) });
  const gpu = await command("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"]); checks.push({ id: "gpu", label: "图形设备", status: gpu ? "passed" : "warning", message: gpu ? "已检测到图形设备；实际 WebGL 状态在应用启动时继续验证。" : "无法读取图形设备信息。", ...(gpu ? { value: gpu.replace(/\r?\n/g, " / ") } : {}) });
  const builderPackage = join(resolve(workspaceDirectory), "node_modules", "electron-builder", "package.json");
  const nsisCache = resolve(process.env.ELECTRON_BUILDER_CACHE ?? "D:\\Tools\\electron-builder-cache");
  const builderReady = options.packaged || await exists(builderPackage);
  checks.push({ id: "installer-builder", label: options.packaged ? "Windows 安装版" : "Windows 安装器构建工具", status: builderReady ? "passed" : "warning", message: options.packaged ? "当前正在运行已构建的 Windows 安装版。" : builderReady ? "Electron Builder 已就绪，NSIS 组件会缓存到 D 盘。" : "尚未安装 Electron Builder；只有生成安装器时才需要。", value: options.packaged ? resolve(process.execPath) : builderReady ? builderPackage : nsisCache });
  const spoutNative = options.packaged && options.resourcesPath
    ? join(resolve(options.resourcesPath), "app.asar.unpacked", "node_modules", "@napolab", "texture-bridge-win32-x64-msvc", "index.win32-x64-msvc.node")
    : join(resolve(workspaceDirectory), "node_modules", "@napolab", "texture-bridge-win32-x64-msvc", "index.win32-x64-msvc.node");
  checks.push({ id: "spout2-native", label: "Spout2 原生发送器", status: await exists(spoutNative) ? "passed" : "warning", message: await exists(spoutNative) ? "Windows D3D11 共享纹理发送器已就绪。" : "未找到预编译 Spout2 发送器；OBS 浏览器源仍可用。", value: spoutNative });
  const builds = options.packaged && options.resourcesPath
    ? [join(resolve(options.resourcesPath), "app.asar", "dist", "electron", "main.js"), join(resolve(options.resourcesPath), "app.asar", "dist", "runtime-assets", "web", "puppetloom-web.js")]
    : [join(resolve(workspaceDirectory), "apps", "desktop", "dist", "electron", "main.js"), join(resolve(workspaceDirectory), "packages", "web-runtime", "dist", "puppetloom-web.js")];
  for (const build of builds) checks.push({ id: `build-${build.endsWith("main.js") ? "desktop" : "web"}`, label: build.endsWith("main.js") ? "桌面构建" : "Web Runtime 构建", status: await exists(build) ? "passed" : "warning", message: await exists(build) ? "构建产物存在。" : "尚未构建；运行 npm run build 后生成。", value: build });
  return { version: 1, generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, ready: checks.every((check) => check.status !== "failed"), checks, paths };
}
