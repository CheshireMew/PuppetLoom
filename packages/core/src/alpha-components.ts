import type { Point, Rect } from "./types.js";

export interface AlphaRaster {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface AlphaComponent {
  index: number;
  pixelCount: number;
  alphaSum: number;
  bounds: Rect;
  centroid: Point;
}

export interface AlphaComponentAnalysis {
  alphaThreshold: number;
  opaquePixels: number;
  minimumMeaningfulPixels: number;
  components: AlphaComponent[];
  meaningful: AlphaComponent[];
  tiny: AlphaComponent[];
  /** Very small, faint, isolated components that are safe to remove automatically. */
  confirmedNoise: AlphaComponent[];
  /** Small opaque components that may be intentional highlights, hair or decoration. */
  suspectedDetails: AlphaComponent[];
  /** Zero is transparent; opaque pixels contain component index + 1. */
  labels: Int32Array;
}

export interface AnalyzeAlphaOptions {
  alphaThreshold?: number;
  minimumMeaningfulPixels?: number;
  confirmedNoiseMaximumPixels?: number;
  confirmedNoiseMaximumAverageAlpha?: number;
}

function alphaAt(raster: AlphaRaster, pixelIndex: number): number {
  return raster.data[pixelIndex * 4 + 3] ?? 0;
}

/**
 * Deterministic four-neighbour Alpha component analysis shared by PSD import
 * and post-build texture inspection. The caller decides whether tiny regions
 * are confirmed low-confidence pixels or possibly intentional details.
 */
export function analyzeAlphaComponents(raster: AlphaRaster, options: AnalyzeAlphaOptions = {}): AlphaComponentAnalysis {
  const alphaThreshold = options.alphaThreshold ?? 8;
  const pixelTotal = raster.width * raster.height;
  const labels = new Int32Array(pixelTotal);
  const queue = new Int32Array(pixelTotal);
  const components: AlphaComponent[] = [];
  let opaquePixels = 0;

  for (let start = 0; start < pixelTotal; start += 1) {
    if (labels[start] !== 0 || alphaAt(raster, start) <= alphaThreshold) continue;
    const label = components.length + 1;
    labels[start] = label;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    let pixelCount = 0;
    let alphaSum = 0;
    let weightedX = 0;
    let weightedY = 0;
    let left = raster.width;
    let top = raster.height;
    let right = -1;
    let bottom = -1;

    while (head < tail) {
      const current = queue[head++]!;
      const x = current % raster.width;
      const y = Math.floor(current / raster.width);
      const alpha = alphaAt(raster, current);
      pixelCount += 1;
      opaquePixels += 1;
      alphaSum += alpha;
      weightedX += x * alpha;
      weightedY += y * alpha;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);

      const visit = (neighbor: number): void => {
        if (neighbor < 0 || neighbor >= pixelTotal || labels[neighbor] !== 0 || alphaAt(raster, neighbor) <= alphaThreshold) return;
        labels[neighbor] = label;
        queue[tail++] = neighbor;
      };
      if (x > 0) visit(current - 1);
      if (x + 1 < raster.width) visit(current + 1);
      if (y > 0) visit(current - raster.width);
      if (y + 1 < raster.height) visit(current + raster.width);
    }

    components.push({
      index: label - 1,
      pixelCount,
      alphaSum,
      bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 },
      centroid: {
        x: alphaSum > 0 ? weightedX / alphaSum : left + (right - left) * 0.5,
        y: alphaSum > 0 ? weightedY / alphaSum : top + (bottom - top) * 0.5
      }
    });
  }

  const minimumMeaningfulPixels = options.minimumMeaningfulPixels
    ?? Math.max(4, Math.ceil(opaquePixels * 0.0001));
  const sorted = [...components].sort((left, right) => right.pixelCount - left.pixelCount || left.index - right.index);
  const meaningful = sorted.filter((component) => component.pixelCount >= minimumMeaningfulPixels);
  const tiny = sorted.filter((component) => component.pixelCount < minimumMeaningfulPixels);
  const confirmedNoiseMaximumPixels = options.confirmedNoiseMaximumPixels ?? 2;
  const confirmedNoiseMaximumAverageAlpha = options.confirmedNoiseMaximumAverageAlpha ?? 32;
  const confirmedNoise = meaningful.length === 0 ? [] : tiny.filter((component) => (
    component.pixelCount <= confirmedNoiseMaximumPixels
    && component.bounds.width <= 2
    && component.bounds.height <= 2
    && component.alphaSum / Math.max(1, component.pixelCount) <= confirmedNoiseMaximumAverageAlpha
  ));
  const confirmedIndices = new Set(confirmedNoise.map((component) => component.index));
  return {
    alphaThreshold,
    opaquePixels,
    minimumMeaningfulPixels,
    components,
    meaningful,
    tiny,
    confirmedNoise,
    suspectedDetails: tiny.filter((component) => !confirmedIndices.has(component.index)),
    labels
  };
}

export function unionComponentBounds(components: AlphaComponent[]): Rect | undefined {
  if (components.length === 0) return undefined;
  const left = Math.min(...components.map((component) => component.bounds.x));
  const top = Math.min(...components.map((component) => component.bounds.y));
  const right = Math.max(...components.map((component) => component.bounds.x + component.bounds.width));
  const bottom = Math.max(...components.map((component) => component.bounds.y + component.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function pixelsForComponents(raster: AlphaRaster, analysis: AlphaComponentAnalysis, componentIndices: Set<number>): Uint8ClampedArray {
  const output = new Uint8ClampedArray(raster.width * raster.height * 4);
  for (let pixelIndex = 0; pixelIndex < analysis.labels.length; pixelIndex += 1) {
    const label = analysis.labels[pixelIndex] ?? 0;
    let selected = label > 0 && componentIndices.has(label - 1);
    // Alpha <= threshold pixels are normally the one-pixel antialias fringe.
    // Preserve that fringe when it touches a selected opaque component.
    if (!selected && label === 0 && alphaAt(raster, pixelIndex) > 0) {
      const x = pixelIndex % raster.width;
      const y = Math.floor(pixelIndex / raster.width);
      for (let dy = -1; dy <= 1 && !selected; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= raster.width || ny >= raster.height) continue;
          const neighborLabel = analysis.labels[ny * raster.width + nx] ?? 0;
          if (neighborLabel > 0 && componentIndices.has(neighborLabel - 1)) {
            selected = true;
            break;
          }
        }
      }
    }
    if (!selected) continue;
    const offset = pixelIndex * 4;
    output[offset] = raster.data[offset] ?? 0;
    output[offset + 1] = raster.data[offset + 1] ?? 0;
    output[offset + 2] = raster.data[offset + 2] ?? 0;
    output[offset + 3] = raster.data[offset + 3] ?? 0;
  }
  return output;
}
