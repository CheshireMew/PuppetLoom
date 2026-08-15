import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import sharp from "sharp";
import { makeAssetRequests } from "./assets.js";
import { PuppetLoomError } from "./errors.js";
import { renderProjectPosePng } from "./offline-render.js";
import { importPsd, inspectionFromImported, type ImportedPsd, type PixelBuffer } from "./psd.js";
import { buildRig } from "./rig.js";
import { applySafetyLimits, safetyPoses, safetyPoseState } from "./safety.js";
import { puppetLoomProjectSchema } from "./schema.js";
import type { BuildReport, BuildResult, CreateOptions, PuppetLoomProject, SourceDescriptor } from "./types.js";

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function ensureWritableOutput(output: string): Promise<void> {
  try {
    const entries = await readdir(output);
    if (entries.length > 0) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `输出目录不是空目录：${output}`);
  } catch (error) {
    if (error instanceof PuppetLoomError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new PuppetLoomError("IO_ERROR", `无法检查输出目录：${output}`, { cause: error });
  }
  await mkdir(output, { recursive: true });
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
  const output = resolve(options.output);
  await ensureWritableOutput(output);
  const imported = await importPsd(input);
  const inspection = inspectionFromImported(imported);
  const name = options.name?.trim() || parse(input).name;
  const source: SourceDescriptor = {
    originalFileName: basename(input),
    psdSha256: await sha256(input),
    psdPath: "source/source.psd"
  };
  if (options.reference) {
    source.referencePath = "source/reference.png";
    source.referenceSha256 = await sha256(resolve(options.reference));
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

  for (const directory of ["source", "textures", "reports", "requests", "supplements"]) await mkdir(join(output, directory), { recursive: true });
  await copyFile(input, join(output, "source", "source.psd"));
  if (options.reference) await sharp(resolve(options.reference)).png().toFile(join(output, "source", "reference.png"));
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
      left: Math.round(request.crop.x),
      top: Math.round(request.crop.y),
      width: Math.round(request.crop.width),
      height: Math.round(request.crop.height)
    }).png().toFile(target);
  }));
  await writePoseSheet(join(output, "reports", "pose-sheet.png"), imported, project);
  await writeFile(join(output, "puppetloom.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await writeFile(join(output, "reports", "build-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(output, "requests", "asset-requests.json"), `${JSON.stringify(requests, null, 2)}\n`, "utf8");
  return { project, report, assetRequests: requests, outputDirectory: output };
}

export async function loadProject(projectDirectory: string): Promise<PuppetLoomProject> {
  const path = join(resolve(projectDirectory), "puppetloom.json");
  try {
    await access(path);
    return puppetLoomProjectSchema.parse(JSON.parse(await readFile(path, "utf8"))) as PuppetLoomProject;
  } catch (error) {
    throw new PuppetLoomError("INVALID_PROJECT", `无法读取 PuppetLoom 项目：${projectDirectory}`, { cause: error });
  }
}
