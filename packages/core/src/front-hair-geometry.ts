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
  bangRoot: Point;
  bangTipY: number;
  bangProgress: number;
  bangMask: number;
  bangRelease: number;
  totalRelease: number;
}

interface FrontHairLayerGeometry {
  width: number;
  height: number;
  commonRootY: number;
  leftRoot: Point;
  rightRoot: Point;
  leftTip: Point;
  rightTip: Point;
  bangRootY: number;
  bangTipY: number;
}

const frontHairLayerGeometryCache = new WeakMap<LayerBinding, FrontHairLayerGeometry>();
const frontHairSideGeometryCache = new WeakMap<LayerBinding, WeakMap<Point, FrontHairSideGeometry>>();
const ahogeHingeWeightCache = new WeakMap<LayerBinding, WeakMap<Point, number>>();

function normalizedU(layer: LayerBinding, point: Point): number {
  return clamp((point.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width));
}

/**
 * Finds the lower edge of the short central fringe independently from the two
 * long face-framing locks. The old implementation normalized every bang
 * vertex against the complete front-hair bitmap height, so a short fringe
 * ending around the eyes never accumulated a useful release weight.
 */
function centralBangTipY(layer: LayerBinding, fallbackRootY: number): number {
  const height = Math.max(1e-6, layer.bounds.height);
  const central = layer.mesh.points.filter((candidate) => {
    const candidateU = normalizedU(layer, candidate);
    return candidateU >= 0.3 && candidateU <= 0.7 && candidate.y > fallbackRootY + height * 0.04;
  });
  const detected = central.length > 0
    ? Math.max(...central.map((candidate) => candidate.y))
    : fallbackRootY + height * 0.34;
  return clamp(detected, fallbackRootY + height * 0.12, layer.bounds.y + height);
}

/**
 * Front-hair geometry is authored per layer and does not change during a
 * render frame. Resolve the contour scan and fallback anchors once for the
 * immutable project layer instead of repeating the full mesh scan per vertex.
 */
function layerGeometry(layer: LayerBinding): FrontHairLayerGeometry {
  const cached = frontHairLayerGeometryCache.get(layer);
  if (cached) return cached;
  const width = Math.max(1e-6, layer.bounds.width);
  const height = Math.max(1e-6, layer.bounds.height);
  const commonRootY = layer.secondaryAnchors?.frontHairRoot?.y ?? layer.bounds.y + height * 0.52;
  const bangRootY = clamp(
    commonRootY - height * 0.14,
    layer.bounds.y + height * 0.26,
    layer.bounds.y + height * 0.44
  );
  const geometry: FrontHairLayerGeometry = {
    width,
    height,
    commonRootY,
    leftRoot: layer.secondaryAnchors?.frontHairRootLeft ?? { x: layer.bounds.x + width * 0.18, y: commonRootY },
    rightRoot: layer.secondaryAnchors?.frontHairRootRight ?? { x: layer.bounds.x + width * 0.82, y: commonRootY },
    leftTip: layer.secondaryAnchors?.frontHairTipLeft ?? { x: layer.bounds.x + width * 0.1, y: layer.bounds.y + height },
    rightTip: layer.secondaryAnchors?.frontHairTipRight ?? { x: layer.bounds.x + width * 0.9, y: layer.bounds.y + height },
    bangRootY,
    bangTipY: centralBangTipY(layer, bangRootY)
  };
  frontHairLayerGeometryCache.set(layer, geometry);
  return geometry;
}

/**
 * Resolves the two face-framing strands against their own roots. Keeping this
 * geometry shared prevents authoring keyforms and runtime physics from bending
 * a side strand around the centre of the complete front-hair bitmap.
 */
export function frontHairSideGeometry(layer: LayerBinding, point: Point): FrontHairSideGeometry {
  let byPoint = frontHairSideGeometryCache.get(layer);
  if (!byPoint) {
    byPoint = new WeakMap();
    frontHairSideGeometryCache.set(layer, byPoint);
  }
  const cached = byPoint.get(point);
  if (cached) return cached;
  const geometry = layerGeometry(layer);
  const { width, height, commonRootY, bangRootY, bangTipY } = geometry;
  const u = normalizedU(layer, point);
  const v = clamp((point.y - layer.bounds.y) / height);
  const screenSide: -1 | 1 = u < 0.5 ? -1 : 1;
  const root = screenSide < 0 ? geometry.leftRoot : geometry.rightRoot;
  const tip = screenSide < 0 ? geometry.leftTip : geometry.rightTip;
  const length = Math.max(height * 0.28, tip.y - root.y);
  const progress = clamp((point.y - root.y) / length);
  const expectedX = root.x + (tip.x - root.x) * progress;
  const distanceFromStrand = Math.abs(point.x - expectedX) / Math.max(1e-6, width * 0.3);
  const strandProximity = 1 - smoothstep((distanceFromStrand - 0.2) / 0.8);
  const outerBand = smoothstep((Math.abs(u - 0.5) - 0.18) / 0.27);
  const strandMask = Math.max(outerBand, strandProximity * 0.9);
  // Central bangs start above the side-lock roots and often finish much
  // earlier than the complete bitmap. Detect their own lower contour, then
  // release each short strand over that local length.
  const bangProgress = clamp((point.y - bangRootY) / Math.max(height * 0.12, bangTipY - bangRootY));
  const bangHorizontal = 1 - smoothstep((Math.abs(u - 0.5) - 0.17) / 0.15);
  // Long side locks can cross the central horizontal band below the short
  // fringe. Stop the bang mask shortly after the detected fringe contour so
  // those locks keep their own roots and motion chain.
  const bangBottomEnvelope = 1 - smoothstep((point.y - bangTipY) / Math.max(1e-6, height * 0.055));
  const bangMask = bangHorizontal * bangBottomEnvelope;
  const atSharedRoot = Math.hypot(point.x - (layer.secondaryAnchors?.frontHairRoot?.x ?? layer.pivot.x), point.y - commonRootY) <= height * 1e-6;
  const bangRelease = atSharedRoot ? 0 : smoothstep((bangProgress - 0.08) / 0.92) ** 1.2 * bangMask;
  // A central fringe tip near either side root previously got claimed by the
  // side-strand proximity test. Give the explicit bang classification
  // precedence while retaining a smooth overlap at its boundary.
  const sideOwnership = 1 - bangMask * 0.9;
  const sideRelease = smoothstep(progress) ** 1.3 * strandMask * sideOwnership;
  const resolved: FrontHairSideGeometry = {
    u,
    v,
    screenSide,
    root,
    tip,
    progress,
    sideMask: strandMask,
    sideRelease,
    bangRoot: { x: point.x, y: bangRootY },
    bangTipY,
    bangProgress,
    bangMask,
    bangRelease,
    totalRelease: Math.max(sideRelease, bangRelease)
  };
  byPoint.set(point, resolved);
  return resolved;
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
  let byPoint = ahogeHingeWeightCache.get(layer);
  if (!byPoint) {
    byPoint = new WeakMap();
    ahogeHingeWeightCache.set(layer, byPoint);
  }
  const cached = byPoint.get(point);
  if (cached !== undefined) return cached;
  const root = layer.secondaryAnchors?.ahogeRoot;
  if (!root) {
    byPoint.set(point, 0);
    return 0;
  }
  const height = Math.max(1e-6, layer.bounds.height);
  const aboveRoot = (root.y - point.y) / height;
  if (aboveRoot <= 0.004) {
    byPoint.set(point, 0);
    return 0;
  }
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
  if (horizontalDistance >= corridorHalfWidth + corridorSoftness) {
    byPoint.set(point, 0);
    return 0;
  }
  const corridor = 1 - smoothstep((horizontalDistance - corridorHalfWidth) / corridorSoftness);
  const weight = clamp(rootRelease * corridor);
  byPoint.set(point, weight);
  return weight;
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
