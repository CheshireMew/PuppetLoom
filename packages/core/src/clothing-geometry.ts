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
 * A supported bell skirt is not a hanging strip of fabric. Its waistband is
 * fixed, the short transition below it eases into motion, and the complete
 * lower shell then moves as one shape so the petticoat volume is retained.
 */
export function skirtStructuralRelease(layer: LayerBinding, point: Point): number {
  return smoothstep01((verticalPosition(layer, point) - 0.2) / 0.18);
}

/** Only the lowest ruffle may pick up motion that is not shared by the shell. */
export function skirtHemFlutterRelease(layer: LayerBinding, point: Point): number {
  return smoothstep01((verticalPosition(layer, point) - 0.84) / 0.16);
}

/**
 * Releases a small amount of deformation through the lower supported shell.
 * It starts well below the waistband, so flexibility cannot loosen the seam.
 */
export function skirtElasticRelease(layer: LayerBinding, point: Point): number {
  return smoothstep01((verticalPosition(layer, point) - 0.46) / 0.42);
}

/** Uses the authored waist pivot while keeping legacy outliers inside the seam band. */
export function skirtSupportPivot(layer: LayerBinding): Point {
  const minimumY = layer.bounds.y + layer.bounds.height * 0.08;
  const maximumY = layer.bounds.y + layer.bounds.height * 0.2;
  return {
    x: clamp(layer.pivot.x, layer.bounds.x, layer.bounds.x + layer.bounds.width),
    y: clamp(layer.pivot.y, minimumY, maximumY)
  };
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
    if (layer.garmentStructure === "supported") return skirtStructuralRelease(layer, point);
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
  if (layer.garmentStructure === "supported") return 1 - skirtStructuralRelease(layer, point) * 0.03;
  const release = smoothstep01((verticalPosition(layer, point) - 0.2) / 0.8);
  return 1 - release * 0.08;
}
