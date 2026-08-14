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
  const featureEntries = Object.entries(project.runtime.features).filter(([key]) => key !== "mouthMotion");
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
    assetRequestCount
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
