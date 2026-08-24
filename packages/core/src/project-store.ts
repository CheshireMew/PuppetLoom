import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyCalibrationOverrides } from "./calibration.js";
import { PuppetLoomError } from "./errors.js";
import { parsePuppetLoomProject } from "./project-format.js";
import { applySafetyLimits } from "./safety.js";
import { calibrationDocumentSchema, calibrationDraftSchema, calibrationOverridesSchema } from "./schema.js";
import type { CalibrationDocument, CalibrationDraftDocument, CalibrationOverrides, PuppetLoomProject } from "./types.js";

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function readBaseProject(projectDirectory: string): Promise<{ project: PuppetLoomProject; hash: string }> {
  const path = join(resolve(projectDirectory), "puppetloom.json");
  try {
    await access(path);
    const text = await readFile(path, "utf8");
    const parsed = parsePuppetLoomProject(JSON.parse(text));
    return { project: parsed, hash: createHash("sha256").update(text).digest("hex") };
  } catch (error) {
    throw new PuppetLoomError("INVALID_PROJECT", `无法读取 PuppetLoom 项目：${projectDirectory}`, { cause: error });
  }
}

function emptyCalibration(baseProjectSha256: string): CalibrationDocument {
  return {
    version: 2,
    baseProjectSha256,
    revision: 0,
    updatedAt: new Date().toISOString(),
    overrides: {}
  };
}

function emptyCalibrationDraft(baseProjectSha256: string, baseRevision: number): CalibrationDraftDocument {
  return {
    version: 1,
    baseProjectSha256,
    baseRevision,
    updatedAt: new Date().toISOString(),
    overrides: {}
  };
}

export async function initializeCalibration(projectDirectory: string): Promise<CalibrationDocument> {
  const root = resolve(projectDirectory);
  const { hash } = await readBaseProject(root);
  const document = emptyCalibration(hash);
  await mkdir(join(root, "calibration", "sessions"), { recursive: true });
  await atomicJson(join(root, "calibration", "current.json"), document);
  return document;
}

export async function loadBaseProject(projectDirectory: string): Promise<PuppetLoomProject> {
  return (await readBaseProject(projectDirectory)).project;
}

export async function readCalibrationDocument(root: string, baseProjectSha256: string): Promise<CalibrationDocument> {
  const path = join(root, "calibration", "current.json");
  try {
    const document = calibrationDocumentSchema.parse(JSON.parse(await readFile(path, "utf8"))) as CalibrationDocument;
    if (document.baseProjectSha256 !== baseProjectSha256) {
      if (document.revision === 0 && Object.keys(document.overrides).length === 0) return emptyCalibration(baseProjectSha256);
      throw new Error("基础项目已改变，现有校准不能安全套用。" );
    }
    return document;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCalibration(baseProjectSha256);
    throw new PuppetLoomError("INVALID_PROJECT", `无法读取项目校准：${root}`, { cause: error });
  }
}

export async function readCalibrationDraftDocument(
  root: string,
  baseProjectSha256: string,
  calibration: CalibrationDocument
): Promise<CalibrationDraftDocument | undefined> {
  try {
    const draft = calibrationDraftSchema.parse(JSON.parse(await readFile(join(root, "calibration", "draft.json"), "utf8"))) as CalibrationDraftDocument;
    if (draft.baseProjectSha256 !== baseProjectSha256 || draft.baseRevision !== calibration.revision) return undefined;
    if (Object.keys(draft.overrides).length === 0 && !draft.label) return undefined;
    return draft;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PuppetLoomError("INVALID_PROJECT", `无法读取项目校准草稿：${root}`, { cause: error });
  }
}

export function applyStoredCalibration(base: PuppetLoomProject, calibration: CalibrationDocument, projectDirectory: string): PuppetLoomProject {
  try {
    return applySafetyLimits(applyCalibrationOverrides(base, calibration.overrides));
  } catch (error) {
    throw new PuppetLoomError("INVALID_PROJECT", `无法应用项目校准：${projectDirectory}`, { cause: error });
  }
}

export async function loadCalibration(projectDirectory: string): Promise<CalibrationDocument> {
  const root = resolve(projectDirectory);
  const { hash } = await readBaseProject(root);
  return readCalibrationDocument(root, hash);
}

export async function loadCalibrationDraft(projectDirectory: string): Promise<CalibrationDraftDocument | undefined> {
  const root = resolve(projectDirectory);
  const { hash } = await readBaseProject(root);
  const calibration = await readCalibrationDocument(root, hash);
  return readCalibrationDraftDocument(root, hash, calibration);
}

export async function saveCalibrationDraft(
  projectDirectory: string,
  baseRevision: number,
  rawOverrides: CalibrationOverrides,
  label?: string
): Promise<CalibrationDraftDocument> {
  const root = resolve(projectDirectory);
  const { hash } = await readBaseProject(root);
  const calibration = await readCalibrationDocument(root, hash);
  if (baseRevision !== calibration.revision) throw new PuppetLoomError("INVALID_PROJECT", "项目校准已更新，请重新打开编辑器后再继续。" );
  let overrides: CalibrationOverrides;
  try {
    overrides = calibrationOverridesSchema.parse(rawOverrides) as CalibrationOverrides;
  } catch (error) {
    throw new PuppetLoomError("INVALID_INPUT", "校准草稿格式无效。", { cause: error });
  }
  const draft: CalibrationDraftDocument = {
    version: 1,
    baseProjectSha256: hash,
    baseRevision,
    updatedAt: new Date().toISOString(),
    ...(label?.trim() ? { label: label.trim() } : {}),
    overrides
  };
  await mkdir(join(root, "calibration"), { recursive: true });
  await atomicJson(join(root, "calibration", "draft.json"), draft);
  return draft;
}

export async function clearCalibrationDraft(projectDirectory: string): Promise<void> {
  const root = resolve(projectDirectory);
  const { hash } = await readBaseProject(root);
  const calibration = await readCalibrationDocument(root, hash);
  await mkdir(join(root, "calibration"), { recursive: true });
  await atomicJson(join(root, "calibration", "draft.json"), emptyCalibrationDraft(hash, calibration.revision));
}

export async function loadProject(projectDirectory: string): Promise<PuppetLoomProject> {
  const root = resolve(projectDirectory);
  const { project: base, hash } = await readBaseProject(root);
  const calibration = await readCalibrationDocument(root, hash);
  return applyStoredCalibration(base, calibration, root);
}
