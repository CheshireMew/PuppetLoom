import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { applyAuthoringOperations, authoringLayerOverrides, buildAuthoringAudit } from "./authoring.js";
import { applyCalibrationOverrides, clearCalibrationOverrides, mergeCalibrationOverrides } from "./calibration.js";
import { PuppetLoomError } from "./errors.js";
import {
  applyStoredCalibration,
  loadBaseProject,
  loadCalibration,
  loadProject,
  readBaseProject,
  readCalibrationDocument,
  readCalibrationDraftDocument
} from "./project-store.js";
import { applySafetyLimits } from "./safety.js";
import { authoringPatchSchema, calibrationOperationSchema, calibrationPatchSchema, calibrationSessionSchema } from "./schema.js";
import type {
  AuthoringPatch,
  CalibrationDocument,
  CalibrationDraftDocument,
  CalibrationOperationDocument,
  CalibrationOverrides,
  CalibrationPatch,
  CalibrationSaveResult,
  CalibrationSessionDocument,
  CalibrationSessionSummary,
  MeshBinding,
  PuppetLoomProject,
  RigLevel
} from "./types.js";

function projectFingerprint(project: PuppetLoomProject): string {
  return createHash("sha256").update(JSON.stringify(project)).digest("hex");
}

function meshLayoutFingerprint(mesh: MeshBinding): string {
  return JSON.stringify({
    topology: mesh.topology,
    rows: mesh.rows,
    cols: mesh.cols,
    art: mesh.art,
    pointCount: mesh.points.length,
    uvs: mesh.uvs,
    triangles: mesh.triangles
  });
}

function rebuiltMeshLayerIds(before: PuppetLoomProject, after: PuppetLoomProject): string[] {
  const beforeLayers = new Map(before.layers.map((layer) => [layer.id, layer]));
  return after.layers
    .filter((layer) => {
      const previous = beforeLayers.get(layer.id);
      return previous !== undefined && meshLayoutFingerprint(previous.mesh) !== meshLayoutFingerprint(layer.mesh);
    })
    .map((layer) => layer.id);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

interface CalibrationLock {
  operationId: string;
  processId: number;
  createdAt: string;
  state: "held" | "released";
}

interface HeldCalibrationLock extends CalibrationLock {
  path: string;
  handle: FileHandle;
}

const activeCalibrationLocks = new Set<string>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function archiveCalibrationLock(root: string, path: string, suffix: "released" | "stale"): Promise<void> {
  const archive = join(root, "calibration", "locks");
  await mkdir(archive, { recursive: true });
  await rename(path, join(archive, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.${suffix}.json`));
}

async function acquireCalibrationLock(root: string, operationId: string): Promise<HeldCalibrationLock> {
  const path = join(root, "calibration", "write.lock");
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 60_000;
  let malformedSince: number | undefined;
  while (Date.now() < deadline) {
    try {
      const handle = await open(path, "wx");
      const lock: CalibrationLock = { operationId, processId: process.pid, createdAt: new Date().toISOString(), state: "held" };
      activeCalibrationLocks.add(operationId);
      try {
        await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        activeCalibrationLocks.delete(operationId);
        await handle.close().catch(() => undefined);
        throw error;
      }
      return { ...lock, path, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new PuppetLoomError("IO_ERROR", "无法取得校准写入锁。", { cause: error });
      }
      try {
        const existing = JSON.parse(await readFile(path, "utf8")) as Partial<CalibrationLock>;
        malformedSince = undefined;
        const ownedHere = existing.processId === process.pid && typeof existing.operationId === "string" && activeCalibrationLocks.has(existing.operationId);
        const staleOwner = existing.processId === process.pid ? !ownedHere : !processIsAlive(existing.processId ?? -1);
        if (existing.state !== "held" || staleOwner) {
          await archiveCalibrationLock(root, path, "stale");
          continue;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        malformedSince ??= Date.now();
        if (Date.now() - malformedSince > 1_000) {
          try {
            await archiveCalibrationLock(root, path, "stale");
            malformedSince = undefined;
            continue;
          } catch {
            // Another process may still be finishing the lock file; retry until the bounded deadline.
          }
        }
      }
      await delay(25);
    }
  }
  throw new PuppetLoomError("OPERATION_BUSY", "另一个进程仍在写入校准，请稍后重试。" );
}

async function releaseCalibrationLock(root: string, lock: HeldCalibrationLock): Promise<void> {
  activeCalibrationLocks.delete(lock.operationId);
  await lock.handle.close();
  try {
    await archiveCalibrationLock(root, lock.path, "released");
  } catch (error) {
    try {
      await atomicJson(lock.path, { ...lock, path: undefined, handle: undefined, state: "released" });
    } catch {
      throw new PuppetLoomError("IO_ERROR", "校准已处理，但写入锁无法归档。", { cause: error });
    }
  }
}

function operationPath(root: string, operationId: string): string {
  return join(root, "reports", "calibration", operationId, "operation.json");
}

async function recoverCalibrationOperationsUnlocked(root: string, current: CalibrationDocument): Promise<CalibrationOperationDocument[]> {
  const reports = join(root, "reports", "calibration");
  let directories: string[];
  try {
    directories = await readdir(reports);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const recovered: CalibrationOperationDocument[] = [];
  for (const directory of directories.sort()) {
    const path = join(reports, directory, "operation.json");
    try {
      const operation = calibrationOperationSchema.parse(JSON.parse(await readFile(path, "utf8"))) as CalibrationOperationDocument;
      if (operation.status !== "pending") continue;
      const now = new Date().toISOString();
      const next: CalibrationOperationDocument = current.headSessionId === operation.sessionId
        ? { ...operation, status: "succeeded", updatedAt: now, completedAt: now }
        : { ...operation, status: "interrupted", updatedAt: now, completedAt: now, error: "进程在切换当前校准版本前中断；未自动重放。" };
      await atomicJson(path, next);
      recovered.push(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PuppetLoomError("INVALID_PROJECT", `无法恢复校准操作记录：${path}`, { cause: error });
      }
    }
  }
  return recovered;
}

export async function recoverCalibrationOperations(projectDirectory: string): Promise<CalibrationOperationDocument[]> {
  const root = resolve(projectDirectory);
  const lock = await acquireCalibrationLock(root, `recovery-${randomUUID()}`);
  try {
    return await recoverCalibrationOperationsUnlocked(root, await loadCalibration(root));
  } finally {
    await releaseCalibrationLock(root, lock);
  }
}

async function commitCalibrationPatch(root: string, patch: CalibrationPatch, replacementOverrides?: CalibrationOverrides): Promise<CalibrationSaveResult> {
  const operationId = randomUUID();
  const lock = await acquireCalibrationLock(root, operationId);
  let operation: CalibrationOperationDocument | undefined;
  let operationFile: string | undefined;
  let committed = false;
  try {
    const { project: base, hash } = await readBaseProject(root);
    const current = await loadCalibration(root);
    await recoverCalibrationOperationsUnlocked(root, current);
    if (current.baseProjectSha256 !== hash && current.revision > 0) throw new PuppetLoomError("INVALID_PROJECT", "基础项目已改变，不能继续追加校准。" );
    if (patch.baseRevision !== current.revision) {
      throw new PuppetLoomError("REVISION_CONFLICT", `校准基线已从 ${patch.baseRevision} 更新到 ${current.revision}，本次修改没有写入。`);
    }
    const before = applySafetyLimits(applyCalibrationOverrides(base, current.overrides));
    const overrides = replacementOverrides ?? mergeCalibrationOverrides(clearCalibrationOverrides(current.overrides, patch.clear), patch.overrides);
    const after = applySafetyLimits(applyCalibrationOverrides(base, overrides));
    const rebuiltLayers = rebuiltMeshLayerIds(before, after);
    if (replacementOverrides === undefined && rebuiltLayers.length > 1) {
      throw new PuppetLoomError(
        "INVALID_INPUT",
        `一次校准重建了 ${rebuiltLayers.length} 个图层网格。为避免整套角色外观和动作同时失真，每次只能重建一个图层，并在保存前检查中立与九向姿态。`
      );
    }
    const rigRank: Record<RigLevel, number> = { minimal: 0, grouped: 1, semantic: 2 };
    if (rigRank[after.rigLevel] < rigRank[before.rigLevel] || after.quality.safetyScale + 1e-9 < before.quality.safetyScale) {
      throw new PuppetLoomError(
        "INVALID_INPUT",
        `校准超过当前安全余量：动作安全系数将从 ${before.quality.safetyScale.toFixed(2)} 降至 ${after.quality.safetyScale.toFixed(2)}。`
      );
    }
    const now = new Date().toISOString();
    const revision = current.revision + 1;
    const id = `${String(revision).padStart(4, "0")}-${randomUUID()}`;
    const label = patch.label?.trim() || `校准 ${revision}`;
    const operationDirectory = join(root, "reports", "calibration", operationId);
    const evidenceDirectory = join(operationDirectory, "evidence");
    operationFile = operationPath(root, operationId);
    operation = {
      version: 1,
      id: operationId,
      kind: "calibration-commit",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      baseRevision: current.revision,
      targetRevision: revision,
      sessionId: id,
      processId: process.pid,
      evidenceDirectory: relative(root, evidenceDirectory)
    };
    await mkdir(operationDirectory, { recursive: true });
    await atomicJson(operationFile, operation);

    const evidence = await (await import("./render-suite.js")).compareProjectStates(
      root, before, after, current.revision, revision, evidenceDirectory, patch.authoring?.previews ?? []
    );
    const neutralMeshDifference = replacementOverrides === undefined && rebuiltLayers.length === 1
      ? await (await import("./render-suite.js")).compareNeutralProjectStates(root, before, after, evidenceDirectory)
      : undefined;
    if (neutralMeshDifference
      && (neutralMeshDifference.significantPixelRatio > 0.02 || neutralMeshDifference.meanAbsoluteDifference > 0.0015)) {
      throw new PuppetLoomError(
        "INVALID_INPUT",
        `当前图层重建后的视觉差异过大：中立外观有 ${(neutralMeshDifference.significantPixelRatio * 100).toFixed(2)}% 像素显著变化，平均差异 ${neutralMeshDifference.meanAbsoluteDifference.toFixed(6)}。本次校准没有写入，请调整网格密度或顶点后再保存。`
      );
    }
    const calibration: CalibrationDocument = {
      version: 2,
      baseProjectSha256: hash,
      revision,
      updatedAt: now,
      label,
      overrides,
      headSessionId: id
    };
    const session: CalibrationSessionDocument = {
      version: 1,
      id,
      createdAt: now,
      label,
      fromRevision: current.revision,
      toRevision: revision,
      beforeFingerprint: projectFingerprint(before),
      afterFingerprint: projectFingerprint(after),
      patch,
      beforeOverrides: current.overrides,
      afterOverrides: overrides,
      evidenceStatus: "unreviewed",
      ...(current.headSessionId ? { parentSessionId: current.headSessionId } : {}),
      operationId,
      evidenceDirectory: relative(root, evidenceDirectory)
    };
    const sessions = join(root, "calibration", "sessions");
    await mkdir(sessions, { recursive: true });
    const sessionPath = join(sessions, `${id}.json`);
    await atomicJson(sessionPath, session);
    await atomicJson(join(root, "calibration", "current.json"), calibration);
    committed = true;
    const completedAt = new Date().toISOString();
    const succeeded: CalibrationOperationDocument = {
      ...operation,
      status: "succeeded",
      updatedAt: completedAt,
      completedAt,
      sessionPath: relative(root, sessionPath)
    };
    try {
      await atomicJson(operationFile, succeeded);
    } catch {
      // Recovery derives success from current.headSessionId; the committed result remains unambiguous.
    }
    return { project: after, calibration, session, sessionPath, evidence, operation: succeeded };
  } catch (error) {
    if (!committed && operation && operationFile) {
      const failedAt = new Date().toISOString();
      const failed: CalibrationOperationDocument = {
        ...operation,
        status: "failed",
        updatedAt: failedAt,
        completedAt: failedAt,
        error: error instanceof Error ? error.message : String(error)
      };
      try { await atomicJson(operationFile, failed); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  } finally {
    await releaseCalibrationLock(root, lock);
  }
}

export async function saveCalibrationPatch(projectDirectory: string, rawPatch: CalibrationPatch): Promise<CalibrationSaveResult> {
  let patch: CalibrationPatch;
  try {
    patch = calibrationPatchSchema.parse(rawPatch) as CalibrationPatch;
  } catch (error) {
    throw new PuppetLoomError("INVALID_INPUT", "校准补丁格式无效。", { cause: error });
  }
  return commitCalibrationPatch(resolve(projectDirectory), patch);
}

export async function saveAuthoringPatch(projectDirectory: string, rawPatch: AuthoringPatch): Promise<CalibrationSaveResult> {
  let patch: AuthoringPatch;
  try {
    patch = authoringPatchSchema.parse(rawPatch) as AuthoringPatch;
  } catch (error) {
    throw new PuppetLoomError("INVALID_INPUT", "Authoring 补丁格式无效。", { cause: error });
  }
  const root = resolve(projectDirectory);
  const [before, calibration] = await Promise.all([loadProject(root), loadCalibration(root)]);
  if (patch.baseRevision !== calibration.revision) {
    throw new PuppetLoomError("REVISION_CONFLICT", `Authoring 基线已从 ${patch.baseRevision} 更新到 ${calibration.revision}，本次修改没有写入。`);
  }
  let after: PuppetLoomProject;
  try {
    after = applyAuthoringOperations(before, patch.operations);
  } catch (error) {
    throw new PuppetLoomError("INVALID_INPUT", "Authoring 操作无法形成有效模型。", { cause: error });
  }
  const layerOverrides = authoringLayerOverrides(before, after);
  const audit = buildAuthoringAudit(patch, before, after);
  return saveCalibrationPatch(root, {
    baseRevision: patch.baseRevision,
    ...(patch.label ? { label: patch.label } : {}),
    overrides: {
      model: after.model,
      ...(Object.keys(layerOverrides).length > 0 ? { layers: layerOverrides } : {})
    },
    authoring: audit
  });
}

export async function listCalibrationSessions(projectDirectory: string): Promise<CalibrationSessionDocument[]> {
  const root = resolve(projectDirectory);
  const directory = join(root, "calibration", "sessions");
  try {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    const all = await Promise.all(files.map(async (name) => calibrationSessionSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8"))) as CalibrationSessionDocument));
    const current = await loadCalibration(root);
    if (!current.headSessionId) return all.filter((session) => session.toRevision <= current.revision).sort((a, b) => a.toRevision - b.toRevision);
    const byId = new Map(all.map((session) => [session.id, session]));
    const chain: CalibrationSessionDocument[] = [];
    const seen = new Set<string>();
    let id: string | undefined = current.headSessionId;
    while (id) {
      if (seen.has(id)) throw new Error(`校准历史形成循环：${id}`);
      seen.add(id);
      const session = byId.get(id);
      if (!session) throw new Error(`当前校准引用了不存在的会话：${id}`);
      chain.push(session);
      id = session.parentSessionId;
    }
    const oldestRevision = chain.at(-1)?.fromRevision ?? current.revision;
    const legacy = all.filter((session) => !session.operationId && session.toRevision <= oldestRevision).sort((a, b) => a.toRevision - b.toRevision);
    return [...legacy, ...chain.reverse()];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new PuppetLoomError("IO_ERROR", `无法读取校准历史：${projectDirectory}`, { cause: error });
  }
}

function sessionStringField(source: string, field: string): string | undefined {
  const match = new RegExp(`^\\s*"${field}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")\\s*,?\\s*$`, "m").exec(source);
  if (!match?.[1]) return undefined;
  try { return JSON.parse(match[1]) as string; } catch { return undefined; }
}

function sessionNumberField(source: string, field: string): number | undefined {
  const match = new RegExp(`^\\s*"${field}"\\s*:\\s*(\\d+)\\s*,?\\s*$`, "m").exec(source);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function summaryFromSessionText(source: string): CalibrationSessionSummary | undefined {
  const id = sessionStringField(source, "id");
  const createdAt = sessionStringField(source, "createdAt");
  const label = sessionStringField(source, "label");
  const fromRevision = sessionNumberField(source, "fromRevision");
  const toRevision = sessionNumberField(source, "toRevision");
  const evidenceStatus = sessionStringField(source, "evidenceStatus");
  const parentSessionId = sessionStringField(source, "parentSessionId");
  const operationId = sessionStringField(source, "operationId");
  if (!id || !createdAt || !label || fromRevision === undefined || toRevision === undefined
    || !["unreviewed", "accepted", "rejected"].includes(evidenceStatus ?? "")) return undefined;
  return {
    id,
    createdAt,
    label,
    fromRevision,
    toRevision,
    evidenceStatus: evidenceStatus as CalibrationSessionSummary["evidenceStatus"],
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(operationId ? { operationId } : {})
  };
}

function summarizeSession(session: CalibrationSessionDocument): CalibrationSessionSummary {
  return {
    id: session.id,
    createdAt: session.createdAt,
    label: session.label,
    fromRevision: session.fromRevision,
    toRevision: session.toRevision,
    evidenceStatus: session.evidenceStatus,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.operationId ? { operationId: session.operationId } : {})
  };
}

async function readCalibrationSessionSummary(path: string): Promise<CalibrationSessionSummary> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const windowSize = 16 * 1024;
    if (size <= windowSize * 2) {
      const source = await readFile(path, "utf8");
      const summary = summaryFromSessionText(source);
      if (summary) return summary;
      return summarizeSession(calibrationSessionSchema.parse(JSON.parse(source)) as CalibrationSessionDocument);
    }
    const prefixBuffer = Buffer.alloc(windowSize);
    const suffixBuffer = Buffer.alloc(windowSize);
    const [{ bytesRead: prefixBytes }, { bytesRead: suffixBytes }] = await Promise.all([
      handle.read(prefixBuffer, 0, windowSize, 0),
      handle.read(suffixBuffer, 0, windowSize, size - windowSize)
    ]);
    const summary = summaryFromSessionText(`${prefixBuffer.toString("utf8", 0, prefixBytes)}\n${suffixBuffer.toString("utf8", 0, suffixBytes)}`);
    if (summary) return summary;
  } finally {
    await handle.close();
  }
  return summarizeSession(calibrationSessionSchema.parse(JSON.parse(await readFile(path, "utf8"))) as CalibrationSessionDocument);
}

function activeCalibrationSessionSummaries(
  all: CalibrationSessionSummary[],
  current: CalibrationDocument
): CalibrationSessionSummary[] {
  if (!current.headSessionId) return all.filter((session) => session.toRevision <= current.revision).sort((a, b) => a.toRevision - b.toRevision);
  const byId = new Map(all.map((session) => [session.id, session]));
  const chain: CalibrationSessionSummary[] = [];
  const seen = new Set<string>();
  let id: string | undefined = current.headSessionId;
  while (id) {
    if (seen.has(id)) throw new Error(`校准历史形成循环：${id}`);
    seen.add(id);
    const session = byId.get(id);
    if (!session) throw new Error(`当前校准引用了不存在的会话：${id}`);
    chain.push(session);
    id = session.parentSessionId;
  }
  const oldestRevision = chain.at(-1)?.fromRevision ?? current.revision;
  const legacy = all
    .filter((session) => !session.operationId && session.toRevision <= oldestRevision)
    .sort((a, b) => a.toRevision - b.toRevision);
  return [...legacy, ...chain.reverse()];
}

async function readCalibrationSessionSummaries(root: string, current: CalibrationDocument): Promise<CalibrationSessionSummary[]> {
  const directory = join(root, "calibration", "sessions");
  try {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    const all = await Promise.all(files.map((name) => readCalibrationSessionSummary(join(directory, name))));
    return activeCalibrationSessionSummaries(all, current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new PuppetLoomError("IO_ERROR", `无法读取校准历史摘要：${root}`, { cause: error });
  }
}

export async function listCalibrationSessionSummaries(projectDirectory: string): Promise<CalibrationSessionSummary[]> {
  const root = resolve(projectDirectory);
  const { hash } = await readBaseProject(root);
  const current = await readCalibrationDocument(root, hash);
  return readCalibrationSessionSummaries(root, current);
}

export async function loadCalibrationWorkspace(projectDirectory: string): Promise<{
  baseProject: PuppetLoomProject;
  project: PuppetLoomProject;
  calibration: CalibrationDocument;
  sessions: CalibrationSessionSummary[];
  draft?: CalibrationDraftDocument;
}> {
  const root = resolve(projectDirectory);
  const { project: baseProject, hash } = await readBaseProject(root);
  const calibration = await readCalibrationDocument(root, hash);
  const sessionsPromise = readCalibrationSessionSummaries(root, calibration);
  const draftPromise = readCalibrationDraftDocument(root, hash, calibration);
  const project = applyStoredCalibration(baseProject, calibration, root);
  const [sessions, draft] = await Promise.all([sessionsPromise, draftPromise]);
  return {
    baseProject,
    project,
    calibration,
    sessions,
    ...(draft ? { draft } : {})
  };
}

export async function loadProjectRevision(projectDirectory: string, revision: number): Promise<PuppetLoomProject> {
  if (!Number.isInteger(revision) || revision < 0) throw new PuppetLoomError("INVALID_INPUT", "校准修订号必须是非负整数。" );
  const base = await loadBaseProject(projectDirectory);
  if (revision === 0) return applySafetyLimits(base);
  const current = await loadCalibration(projectDirectory);
  if (revision === current.revision) return applySafetyLimits(applyCalibrationOverrides(base, current.overrides));
  const session = (await listCalibrationSessions(projectDirectory)).find((candidate) => candidate.toRevision === revision);
  if (!session) throw new PuppetLoomError("INVALID_INPUT", `找不到校准修订 ${revision}。`);
  return applySafetyLimits(applyCalibrationOverrides(base, session.afterOverrides));
}

export async function setCalibrationEvidenceStatus(
  projectDirectory: string,
  sessionId: string,
  status: CalibrationSessionDocument["evidenceStatus"]
): Promise<CalibrationSessionDocument> {
  const path = join(resolve(projectDirectory), "calibration", "sessions", `${sessionId}.json`);
  try {
    if (!["accepted", "rejected", "unreviewed"].includes(status)) throw new Error("证据状态无效。");
    const session = calibrationSessionSchema.parse(JSON.parse(await readFile(path, "utf8"))) as CalibrationSessionDocument;
    const next = { ...session, evidenceStatus: status };
    await atomicJson(path, next);
    return next;
  } catch (error) {
    throw new PuppetLoomError("INVALID_INPUT", `找不到校准会话：${sessionId}`, { cause: error });
  }
}

export async function restoreCalibrationRevision(projectDirectory: string, revision: number, baseRevision: number, label?: string): Promise<CalibrationSaveResult> {
  if (!Number.isInteger(revision) || revision < 0) throw new PuppetLoomError("INVALID_INPUT", "校准修订号必须是非负整数。" );
  const sessions = await listCalibrationSessions(projectDirectory);
  const overrides = revision === 0 ? {} : sessions.find((session) => session.toRevision === revision)?.afterOverrides;
  if (!overrides) throw new PuppetLoomError("INVALID_INPUT", `找不到校准修订 ${revision}。`);
  const resetPatch: CalibrationPatch = { baseRevision, label: label ?? `恢复到校准 ${revision}`, overrides };
  return commitCalibrationPatch(resolve(projectDirectory), resetPatch, overrides);
}
