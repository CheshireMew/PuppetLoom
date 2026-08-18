import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { neutralMotionState } from "./deform.js";
import { ModelPhysicsController } from "./model.js";
import { loadProjectTextureSources, renderProjectPoseWithSources } from "./offline-render.js";
import type { AuthoringPreview, MotionState, PuppetLoomProject, Rect } from "./types.js";

export interface AgentFocusEvidence {
  region: Rect;
  comparisonSheet: string;
  motionSheet: string;
  motionManifest: string;
  motionFrameDirectory: string;
  frameCount: number;
  artifactSha256: Record<"comparisonSheet" | "motionSheet" | "motionManifest", string>;
}

// Evidence is a review surface for the external Agent, not a thumbnail. Keep
// enough native pixels for hair contours, eye perspective and mesh artefacts.
const renderSize = 1080;
const panelSize = 600;

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function union(left: Rect, right: Rect): Rect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const endX = Math.max(left.x + left.width, right.x + right.width);
  const endY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: endX - x, height: endY - y };
}

export function agentTargetRegion(before: PuppetLoomProject, after: PuppetLoomProject, targetLayerIds: string[]): Rect {
  const ids = new Set(targetLayerIds);
  const bounds = [...before.layers, ...after.layers].filter((layer) => ids.has(layer.id)).map((layer) => layer.bounds);
  if (bounds.length === 0) throw new Error("局部证据没有可用的目标图层。");
  let region = bounds.slice(1).reduce(union, bounds[0]!);
  const centerX = region.x + region.width * 0.5;
  const centerY = region.y + region.height * 0.5;
  const paddedPixelWidth = Math.max(before.canvas.width * 0.16, region.width * before.canvas.width * 1.42);
  const paddedPixelHeight = Math.max(before.canvas.height * 0.16, region.height * before.canvas.height * 1.42);
  const squarePixelSize = Math.max(paddedPixelWidth, paddedPixelHeight);
  const width = Math.min(1, squarePixelSize / before.canvas.width);
  const height = Math.min(1, squarePixelSize / before.canvas.height);
  region = {
    x: Math.max(0, Math.min(1 - width, centerX - width * 0.5)),
    y: Math.max(0, Math.min(1 - height, centerY - height * 0.5)),
    width,
    height
  };
  return Object.fromEntries(Object.entries(region).map(([key, value]) => [key, rounded(value)])) as unknown as Rect;
}

export function agentRegionCrop(project: PuppetLoomProject, region: Rect, width = renderSize, height = renderSize): { left: number; top: number; width: number; height: number } {
  const scale = Math.min(width / project.canvas.width, height / project.canvas.height);
  const offsetX = (width - project.canvas.width * scale) * 0.5;
  const offsetY = (height - project.canvas.height * scale) * 0.5;
  const left = Math.max(0, Math.floor(offsetX + region.x * project.canvas.width * scale));
  const top = Math.max(0, Math.floor(offsetY + region.y * project.canvas.height * scale));
  const right = Math.min(width, Math.ceil(offsetX + (region.x + region.width) * project.canvas.width * scale));
  const bottom = Math.min(height, Math.ceil(offsetY + (region.y + region.height) * project.canvas.height * scale));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function previewState(project: PuppetLoomProject, preview: AuthoringPreview): MotionState {
  const initial: MotionState = {
    ...neutralMotionState,
    ...(preview.parameters ? { parameters: preview.parameters } : {}),
    ...(preview.expressions ? { expressions: preview.expressions } : {}),
    ...(preview.behavior ? { behavior: preview.behavior, timeSeconds: preview.behavior.timeSeconds } : {})
  };
  if (!preview.settleSeconds || preview.settleSeconds <= 0) return initial;
  const controller = new ModelPhysicsController(project);
  let current = initial;
  const frames = Math.max(1, Math.ceil(preview.settleSeconds * 60));
  for (let frame = 0; frame <= frames; frame += 1) current = controller.sample({ ...initial, timeSeconds: frame / 60 }, frame / 60);
  return current;
}

function selectedPreviews(previews: AuthoringPreview[]): AuthoringPreview[] {
  if (previews.length <= 9) return previews;
  const indices = [0, 1, 2, Math.floor(previews.length / 2) - 1, Math.floor(previews.length / 2), Math.floor(previews.length / 2) + 1, previews.length - 3, previews.length - 2, previews.length - 1];
  return [...new Set(indices)].map((index) => previews[Math.max(0, Math.min(previews.length - 1, index))]!);
}

async function checkerboard(): Promise<Buffer> {
  const cell = 22;
  const cells = Math.ceil(panelSize / cell);
  const overlays: sharp.OverlayOptions[] = [];
  for (let y = 0; y < cells; y += 1) for (let x = 0; x < cells; x += 1) if ((x + y) % 2 === 0) overlays.push({
    input: { create: { width: cell, height: cell, channels: 4, background: { r: 35, g: 43, b: 57, alpha: 1 } } },
    left: x * cell,
    top: y * cell
  });
  return sharp({ create: { width: panelSize, height: panelSize, channels: 4, background: { r: 25, g: 32, b: 44, alpha: 1 } } }).composite(overlays).png().toBuffer();
}

async function renderFocus(project: PuppetLoomProject, sources: Awaited<ReturnType<typeof loadProjectTextureSources>>, state: MotionState, region: Rect, background: Buffer): Promise<Buffer> {
  const pixels = renderProjectPoseWithSources(project, sources, state, renderSize, renderSize);
  const crop = agentRegionCrop(project, region);
  const image = await sharp(Buffer.from(pixels.data), { raw: { width: renderSize, height: renderSize, channels: 4 } })
    .extract(crop)
    .resize(panelSize, panelSize, { fit: "contain" })
    .png()
    .toBuffer();
  return sharp(background).composite([{ input: image, gravity: "center" }]).png().toBuffer();
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function pairPanel(before: Buffer, after: Buffer, label: string): Promise<Buffer> {
  const header = Buffer.from(`<svg width="${panelSize * 2}" height="34" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111827"/><text x="12" y="23" fill="#f8fafc" font-family="Segoe UI, Microsoft YaHei" font-size="15">${xml(label)}</text><text x="${panelSize - 52}" y="23" fill="#94a3b8" font-size="12">修改前</text><text x="${panelSize * 2 - 52}" y="23" fill="#94a3b8" font-size="12">修改后</text></svg>`);
  return sharp({ create: { width: panelSize * 2, height: panelSize + 34, channels: 4, background: { r: 10, g: 15, b: 24, alpha: 1 } } })
    .composite([{ input: header, left: 0, top: 0 }, { input: before, left: 0, top: 34 }, { input: after, left: panelSize, top: 34 }])
    .png()
    .toBuffer();
}

export async function renderAgentMotionSheet(manifestPath: string, outputPath = join(dirname(manifestPath), "focus-motion-sheet.png")): Promise<string> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { frames?: Array<{ path?: string }> };
  const framePaths = manifest.frames?.map((frame) => frame.path).filter((path): path is string => Boolean(path)) ?? [];
  if (framePaths.length === 0) throw new Error(`连续运动 manifest 没有帧：${manifestPath}`);
  const metadata = await sharp(framePaths[0]!).metadata();
  const width = metadata.width ?? panelSize * 2;
  const height = metadata.height ?? panelSize + 34;
  const columns = Math.min(4, framePaths.length);
  const rows = Math.ceil(framePaths.length / columns);
  await sharp({ create: { width: width * columns, height: height * rows, channels: 4, background: { r: 8, g: 12, b: 18, alpha: 1 } } })
    .composite(framePaths.map((input, index) => ({ input, left: index % columns * width, top: Math.floor(index / columns) * height })))
    .png()
    .toFile(outputPath);
  return outputPath;
}

function motionState(frame: number, total: number): MotionState {
  const phase = frame / total * Math.PI * 2;
  const horizontal = Math.sin(phase);
  const vertical = Math.sin(phase * 2) * 0.45;
  const blinkPhase = frame % Math.max(6, Math.floor(total / 2));
  const blink = blinkPhase === 1 ? 0.5 : blinkPhase === 2 ? 1 : blinkPhase === 3 ? 0.5 : 0;
  const mouthOpen = (Math.sin(phase - Math.PI * 0.5) + 1) * 0.5;
  return {
    ...neutralMotionState,
    headYaw: horizontal * 0.82,
    headPitch: vertical,
    headRoll: horizontal * 0.18,
    bodySway: horizontal * 0.45,
    bodyPitch: vertical * 0.32,
    bodyRoll: horizontal * 0.22,
    gazeX: horizontal * 0.72,
    gazeY: vertical * 0.55,
    breath: Math.sin(phase) * 0.7,
    hairX: -horizontal * 0.024,
    backHairX: -horizontal * 0.038,
    ahogeX: -horizontal * 0.045,
    headwearX: -horizontal * 0.018,
    earY: -Math.abs(horizontal) * 0.018,
    clothX: -horizontal * 0.02,
    tailX: -horizontal * 0.07,
    tailY: -vertical * 0.045,
    accessoryX: -horizontal * 0.05,
    blink,
    mouthOpen
  };
}

/** Produces close-up review evidence plus ordered frames that the desktop can play as a loop. */
export async function renderAgentFocusEvidence(
  projectDirectory: string,
  before: PuppetLoomProject,
  after: PuppetLoomProject,
  targetLayerIds: string[],
  previews: AuthoringPreview[],
  outputDirectory: string
): Promise<AgentFocusEvidence> {
  const region = agentTargetRegion(before, after, targetLayerIds);
  const [beforeSources, afterSources, background] = await Promise.all([
    loadProjectTextureSources(projectDirectory, before),
    loadProjectTextureSources(projectDirectory, after),
    checkerboard()
  ]);
  await mkdir(outputDirectory, { recursive: true });
  const chosen = selectedPreviews(previews.length > 0 ? previews : [{ id: "neutral", label: "中立" }]);
  const panels: Buffer[] = [];
  for (const preview of chosen) {
    const [beforeImage, afterImage] = await Promise.all([
      renderFocus(before, beforeSources, previewState(before, preview), region, background),
      renderFocus(after, afterSources, previewState(after, preview), region, background)
    ]);
    panels.push(await pairPanel(beforeImage, afterImage, preview.label));
  }
  const columns = panels.length === 1 ? 1 : panels.length <= 4 ? 2 : 3;
  const rows = Math.ceil(panels.length / columns);
  const cellWidth = panelSize * 2;
  const cellHeight = panelSize + 34;
  const sheet = join(outputDirectory, "focus-before-after.png");
  await sharp({ create: { width: cellWidth * columns, height: cellHeight * rows, channels: 4, background: { r: 8, g: 12, b: 18, alpha: 1 } } })
    .composite(panels.map((input, index) => ({ input, left: index % columns * cellWidth, top: Math.floor(index / columns) * cellHeight })))
    .png()
    .toFile(sheet);

  const motionDirectory = join(outputDirectory, "focus-motion");
  await mkdir(motionDirectory, { recursive: true });
  const beforePhysics = new ModelPhysicsController(before);
  const afterPhysics = new ModelPhysicsController(after);
  const frameCount = 16;
  const frames: Array<{ index: number; path: string; timeSeconds: number }> = [];
  for (let index = 0; index < frameCount; index += 1) {
    const timeSeconds = index / 12;
    const base = { ...motionState(index, frameCount), timeSeconds };
    const beforeState = beforePhysics.sample(base, timeSeconds);
    const afterState = afterPhysics.sample(base, timeSeconds);
    const [beforeImage, afterImage] = await Promise.all([
      renderFocus(before, beforeSources, beforeState, region, background),
      renderFocus(after, afterSources, afterState, region, background)
    ]);
    const framePath = join(motionDirectory, `frame-${String(index).padStart(3, "0")}.png`);
    await writeFile(framePath, await pairPanel(beforeImage, afterImage, `连续运动 · ${(timeSeconds).toFixed(2)}s`));
    frames.push({ index, path: framePath, timeSeconds: rounded(timeSeconds) });
  }
  const manifestPath = join(outputDirectory, "focus-motion.json");
  const manifest = Buffer.from(`${JSON.stringify({ version: 1, delayMilliseconds: 83, loop: true, region, frames }, null, 2)}\n`);
  await writeFile(manifestPath, manifest);
  const motionSheet = await renderAgentMotionSheet(manifestPath, join(outputDirectory, "focus-motion-sheet.png"));
  const [sheetBuffer, motionSheetBuffer] = await Promise.all([readFile(sheet), readFile(motionSheet)]);
  return {
    region,
    comparisonSheet: sheet,
    motionSheet,
    motionManifest: manifestPath,
    motionFrameDirectory: motionDirectory,
    frameCount,
    artifactSha256: { comparisonSheet: sha256(sheetBuffer), motionSheet: sha256(motionSheetBuffer), motionManifest: sha256(manifest) }
  };
}
