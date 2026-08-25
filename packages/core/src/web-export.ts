import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { PuppetLoomError } from "./errors.js";
import { loadCalibration, loadProject } from "./project.js";

export interface WebRuntimeExportOptions { project: string; output: string; sdkBundle: string }
export interface WebRuntimeExportResult { outputDirectory: string; project: string; revision: number; files: string[]; sha256: Record<string, string> }

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function page(projectName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${projectName.replace(/[<>&]/g, "")}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}puppetloom-player{display:block;width:100%;height:100%}</style></head><body><puppetloom-player src="./project/puppetloom.json"></puppetloom-player><script type="module" src="./puppetloom-web.js"></script></body></html>`;
}

/** Exports a browser/OBS-ready character without the source PSD or calibration history. */
export async function exportWebRuntime(options: WebRuntimeExportOptions): Promise<WebRuntimeExportResult> {
  const root = resolve(options.project); const output = resolve(options.output); const sdk = resolve(options.sdkBundle);
  if (await exists(output)) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `Web Runtime 导出目录必须尚未存在：${output}`);
  if (!await exists(sdk)) throw new PuppetLoomError("IO_ERROR", `Web Runtime SDK 尚未构建：${sdk}`);
  const staging = join(dirname(output), `.${basename(output)}.web-export-${randomUUID()}`);
  const [project, calibration] = await Promise.all([loadProject(root), loadCalibration(root)]);
  const files: string[] = ["index.html", "puppetloom-web.js", "project/puppetloom.json"];
  try {
    await mkdir(join(staging, "project"), { recursive: true });
    const webProject = { ...project, source: { ...project.source, psdPath: "source-not-in-web-export.psd" } };
    await writeFile(join(staging, "project", "puppetloom.json"), `${JSON.stringify(webProject, null, 2)}\n`, "utf8");
    for (const texture of [...new Set(project.layers.map((layer) => layer.texture))]) {
      const source = resolve(root, texture); const target = resolve(staging, "project", texture); const relation = relative(join(staging, "project"), target);
      if (relation.startsWith("..")) throw new Error(`纹理路径越过项目目录：${texture}`);
      await mkdir(dirname(target), { recursive: true }); await copyFile(source, target); files.push(`project/${texture.replace(/\\/g, "/")}`);
    }
    await copyFile(sdk, join(staging, "puppetloom-web.js"));
    await writeFile(join(staging, "index.html"), page(project.name), "utf8");
    await writeFile(join(staging, "README.md"), `# ${project.name} Web Runtime\n\n用任意静态 HTTP 服务器打开本目录，不要直接双击 index.html。OBS 中添加浏览器源并指向该 HTTP 地址；页面背景为透明。\n\n嵌入：\n\n\`\`\`html\n<puppetloom-player src="./project/puppetloom.json"></puppetloom-player>\n<script type="module" src="./puppetloom-web.js"></script>\n\`\`\`\n`, "utf8"); files.push("README.md");
    const sha256: Record<string, string> = {};
    for (const file of files) sha256[file] = createHash("sha256").update(await readFile(join(staging, file))).digest("hex");
    await writeFile(join(staging, "web-runtime-manifest.json"), `${JSON.stringify({ version: 1, project: project.name, revision: calibration.revision, exportedAt: new Date().toISOString(), files, sha256 }, null, 2)}\n`, "utf8"); files.push("web-runtime-manifest.json");
    await rename(staging, output);
    return { outputDirectory: output, project: project.name, revision: calibration.revision, files, sha256 };
  } catch (cause) {
    throw new PuppetLoomError("IO_ERROR", `Web Runtime 导出失败；未发布内容保留在 ${staging}`, { cause });
  }
}
