import type { LayerBinding, Point } from "./types.js";

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(value: number): number {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

export interface FrontHairSideGeometry {
  u: number;
  v: number;
  screenSide: -1 | 1;
  root: Point;
  tip: Point;
  progress: number;
  sideMask: number;
  sideRelease: number;
  bangRelease: number;
  totalRelease: number;
}

/**
 * Resolves the two face-framing strands against their own roots. Keeping this
 * geometry shared prevents authoring keyforms and runtime physics from bending
 * a side strand around the centre of the complete front-hair bitmap.
 */
export function frontHairSideGeometry(layer: LayerBinding, point: Point): FrontHairSideGeometry {
  const width = Math.max(1e-6, layer.bounds.width);
  const height = Math.max(1e-6, layer.bounds.height);
  const u = clamp((point.x - layer.bounds.x) / width);
  const v = clamp((point.y - layer.bounds.y) / height);
  const screenSide: -1 | 1 = u < 0.5 ? -1 : 1;
  const commonRootY = layer.secondaryAnchors?.frontHairRoot?.y ?? layer.bounds.y + height * 0.52;
  const root = screenSide < 0
    ? layer.secondaryAnchors?.frontHairRootLeft ?? { x: layer.bounds.x + width * 0.18, y: commonRootY }
    : layer.secondaryAnchors?.frontHairRootRight ?? { x: layer.bounds.x + width * 0.82, y: commonRootY };
  const tip = screenSide < 0
    ? layer.secondaryAnchors?.frontHairTipLeft ?? { x: layer.bounds.x + width * 0.1, y: layer.bounds.y + height }
    : layer.secondaryAnchors?.frontHairTipRight ?? { x: layer.bounds.x + width * 0.9, y: layer.bounds.y + height };
  const length = Math.max(height * 0.28, tip.y - root.y);
  const progress = clamp((point.y - root.y) / length);
  const expectedX = root.x + (tip.x - root.x) * progress;
  const distanceFromStrand = Math.abs(point.x - expectedX) / Math.max(1e-6, width * 0.3);
  const strandProximity = 1 - smoothstep((distanceFromStrand - 0.2) / 0.8);
  const outerBand = smoothstep((Math.abs(u - 0.5) - 0.18) / 0.27);
  const strandMask = Math.max(outerBand, strandProximity * 0.9);
  const sideRelease = smoothstep(progress) ** 1.3 * strandMask;
  const rootV = clamp((commonRootY - layer.bounds.y) / height, 0.35, 0.78);
  const bangRelease = smoothstep((v - rootV) / Math.max(0.08, 1 - rootV)) ** 1.35 * (1 - outerBand) * 0.22;
  return {
    u,
    v,
    screenSide,
    root,
    tip,
    progress,
    sideMask: strandMask,
    sideRelease,
    bangRelease,
    totalRelease: Math.max(sideRelease, bangRelease)
  };
}

/**
 * Selects the ahoge branch without accidentally selecting the complete crown.
 * A vertical-only test marks every scalp vertex above the root as ahoge and
 * makes the crown wobble with secondary motion. The narrow root collar blends
 * from the stationary scalp attachment into the rigid branch; all vertices
 * above that collar receive the same hinge rotation.
 */
export function ahogeHingeWeight(layer: LayerBinding, point: Point): number {
  if (layer.role !== "frontHair") return 0;
  const root = layer.secondaryAnchors?.ahogeRoot;
  if (!root) return 0;
  const height = Math.max(1e-6, layer.bounds.height);
  const aboveRoot = (root.y - point.y) / height;
  if (aboveRoot <= 0.004) return 0;
  const rootRelease = smoothstep((aboveRoot - 0.004) / 0.052);
  // Measure the hinge corridor against the strand's height, not the complete
  // front-hair bitmap width. A narrow crop otherwise creates an abrupt weight
  // cliff across one triangle, while a wide crop accidentally includes scalp.
  const horizontalDistance = Math.abs(point.x - root.x) / height;
  // The corridor widens with height so a curled tip remains selected while
  // the broad crown immediately beside the joint remains outside the hinge.
  const heightProgress = clamp(aboveRoot / 0.28);
  const corridorHalfWidth = 0.06 + heightProgress ** 1.5 * 0.31;
  const corridorSoftness = 0.1 + heightProgress * 0.1;
  if (horizontalDistance >= corridorHalfWidth + corridorSoftness) return 0;
  const corridor = 1 - smoothstep((horizontalDistance - corridorHalfWidth) / corridorSoftness);
  return clamp(rootRelease * corridor);
}

export function ahogeMembership(layer: LayerBinding, point: Point): 0 | 1 {
  return ahogeHingeWeight(layer, point) >= 0.5 ? 1 : 0;
}

/** Marks only vertices that may participate in front-hair secondary motion. */
export function frontHairPhysicsMask(layer: LayerBinding, point: Point): 0 | 1 {
  if (layer.role !== "frontHair") return 0;
  const release = Math.max(frontHairSideGeometry(layer, point).totalRelease, ahogeHingeWeight(layer, point));
  return release > 1e-4 ? 1 : 0;
}

export function rotateAround(point: Point, pivot: Point, radians: number): Point {
  if (Math.abs(radians) < 1e-12) return { ...point };
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point.x - pivot.x;
  const y = point.y - pivot.y;
  return {
    x: pivot.x + x * cosine - y * sine,
    y: pivot.y + x * sine + y * cosine
  };
}

export function rotationDelta(point: Point, pivot: Point, radians: number): Point {
  const rotated = rotateAround(point, pivot, radians);
  return { x: rotated.x - point.x, y: rotated.y - point.y };
}
