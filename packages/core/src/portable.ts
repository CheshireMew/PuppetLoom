import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PuppetLoomError } from "./errors.js";
import { loadCalibration, loadProject } from "./project.js";
import type { PortableExportManifest, PortableExportOptions, PortableExportResult } from "./types.js";
import { verifyProject } from "./verify.js";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Exports the effective revision as a new, ordinary project directory with calibration baked in. */
export async function exportPortableProject(options: PortableExportOptions): Promise<PortableExportResult> {
  const sourceDirectory = resolve(options.project);
  const outputDirectory = resolve(options.output);
  if (sourceDirectory === outputDirectory) throw new PuppetLoomError("INVALID_INPUT", "导出目录不能与源项目相同。" );
  if (await exists(outputDirectory)) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `导出目录必须尚未存在：${outputDirectory}`);
  const parent = dirname(outputDirectory);
  await mkdir(parent, { recursive: true });
  const staging = join(parent, `.${basename(outputDirectory)}.puppetloom-export-${randomUUID()}`);
  const [project, calibration] = await Promise.all([loadProject(sourceDirectory), loadCalibration(sourceDirectory)]);
  const assetPaths = [...new Set([
    project.source.psdPath,
    ...(project.source.referencePath ? [project.source.referencePath] : []),
    ...project.layers.map((layer) => layer.texture)
  ])];
  try {
    await mkdir(staging, { recursive: false });
    for (const asset of assetPaths) {
      const source = resolve(sourceDirectory, asset);
      const target = resolve(staging, asset);
      const relation = relative(staging, target);
      const sourceRelation = relative(sourceDirectory, source);
      if (relation.startsWith("..") || isAbsolute(relation) || sourceRelation.startsWith("..") || isAbsolute(sourceRelation)) throw new Error(`资源路径越过项目边界：${asset}`);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    const projectText = `${JSON.stringify(project, null, 2)}\n`;
    await writeFile(join(staging, "puppetloom.json"), projectText, "utf8");
    const baseProjectSha256 = createHash("sha256").update(projectText).digest("hex");
    await mkdir(join(staging, "calibration", "sessions"), { recursive: true });
    await writeJson(join(staging, "calibration", "current.json"), {
      version: 2,
      baseProjectSha256,
      revision: 0,
      updatedAt: new Date().toISOString(),
      label: `从 revision ${calibration.revision} 导出`,
      overrides: {}
    });
    const manifest: PortableExportManifest = {
      version: 1,
      project: project.name,
      sourceDirectory,
      sourceRevision: calibration.revision,
      exportedAt: new Date().toISOString(),
      files: ["puppetloom.json", "calibration/current.json", ...assetPaths].sort()
    };
    await writeJson(join(staging, "reports", "portable-export.json"), manifest);
    const verification = await verifyProject(staging);
    if (!verification.valid) throw new Error(`导出副本未通过验证：${verification.warnings.join("；")}`);
    await rename(staging, outputDirectory);
    return { outputDirectory, manifest, verification: { ...verification, project: project.name } };
  } catch (error) {
    throw new PuppetLoomError("IO_ERROR", `可移植导出失败；未发布副本保留在 ${staging}`, { cause: error });
  }
}
