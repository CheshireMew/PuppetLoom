import { createHash } from "node:crypto";
import { access, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const installerArgument = process.argv[process.argv.indexOf("--installer") + 1];
if (!installerArgument || installerArgument === process.argv[0]) throw new Error("请使用 --installer <setup.exe>。");
const urlIndex = process.argv.indexOf("--url");
const publishedUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : undefined;
if (urlIndex >= 0 && (!publishedUrl || publishedUrl.startsWith("--"))) throw new Error("--url 之后需要提供安装器的发布地址。");
const versionIndex = process.argv.indexOf("--version");
const requestedVersion = versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined;
if (versionIndex >= 0 && (!requestedVersion || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(requestedVersion))) throw new Error("--version 之后需要提供有效的语义版本号。");
const installer = resolve(installerArgument); const directory = dirname(installer); const version = requestedVersion ?? basename(directory);
const target = resolve(directory, "update-manifest.json");
try { await access(target); await rename(target, resolve(directory, `update-manifest.previous-${Date.now()}.json`)); } catch (error) { if (error.code !== "ENOENT") throw error; }
const bytes = await readFile(installer); const info = await stat(installer);
const manifest = { version, url: publishedUrl ?? installer, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: info.size, publishedAt: new Date().toISOString(), releaseNotes: `PuppetLoom ${version} Windows 安装版` };
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ ok: true, target, manifest })}\n`);
