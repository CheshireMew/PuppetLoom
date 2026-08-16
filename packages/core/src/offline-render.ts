import sharp from "sharp";
import { join, resolve } from "node:path";
import { deformedPoints } from "./deform.js";
import type { ImportedPsd, PixelBuffer } from "./psd.js";
import type { MotionState, Point, PuppetLoomProject, Rect } from "./types.js";

interface RasterPoint extends Point {
  u: number;
  v: number;
}

function deformedBounds(project: PuppetLoomProject, layerId: string, state: MotionState): Rect | undefined {
  const layer = project.layers.find((candidate) => candidate.id === layerId);
  if (!layer) return undefined;
  const points = deformedPoints(project, layer, state);
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { x, y, width: right - x, height: bottom - y };
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function renderedOpacity(layer: PuppetLoomProject["layers"][number], state: MotionState): number {
  if (layer.role === "eyeClosed") return layer.opacity === 0 ? state.blink : layer.opacity * state.blink;
  if (layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash") return layer.opacity * (1 - state.blink);
  if (layer.role !== "mouth") return layer.opacity;
  const openness = Math.max(0, Math.min(1, state.mouthOpen));
  const variant = layer.mouthVariant ?? "closed";
  if (variant === "closed") return layer.opacity * (1 - smoothstep(openness / 0.42));
  if (variant === "slight") return layer.opacity * smoothstep(openness / 0.42) * (1 - smoothstep((openness - 0.5) / 0.38));
  return layer.opacity * smoothstep((openness - 0.42) / 0.58);
}

function edge(a: Point, b: Point, point: Point): number {
  return (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
}

function over(target: Uint8ClampedArray, index: number, red: number, green: number, blue: number, alphaByte: number): void {
  const sourceAlpha = alphaByte / 255;
  const targetAlpha = (target[index + 3] ?? 0) / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  target[index] = Math.round((red * sourceAlpha + (target[index] ?? 0) * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  target[index + 1] = Math.round((green * sourceAlpha + (target[index + 1] ?? 0) * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  target[index + 2] = Math.round((blue * sourceAlpha + (target[index + 2] ?? 0) * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  target[index + 3] = Math.round(outputAlpha * 255);
}

function rasterTriangle(
  output: PixelBuffer,
  source: PixelBuffer,
  triangle: [RasterPoint, RasterPoint, RasterPoint],
  opacity: number,
  clip: Rect | undefined,
  pixelToNormalized: (x: number, y: number) => Point
): void {
  const [a, b, c] = triangle;
  const area = edge(a, b, c);
  if (Math.abs(area) < 1e-8) return;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(output.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(output.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (clip) {
        const normalized = pixelToNormalized(x + 0.5, y + 0.5);
        if (normalized.x < clip.x || normalized.y < clip.y || normalized.x > clip.x + clip.width || normalized.y > clip.y + clip.height) continue;
      }
      const point = { x: x + 0.5, y: y + 0.5 };
      const wa = edge(b, c, point) / area;
      const wb = edge(c, a, point) / area;
      const wc = 1 - wa - wb;
      if (wa < -1e-5 || wb < -1e-5 || wc < -1e-5) continue;
      const u = Math.max(0, Math.min(1, a.u * wa + b.u * wb + c.u * wc));
      const v = Math.max(0, Math.min(1, a.v * wa + b.v * wb + c.v * wc));
      const sx = Math.min(source.width - 1, Math.round(u * (source.width - 1)));
      const sy = Math.min(source.height - 1, Math.round(v * (source.height - 1)));
      const sourceIndex = (sy * source.width + sx) * 4;
      const alpha = Math.round((source.data[sourceIndex + 3] ?? 0) * opacity);
      if (alpha <= 0) continue;
      over(output.data, (y * output.width + x) * 4, source.data[sourceIndex] ?? 0, source.data[sourceIndex + 1] ?? 0, source.data[sourceIndex + 2] ?? 0, alpha);
    }
  }
}

export function renderProjectPoseWithSources(project: PuppetLoomProject, sources: Map<string, PixelBuffer>, state: MotionState, width: number, height: number): PixelBuffer {
  const output: PixelBuffer = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const scale = Math.min(width / project.canvas.width, height / project.canvas.height);
  const drawnWidth = project.canvas.width * scale;
  const drawnHeight = project.canvas.height * scale;
  const offsetX = (width - drawnWidth) * 0.5;
  const offsetY = (height - drawnHeight) * 0.5;
  const toPixel = (point: Point): Point => ({ x: offsetX + point.x * project.canvas.width * scale, y: offsetY + point.y * project.canvas.height * scale });
  const pixelToNormalized = (x: number, y: number): Point => ({ x: (x - offsetX) / Math.max(1, drawnWidth), y: (y - offsetY) / Math.max(1, drawnHeight) });
  for (const layer of [...project.layers].sort((left, right) => left.order - right.order)) {
    const source = sources.get(layer.id);
    const opacity = renderedOpacity(layer, state);
    if (!source || opacity <= 0) continue;
    const points = deformedPoints(project, layer, state);
    const clip = layer.clipLayerId ? deformedBounds(project, layer.clipLayerId, state) : undefined;
    for (let index = 0; index < layer.mesh.triangles.length; index += 3) {
      const ia = layer.mesh.triangles[index];
      const ib = layer.mesh.triangles[index + 1];
      const ic = layer.mesh.triangles[index + 2];
      if (ia === undefined || ib === undefined || ic === undefined) continue;
      const pa = points[ia]; const pb = points[ib]; const pc = points[ic];
      const ua = layer.mesh.uvs[ia]; const ub = layer.mesh.uvs[ib]; const uc = layer.mesh.uvs[ic];
      if (!pa || !pb || !pc || !ua || !ub || !uc) continue;
      const a = { ...toPixel(pa), u: ua.x, v: ua.y };
      const b = { ...toPixel(pb), u: ub.x, v: ub.y };
      const c = { ...toPixel(pc), u: uc.x, v: uc.y };
      rasterTriangle(output, source, [a, b, c], opacity, clip, pixelToNormalized);
    }
  }
  return output;
}

export function renderProjectPose(project: PuppetLoomProject, imported: ImportedPsd, state: MotionState, width: number, height: number): PixelBuffer {
  return renderProjectPoseWithSources(project, new Map(imported.layers.map((layer) => [layer.id, layer.pixels])), state, width, height);
}

export async function renderProjectPosePng(project: PuppetLoomProject, imported: ImportedPsd, state: MotionState, width: number, height: number): Promise<Buffer> {
  const pixels = renderProjectPose(project, imported, state, width, height);
  return sharp(Buffer.from(pixels.data), { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export async function loadProjectTextureSources(projectDirectory: string, project: PuppetLoomProject): Promise<Map<string, PixelBuffer>> {
  const root = resolve(projectDirectory);
  const entries = await Promise.all(project.layers.map(async (layer) => {
    const image = await sharp(join(root, layer.texture)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return [layer.id, { width: image.info.width, height: image.info.height, data: new Uint8ClampedArray(image.data) }] as const;
  }));
  return new Map(entries);
}

export async function renderProjectDirectoryPose(
  projectDirectory: string,
  project: PuppetLoomProject,
  state: MotionState,
  width: number,
  height: number
): Promise<PixelBuffer> {
  return renderProjectPoseWithSources(project, await loadProjectTextureSources(projectDirectory, project), state, width, height);
}

export async function renderProjectDirectoryPosePng(
  projectDirectory: string,
  project: PuppetLoomProject,
  state: MotionState,
  width: number,
  height: number
): Promise<Buffer> {
  const pixels = await renderProjectDirectoryPose(projectDirectory, project, state, width, height);
  return sharp(Buffer.from(pixels.data), { raw: { width, height, channels: 4 } }).png().toBuffer();
}
