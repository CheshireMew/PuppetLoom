import type { PixelBuffer } from "./psd.js";
import type { LayerBinding, ModelBinding, Point, Rect } from "./types.js";
import { meshPointAtUv } from "./mesh.js";

export interface EyeInkProfile {
  bounds: Rect;
  /** Alpha-weighted source centre, in project coordinates, one sample per texture column. */
  centerline: number[];
  textureBounds: Rect;
}

/** Read the painted shape, independently of mesh topology and transparent texture padding. */
export function eyeInkProfile(layer: LayerBinding, pixels: PixelBuffer): EyeInkProfile | undefined {
  const { width, height, data } = pixels;
  if (width < 1 || height < 1 || data.length !== width * height * 4) throw new Error("Invalid eye texture dimensions");
  const samples = new Array<number>(width).fill(Number.NaN);
  let left = width, right = -1, top = height, bottom = -1;
  for (let x = 0; x < width; x++) {
    let weight = 0, weightedY = 0;
    for (let y = 0; y < height; y++) {
      const alpha = data[(y * width + x) * 4 + 3]!;
      if (!alpha) continue;
      weight += alpha;
      weightedY += (y + 0.5) * alpha;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    if (weight) samples[x] = layer.bounds.y + weightedY / weight / height * layer.bounds.height;
  }
  if (right < 0) return undefined;
  let previous = left;
  for (let x = 0; x < left; x++) samples[x] = samples[left]!;
  for (let x = left + 1; x <= right; x++) {
    if (!Number.isFinite(samples[x])) continue;
    for (let gap = previous + 1; gap < x; gap++) {
      samples[gap] = samples[previous]! + (samples[x]! - samples[previous]!) * (gap - previous) / (x - previous);
    }
    previous = x;
  }
  for (let x = right + 1; x < width; x++) samples[x] = samples[right]!;
  return {
    bounds: {
      x: layer.bounds.x + left / width * layer.bounds.width,
      y: layer.bounds.y + top / height * layer.bounds.height,
      width: (right + 1 - left) / width * layer.bounds.width,
      height: (bottom + 1 - top) / height * layer.bounds.height
    },
    textureBounds: { ...layer.bounds }, centerline: samples
  };
}

function sampleInk(profile: EyeInkProfile, x: number): number {
  const position = Math.max(0, Math.min(profile.centerline.length - 1,
    (x - profile.textureBounds.x) / profile.textureBounds.width * profile.centerline.length - 0.5));
  const left = Math.floor(position), right = Math.min(profile.centerline.length - 1, left + 1);
  return profile.centerline[left]! + (profile.centerline[right]! - profile.centerline[left]!) * (position - left);
}

/** Shared eye-white/lash target. Inspired by PSD2Live's eyeClosurePoint and alpha centreline. */
export function closedEyePoint(point: Point, role: "eyeWhite" | "eyelash", ink: EyeInkProfile, white: EyeInkProfile): Point {
  const bounds = white.bounds;
  const u = Math.max(-1, Math.min(1, (point.x - bounds.x - bounds.width / 2) / (bounds.width / 2)));
  const target = bounds.y + bounds.height * (0.34 + 0.38 * (1 - u * u));
  // Preserve lash ink thickness; collapse the aperture rather than fading the iris.
  const anchor = role === "eyelash" ? sampleInk(ink, point.x) : bounds.y + bounds.height / 2;
  const scale = role === "eyelash" ? 0.88 : 0.02;
  return { x: point.x, y: target + (point.y - anchor) * scale };
}

/** Produces editable endpoint keyforms; activation and opacity are the caller's responsibility. */
export function eyeClosureBinding(layer: LayerBinding, pixels: PixelBuffer, whiteLayer: LayerBinding, whitePixels: PixelBuffer, parameterId: string): ModelBinding {
  if (layer.role !== "eyeWhite" && layer.role !== "eyelash") throw new Error("Eye closure geometry requires an eye-white or eyelash layer");
  if (whiteLayer.role !== "eyeWhite" || layer.side !== whiteLayer.side) throw new Error("Eye closure requires a matching eye-white side");
  const ink = eyeInkProfile(layer, pixels), white = eyeInkProfile(whiteLayer, whitePixels);
  if (!ink || !white) throw new Error("Eye closure requires painted eye-white and eyelash pixels");
  const restWhiteMesh = { ...whiteLayer.mesh, points: whiteLayer.mesh.uvs.map(uv => ({
    x: whiteLayer.bounds.x + uv.x * whiteLayer.bounds.width,
    y: whiteLayer.bounds.y + uv.y * whiteLayer.bounds.height
  })) };
  return {
    id: `eye-closure-${layer.id}`, blinkMode: "geometry", parameterIds: [parameterId], target: { kind: "layer", id: layer.id },
    keyforms: [
      { values: [0], meshPointDeltas: {} },
      { values: [1], meshPointDeltas: Object.fromEntries(layer.mesh.points.map((point, index) => {
        const uv = layer.mesh.uvs[index]!;
        const source = { x: layer.bounds.x + uv.x * layer.bounds.width, y: layer.bounds.y + uv.y * layer.bounds.height };
        const closed = closedEyePoint(source, layer.role as "eyeWhite" | "eyelash", ink, white);
        // The target belongs to the eye-white surface. Transport the original-art
        // displacement through that surface, retaining the layer's existing edits.
        const whiteUv = (p: Point) => ({ x: (p.x - whiteLayer.bounds.x) / whiteLayer.bounds.width, y: (p.y - whiteLayer.bounds.y) / whiteLayer.bounds.height });
        const mappedSource = meshPointAtUv(whiteLayer.mesh, whiteUv(source));
        const mappedClosed = meshPointAtUv(whiteLayer.mesh, whiteUv(closed));
        // The aperture must converge to one surface. Retaining each vertex's
        // unrelated neutral edit after compression can reverse its thin rows.
        if (layer.role === "eyeWhite") return [String(index), {
          x: mappedClosed.x - point.x,
          y: mappedClosed.y - point.y
        }];
        const restSource = meshPointAtUv(restWhiteMesh, whiteUv(source));
        const restClosed = meshPointAtUv(restWhiteMesh, whiteUv(closed));
        return [String(index), {
          x: closed.x - source.x + mappedClosed.x - mappedSource.x - (restClosed.x - restSource.x),
          y: closed.y - source.y + mappedClosed.y - mappedSource.y - (restClosed.y - restSource.y)
        }];
      })) }
    ]
  };
}
