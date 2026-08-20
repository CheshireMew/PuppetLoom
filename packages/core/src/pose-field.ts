import { clamp } from "./math.js";
import type { CoherentPoseField, LayerBinding, Point, SemanticCagePointId, SemanticControlCage, SemanticRole } from "./types.js";
import { ahogeHingeWeight, ahogeMembership, frontHairSideGeometry } from "./front-hair-geometry.js";

const skullRoles = new Set<SemanticRole>(["frontHair", "backHair", "sideHair", "headwear", "ear"]);
const eyeSocketRoles = new Set<SemanticRole>(["eyeWhite", "iris", "eyelash", "eyeClosed"]);
const faceDepthRoles = new Set<SemanticRole>(["face", "nose", "mouth", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow"]);

function smoothstep01(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

interface SidePerspective {
  near: number;
  far: number;
}

function sidePerspective(yaw: number, screenSide: -1 | 0 | 1): SidePerspective {
  const turn = clamp(yaw, -1, 1);
  // When the nose moves to screen-right, the screen-left half of the face is
  // physically nearer to the camera (and vice versa).
  return {
    near: Math.max(0, -turn * screenSide),
    far: Math.max(0, turn * screenSide)
  };
}

function layerScreenSide(layer: LayerBinding): -1 | 0 | 1 {
  // Layer side names are anatomical: the character's left eye is displayed
  // on screen-right in the neutral pose.
  if (layer.side === "left") return 1;
  if (layer.side === "right") return -1;
  return 0;
}

function roleDepth(role: SemanticRole): number {
  if (role === "nose") return 0.22;
  if (role === "mouth") return 0.08;
  if (role === "eyeWhite" || role === "iris" || role === "eyelash" || role === "eyeClosed") return 0.12;
  if (role === "eyebrow") return 0.08;
  if (role === "frontHair") return 0.16;
  if (role === "headwear") return 0.08;
  if (role === "backHair") return -0.18;
  if (role === "sideHair" || role === "ear") return -0.02;
  if (role === "neck") return -0.12;
  return 0;
}

export function faceDepthAt(field: CoherentPoseField, normalizedFaceY: number): number {
  const points = field.faceDepthProfile?.points;
  if (!points || points.length === 0) return 0;
  const y = clamp(normalizedFaceY, 0, 1);
  if (y <= points[0]!.position) return points[0]!.depth;
  if (y >= points.at(-1)!.position) return points.at(-1)!.depth;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!;
    const left = points[index - 1]!;
    if (y > right.position) continue;
    const amount = smoothstep01((y - left.position) / Math.max(1e-9, right.position - left.position));
    return left.depth + (right.depth - left.depth) * amount;
  }
  return 0;
}

function rolePoseBlend(layer: LayerBinding, base: Point): number {
  const { role } = layer;
  if (role === "face" || role === "nose" || role === "mouth" || role === "eyeWhite" || role === "iris" || role === "eyelash" || role === "eyeClosed" || role === "eyebrow") return 1;
  if (role === "ear") return 0.74;
  if (role === "frontHair") {
    const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
    const crown = 1 - smoothstep01((v - 0.38) / 0.52);
    return 0.72 + crown * 0.18;
  }
  if (role === "headwear") return 0.78;
  if (role === "sideHair") return 0.72;
  if (role === "backHair") {
    const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
    const freeEnd = v * v * (3 - 2 * v);
    return 0.8 - freeEnd * 0.35;
  }
  if (role === "neck") {
    const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
    const pinned = v * v * (3 - 2 * v);
    return 1 - pinned;
  }
  return 0.4;
}

interface Surface {
  center: Point;
  radiusX: number;
  radiusY: number;
}

interface Barycentric {
  a: number;
  b: number;
  c: number;
}

type SemanticCageMapping =
  | { kind: "triangle"; ids: [SemanticCagePointId, SemanticCagePointId, SemanticCagePointId]; weights: Barycentric }
  | { kind: "weighted"; entries: Array<{ id: SemanticCagePointId; weight: number }>; total: number };

interface SemanticCageMappingCache {
  face: WeakMap<Point, SemanticCageMapping>;
  skull: WeakMap<Point, SemanticCageMapping>;
}

interface PoseEvaluationCache {
  field: CoherentPoseField;
  cage: SemanticControlCage;
  yawAngle: number;
  pitchAngle: number;
  yaw: number;
  pitch: number;
  projectedFace: Map<SemanticCagePointId, Point>;
  projectedSkull: Map<SemanticCagePointId, Point>;
  surfacePivots: WeakMap<LayerBinding, Point>;
  cagePivots: WeakMap<LayerBinding, Point>;
  attachmentPivots: WeakMap<LayerBinding, { surface: Point; cage: Point; faceFollow?: Point }>;
}

let poseEvaluationCache: PoseEvaluationCache | undefined;
let angleCache: { yawAngle: number; pitchAngle: number; cosYaw: number; sinYaw: number; cosPitch: number; sinPitch: number } | undefined;
const semanticCageMappingCaches = new WeakMap<CoherentPoseField, WeakMap<SemanticControlCage, SemanticCageMappingCache>>();

function evaluationCacheFor(
  field: CoherentPoseField,
  cage: SemanticControlCage,
  yawAngle: number,
  pitchAngle: number,
  yaw: number,
  pitch: number
): PoseEvaluationCache {
  const cached = poseEvaluationCache;
  if (
    cached && cached.field === field && cached.cage === cage && cached.yawAngle === yawAngle &&
    cached.pitchAngle === pitchAngle && cached.yaw === yaw && cached.pitch === pitch
  ) return cached;
  poseEvaluationCache = {
    field,
    cage,
    yawAngle,
    pitchAngle,
    yaw,
    pitch,
    projectedFace: new Map(),
    projectedSkull: new Map(),
    surfacePivots: new WeakMap(),
    cagePivots: new WeakMap(),
    attachmentPivots: new WeakMap()
  };
  return poseEvaluationCache;
}

function surfaceFor(field: CoherentPoseField, role: SemanticRole): Surface {
  if (
    field.kind === "head-surfaces-v2" &&
    skullRoles.has(role) &&
    field.skullCenter &&
    field.skullRadiusX &&
    field.skullRadiusY
  ) {
    return { center: field.skullCenter, radiusX: field.skullRadiusX, radiusY: field.skullRadiusY };
  }
  return { center: field.center, radiusX: field.radiusX, radiusY: field.radiusY };
}

function projectedCoordinate(
  surface: Surface,
  nx: number,
  ny: number,
  z: number,
  yawAngle: number,
  pitchAngle: number,
  perspective: number
): Point {
  if (!angleCache || angleCache.yawAngle !== yawAngle || angleCache.pitchAngle !== pitchAngle) {
    angleCache = {
      yawAngle,
      pitchAngle,
      cosYaw: Math.cos(yawAngle),
      sinYaw: Math.sin(yawAngle),
      cosPitch: Math.cos(pitchAngle),
      sinPitch: Math.sin(pitchAngle)
    };
  }
  const { cosYaw, sinYaw, cosPitch, sinPitch } = angleCache;
  const yawX = nx * cosYaw + z * sinYaw;
  const yawZ = -nx * sinYaw + z * cosYaw;
  // Compose the two authored 2D pose fields without feeding yaw depth into
  // pitch. Using yawZ here made a diagonal pose bend the eye line and jaw as
  // if the face were twisted, even though the intended motion is a clean turn
  // plus a clean look up/down.
  const pitchY = ny * cosPitch + z * sinPitch;
  const pitchZ = -ny * sinPitch + z * cosPitch;
  const depthDelta = (yawZ - z) + (pitchZ - z);
  const perspectiveScale = clamp(1 + depthDelta * perspective, 0.94, 1.06);
  return {
    x: surface.center.x + yawX * surface.radiusX * perspectiveScale,
    y: surface.center.y + pitchY * surface.radiusY * perspectiveScale
  };
}

function semanticLandmarkAdjustment(
  field: CoherentPoseField,
  id: SemanticCagePointId,
  base: Point,
  projected: Point,
  yaw: number,
  pitch: number
): Point {
  const turn = clamp(yaw, -1, 1);
  const amount = Math.abs(turn);
  const contourStrength = clamp(field.contourStrength ?? 1, 0.4, 1.6);
  let adjusted = projected;
  const direction = Math.sign(turn);
  const screenSide = base.x < field.center.x ? -1 : base.x > field.center.x ? 1 : 0;
  // The temple anchors already follow the spherical projection. Extra
  // foreshortening starts below the eyes so the far eye corner cannot cross
  // the face edge at combined yaw/pitch poses.
  const outlineIds = new Set<SemanticCagePointId>(["cheekLeft", "cheekRight", "jawLeft", "jawRight"]);
  if (amount >= 1e-9 && outlineIds.has(id)) {
    const { near, far } = sidePerspective(turn, screenSide);
    // The spherical surface already turns the outline. This is only a small
    // continuity correction; a large second squeeze makes the far cheek a
    // vertical cut while the eyes and mouth keep moving on the surface.
    adjusted = { x: adjusted.x - direction * field.radiusX * (far * 0.04 + near * 0.008) * contourStrength, y: adjusted.y };
  } else if (amount >= 1e-9) {
    const centerShift = id === "chin" ? 0.04 : id === "mouth" || id === "mouthLeft" || id === "mouthRight" ? 0.025 : id === "nose" ? 0.018 : 0;
    if (centerShift > 0) adjusted = { x: adjusted.x + direction * field.radiusX * amount * centerShift * contourStrength, y: adjusted.y };
  }

  const verticalTurn = clamp(pitch, -1, 1);
  const lowerPlane = id === "chin" ? 1
    : id === "jawLeft" || id === "jawRight" ? 0.76
      : id === "mouth" || id === "mouthLeft" || id === "mouthRight" ? 0.24
        : id === "cheekLeft" || id === "cheekRight" ? 0.16
          : 0;
  if (lowerPlane > 0 && Math.abs(verticalTurn) >= 1e-9) {
    // Looking up exposes the underside of the jaw; looking down foreshortens
    // the lower face. Side landmarks also widen/narrow around the same face
    // centre instead of each layer applying an unrelated vertical shift.
    const pitchAmount = Math.abs(verticalTurn);
    const widthScale = verticalTurn < 0
      ? 1 + pitchAmount * 0.055 * lowerPlane * contourStrength
      : 1 - pitchAmount * 0.07 * lowerPlane * contourStrength;
    const lowerFaceCounterScale = verticalTurn < 0 ? -0.045 : -0.09;
    adjusted = {
      x: field.center.x + (adjusted.x - field.center.x) * widthScale,
      // Counter the strong depth difference between the mouth and chin in the
      // spherical projection. Up and down need separate compensation because
      // the available 2D artwork exposes much less underside than forehead.
      y: adjusted.y - verticalTurn * field.radiusY * lowerPlane * lowerFaceCounterScale * contourStrength
    };
  }
  return adjusted;
}

function projectedCagePoint(
  field: CoherentPoseField,
  cage: SemanticControlCage,
  id: SemanticCagePointId,
  region: "face" | "skull",
  yawAngle: number,
  pitchAngle: number,
  yaw: number,
  pitch: number
): Point {
  const base = cage.points[id].position;
  const surface = region === "skull" && field.skullCenter && field.skullRadiusX && field.skullRadiusY
    ? { center: field.skullCenter, radiusX: field.skullRadiusX, radiusY: field.skullRadiusY }
    : { center: field.center, radiusX: field.radiusX, radiusY: field.radiusY };
  const nx = (base.x - surface.center.x) / surface.radiusX;
  const ny = (base.y - surface.center.y) / surface.radiusY;
  const radial = nx * nx + ny * ny;
  let z = Math.sqrt(Math.max(0, 1 - Math.min(1, radial)));
  if (region === "face" && (id === "faceLeft" || id === "faceRight")) {
    const eyeCorner = cage.points[id === "faceLeft" ? "eyeLeftOuter" : "eyeRightOuter"].position;
    const eyeNx = (eyeCorner.x - surface.center.x) / surface.radiusX;
    const eyeNy = (eyeCorner.y - surface.center.y) / surface.radiusY;
    const eyeZ = Math.sqrt(Math.max(0, 1 - Math.min(1, eyeNx * eyeNx + eyeNy * eyeNy)));
    z = z * 0.5 + eyeZ * 0.5;
  }
  let projected = projectedCoordinate(surface, nx, ny, z, yawAngle, pitchAngle, field.perspective);
  if (region === "skull" && field.skullCenter && field.skullRadiusX && field.skullRadiusY) {
    const skullRoot = projectedCoordinate(surface, 0, 0, 1, yawAngle, pitchAngle, field.perspective);
    const faceSurface = { center: field.center, radiusX: field.radiusX, radiusY: field.radiusY };
    const faceRoot = projectedCoordinate(faceSurface, 0, 0, 1, yawAngle, pitchAngle, field.perspective);
    projected = {
      x: surface.center.x + (faceRoot.x - faceSurface.center.x) + (projected.x - skullRoot.x),
      y: surface.center.y + (faceRoot.y - faceSurface.center.y) + (projected.y - skullRoot.y)
    };
  }
  return region === "face" ? semanticLandmarkAdjustment(field, id, base, projected, yaw, pitch) : projected;
}

function barycentric(point: Point, a: Point, b: Point, c: Point): Barycentric | undefined {
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(denominator) < 1e-10) return undefined;
  const wa = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denominator;
  const wb = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denominator;
  return { a: wa, b: wb, c: 1 - wa - wb };
}

function semanticCageMapping(
  field: CoherentPoseField,
  cage: SemanticControlCage,
  base: Point,
  region: "face" | "skull"
): SemanticCageMapping {
  let byCage = semanticCageMappingCaches.get(field);
  if (!byCage) {
    byCage = new WeakMap();
    semanticCageMappingCaches.set(field, byCage);
  }
  let mappings = byCage.get(cage);
  if (!mappings) {
    mappings = { face: new WeakMap(), skull: new WeakMap() };
    byCage.set(cage, mappings);
  }
  const cache = mappings[region];
  const cached = cache.get(base);
  if (cached) return cached;

  const triangles = region === "face" ? cage.faceTriangles : cage.skullTriangles;
  for (const [aId, bId, cId] of triangles) {
    const weights = barycentric(base, cage.points[aId].position, cage.points[bId].position, cage.points[cId].position);
    if (!weights || Math.min(weights.a, weights.b, weights.c) < -0.015) continue;
    const mapping: SemanticCageMapping = { kind: "triangle", ids: [aId, bId, cId], weights };
    cache.set(base, mapping);
    return mapping;
  }

  const softening = Math.max(1e-6, field.radiusX * field.radiusX * 0.0036);
  const entries = [...new Set(triangles.flat())].map((id) => {
    const source = cage.points[id];
    const distanceSquared = (base.x - source.position.x) ** 2 + (base.y - source.position.y) ** 2;
    return { id, weight: source.confidence / (distanceSquared + softening) };
  });
  const mapping: SemanticCageMapping = { kind: "weighted", entries, total: entries.reduce((sum, entry) => sum + entry.weight, 0) };
  cache.set(base, mapping);
  return mapping;
}

function mappedBySemanticCage(
  field: CoherentPoseField,
  cage: SemanticControlCage,
  base: Point,
  region: "face" | "skull",
  yawAngle: number,
  pitchAngle: number,
  yaw: number,
  pitch: number
): Point {
  const cache = evaluationCacheFor(field, cage, yawAngle, pitchAngle, yaw, pitch);
  const projected = region === "face" ? cache.projectedFace : cache.projectedSkull;
  const targetFor = (id: SemanticCagePointId): Point => {
    const existing = projected.get(id);
    if (existing) return existing;
    const target = projectedCagePoint(field, cage, id, region, yawAngle, pitchAngle, yaw, pitch);
    projected.set(id, target);
    return target;
  };
  const mapping = semanticCageMapping(field, cage, base, region);
  if (mapping.kind === "triangle") {
    const [aId, bId, cId] = mapping.ids;
    const { weights } = mapping;
    const targetA = targetFor(aId);
    const targetB = targetFor(bId);
    const targetC = targetFor(cId);
    return {
      x: targetA.x * weights.a + targetB.x * weights.b + targetC.x * weights.c,
      y: targetA.y * weights.a + targetB.y * weights.b + targetC.y * weights.c
    };
  }

  let dx = 0;
  let dy = 0;
  for (const { id, weight } of mapping.entries) {
    const source = cage.points[id];
    const target = targetFor(id);
    dx += (target.x - source.position.x) * weight;
    dy += (target.y - source.position.y) * weight;
  }
  return mapping.total > 0 ? { x: base.x + dx / mapping.total, y: base.y + dy / mapping.total } : { ...base };
}

function cageBlendFor(role: SemanticRole): number {
  if (role === "face") return 0.88;
  if (role === "eyeWhite" || role === "iris" || role === "eyelash" || role === "eyeClosed" || role === "eyebrow") return 0.82;
  if (role === "nose" || role === "mouth") return 0.86;
  if (role === "frontHair") return 0.3;
  if (role === "sideHair") return 0.36;
  if (role === "backHair") return 0.22;
  if (role === "headwear") return 0.15;
  if (role === "ear") return 0.18;
  return 0;
}

interface FrontHairStrandProfile {
  faceFollow: number;
  rootLock: number;
  strandRelease: number;
  root: Point;
}

interface FrontHairBangProfile {
  weight: number;
  progress: number;
  root: Point;
}

function posedFrontHairAnchor(
  field: CoherentPoseField,
  cage: SemanticControlCage,
  layer: LayerBinding,
  anchor: Point,
  yawAngle: number,
  pitchAngle: number,
  yaw: number,
  pitch: number
): Point {
  const surface = projectSurface(field, layer, anchor, yawAngle, pitchAngle);
  const cageTarget = mappedBySemanticCage(field, cage, anchor, "skull", yawAngle, pitchAngle, yaw, pitch);
  const blend = cageBlendFor("frontHair");
  return {
    x: surface.x + (cageTarget.x - surface.x) * blend,
    y: surface.y + (cageTarget.y - surface.y) * blend
  };
}

function frontHairStrandProfile(cage: SemanticControlCage, layer: LayerBinding, base: Point): FrontHairStrandProfile {
  const forehead = cage.points.forehead.position;
  const eyeY = (cage.points.eyeLeft.position.y + cage.points.eyeRight.position.y) * 0.5;
  const faceLeft = cage.points.faceLeft.position.x;
  const faceRight = cage.points.faceRight.position.x;
  const centerX = (faceLeft + faceRight) * 0.5;
  const halfWidth = Math.max(1e-6, (faceRight - faceLeft) * 0.5);
  const screenLeft = base.x < centerX;
  const root = screenLeft
    ? layer.secondaryAnchors?.frontHairRootLeft
    : layer.secondaryAnchors?.frontHairRootRight;
  const tip = screenLeft
    ? layer.secondaryAnchors?.frontHairTipLeft
    : layer.secondaryAnchors?.frontHairTipRight;
  const fallbackRoot = {
    x: screenLeft ? faceLeft : faceRight,
    y: forehead.y + (eyeY - forehead.y) * 0.46
  };
  const fallbackTip = {
    x: screenLeft ? layer.bounds.x + layer.bounds.width * 0.1 : layer.bounds.x + layer.bounds.width * 0.9,
    y: layer.bounds.y + layer.bounds.height
  };
  const strandRoot = root ?? fallbackRoot;
  const strandTip = tip ?? fallbackTip;
  const strandLength = Math.max(layer.bounds.height * 0.28, strandTip.y - strandRoot.y);
  const progress = clamp((base.y - strandRoot.y) / strandLength, 0, 1);
  // Include a broad collar above the detected side root. The root can sit
  // between two mesh rows; a narrow collar then sends the outer row over the
  // skull surface and the adjacent row with the face, collapsing the triangle
  // between them at full yaw.
  const rootCollar = strandLength * 0.9;
  const entersAtRoot = smoothstep01((base.y - (strandRoot.y - rootCollar)) / Math.max(1e-6, rootCollar));
  const sideDistance = Math.abs(base.x - centerX) / halfWidth;
  const sideLock = smoothstep01((sideDistance - 0.42) / 0.58);
  const expectedX = strandRoot.x + (strandTip.x - strandRoot.x) * progress;
  const distanceFromStrand = Math.abs(base.x - expectedX) / Math.max(1e-6, layer.bounds.width * 0.24);
  const strandProximity = 1 - smoothstep01((distanceFromStrand - 0.18) / 0.82);
  const sideGate = smoothstep01((sideDistance - 0.5) / 0.34);
  const strandMask = Math.max(sideLock, strandProximity * sideGate);
  const faceFollow = entersAtRoot * strandMask * (1 - smoothstep01((progress - 0.06) / 0.64)) * 0.82;
  const rootLock = entersAtRoot * strandMask * (1 - smoothstep01((progress - 0.01) / 0.34));
  // Once the strand leaves its root, preserve its painted vertical fall early.
  // Letting the spherical skull projection dominate until the lower half made
  // the far-side contour cave inward before it reached the free tip. The 94%
  // ceiling keeps the transition continuous without replacing adjacent mesh
  // columns discontinuously.
  const strandRelease = strandMask * smoothstep01((progress - 0.015) / 0.56) * 0.94;
  return { faceFollow, rootLock, strandRelease, root: strandRoot };
}

function frontHairBangProfile(cage: SemanticControlCage, layer: LayerBinding, base: Point): FrontHairBangProfile {
  const forehead = cage.points.forehead.position;
  const eyeY = (cage.points.eyeLeft.position.y + cage.points.eyeRight.position.y) * 0.5;
  const faceLeft = cage.points.faceLeft.position.x;
  const faceRight = cage.points.faceRight.position.x;
  const centerX = (faceLeft + faceRight) * 0.5;
  const halfWidth = Math.max(1e-6, (faceRight - faceLeft) * 0.5);
  const rootY = Math.max(
    layer.bounds.y + layer.bounds.height * 0.27,
    forehead.y - (eyeY - forehead.y) * 0.65
  );
  const progress = clamp((base.y - rootY) / Math.max(1e-6, eyeY - rootY), 0, 1);
  const horizontal = 1 - smoothstep01((Math.abs(base.x - centerX) / halfWidth - 0.58) / 0.42);
  const belowRoot = smoothstep01((base.y - rootY) / Math.max(1e-6, (eyeY - rootY) * 0.3));
  const belowEyes = 1 - smoothstep01((base.y - (eyeY + layer.bounds.height * 0.025)) / Math.max(1e-6, layer.bounds.height * 0.14));
  return {
    weight: horizontal * belowRoot * belowEyes,
    progress,
    root: { x: base.x, y: rootY }
  };
}

function frontHairAttachmentDisplacement(
  field: CoherentPoseField,
  cage: SemanticControlCage,
  layer: LayerBinding,
  base: Point,
  yawAngle: number,
  pitchAngle: number,
  yaw: number,
  pitch: number
): Point {
  const centerX = (cage.points.faceLeft.position.x + cage.points.faceRight.position.x) * 0.5;
  const edge = base.x < centerX ? cage.points.faceLeft.position : cage.points.faceRight.position;
  const anchor = { x: edge.x, y: base.y };
  const faceLayer = { ...layer, role: "face" as const, side: "center" as const };
  const surfaceTarget = projectSurface(field, faceLayer, anchor, yawAngle, pitchAngle);
  const cageTarget = mappedBySemanticCage(field, cage, anchor, "face", yawAngle, pitchAngle, yaw, pitch);
  const blend = cageBlendFor("face");
  return {
    x: surfaceTarget.x + (cageTarget.x - surfaceTarget.x) * blend - anchor.x,
    y: surfaceTarget.y + (cageTarget.y - surfaceTarget.y) * blend - anchor.y
  };
}

function preserveFrontHairFaceGap(
  cage: SemanticControlCage,
  base: Point,
  posed: Point,
  faceDisplacement: Point,
  yaw: number,
  rootLock: number
): Point {
  if (rootLock <= 1e-6) return posed;
  const centerX = (cage.points.faceLeft.position.x + cage.points.faceRight.position.x) * 0.5;
  const screenSide: -1 | 1 = base.x < centerX ? -1 : 1;
  const edge = screenSide < 0 ? cage.points.faceLeft.position : cage.points.faceRight.position;
  const neutralGap = base.x - edge.x;
  const outwardGap = neutralGap * screenSide;
  const faceHalfWidth = Math.max(1e-6, (cage.points.faceRight.position.x - cage.points.faceLeft.position.x) * 0.5);
  if (outwardGap <= 0 || outwardGap >= faceHalfWidth * 0.45) return posed;

  const { near, far } = sidePerspective(yaw, screenSide);
  const targetGapScale = 1 + near * 0.035 - far * 0.035;
  const faceX = edge.x + faceDisplacement.x;
  const currentGap = screenSide * (posed.x - faceX);
  const safeGap = clamp(currentGap, outwardGap * 0.86, outwardGap * 1.42);
  const desiredGap = outwardGap * targetGapScale;
  const correctedGap = safeGap + (desiredGap - safeGap) * 0.38;
  const targetX = faceX + screenSide * correctedGap;
  const edgeWeight = layerEdgeWeight(base, edge, faceHalfWidth) * rootLock;
  return { x: posed.x + (targetX - posed.x) * edgeWeight, y: posed.y };
}

function applyFrontHairContourPlane(
  field: CoherentPoseField,
  cage: SemanticControlCage | undefined,
  layer: LayerBinding,
  base: Point,
  posed: Point,
  yawAngle: number,
  pitchAngle: number,
  yaw: number,
  pitch: number
): Point {
  if (layer.role !== "frontHair") return posed;
  if (ahogeMembership(layer, base)) return posed;
  const geometry = frontHairSideGeometry(layer, base);
  const width = Math.max(1e-6, layer.bounds.width);
  const u = clamp((base.x - layer.bounds.x) / width, 0, 1);
  const outerWeight = smoothstep01((Math.abs(u - 0.5) - 0.1) / 0.16);
  const hangingWeight = smoothstep01((geometry.progress - 0.015) / 0.38);
  const contourWeight = outerWeight * hangingWeight;
  if (contourWeight <= 1e-6) return posed;
  const rootSurface = projectSurface(field, layer, geometry.root, yawAngle, pitchAngle);
  const rootCage = cage
    ? mappedBySemanticCage(field, cage, geometry.root, "skull", yawAngle, pitchAngle, yaw, pitch)
    : rootSurface;
  const blend = cage ? cageBlendFor("frontHair") : 0;
  const posedRoot = {
    x: rootSurface.x + (rootCage.x - rootSurface.x) * blend,
    y: rootSurface.y + (rootCage.y - rootSurface.y) * blend
  };
  const { near, far } = sidePerspective(yaw, geometry.screenSide);
  // The complete side lock hangs from one transformed root. Scaling its
  // painted local offset keeps the outer contour continuous: perspective can
  // make the lock modestly wider or narrower, but cannot pull successive
  // vertices toward the face by different spherical-projection amounts.
  const scaleX = 1 + near * 0.045 - far * 0.04;
  const targetX = posedRoot.x + (base.x - geometry.root.x) * scaleX;
  const contourCorrection = clamp((targetX - posed.x) * contourWeight, -width * 0.018, width * 0.018);
  return {
    x: posed.x + contourCorrection,
    y: posed.y
  };
}

function layerEdgeWeight(base: Point, edge: Point, faceHalfWidth: number): number {
  const normalized = Math.abs(base.x - edge.x) / Math.max(1e-6, faceHalfWidth * 0.45);
  return 1 - smoothstep01((normalized - 0.35) / 0.65);
}

function applyHeadwearCrownPerspective(
  field: CoherentPoseField,
  cage: SemanticControlCage | undefined,
  layer: LayerBinding,
  base: Point,
  posed: Point,
  yawAngle: number,
  pitchAngle: number,
  yaw: number,
  pitch: number
): Point {
  if (layer.role !== "headwear") return posed;
  const crownPivot = {
    x: layer.bounds.x + layer.bounds.width * 0.5,
    y: layer.bounds.y + layer.bounds.height * 0.28
  };
  // Keep the band seated on the same outer shell as the front hair. Using the
  // shallower generic headwear depth made the cap and the band drift around
  // different centres during a turn.
  const hairShellLayer = { ...layer, role: "frontHair" as const };
  const surfacePivot = projectSurface(field, hairShellLayer, crownPivot, yawAngle, pitchAngle);
  const cagePivot = cage
    ? mappedBySemanticCage(field, cage, crownPivot, "skull", yawAngle, pitchAngle, yaw, pitch)
    : surfacePivot;
  const blend = cage ? cageBlendFor("headwear") : 0;
  const posedPivot = {
    x: surfacePivot.x + (cagePivot.x - surfacePivot.x) * blend,
    y: surfacePivot.y + (cagePivot.y - surfacePivot.y) * blend
  };
  const screenSide: -1 | 0 | 1 = base.x < crownPivot.x ? -1 : base.x > crownPivot.x ? 1 : 0;
  const { near, far } = sidePerspective(yaw, screenSide);
  // This target replaces the skull foreshortening across the crown rather
  // than merely nudging it. At the runtime yaw limit it keeps the near frills
  // visibly wider and the far frills visibly narrower.
  const vertical = clamp(pitch, -1, 1);
  const scaleX = (1 + near * 0.15 - far * 0.18) * (1 + Math.max(0, vertical) * 0.035);
  const scaleY = (1 + near * 0.045 - far * 0.065)
    * (1 - Math.max(0, -vertical) * 0.1 + Math.max(0, vertical) * 0.12);
  const crownTarget = {
    x: posedPivot.x + (base.x - crownPivot.x) * scaleX,
    y: posedPivot.y + (base.y - crownPivot.y) * scaleY
  };
  // The source combines the crown, bows and side fins in one bitmap. Spatially
  // separate the lower outer regions so they follow their own skull attachment
  // instead of being stretched around the crown centre.
  const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
  const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
  const sideWeight = smoothstep01((Math.abs(u - 0.5) - 0.19) / 0.2) * smoothstep01((v - 0.3) / 0.34);
  const side: -1 | 1 = u < 0.5 ? -1 : 1;
  const sideRoot = {
    x: layer.bounds.x + layer.bounds.width * (side < 0 ? 0.34 : 0.66),
    y: layer.bounds.y + layer.bounds.height * 0.54
  };
  const sideSurface = projectSurface(field, hairShellLayer, sideRoot, yawAngle, pitchAngle);
  const sideCage = cage
    ? mappedBySemanticCage(field, cage, sideRoot, "skull", yawAngle, pitchAngle, yaw, pitch)
    : sideSurface;
  const sideRootPosed = {
    x: sideSurface.x + (sideCage.x - sideSurface.x) * blend,
    y: sideSurface.y + (sideCage.y - sideSurface.y) * blend
  };
  const sideDepth = sidePerspective(yaw, side);
  const sideTarget = {
    x: sideRootPosed.x + (base.x - sideRoot.x) * (1 + sideDepth.near * 0.07 - sideDepth.far * 0.12),
    y: sideRootPosed.y + (base.y - sideRoot.y) * (1 - Math.max(0, -vertical) * 0.05 + Math.max(0, vertical) * 0.06)
  };
  const target = {
    x: crownTarget.x + (sideTarget.x - crownTarget.x) * sideWeight,
    y: crownTarget.y + (sideTarget.y - crownTarget.y) * sideWeight
  };
  return {
    x: target.x,
    y: target.y
  };
}

function applyBackHairVolume(
  field: CoherentPoseField,
  cage: SemanticControlCage | undefined,
  layer: LayerBinding,
  base: Point,
  posed: Point,
  yawAngle: number,
  pitchAngle: number,
  yaw: number,
  pitch: number,
  skullInfluence: number,
  explicitAttachment?: number
): Point {
  if (layer.role !== "backHair" && layer.role !== "sideHair") return posed;
  const pivot = layer.role === "backHair" && field.skullCenter
    ? { x: field.skullCenter.x, y: field.skullCenter.y + (field.skullRadiusY ?? layer.bounds.height * 0.3) * 0.12 }
    : layer.pivot;
  const cachedPivots = cage ? evaluationCacheFor(field, cage, yawAngle, pitchAngle, yaw, pitch).attachmentPivots.get(layer) : undefined;
  const surfacePivot = cachedPivots?.surface ?? projectSurface(field, layer, pivot, yawAngle, pitchAngle);
  const cagePivot = cachedPivots?.cage ?? (cage
    ? mappedBySemanticCage(field, cage, pivot, "skull", yawAngle, pitchAngle, yaw, pitch)
    : surfacePivot);
  if (cage && !cachedPivots) evaluationCacheFor(field, cage, yawAngle, pitchAngle, yaw, pitch).attachmentPivots.set(layer, { surface: surfacePivot, cage: cagePivot });
  const blend = cage ? cageBlendFor(layer.role) * clamp(skullInfluence, 0, 1) : 0;
  const posedPivot = {
    x: surfacePivot.x + (cagePivot.x - surfacePivot.x) * blend,
    y: surfacePivot.y + (cagePivot.y - surfacePivot.y) * blend
  };
  const side: -1 | 1 = base.x < pivot.x ? -1 : 1;
  const depth = sidePerspective(yaw, side);
  const vertical = clamp(pitch, -1, 1);
  const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
  const freeLength = explicitAttachment === undefined
    ? smoothstep01((v - 0.28) / 0.62)
    : Math.max(smoothstep01((v - 0.28) / 0.62), 1 - clamp(explicitAttachment, 0, 1));
  const attached = {
    x: posedPivot.x + (base.x - pivot.x) * (1 + depth.near * 0.035 - depth.far * 0.055),
    y: posedPivot.y + (base.y - pivot.y) * (1 - Math.max(0, -vertical) * 0.08 + Math.max(0, vertical) * 0.09)
  };
  const hanging = {
    x: base.x + (posedPivot.x - pivot.x) + (base.x - pivot.x) * (depth.near * 0.018 - depth.far * 0.028),
    y: base.y + (posedPivot.y - pivot.y)
  };
  return {
    x: attached.x + (hanging.x - attached.x) * freeLength,
    y: attached.y + (hanging.y - attached.y) * freeLength
  };
}

function applyFrontHairVolume(
  field: CoherentPoseField,
  cage: SemanticControlCage | undefined,
  layer: LayerBinding,
  base: Point,
  yawAngle: number,
  pitchAngle: number,
  yaw: number,
  pitch: number,
  skullInfluence: number,
  explicitAttachment?: number
): Point {
  const pivot = layer.secondaryAnchors?.frontHairRoot ?? layer.pivot;
  const cachedPivots = cage ? evaluationCacheFor(field, cage, yawAngle, pitchAngle, yaw, pitch).attachmentPivots.get(layer) : undefined;
  const surfacePivot = cachedPivots?.surface ?? projectSurface(field, layer, pivot, yawAngle, pitchAngle);
  const cagePivot = cachedPivots?.cage ?? (cage
    ? mappedBySemanticCage(field, cage, pivot, "skull", yawAngle, pitchAngle, yaw, pitch)
    : surfacePivot);
  if (cage && !cachedPivots) evaluationCacheFor(field, cage, yawAngle, pitchAngle, yaw, pitch).attachmentPivots.set(layer, { surface: surfacePivot, cage: cagePivot });
  const blend = cage ? cageBlendFor("frontHair") * clamp(skullInfluence, 0, 1) : 0;
  const surfaceScalp = projectSurface(field, layer, base, yawAngle, pitchAngle);
  const cageScalp = cage
    ? mappedBySemanticCage(field, cage, base, "skull", yawAngle, pitchAngle, yaw, pitch)
    : surfaceScalp;
  const posedScalp = {
    x: surfaceScalp.x + (cageScalp.x - surfaceScalp.x) * blend,
    y: surfaceScalp.y + (cageScalp.y - surfaceScalp.y) * blend
  };
  let posedPivot = {
    x: surfacePivot.x + (cagePivot.x - surfacePivot.x) * blend,
    y: surfacePivot.y + (cagePivot.y - surfacePivot.y) * blend
  };
  if (cage) {
    let faceFollow = cachedPivots?.faceFollow;
    if (!faceFollow) {
      const centerX = (cage.points.faceLeft.position.x + cage.points.faceRight.position.x) * 0.5;
      const epsilon = Math.max(1e-8, field.radiusX * 1e-5);
      const left = frontHairAttachmentDisplacement(field, cage, layer, { x: centerX - epsilon, y: pivot.y }, yawAngle, pitchAngle, yaw, pitch);
      const right = frontHairAttachmentDisplacement(field, cage, layer, { x: centerX + epsilon, y: pivot.y }, yawAngle, pitchAngle, yaw, pitch);
      faceFollow = {
        x: pivot.x + (left.x + right.x) * 0.5,
        y: pivot.y + (left.y + right.y) * 0.5
      };
      evaluationCacheFor(field, cage, yawAngle, pitchAngle, yaw, pitch).attachmentPivots.set(layer, { surface: surfacePivot, cage: cagePivot, faceFollow });
    }
    const attachment = explicitAttachment === undefined
      ? clamp(skullInfluence, 0, 1)
      : clamp(explicitAttachment, 0, 1);
    posedPivot = {
      x: posedPivot.x + (faceFollow.x - posedPivot.x) * attachment,
      y: posedPivot.y + (faceFollow.y - posedPivot.y) * attachment
    };
  }
  const turn = clamp(yaw, -1, 1);
  const vertical = clamp(pitch, -1, 1);
  const localX = base.x - pivot.x;
  const localY = base.y - pivot.y;
  const halfWidth = Math.max(1e-6, layer.bounds.width * 0.5);
  const normalizedX = clamp(localX / halfWidth, -1, 1);
  const ahogeRoot = layer.secondaryAnchors?.ahogeRoot;
  const flexibleRootY = layer.secondaryAnchors?.frontHairRoot?.y ?? pivot.y;
  const geometricRelease = smoothstep01((base.y - flexibleRootY) / Math.max(1e-6, layer.bounds.height * 0.18));
  const flexibleRelease = explicitAttachment === undefined
    ? geometricRelease
    : Math.max(geometricRelease, 1 - clamp(explicitAttachment, 0, 1));

  // The scalp follows the stable skull perspective. Below the detected root,
  // bangs gradually leave that curved head surface and hang from the shared
  // attachment plane. This is head-pose deformation, not secondary wobble.
  const cosine = 1;
  const sine = 0;
  const flexiblePitchScale = 1 - Math.max(0, -vertical) * 0.045 + Math.max(0, vertical) * 0.055;
  const pitchScale = 1 + (flexiblePitchScale - 1) * flexibleRelease;
  const screenSide: -1 | 1 = normalizedX < 0 ? -1 : 1;
  const depth = sidePerspective(turn, screenSide);
  const perspectiveScaleX = 1 + depth.near * 0.1 - depth.far * 0.1;
  const perspectiveWrap = turn * halfWidth * 0.025 * (1 - normalizedX * normalizedX) * flexibleRelease;
  const hangingMapped = {
    x: posedPivot.x + localX * perspectiveScaleX * cosine - localY * pitchScale * sine + perspectiveWrap,
    y: posedPivot.y + localX * sine + localY * pitchScale * cosine
  };
  let mapped = {
    x: posedScalp.x + (hangingMapped.x - posedScalp.x) * flexibleRelease,
    y: posedScalp.y + (hangingMapped.y - posedScalp.y) * flexibleRelease
  };
  if (cage) {
    const strand = frontHairStrandProfile(cage, layer, base);
    const faceDisplacement = frontHairAttachmentDisplacement(
      field,
      cage,
      layer,
      base,
      yawAngle,
      pitchAngle,
      yaw,
      pitch
    );
    // A side lock is attached to the face at its detected root, then becomes
    // progressively independent as it falls. Without this attachment pass,
    // the root follows the round skull surface while the face edge follows the
    // face cage, which opens a visible notch and can fold the first mesh row.
    const attachment = explicitAttachment === undefined
      ? Math.max(strand.faceFollow, strand.rootLock)
      : Math.max(strand.faceFollow, strand.rootLock, clamp(explicitAttachment, 0, 1));
    const attached = {
      x: base.x + faceDisplacement.x,
      y: base.y + faceDisplacement.y
    };
    mapped = {
      x: mapped.x + (attached.x - mapped.x) * attachment,
      y: mapped.y + (attached.y - mapped.y) * attachment
    };
    mapped = preserveFrontHairFaceGap(cage, base, mapped, faceDisplacement, yaw, strand.rootLock);
  }
  mapped = applyFrontHairContourPlane(field, cage, layer, base, mapped, yawAngle, pitchAngle, yaw, pitch);
  const ahogeWeight = ahogeHingeWeight(layer, base);
  if (!ahogeRoot || ahogeWeight <= 1e-6) return mapped;

  const rootPosed = cage
    ? posedFrontHairAnchor(field, cage, layer, ahogeRoot, yawAngle, pitchAngle, yaw, pitch)
    : projectSurface(field, layer, ahogeRoot, yawAngle, pitchAngle);
  const rigidAhoge = {
    x: rootPosed.x + base.x - ahogeRoot.x,
    y: rootPosed.y + base.y - ahogeRoot.y
  };
  // Keep head-turn projection continuous across the shared ArtMesh. The
  // ahoge uses a broad, continuously tapered collar so this rigid primary
  // transform cannot create a discontinuous seam at the painted scalp.
  return {
    x: mapped.x + (rigidAhoge.x - mapped.x) * ahogeWeight,
    y: mapped.y + (rigidAhoge.y - mapped.y) * ahogeWeight
  };
}

function projectSurface(field: CoherentPoseField, layer: LayerBinding, base: Point, yawAngle: number, pitchAngle: number): Point {
  const surface = surfaceFor(field, layer.role);
  const nx = (base.x - surface.center.x) / surface.radiusX;
  const ny = (base.y - surface.center.y) / surface.radiusY;
  const radial = nx * nx + ny * ny;
  const surfaceDepth = Math.sqrt(Math.max(0, 1 - Math.min(1, radial)));
  const authoredDepth = faceDepthRoles.has(layer.role) ? faceDepthAt(field, (ny + 1) * 0.5) : 0;
  const z = surfaceDepth + (roleDepth(layer.role) + authoredDepth) * clamp(field.depthStrength ?? 1, 0.4, 1.6);

  let projected = projectedCoordinate(surface, nx, ny, z, yawAngle, pitchAngle, field.perspective);
  let commonOffset: Point | undefined;
  if (field.kind === "head-surfaces-v2" && skullRoles.has(layer.role)) {
    const surfaceRoot = projectedCoordinate(surface, 0, 0, 1, yawAngle, pitchAngle, field.perspective);
    const faceSurface = { center: field.center, radiusX: field.radiusX, radiusY: field.radiusY };
    const commonRoot = projectedCoordinate(faceSurface, 0, 0, 1, yawAngle, pitchAngle, field.perspective);
    commonOffset = { x: commonRoot.x - faceSurface.center.x, y: commonRoot.y - faceSurface.center.y };
    projected = {
      x: surface.center.x + commonOffset.x + (projected.x - surfaceRoot.x),
      y: surface.center.y + commonOffset.y + (projected.y - surfaceRoot.y)
    };
  }
  const blend = rolePoseBlend(layer, base) * layer.weights.head;
  if (commonOffset) {
    const rootWeight = layer.weights.head;
    const rooted = { x: base.x + commonOffset.x * rootWeight, y: base.y + commonOffset.y * rootWeight };
    return {
      x: rooted.x + (projected.x - (base.x + commonOffset.x)) * blend,
      y: rooted.y + (projected.y - (base.y + commonOffset.y)) * blend
    };
  }
  return {
    x: base.x + (projected.x - base.x) * blend,
    y: base.y + (projected.y - base.y) * blend
  };
}

function applyEyePerspective(layer: LayerBinding, base: Point, posed: Point, posedPivot: Point, yaw: number, pitch: number): Point {
  if (layer.side === "center" || (!eyeSocketRoles.has(layer.role) && layer.role !== "eyebrow")) return posed;
  const { near, far } = sidePerspective(yaw, layerScreenSide(layer));
  const scaleX = eyeSocketRoles.has(layer.role)
    ? clamp(1 + near * 0.025 - far * 0.12, 0.88, 1.025)
    : clamp(1 + near * 0.018 - far * 0.08, 0.92, 1.018);
  const yawScaleY = eyeSocketRoles.has(layer.role)
    ? clamp(1 + near * 0.006 - far * 0.018, 0.982, 1.006)
    : clamp(1 + near * 0.004 - far * 0.012, 0.988, 1.004);
  const vertical = clamp(pitch, -1, 1);
  const pitchScaleX = 1 - Math.max(0, vertical) * 0.018 + Math.max(0, -vertical) * 0.008;
  const pitchScaleY = 1 - Math.max(0, vertical) * 0.055 + Math.max(0, -vertical) * 0.035;
  const scaleY = yawScaleY * pitchScaleY;
  // The eye centre already follows the semantic face cage. Preserve the
  // neutral eye drawing around that centre and apply perspective once; using
  // the already-projected local coordinates here compressed the far eye twice.
  const localX = base.x - layer.pivot.x;
  const localY = base.y - layer.pivot.y;
  const turn = clamp(yaw, -1, 1);
  return {
    x: posedPivot.x + localX * scaleX * pitchScaleX,
    y: posedPivot.y + localY * scaleY + localX * turn * 0.018
  };
}

function applyFaceSilhouette(field: CoherentPoseField, layer: LayerBinding, base: Point, posed: Point, yaw: number): Point {
  if (layer.role !== "face") return posed;
  const turn = clamp(yaw, -1, 1);
  const amount = Math.abs(turn);
  if (amount < 1e-9) return posed;
  const localX = clamp((base.x - field.center.x) / Math.max(1e-6, field.radiusX), -1, 1);
  const screenSide = localX < -1e-6 ? -1 : localX > 1e-6 ? 1 : 0;
  const edge = Math.abs(localX);
  const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
  const cheekWeight = clamp((v - 0.18) / 0.72, 0, 1);
  const jawWeight = clamp((v - 0.55) / 0.45, 0, 1);
  const { near, far } = sidePerspective(turn, screenSide);
  const direction = Math.sign(turn);
  const contourStrength = clamp(field.contourStrength ?? 1, 0.4, 1.6);
  const cheekShift = -direction * field.radiusX * edge * cheekWeight * (far * 0.08 + near * 0.02) * contourStrength;
  const chinShift = direction * field.radiusX * (1 - edge) * jawWeight * amount * 0.08 * contourStrength;
  return { x: posed.x + cheekShift + chinShift, y: posed.y };
}

export function applyCoherentPoseField(
  field: CoherentPoseField,
  layer: LayerBinding,
  base: Point,
  yaw: number,
  pitch: number,
  semanticCage?: SemanticControlCage,
  cageInfluence: { face?: number; skull?: number; attachment?: number } = {}
): Point {
  const yawAngle = clamp(yaw, -1, 1) * field.maxYawRadians;
  const pitchLimit = pitch < 0
    ? field.maxPitchUpRadians ?? field.maxPitchRadians
    : field.maxPitchDownRadians ?? field.maxPitchRadians;
  const pitchAngle = clamp(pitch, -1, 1) * pitchLimit;
  if (Math.abs(yawAngle) < 1e-9 && Math.abs(pitchAngle) < 1e-9) return { ...base };
  if (layer.role === "frontHair") {
    return applyFrontHairVolume(
      field,
      semanticCage,
      layer,
      base,
      yawAngle,
      pitchAngle,
      yaw,
      pitch,
      cageInfluence.skull ?? 1,
      cageInfluence.attachment
    );
  }
  const surfacePosed = projectSurface(field, layer, base, yawAngle, pitchAngle);
  const cache = semanticCage ? evaluationCacheFor(field, semanticCage, yawAngle, pitchAngle, yaw, pitch) : undefined;
  let surfacePivot = cache?.surfacePivots.get(layer);
  if (!surfacePivot) {
    surfacePivot = projectSurface(field, layer, layer.pivot, yawAngle, pitchAngle);
    cache?.surfacePivots.set(layer, surfacePivot);
  }
  const region = semanticCage?.roleGroups.skull.includes(layer.role)
    ? "skull"
    : semanticCage?.roleGroups.face.includes(layer.role)
      ? "face"
      : undefined;
  const regionInfluence = region === "face" ? cageInfluence.face ?? 1 : region === "skull" ? cageInfluence.skull ?? 1 : 1;
  const cageBlend = semanticCage && region ? cageBlendFor(layer.role) * clamp(regionInfluence, 0, 1) : 0;
  const cagePosed = semanticCage && region
    ? mappedBySemanticCage(field, semanticCage, base, region, yawAngle, pitchAngle, yaw, pitch)
    : surfacePosed;
  let cagePivot = semanticCage && region ? cache?.cagePivots.get(layer) : surfacePivot;
  if (!cagePivot) {
    cagePivot = mappedBySemanticCage(field, semanticCage!, layer.pivot, region!, yawAngle, pitchAngle, yaw, pitch);
    cache?.cagePivots.set(layer, cagePivot);
  }
  let posed = {
    x: surfacePosed.x + (cagePosed.x - surfacePosed.x) * cageBlend,
    y: surfacePosed.y + (cagePosed.y - surfacePosed.y) * cageBlend
  };
  posed = applyHeadwearCrownPerspective(field, semanticCage, layer, base, posed, yawAngle, pitchAngle, yaw, pitch);
  posed = applyBackHairVolume(
    field,
    semanticCage,
    layer,
    base,
    posed,
    yawAngle,
    pitchAngle,
    yaw,
    pitch,
    cageInfluence.skull ?? 1,
    cageInfluence.attachment
  );
  const posedPivot = {
    x: surfacePivot.x + (cagePivot.x - surfacePivot.x) * cageBlend,
    y: surfacePivot.y + (cagePivot.y - surfacePivot.y) * cageBlend
  };
  posed = applyFrontHairContourPlane(field, semanticCage, layer, base, posed, yawAngle, pitchAngle, yaw, pitch);
  const perspective = applyEyePerspective(layer, base, posed, posedPivot, yaw, pitch);
  return semanticCage ? perspective : applyFaceSilhouette(field, layer, base, perspective, yaw);
}
