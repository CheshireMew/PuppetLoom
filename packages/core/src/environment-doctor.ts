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
  checks.push({ id: "windows", label: "Windows 플랫폼", status: process.platform === "win32" ? "passed" : "failed", message: process.platform === "win32" ? "현재 플랫폼이 지원됩니다." : "현재 검수는 Windows만 지원합니다.", value: `${process.platform} ${process.arch}` });
  const nodeMajor = Number(process.versions.node.split(".")[0]); checks.push({ id: "node", label: "Node.js 24+", status: nodeMajor >= 24 ? "passed" : "failed", message: nodeMajor >= 24 ? "Node.js 런타임이 요구 사항을 충족합니다." : "Node.js 24 이상이 필요합니다.", value: process.versions.node });
  try { await mkdir(paths.userData, { recursive: true }); const probe = join(paths.userData, ".environment-doctor-write-test"); await writeFile(probe, `checked ${new Date().toISOString()}\n`, "utf8"); checks.push({ id: "tools-write", label: "D 드라이브 도구 디렉터리", status: "passed", message: "런타임 자산, 사용자 데이터, 업데이트 디렉터리에 쓸 수 있습니다.", value: toolsRoot }); }
  catch (error) { checks.push({ id: "tools-write", label: "D 드라이브 도구 디렉터리", status: "failed", message: error instanceof Error ? error.message : String(error), value: toolsRoot }); }
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
    checks.push({ id: `model-${name}`, label: name, status: valid ? "passed" : "failed", message: valid ? options.packaged ? "설치 패키지에 내장된 모델 파일이 완전합니다." : "모델 파일이 완전합니다." : present ? "모델 파일 크기 또는 해시가 올바르지 않습니다. 설치 버전을 다시 빌드해 주세요." : options.packaged ? "설치 패키지에 내장 모델 파일이 없습니다." : "모델 파일이 없습니다. 데스크톱 빌드를 실행해 주세요.", value: path });
  }
  const ffmpeg = await command("where.exe", ["ffmpeg.exe"]); checks.push({ id: "ffmpeg", label: "FFmpeg", status: ffmpeg ? "passed" : "warning", message: ffmpeg ? "동적 증거와 형식 변환에 사용할 수 있습니다." : "PATH에서 FFmpeg를 찾지 못했습니다. 데스크톱 WebM 녹화는 계속 사용할 수 있지만 일부 오프라인 내보내기는 사용할 수 없습니다.", ...(ffmpeg ? { value: ffmpeg.split(/\r?\n/)[0] } : {}) });
  const gpu = await command("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"]); checks.push({ id: "gpu", label: "그래픽 장치", status: gpu ? "passed" : "warning", message: gpu ? "그래픽 장치를 감지했습니다. 실제 WebGL 상태는 앱 시작 시 계속 확인합니다." : "그래픽 장치 정보를 읽을 수 없습니다.", ...(gpu ? { value: gpu.replace(/\r?\n/g, " / ") } : {}) });
  const builderPackage = join(resolve(workspaceDirectory), "node_modules", "electron-builder", "package.json");
  const nsisCache = resolve(process.env.ELECTRON_BUILDER_CACHE ?? "D:\\Tools\\electron-builder-cache");
  const builderReady = options.packaged || await exists(builderPackage);
  checks.push({ id: "installer-builder", label: options.packaged ? "Windows 설치 버전" : "Windows 설치 프로그램 빌드 도구", status: builderReady ? "passed" : "warning", message: options.packaged ? "빌드된 Windows 설치 버전을 실행 중입니다." : builderReady ? "Electron Builder가 준비되었습니다. NSIS 구성 요소는 D 드라이브에 캐시됩니다." : "Electron Builder가 아직 설치되지 않았습니다. 설치 프로그램을 만들 때만 필요합니다.", value: options.packaged ? resolve(process.execPath) : builderReady ? builderPackage : nsisCache });
  const spoutNative = options.packaged && options.resourcesPath
    ? join(resolve(options.resourcesPath), "app.asar.unpacked", "node_modules", "@napolab", "texture-bridge-win32-x64-msvc", "index.win32-x64-msvc.node")
    : join(resolve(workspaceDirectory), "node_modules", "@napolab", "texture-bridge-win32-x64-msvc", "index.win32-x64-msvc.node");
  checks.push({ id: "spout2-native", label: "Spout2 네이티브 센더", status: await exists(spoutNative) ? "passed" : "warning", message: await exists(spoutNative) ? "Windows D3D11 공유 텍스처 센더가 준비되었습니다." : "미리 컴파일된 Spout2 센더를 찾지 못했습니다. OBS 브라우저 소스는 계속 사용할 수 있습니다.", value: spoutNative });
  const builds = options.packaged && options.resourcesPath
    ? [join(resolve(options.resourcesPath), "app.asar", "dist", "electron", "main.js"), join(resolve(options.resourcesPath), "app.asar", "dist", "runtime-assets", "web", "puppetloom-web.js")]
    : [join(resolve(workspaceDirectory), "apps", "desktop", "dist", "electron", "main.js"), join(resolve(workspaceDirectory), "packages", "web-runtime", "dist", "puppetloom-web.js")];
  for (const build of builds) checks.push({ id: `build-${build.endsWith("main.js") ? "desktop" : "web"}`, label: build.endsWith("main.js") ? "데스크톱 빌드" : "Web Runtime 빌드", status: await exists(build) ? "passed" : "warning", message: await exists(build) ? "빌드 결과물이 있습니다." : "아직 빌드되지 않았습니다. npm run build를 실행하면 생성됩니다.", value: build });
  return { version: 1, generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, ready: checks.every((check) => check.status !== "failed"), checks, paths };
}
