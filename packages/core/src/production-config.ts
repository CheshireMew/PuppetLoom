import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { calibrationDocumentSchema, characterProductionConfigSchema, runtimeConstraintSettingsSchema } from "./schema.js";
import { parsePuppetLoomProject } from "./project-format.js";
import type { CharacterProductionConfig, PuppetLoomProject, RuntimeConstraintSettings } from "./types.js";

export interface ProductionConfigurationDocument {
  version: 1;
  production: CharacterProductionConfig;
  constraints: RuntimeConstraintSettings;
}

export interface ProductionConfigurationResult {
  project: string;
  revision: number;
  configRevision: number;
  variantGroups: number;
  props: number;
  presets: number;
  motionLimits: number;
  collisions: number;
}

async function nextConfigRevision(root: string): Promise<number> {
  const directory = join(root, "production", "config-history");
  let names: string[] = [];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return names.reduce((highest, name) => {
    const match = /^revision-(\d+)\.json$/.exec(name);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;
}

function parseDocument(value: unknown): ProductionConfigurationDocument {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("制作配置 version 必须是 1。");
  const raw = value as { production?: unknown; constraints?: unknown };
  return {
    version: 1,
    production: characterProductionConfigSchema.parse(raw.production),
    constraints: runtimeConstraintSettingsSchema.parse(raw.constraints ?? {})
  } as ProductionConfigurationDocument;
}

export async function inspectProductionConfiguration(projectDirectory: string): Promise<ProductionConfigurationDocument> {
  const project = parsePuppetLoomProject(JSON.parse(await readFile(join(resolve(projectDirectory), "puppetloom.json"), "utf8")));
  return {
    version: 1,
    production: project.production ?? { variants: [], props: [], presets: [] },
    constraints: project.runtime.constraints ?? { motionLimits: [], collisions: [] }
  };
}

/** Atomically installs a reviewed production configuration and keeps the first prior base document. */
export async function applyProductionConfiguration(projectDirectory: string, document: unknown): Promise<ProductionConfigurationResult> {
  const root = resolve(projectDirectory);
  const projectPath = join(root, "puppetloom.json");
  const before = parsePuppetLoomProject(JSON.parse(await readFile(projectPath, "utf8")));
  const config = parseDocument(document);
  const next: PuppetLoomProject = parsePuppetLoomProject({
    ...before,
    production: config.production,
    runtime: { ...before.runtime, constraints: config.constraints }
  });
  const configRevision = await nextConfigRevision(root);
  const historyDirectory = join(root, "production", "config-history");
  await mkdir(historyDirectory, { recursive: true });
  const historyPath = join(historyDirectory, `revision-${String(configRevision).padStart(4, "0")}.json`);
  try { await writeFile(join(root, "reports", "pre-production-config-puppetloom.json"), `${JSON.stringify(before, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); } catch { /* Keep the first prior document. */ }
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const historyTemporary = `${historyPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(historyTemporary, `${JSON.stringify({
    version: 1,
    revision: configRevision,
    appliedAt: new Date().toISOString(),
    beforeProjectSha256: createHash("sha256").update(`${JSON.stringify(before, null, 2)}\n`).digest("hex"),
    afterProjectSha256: createHash("sha256").update(text).digest("hex"),
    before: { production: before.production ?? { variants: [], props: [], presets: [] }, constraints: before.runtime.constraints ?? { motionLimits: [], collisions: [] } },
    after: config
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const temporary = `${projectPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, projectPath);
  const calibrationPath = join(root, "calibration", "current.json");
  let revision = 0;
  try {
    const calibration = calibrationDocumentSchema.parse(JSON.parse(await readFile(calibrationPath, "utf8")));
    revision = calibration.revision;
    const updated = { ...calibration, baseProjectSha256: createHash("sha256").update(text).digest("hex"), updatedAt: new Date().toISOString() };
    const calibrationTemporary = `${calibrationPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(calibrationTemporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await rename(calibrationTemporary, calibrationPath);
  } catch { /* Legacy projects may not have a calibration document yet. */ }
  await rename(historyTemporary, historyPath);
  return {
    project: root,
    revision,
    configRevision,
    variantGroups: config.production.variants.length,
    props: config.production.props.length,
    presets: config.production.presets.length,
    motionLimits: config.constraints.motionLimits.length,
    collisions: config.constraints.collisions.length
  };
}
