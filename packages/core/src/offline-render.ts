import sharp from "sharp";
import { join, resolve } from "node:path";
import { deformedPoints } from "./deform.js";
import { authoredLayersInRenderOrder, authoredOpacityFor, featureGatedMotionState, normalizedBlendMode, type SupportedBlendMode } from "./render-contract.js";
import type { ImportedPsd, PixelBuffer } from "./psd.js";
import type { MotionState, Point, PuppetLoomProject } from "./types.js";

interface RasterPoint extends Point {
  u: number;
  v: number;
}

function edge(a: Point, b: Point, point: Point): number {
  return (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
}

function blend(target: Uint8ClampedArray, index: number, red: number, green: number, blue: number, alphaByte: number, mode: SupportedBlendMode): void {
  const sourceAlpha = alphaByte / 255;
  const targetAlpha = (target[index + 3] ?? 0) / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    const source = ([red, green, blue][channel] ?? 0) / 255 * sourceAlpha;
    const destination = (target[index + channel] ?? 0) / 255 * targetAlpha;
    let output: number;
    if (mode === "multiply") output = source * destination + destination * (1 - sourceAlpha);
    else if (mode === "screen") output = source + destination * (1 - source);
    else if (mode === "add") output = Math.min(1, source + destination);
    else if (mode === "darken") output = Math.min(source, destination);
    else if (mode === "lighten") output = Math.max(source, destination);
    else output = source + destination * (1 - sourceAlpha);
    target[index + channel] = Math.round(Math.max(0, Math.min(1, output / outputAlpha)) * 255);
  }
  target[index + 3] = Math.round(outputAlpha * 255);
}

function sample(source: PixelBuffer, u: number, v: number): [number, number, number, number] {
  const sourceX = Math.max(0, Math.min(source.width - 1, u * (source.width - 1)));
  const sourceY = Math.max(0, Math.min(source.height - 1, v * (source.height - 1)));
  const left = Math.floor(sourceX); const right = Math.min(source.width - 1, left + 1);
  const top = Math.floor(sourceY); const bottom = Math.min(source.height - 1, top + 1);
  const fractionX = sourceX - left; const fractionY = sourceY - top;
  const channel = (offset: number): number => {
    const topValue = (source.data[(top * source.width + left) * 4 + offset] ?? 0) * (1 - fractionX)
      + (source.data[(top * source.width + right) * 4 + offset] ?? 0) * fractionX;
    const bottomValue = (source.data[(bottom * source.width + left) * 4 + offset] ?? 0) * (1 - fractionX)
      + (source.data[(bottom * source.width + right) * 4 + offset] ?? 0) * fractionX;
    return topValue * (1 - fractionY) + bottomValue * fractionY;
  };
  return [channel(0), channel(1), channel(2), channel(3)];
}

function rasterTriangle(
  output: PixelBuffer,
  source: PixelBuffer,
  triangle: [RasterPoint, RasterPoint, RasterPoint],
  opacity: number,
  clipMask: Uint8Array | undefined,
  blendMode: SupportedBlendMode,
  maskOutput?: Uint8Array,
  coverage?: Uint8Array
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
      const pixelIndex = y * output.width + x;
      if (clipMask && clipMask[pixelIndex] !== 1) continue;
      const point = { x: x + 0.5, y: y + 0.5 };
      const wa = edge(b, c, point) / area;
      const wb = edge(c, a, point) / area;
      const wc = 1 - wa - wb;
      if (wa < -1e-5 || wb < -1e-5 || wc < -1e-5) continue;
      if (coverage?.[pixelIndex] === 1) continue;
      if (coverage) coverage[pixelIndex] = 1;
      const u = Math.max(0, Math.min(1, a.u * wa + b.u * wb + c.u * wc));
      const v = Math.max(0, Math.min(1, a.v * wa + b.v * wb + c.v * wc));
      const [red, green, blue, sampledAlpha] = sample(source, u, v);
      if (maskOutput) {
        if (sampledAlpha / 255 > 0.01) maskOutput[pixelIndex] = 1;
        continue;
      }
      const alpha = Math.round(sampledAlpha * opacity);
      if (alpha <= 0) continue;
      blend(output.data, pixelIndex * 4, red, green, blue, alpha, blendMode);
    }
  }
}

export function renderProjectPoseWithSources(project: PuppetLoomProject, sources: Map<string, PixelBuffer>, state: MotionState, width: number, height: number): PixelBuffer {
  const renderState = featureGatedMotionState(project, state);
  const output: PixelBuffer = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const scale = Math.min(width / project.canvas.width, height / project.canvas.height);
  const drawnWidth = project.canvas.width * scale;
  const drawnHeight = project.canvas.height * scale;
  const offsetX = (width - drawnWidth) * 0.5;
  const offsetY = (height - drawnHeight) * 0.5;
  const toPixel = (point: Point): Point => ({ x: offsetX + point.x * project.canvas.width * scale, y: offsetY + point.y * project.canvas.height * scale });
  const clipMasks = new Map<string, Uint8Array>();
  const maskFor = (layerId: string): Uint8Array | undefined => {
    const existing = clipMasks.get(layerId);
    if (existing) return existing;
    const layer = project.layers.find((candidate) => candidate.id === layerId);
    const source = sources.get(layerId);
    if (!layer || !source) return undefined;
    const mask = new Uint8Array(width * height);
    const points = deformedPoints(project, layer, renderState);
    for (let index = 0; index < layer.mesh.triangles.length; index += 3) {
      const indices = layer.mesh.triangles.slice(index, index + 3);
      if (indices.length !== 3) continue;
      const raster = indices.map((pointIndex) => ({ ...toPixel(points[pointIndex]!), u: layer.mesh.uvs[pointIndex]!.x, v: layer.mesh.uvs[pointIndex]!.y })) as [RasterPoint, RasterPoint, RasterPoint];
      rasterTriangle(output, source, raster, 1, undefined, "normal", mask);
    }
    clipMasks.set(layerId, mask);
    return mask;
  };
  for (const layer of authoredLayersInRenderOrder(project, renderState)) {
    const source = sources.get(layer.id);
    const opacity = authoredOpacityFor(project, layer, renderState);
    if (!source || opacity <= 0) continue;
    const points = deformedPoints(project, layer, renderState);
    const clip = layer.clipLayerId ? maskFor(layer.clipLayerId) : undefined;
    const coverage = new Uint8Array(width * height);
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
      rasterTriangle(output, source, [a, b, c], opacity, clip, normalizedBlendMode(layer.blendMode), undefined, coverage);
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
