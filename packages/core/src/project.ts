import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, open, readFile, readdir, rename, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import sharp from "sharp";
import { makeAssetRequests } from "./assets.js";
import { applyAuthoringOperations, authoringLayerOverrides, authoringSummary, buildAuthoringAudit } from "./authoring.js";
import { applyCalibrationOverrides, clearCalibrationOverrides, mergeCalibrationOverrides } from "./calibration.js";
import { PuppetLoomError } from "./errors.js";
import { renderProjectPosePng } from "./offline-render.js";
import { importPsd, inspectionFromImported, type ImportedPsd, type PixelBuffer } from "./psd.js";
import { buildRig } from "./rig.js";
import { parsePuppetLoomProject } from "./project-format.js";
import { applySafetyLimits, safetyPoses, safetyPoseState } from "./safety.js";
import { authoringPatchSchema, calibrationDocumentSchema, calibrationDraftSchema, calibrationOperationSchema, calibrationOverridesSchema, calibrationPatchSchema, calibrationSessionSchema } from "./schema.js";
import { inspectLayerAlphaTopology } from "./topology.js";
import type {
  BuildReport,
  BuildResult,
  AuthoringPatch,
  CalibrationDocument,
  CalibrationDraftDocument,
  CalibrationOperationDocument,
  CalibrationOverrides,
  CalibrationPatch,
  CalibrationSaveResult,
  CalibrationSessionDocument,
  CreateOptions,
  ProjectDescription,
  PuppetLoomProject,
  RigLevel,
  SourceDescriptor
} from "./types.js";

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function projectFingerprint(project: PuppetLoomProject): string {
  return createHash("sha256").update(JSON.stringify(project)).digest("hex");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function ensureWritableOutput(output: string): Promise<boolean> {
  try {
    const entries = await readdir(output);
    if (entries.length > 0) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `输出目录不是空目录：${output}`);
    return true;
  } catch (error) {
    if (error instanceof PuppetLoomError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new PuppetLoomError("IO_ERROR", `无法检查输出目录：${output}`, { cause: error });
    return false;
  }
}

async function encodeRawPng(pixels: PixelBuffer): Promise<Buffer> {
  return sharp(Buffer.from(pixels.data), { raw: { width: pixels.width, height: pixels.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

async function neutralPng(imported: ImportedPsd): Promise<Buffer> {
  if (imported.composite) return encodeRawPng(imported.composite);
  const composites = await Promise.all(
    imported.layers
      .sort((a, b) => a.order - b.order)
      .map(async (layer) => ({ input: await encodeRawPng(layer.pixels), left: Math.round(layer.bounds.x), top: Math.round(layer.bounds.y), blend: "over" as const, opacity: layer.opacity }))
  );
  return sharp({ create: { width: imported.canvas.width, height: imported.canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composites).png().toBuffer();
}

async function writeSemanticCageArtifacts(output: string, neutral: Buffer, project: PuppetLoomProject): Promise<void> {
  const cage = project.runtime.semanticCage;
  if (!cage) return;
  const width = project.canvas.width;
  const height = project.canvas.height;
  const pointEntries = Object.entries(cage.points);
  const lines = (triangles: typeof cage.faceTriangles) => triangles.flatMap(([aId, bId, cId]) => {
    const ids = [[aId, bId], [bId, cId], [cId, aId]] as const;
    return ids.map(([fromId, toId]) => {
      const from = cage.points[fromId].position;
      const to = cage.points[toId].position;
      return `<line x1="${from.x * width}" y1="${from.y * height}" x2="${to.x * width}" y2="${to.y * height}"/>`;
    });
  }).join("");
  const markers = pointEntries.map(([, entry], index) => {
    const x = entry.position.x * width;
    const y = entry.position.y * height;
    const number = String(index + 1).padStart(2, "0");
    return `<g><circle cx="${x}" cy="${y}" r="8"/><text x="${x}" y="${y + 3.6}" text-anchor="middle">${number}</text></g>`;
  }).join("");
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <g fill="none" stroke="#38d6ff" stroke-width="2.2" stroke-opacity="0.8">${lines(cage.faceTriangles)}</g>
    <g fill="none" stroke="#ffd166" stroke-width="2.2" stroke-opacity="0.72">${lines(cage.skullTriangles)}</g>
    <g fill="#ff4861" stroke="#ffffff" stroke-width="1.5" font-family="Arial" font-size="7" font-weight="700">${markers}</g>
  </svg>`);
  const annotated = await sharp(neutral).composite([{ input: svg }]).png().toBuffer();
  await writeFile(join(output, "reports", "semantic-cage.png"), annotated);
  const positions = Object.values(cage.points).map((entry) => entry.position);
  const minimumX = Math.min(...positions.map((entry) => entry.x));
  const maximumX = Math.max(...positions.map((entry) => entry.x));
  const minimumY = Math.min(...positions.map((entry) => entry.y));
  const maximumY = Math.max(...positions.map((entry) => entry.y));
  const paddingX = Math.max(0.025, (maximumX - minimumX) * 0.24);
  const paddingY = Math.max(0.025, (maximumY - minimumY) * 0.2);
  const cropLeft = Math.max(0, Math.floor((minimumX - paddingX) * width));
  const cropTop = Math.max(0, Math.floor((minimumY - paddingY) * height));
  const cropRight = Math.min(width, Math.ceil((maximumX + paddingX) * width));
  const cropBottom = Math.min(height, Math.ceil((maximumY + paddingY) * height));
  const head = await sharp(annotated)
    .extract({ left: cropLeft, top: cropTop, width: cropRight - cropLeft, height: cropBottom - cropTop })
    .resize({ width: 1000, withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const legendWidth = 720;
  const reportHeight = Math.max(head.info.height, 820);
  const legendRows = Math.ceil(pointEntries.length / 2);
  const rowHeight = Math.floor((reportHeight - 92) / legendRows);
  const legendItems = pointEntries.map(([id, entry], index) => {
    const column = Math.floor(index / legendRows);
    const row = index % legendRows;
    const x = 24 + column * (legendWidth / 2);
    const y = 82 + row * rowHeight;
    const number = String(index + 1).padStart(2, "0");
    return `<g>
      <circle cx="${x + 13}" cy="${y - 7}" r="13" fill="#ff4861" stroke="#ffffff" stroke-width="1.5"/>
      <text x="${x + 13}" y="${y - 2}" fill="#ffffff" text-anchor="middle" font-size="11" font-weight="700">${number}</text>
      <text x="${x + 34}" y="${y - 5}" fill="#f4f7fb" font-size="16" font-weight="700">${id}</text>
      <text x="${x + 34}" y="${y + 14}" fill="#aebbd0" font-size="12">${entry.source} · ${entry.confidence.toFixed(2)}</text>
    </g>`;
  }).join("");
  const legend = Buffer.from(`<svg width="${legendWidth}" height="${reportHeight}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#101722"/>
    <text x="24" y="34" fill="#ffffff" font-family="Arial" font-size="22" font-weight="700">Semantic control cage</text>
    <text x="24" y="57" fill="#9fb0c7" font-family="Arial" font-size="13">编号 · 名称 · 定位来源 · 置信度</text>
    <g font-family="Arial">${legendItems}</g>
  </svg>`);
  await sharp({ create: { width: head.info.width + legendWidth, height: reportHeight, channels: 4, background: { r: 11, g: 15, b: 23, alpha: 1 } } })
    .composite([
      { input: head.data, left: 0, top: Math.floor((reportHeight - head.info.height) / 2) },
      { input: legend, left: head.info.width, top: 0 }
    ])
    .png()
    .toFile(join(output, "reports", "semantic-cage-head.png"));
  const appliedLayers = Object.fromEntries(Object.entries(cage.roleGroups).map(([group, roles]) => [
    group,
    project.layers
      .filter((layer) => roles.includes(layer.role))
      .map((layer) => ({ id: layer.id, sourceName: layer.sourceName, role: layer.role, side: layer.side }))
  ]));
  await writeFile(join(output, "reports", "landmark-report.json"), `${JSON.stringify({
    kind: cage.kind,
    coordinateConvention: cage.coordinateConvention,
    validation: cage.validation,
    points: cage.points,
    triangles: { face: cage.faceTriangles, skull: cage.skullTriangles },
    roleGroups: cage.roleGroups,
    appliedLayers
  }, null, 2)}\n`, "utf8");
}

async function luminanceSimilarity(referencePath: string, composite: PixelBuffer): Promise<number | undefined> {
  const reference = await sharp(referencePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (reference.info.width !== composite.width || reference.info.height !== composite.height) return undefined;
  const count = composite.width * composite.height;
  let sumX = 0;
  let sumY = 0;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let pixel = 0; pixel < count; pixel += 1) {
    const ri = pixel * reference.info.channels;
    const ci = pixel * 4;
    const x = (0.2126 * (reference.data[ri] ?? 0) + 0.7152 * (reference.data[ri + 1] ?? 0) + 0.0722 * (reference.data[ri + 2] ?? 0)) * ((reference.data[ri + 3] ?? 255) / 255);
    const y = (0.2126 * (composite.data[ci] ?? 0) + 0.7152 * (composite.data[ci + 1] ?? 0) + 0.0722 * (composite.data[ci + 2] ?? 0)) * ((composite.data[ci + 3] ?? 255) / 255);
    xs[pixel] = x;
    ys[pixel] = y;
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / count;
  const meanY = sumY / count;
  let varianceX = 0;
  let varianceY = 0;
  let covariance = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = (xs[index] ?? 0) - meanX;
    const dy = (ys[index] ?? 0) - meanY;
    varianceX += dx * dx;
    varianceY += dy * dy;
    covariance += dx * dy;
  }
  varianceX /= count;
  varianceY /= count;
  covariance /= count;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return ((2 * meanX * meanY + c1) * (2 * covariance + c2)) / ((meanX ** 2 + meanY ** 2 + c1) * (varianceX + varianceY + c2));
}

async function writePoseSheet(output: string, imported: ImportedPsd, project: PuppetLoomProject): Promise<void> {
  const cellWidth = 240;
  const cellHeight = 240;
  const columns = 4;
  const rows = 4;
  const composites: sharp.OverlayOptions[] = [];
  for (let index = 0; index < project.quality.poseValidations.length; index += 1) {
    const pose = project.quality.poseValidations[index]!;
    const specification = safetyPoses.find((candidate) => candidate.id === pose.id) ?? safetyPoses[0]!;
    const thumbnail = await renderProjectPosePng(project, imported, safetyPoseState(specification.yaw, specification.pitch, specification.roll), 190, 180);
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = column * cellWidth;
    const top = row * cellHeight;
    composites.push({ input: thumbnail, left: left + 25, top: top + 20 });
    const label = `<svg width="${cellWidth}" height="40"><rect width="100%" height="100%" fill="#10141c"/><text x="12" y="25" fill="${pose.passed ? "#80e0b0" : "#ff8f8f"}" font-family="Arial" font-size="15">${pose.id} · ${pose.score.toFixed(2)}</text></svg>`;
    composites.push({ input: Buffer.from(label), left, top: top + 200 });
  }
  await sharp({ create: { width: cellWidth * columns, height: cellHeight * rows, channels: 4, background: { r: 24, g: 29, b: 39, alpha: 1 } } }).composite(composites).png().toFile(output);
}

function buildReport(project: PuppetLoomProject, recognized: number, warnings: string[], assetRequestCount: number): BuildReport {
  const featureEntries = Object.entries(project.runtime.features);
  return {
    version: 1,
    project: project.name,
    rigLevel: project.rigLevel,
    layerCount: project.layers.length,
    recognizedLayerCount: recognized,
    safetyScale: project.quality.safetyScale,
    enabledFeatures: featureEntries.filter(([, enabled]) => enabled).map(([key]) => key),
    disabledFeatures: featureEntries.filter(([, enabled]) => !enabled).map(([key]) => key),
    warnings,
    quality: project.quality,
    assetRequestCount,
    ...(project.runtime.semanticCage ? {
      landmarkCalibration: {
        ...project.runtime.semanticCage.validation,
        pointCount: Object.keys(project.runtime.semanticCage.points).length
      }
    } : {})
  };
}

export async function createProject(options: CreateOptions): Promise<BuildResult> {
  const input = resolve(options.input);
  const finalOutput = resolve(options.output);
  const outputExisted = await ensureWritableOutput(finalOutput);
  const imported = await importPsd(input);
  const inspection = inspectionFromImported(imported);
  const name = options.name?.trim() || parse(input).name;
  const referencePng = options.reference ? await sharp(resolve(options.reference)).png().toBuffer() : undefined;
  const source: SourceDescriptor = {
    originalFileName: basename(input),
    psdSha256: await sha256(input),
    psdPath: "source/source.psd"
  };
  if (options.reference) {
    source.referencePath = "source/reference.png";
    source.referenceSha256 = createHash("sha256").update(referencePng!).digest("hex");
  }
  let project = buildRig({ imported, name, seed: options.seed ?? 42, source });
  if (options.reference && imported.composite) {
    const similarity = await luminanceSimilarity(resolve(options.reference), imported.composite);
    if (similarity !== undefined) project = { ...project, quality: { ...project.quality, neutralSimilarity: similarity } };
    else imported.warnings.push("参考图尺寸与 PSD 画布不同，未计算中立相似度。" );
  }
  project = applySafetyLimits(project);
  const requests = makeAssetRequests(project);
  const report = buildReport(project, inspection.recognizedLayerCount, imported.warnings, requests.requests.length);
  const operationId = randomUUID();
  const stagingOutput = join(dirname(finalOutput), `.${basename(finalOutput)}.puppetloom-pending-${operationId}`);
  const reservation = join(dirname(finalOutput), `.${basename(finalOutput)}.puppetloom-reserved-${operationId}`);
  const operationRelative = join("reports", "operations", `create-${operationId}`, "operation.json");
  const startedAt = new Date().toISOString();
  let operationRoot = stagingOutput;
  let published = false;
  await mkdir(dirname(finalOutput), { recursive: true });
  await mkdir(dirname(join(stagingOutput, operationRelative)), { recursive: true });
  await atomicJson(join(stagingOutput, operationRelative), {
    version: 1, id: operationId, kind: "project-create", status: "pending", createdAt: startedAt, updatedAt: startedAt,
    target: finalOutput, staging: stagingOutput, processId: process.pid
  });
  try {
    const output = stagingOutput;
    for (const directory of ["source", "textures", "reports", "requests", "supplements", "calibration", "calibration/sessions", "reports/calibration"]) await mkdir(join(output, directory), { recursive: true });
    await copyFile(input, join(output, "source", "source.psd"));
    if (referencePng) await writeFile(join(output, "source", "reference.png"), referencePng);
    await Promise.all(
      imported.layers.map(async (layer) => {
        await sharp(Buffer.from(layer.pixels.data), { raw: { width: layer.pixels.width, height: layer.pixels.height, channels: 4 } }).png({ compressionLevel: 9 }).toFile(join(output, "textures", `${layer.id}.png`));
      })
    );
    const neutral = await neutralPng(imported);
    await writeFile(join(output, "reports", "neutral.png"), neutral);
    await writeSemanticCageArtifacts(output, neutral, project);
    await Promise.all(requests.requests.map(async (request) => {
      if (!request.reference) return;
      const target = join(output, request.reference.path);
      await mkdir(dirname(target), { recursive: true });
      await sharp(neutral).extract({
        left: Math.round(request.crop.x), top: Math.round(request.crop.y),
        width: Math.round(request.crop.width), height: Math.round(request.crop.height)
      }).png().toFile(target);
    }));
    await writePoseSheet(join(output, "reports", "pose-sheet.png"), imported, project);
    await writeFile(join(output, "puppetloom.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await writeFreshCalibration(output);
    await writeFile(join(output, "reports", "build-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(join(output, "requests", "asset-requests.json"), `${JSON.stringify(requests, null, 2)}\n`, "utf8");
    const verification = await (await import("./verify.js")).verifyProject(output);
    if (!verification.valid) throw new PuppetLoomError("INVALID_PROJECT", `生成项目未通过发布前验证：${verification.warnings.join("；")}`);

    if (outputExisted) await rename(finalOutput, reservation);
    try {
      await rename(stagingOutput, finalOutput);
      operationRoot = finalOutput;
      published = true;
    } catch (error) {
      if (outputExisted) await rename(reservation, finalOutput).catch(() => undefined);
      throw error;
    }
    let reservedOutput: string | undefined;
    if (outputExisted) {
      reservedOutput = join(finalOutput, "reports", "operations", `create-${operationId}`, "reserved-output");
      try { await rename(reservation, reservedOutput); }
      catch { reservedOutput = reservation; }
    }
    const completedAt = new Date().toISOString();
    try {
      await atomicJson(join(operationRoot, operationRelative), {
        version: 1, id: operationId, kind: "project-create", status: "succeeded", createdAt: startedAt, updatedAt: completedAt,
        completedAt, target: finalOutput, processId: process.pid, ...(reservedOutput ? { reservedOutput } : {})
      });
    } catch { /* The published project remains the unique final state. */ }
    return { project, report, assetRequests: requests, outputDirectory: finalOutput };
  } catch (error) {
    if (!published) {
      const failedAt = new Date().toISOString();
      try {
        await atomicJson(join(operationRoot, operationRelative), {
          version: 1, id: operationId, kind: "project-create", status: "failed", createdAt: startedAt, updatedAt: failedAt,
          completedAt: failedAt, target: finalOutput, staging: stagingOutput, processId: process.pid,
          error: error instanceof Error ? error.message : String(error)
        });
      } catch { /* Preserve the original error and the staging directory. */ }
    }
    throw new PuppetLoomError("IO_ERROR", `项目生成失败；未发布的操作记录保留在 ${stagingOutput}`, { cause: error });
  }
}

async function readBaseProject(projectDirectory: string): Promise<{ project: PuppetLoomProject; hash: string }> {
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

async function writeFreshCalibration(projectDirectory: string): Promise<CalibrationDocument> {
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

export async function loadCalibration(projectDirectory: string): Promise<CalibrationDocument> {
  const root = resolve(projectDirectory);
  const { hash } = await readBaseProject(root);
  const path = join(root, "calibration", "current.json");
  try {
    const document = calibrationDocumentSchema.parse(JSON.parse(await readFile(path, "utf8"))) as CalibrationDocument;
    if (document.baseProjectSha256 !== hash) {
      if (document.revision === 0 && Object.keys(document.overrides).length === 0) return emptyCalibration(hash);
      throw new Error("基础项目已改变，现有校准不能安全套用。" );
    }
    return document;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCalibration(hash);
    throw new PuppetLoomError("INVALID_PROJECT", `无法读取项目校准：${projectDirectory}`, { cause: error });
  }
}

export async function loadCalibrationDraft(projectDirectory: string): Promise<CalibrationDraftDocument | undefined> {
  const root = resolve(projectDirectory);
  const [{ hash }, calibration] = await Promise.all([readBaseProject(root), loadCalibration(root)]);
  try {
    const draft = calibrationDraftSchema.parse(JSON.parse(await readFile(join(root, "calibration", "draft.json"), "utf8"))) as CalibrationDraftDocument;
    if (draft.baseProjectSha256 !== hash || draft.baseRevision !== calibration.revision) return undefined;
    if (Object.keys(draft.overrides).length === 0 && !draft.label) return undefined;
    return draft;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PuppetLoomError("INVALID_PROJECT", `无法读取项目校准草稿：${projectDirectory}`, { cause: error });
  }
}

export async function saveCalibrationDraft(
  projectDirectory: string,
  baseRevision: number,
  rawOverrides: CalibrationOverrides,
  label?: string
): Promise<CalibrationDraftDocument> {
  const root = resolve(projectDirectory);
  const [{ hash }, calibration] = await Promise.all([readBaseProject(root), loadCalibration(root)]);
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
  const [{ hash }, calibration] = await Promise.all([readBaseProject(root), loadCalibration(root)]);
  await mkdir(join(root, "calibration"), { recursive: true });
  await atomicJson(join(root, "calibration", "draft.json"), emptyCalibrationDraft(hash, calibration.revision));
}

export async function loadProject(projectDirectory: string): Promise<PuppetLoomProject> {
  const base = await loadBaseProject(projectDirectory);
  const calibration = await loadCalibration(projectDirectory);
  try {
    return applySafetyLimits(applyCalibrationOverrides(base, calibration.overrides));
  } catch (error) {
    throw new PuppetLoomError("INVALID_PROJECT", `无法应用项目校准：${projectDirectory}`, { cause: error });
  }
}

export async function describeProject(projectDirectory: string, layerId?: string, revision?: number): Promise<ProjectDescription> {
  const directory = resolve(projectDirectory);
  const [{ project: baseProject, hash }, calibration] = await Promise.all([readBaseProject(directory), loadCalibration(directory)]);
  const selectedRevision = revision ?? calibration.revision;
  const project = revision === undefined ? await loadProject(directory) : await loadProjectRevision(directory, selectedRevision);
  const selected = layerId ? project.layers.find((layer) => layer.id === layerId) : undefined;
  const selectedBase = selected ? baseProject.layers.find((layer) => layer.id === selected.id) : undefined;
  if (layerId && !selected) throw new PuppetLoomError("INVALID_INPUT", `找不到图层：${layerId}`);
  const selectedLayer = selected ? {
    id: selected.id,
    sourceName: selected.sourceName,
    sourcePath: selected.sourcePath,
    role: selected.role,
    side: selected.side,
    opacity: selected.opacity,
    blendMode: selected.blendMode,
    texture: selected.texture,
    parentGroup: selected.parentGroup,
    ...(selected.parentLayerId ? { parentLayerId: selected.parentLayerId } : {}),
    order: selected.order,
    visible: selected.visible !== false,
    locked: selected.locked === true,
    bounds: selected.bounds,
    pivot: selected.pivot,
    ...(selected.secondaryAnchors ? { secondaryAnchors: selected.secondaryAnchors } : {}),
    weights: selected.weights,
    ...(selected.clipLayerId ? { clipLayerId: selected.clipLayerId } : {}),
    ...(selected.mouthVariant ? { mouthVariant: selected.mouthVariant } : {}),
    alphaTopology: await inspectLayerAlphaTopology(join(directory, selected.texture), selected),
    mesh: {
      topology: selected.mesh.topology,
      ...(selected.mesh.rows !== undefined ? { rows: selected.mesh.rows } : {}),
      ...(selected.mesh.cols !== undefined ? { cols: selected.mesh.cols } : {}),
      ...(selected.mesh.art ? {
        detail: selected.mesh.art.detail,
        regionCount: selected.mesh.art.regions.length,
        holeCount: selected.mesh.art.regions.reduce((count, region) => count + region.holes.length, 0)
      } : {}),
      points: selected.mesh.points.map((position, index) => {
        const uv = selected.mesh.uvs[index] ?? {
          x: 0,
          y: 0
        };
        const sameBaseLayout = selectedBase?.mesh.topology === selected.mesh.topology
          && selectedBase.mesh.points.length === selected.mesh.points.length
          && selectedBase.mesh.uvs.every((candidate, uvIndex) => {
            const current = selected.mesh.uvs[uvIndex];
            return current !== undefined && Math.abs(candidate.x - current.x) < 1e-8 && Math.abs(candidate.y - current.y) < 1e-8;
          });
        const basePosition = sameBaseLayout
          ? selectedBase.mesh.points[index] ?? position
          : {
              x: selected.bounds.x + selected.bounds.width * uv.x,
              y: selected.bounds.y + selected.bounds.height * uv.y
            };
        return {
          index,
          ...(selected.mesh.topology === "grid" && selected.mesh.cols !== undefined ? {
            row: Math.floor(index / selected.mesh.cols),
            col: index % selected.mesh.cols
          } : {}),
          basePosition,
          position,
          delta: { x: position.x - basePosition.x, y: position.y - basePosition.y },
          uv,
          influences: Object.fromEntries((["face", "skull", "head", "body", "gaze", "physics", "pin"] as const).map((channel) => [
            channel,
            selected.mesh.influences?.[channel]?.[index] ?? (channel === "pin" ? 0 : 1)
          ])) as Record<import("./types.js").MeshInfluenceChannel, number>
        };
      }),
      triangles: selected.mesh.triangles
    }
  } : undefined;
  return {
    project: project.name,
    directory,
    version: project.version,
    calibrationRevision: selectedRevision,
    baseProjectSha256: hash,
    coordinateSystem: {
      unit: "normalized-canvas",
      origin: "top-left",
      xAxis: "right",
      yAxis: "down",
      sideConvention: "anatomical",
      note: "side 表示角色自身左右；正面角色的 left 通常显示在画面右侧。"
    },
    canvas: project.canvas,
    rigLevel: project.rigLevel,
    anchors: project.anchors,
    semanticPoints: project.runtime.semanticCage?.points ?? {},
    runtime: project.runtime,
    model: project.model,
    layers: project.layers.map((layer) => ({
      id: layer.id,
      sourceName: layer.sourceName,
      sourcePath: layer.sourcePath,
      role: layer.role,
      side: layer.side,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      texture: layer.texture,
      parentGroup: layer.parentGroup,
      ...(layer.parentLayerId ? { parentLayerId: layer.parentLayerId } : {}),
      ...(layer.deformerId ? { deformerId: layer.deformerId } : {}),
      order: layer.order,
      visible: layer.visible !== false,
      locked: layer.locked === true,
      bounds: layer.bounds,
      pivot: layer.pivot,
      ...(layer.secondaryAnchors ? { secondaryAnchors: layer.secondaryAnchors } : {}),
      mesh: {
        topology: layer.mesh.topology,
        ...(layer.mesh.rows !== undefined ? { rows: layer.mesh.rows } : {}),
        ...(layer.mesh.cols !== undefined ? { cols: layer.mesh.cols } : {}),
        ...(layer.mesh.art ? {
          detail: layer.mesh.art.detail,
          regionCount: layer.mesh.art.regions.length,
          holeCount: layer.mesh.art.regions.reduce((count, region) => count + region.holes.length, 0)
        } : {}),
        pointCount: layer.mesh.points.length,
        triangleCount: Math.floor(layer.mesh.triangles.length / 3)
      },
      weights: layer.weights
    })),
    ...(selectedLayer ? { selectedLayer } : {})
  };
}

export async function describeAuthoringProject(projectDirectory: string): Promise<ReturnType<typeof authoringSummary>> {
  const root = resolve(projectDirectory);
  const [project, calibration] = await Promise.all([loadProject(root), loadCalibration(root)]);
  return authoringSummary(project, calibration.revision);
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
