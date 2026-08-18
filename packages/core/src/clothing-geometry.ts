import { clamp } from "./math.js";
import type { LayerBinding, Point } from "./types.js";

function smoothstep01(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function verticalPosition(layer: LayerBinding, point: Point): number {
  return clamp((point.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
}

/**
 * Returns how much a garment vertex may move independently from the body.
 * Both sides of the waist seam are locked: the bodice settles before its
 * lower edge, while the skirt starts releasing only below its waistband.
 */
export function clothingSecondaryRelease(layer: LayerBinding, point: Point): number {
  const v = verticalPosition(layer, point);
  if (layer.role === "topWear") {
    const belowUpperAnchor = smoothstep01((v - 0.16) / 0.28);
    const aboveWaistSeam = 1 - smoothstep01((v - 0.58) / 0.24);
    return clamp(belowUpperAnchor * aboveWaistSeam * 0.34, 0, 1);
  }
  if (layer.role === "bottomWear") {
    return smoothstep01((v - 0.2) / 0.8) ** 2;
  }
  if (layer.role === "arm") {
    return smoothstep01((v - 0.08) / 0.92) ** 2;
  }
  return v * v;
}

/** A binary authored mask; the actual falloff is evaluated geometrically. */
export function clothingPhysicsMask(layer: LayerBinding, point: Point): 0 | 1 {
  return clothingSecondaryRelease(layer, point) > 1e-5 ? 1 : 0;
}

/**
 * The skirt must translate with the torso at the waist. The lower hem keeps a
 * small amount of independent inertia, but never the old detached 62% follow.
 */
export function clothingBodyFollow(layer: LayerBinding, point: Point): number {
  if (layer.role !== "bottomWear") return 1;
  const release = smoothstep01((verticalPosition(layer, point) - 0.2) / 0.8);
  return 1 - release * 0.08;
}
