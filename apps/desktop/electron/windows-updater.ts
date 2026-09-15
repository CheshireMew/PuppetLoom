import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { app } from "electron";

export interface WindowsUpdateManifest { version: string; url: string; sha256: string; bytes?: number; publishedAt: string; releaseNotes?: string }
export interface WindowsUpdateStatus { configured: boolean; currentVersion: string; available: boolean; manifest?: WindowsUpdateManifest; installer?: string; message: string }
const updatesRoot = resolve(process.env.PUPPETLOOM_UPDATES_ROOT ?? "D:\\Tools\\PuppetLoom\\updates");
function newer(candidate: string, current: string): boolean { const parts = (value: string) => value.split(".").map((part) => Number(part.replace(/\D.*$/, "")) || 0); const a = parts(candidate); const b = parts(current); for (let i = 0; i < Math.max(a.length, b.length); i += 1) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); } return false; }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function hash(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function manifestLocation(): Promise<string | undefined> {
  if (process.env.PUPPETLOOM_UPDATE_MANIFEST) return process.env.PUPPETLOOM_UPDATE_MANIFEST;
  const channel = join("D:\\Tools", "PuppetLoom", "user-data", "update-channel.json");
  if (!await exists(channel)) return undefined;
  const value = JSON.parse(await readFile(channel, "utf8")) as { manifest?: string }; return value.manifest;
}
async function readManifest(location: string): Promise<WindowsUpdateManifest> {
  const value = /^https?:\/\//i.test(location) ? await (async () => { const response = await fetch(location, { signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`업데이트 매니페스트 HTTP ${response.status}`); return response.json(); })() : JSON.parse(await readFile(resolve(location), "utf8"));
  const manifest = value as WindowsUpdateManifest;
  if (!/^\d+\.\d+\.\d+/.test(manifest.version) || !manifest.url || !/^[a-f0-9]{64}$/.test(manifest.sha256) || Number.isNaN(Date.parse(manifest.publishedAt))) throw new Error("업데이트 매니페스트에 유효한 version, url, sha256 또는 publishedAt이 없습니다.");
  return manifest;
}
function updateFileName(url: string): string { return basename(/^https?:\/\//i.test(url) ? new URL(url).pathname : resolve(url)) || "PuppetLoom-Setup.exe"; }
export async function checkWindowsUpdate(): Promise<WindowsUpdateStatus> {
  const currentVersion = app.getVersion(); const location = await manifestLocation();
  if (!location) return { configured: false, currentVersion, available: false, message: "업데이트 채널이 아직 설정되지 않았습니다." };
  const manifest = await readManifest(location); const installer = join(updatesRoot, manifest.version, updateFileName(manifest.url));
  const downloaded = await exists(installer) && await hash(installer) === manifest.sha256;
  return { configured: true, currentVersion, available: newer(manifest.version, currentVersion), manifest, ...(downloaded ? { installer } : {}), message: newer(manifest.version, currentVersion) ? downloaded ? "업데이트가 다운로드되어 설치할 수 있습니다." : "새 버전이 있습니다." : "이미 최신 버전입니다." };
}
export async function downloadWindowsUpdate(): Promise<WindowsUpdateStatus> {
  const status = await checkWindowsUpdate(); if (!status.available || !status.manifest) return status; if (status.installer) return status;
  const directory = join(updatesRoot, status.manifest.version); await mkdir(directory, { recursive: true });
  const installer = join(directory, updateFileName(status.manifest.url));
  if (await exists(installer)) await rename(installer, `${installer}.invalid-${Date.now()}`);
  const bytes = /^https?:\/\//i.test(status.manifest.url)
    ? await (async () => { const response = await fetch(status.manifest!.url, { signal: AbortSignal.timeout(120_000) }); if (!response.ok) throw new Error(`업데이트 다운로드 HTTP ${response.status}`); return new Uint8Array(await response.arrayBuffer()); })()
    : new Uint8Array(await readFile(resolve(status.manifest.url)));
  if (status.manifest.bytes !== undefined && bytes.byteLength !== status.manifest.bytes) throw new Error("업데이트 파일 크기가 매니페스트와 일치하지 않습니다.");
  if (createHash("sha256").update(bytes).digest("hex") !== status.manifest.sha256) throw new Error("업데이트 파일 해시가 매니페스트와 일치하지 않습니다.");
  const temporary = `${installer}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, installer);
  return { ...status, installer, message: "업데이트가 다운로드되어 설치할 수 있습니다." };
}
export function installWindowsUpdate(installer: string): void {
  const path = resolve(installer); const relation = relative(updatesRoot, path); if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("설치 파일이 PuppetLoom 업데이트 디렉터리 밖에 있습니다.");
  const child = spawn(path, ["/SILENT", "/CLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS"], { detached: true, stdio: "ignore", windowsHide: true }); child.unref(); app.quit();
}
