import { clamp } from "./math.js";
import type { CoherentPoseField, LayerBinding, Point, SemanticCagePointId, SemanticControlCage, SemanticRole } from "./types.js";

const skullRoles = new Set<SemanticRole>(["frontHair", "backHair", "sideHair", "headwear", "ear"]);
const eyeSocketRoles = new Set<SemanticRole>(["eyeWhite", "iris", "eyelash", "eyeClosed"]);

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
  const cosYaw = Math.cos(yawAngle);
  const sinYaw = Math.sin(yawAngle);
  const yawX = nx * cosYaw + z * sinYaw;
  const yawZ = -nx * sinYaw + z * cosYaw;
  const cosPitch = Math.cos(pitchAngle);
  const sinPitch = Math.sin(pitchAngle);
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
  let adjusted = projected;
  const direction = Math.sign(turn);
  const screenSide = base.x < field.center.x ? -1 : base.x > field.center.x ? 1 : 0;
  // The temple anchors already follow the spherical projection. Extra
  // foreshortening starts below the eyes so the far eye corner cannot cross
  // the face edge at combined yaw/pitch poses.
  const outlineIds = new Set<SemanticCagePointId>(["cheekLeft", "cheekRight", "jawLeft", "jawRight"]);
  if (amount >= 1e-9 && outlineIds.has(id)) {
    const { near, far } = sidePerspective(turn, screenSide);
    adjusted = { x: adjusted.x - direction * field.radiusX * (far * 0.035 + near * 0.008), y: adjusted.y };
  } else if (amount >= 1e-9) {
    const centerShift = id === "chin" ? 0.07 : id === "mouth" || id === "mouthLeft" || id === "mouthRight" ? 0.045 : id === "nose" ? 0.025 : 0;
    if (centerShift > 0) adjusted = { x: adjusted.x + direction * field.radiusX * amount * centerShift, y: adjusted.y };
  }

  const verticalTurn = clamp(pitch, -1, 1);
  const lowerPlane = id === "chin" ? 1 : id === "jawLeft" || id === "jawRight" ? 0.62 : 0;
  if (lowerPlane > 0 && Math.abs(verticalTurn) >= 1e-9) {
    // Looking up exposes the underside of the jaw; looking down foreshortens it.
    adjusted = { x: adjusted.x, y: adjusted.y - verticalTurn * field.radiusY * lowerPlane * 0.065 };
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
  const triangles = region === "face" ? cage.faceTriangles : cage.skullTriangles;
  for (const [aId, bId, cId] of triangles) {
    const a = cage.points[aId].position;
    const b = cage.points[bId].position;
    const c = cage.points[cId].position;
    const weights = barycentric(base, a, b, c);
    if (!weights || Math.min(weights.a, weights.b, weights.c) < -0.015) continue;
    const targetA = projectedCagePoint(field, cage, aId, region, yawAngle, pitchAngle, yaw, pitch);
    const targetB = projectedCagePoint(field, cage, bId, region, yawAngle, pitchAngle, yaw, pitch);
    const targetC = projectedCagePoint(field, cage, cId, region, yawAngle, pitchAngle, yaw, pitch);
    return {
      x: targetA.x * weights.a + targetB.x * weights.b + targetC.x * weights.c,
      y: targetA.y * weights.a + targetB.y * weights.b + targetC.y * weights.c
    };
  }

  const ids = [...new Set(triangles.flat())];
  let total = 0;
  let dx = 0;
  let dy = 0;
  const softening = Math.max(1e-6, field.radiusX * field.radiusX * 0.0036);
  for (const id of ids) {
    const source = cage.points[id];
    const distanceSquared = (base.x - source.position.x) ** 2 + (base.y - source.position.y) ** 2;
    if (distanceSquared < 1e-12) return projectedCagePoint(field, cage, id, region, yawAngle, pitchAngle, yaw, pitch);
    const weight = source.confidence / (distanceSquared + softening);
    const target = projectedCagePoint(field, cage, id, region, yawAngle, pitchAngle, yaw, pitch);
    dx += (target.x - source.position.x) * weight;
    dy += (target.y - source.position.y) * weight;
    total += weight;
  }
  return total > 0 ? { x: base.x + dx / total, y: base.y + dy / total } : { ...base };
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
  const entersAtRoot = smoothstep01((base.y - (strandRoot.y - strandLength * 0.18)) / Math.max(1e-6, strandLength * 0.18));
  const sideDistance = Math.abs(base.x - centerX) / halfWidth;
  const sideLock = smoothstep01((sideDistance - 0.42) / 0.58);
  const expectedX = strandRoot.x + (strandTip.x - strandRoot.x) * progress;
  const distanceFromStrand = Math.abs(base.x - expectedX) / Math.max(1e-6, layer.bounds.width * 0.24);
  const strandProximity = 1 - smoothstep01((distanceFromStrand - 0.18) / 0.82);
  const sideGate = smoothstep01((sideDistance - 0.5) / 0.34);
  const strandMask = Math.max(sideLock, strandProximity * sideGate);
  const faceFollow = entersAtRoot * strandMask * (1 - smoothstep01((progress - 0.06) / 0.64)) * 0.82;
  const rootLock = entersAtRoot * strandMask * (1 - smoothstep01((progress - 0.01) / 0.34));
  // Keep the side-strand transition below a full replacement. A narrow hair
  // layer can place adjacent grid columns on opposite sides of this mask; a
  // 100% replacement then collapses the transition column at full yaw.
  const strandRelease = strandMask * smoothstep01((progress - 0.08) / 0.82) * 0.82;
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

function ahogePoseWeight(layer: LayerBinding, base: Point): number {
  if (layer.role !== "frontHair") return 0;
  const root = layer.secondaryAnchors?.ahogeRoot;
  if (!root || base.y >= root.y) return 0;
  const aboveRoot = smoothstep01((root.y - base.y) / Math.max(1e-6, root.y - layer.bounds.y));
  return aboveRoot;
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
  const targetGapScale = 1 + near * 0.04 - far * 0.1;
  const faceX = edge.x + faceDisplacement.x;
  const currentGap = screenSide * (posed.x - faceX);
  const safeGap = clamp(currentGap, outwardGap * 0.68, outwardGap * 1.48);
  const desiredGap = outwardGap * targetGapScale;
  const correctedGap = safeGap + (desiredGap - safeGap) * 0.46;
  const targetX = faceX + screenSide * correctedGap;
  const edgeWeight = layerEdgeWeight(base, edge, faceHalfWidth) * rootLock;
  return { x: posed.x + (targetX - posed.x) * edgeWeight, y: posed.y };
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
  // This PSD combines the white crown, bows and side fins in one bitmap. A
  // partial geometric mask cannot follow the painted frill silhouette between
  // grid vertices, so it leaves the visible outer edge on the old projection.
  // Treat the complete headwear as one depth plane here; the side fins still
  // receive their separate hinge motion later in deform.ts.
  const crownWeight = 1;

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
  const scaleX = 1 + near * 0.15 - far * 0.18;
  const scaleY = 1 + near * 0.045 - far * 0.065;
  const target = {
    x: posedPivot.x + (base.x - crownPivot.x) * scaleX,
    y: posedPivot.y + (base.y - crownPivot.y) * scaleY
  };
  return {
    x: posed.x + (target.x - posed.x) * crownWeight,
    y: posed.y + (target.y - posed.y) * crownWeight
  };
}

function projectSurface(field: CoherentPoseField, layer: LayerBinding, base: Point, yawAngle: number, pitchAngle: number): Point {
  const surface = surfaceFor(field, layer.role);
  const nx = (base.x - surface.center.x) / surface.radiusX;
  const ny = (base.y - surface.center.y) / surface.radiusY;
  const radial = nx * nx + ny * ny;
  const surfaceDepth = Math.sqrt(Math.max(0, 1 - Math.min(1, radial)));
  const z = surfaceDepth + roleDepth(layer.role);

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

function applyEyePerspective(layer: LayerBinding, base: Point, posed: Point, posedPivot: Point, yaw: number): Point {
  if (layer.side === "center" || (!eyeSocketRoles.has(layer.role) && layer.role !== "eyebrow")) return posed;
  const { near, far } = sidePerspective(yaw, layerScreenSide(layer));
  const scaleX = eyeSocketRoles.has(layer.role)
    ? clamp(1 + near * 0.025 - far * 0.12, 0.88, 1.025)
    : clamp(1 + near * 0.018 - far * 0.08, 0.92, 1.018);
  const scaleY = eyeSocketRoles.has(layer.role)
    ? clamp(1 + near * 0.006 - far * 0.018, 0.982, 1.006)
    : clamp(1 + near * 0.004 - far * 0.012, 0.988, 1.004);
  // The eye centre already follows the semantic face cage. Preserve the
  // neutral eye drawing around that centre and apply perspective once; using
  // the already-projected local coordinates here compressed the far eye twice.
  const localX = base.x - layer.pivot.x;
  const localY = base.y - layer.pivot.y;
  const turn = clamp(yaw, -1, 1);
  return {
    x: posedPivot.x + localX * scaleX,
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
  const cheekShift = -direction * field.radiusX * edge * cheekWeight * (far * 0.08 + near * 0.02);
  const chinShift = direction * field.radiusX * (1 - edge) * jawWeight * amount * 0.08;
  return { x: posed.x + cheekShift + chinShift, y: posed.y };
}

export function applyCoherentPoseField(
  field: CoherentPoseField,
  layer: LayerBinding,
  base: Point,
  yaw: number,
  pitch: number,
  semanticCage?: SemanticControlCage,
  cageInfluence: { face?: number; skull?: number } = {}
): Point {
  const yawAngle = clamp(yaw, -1, 1) * field.maxYawRadians;
  const pitchAngle = clamp(pitch, -1, 1) * field.maxPitchRadians;
  if (Math.abs(yawAngle) < 1e-9 && Math.abs(pitchAngle) < 1e-9) return { ...base };
  const surfacePosed = projectSurface(field, layer, base, yawAngle, pitchAngle);
  const surfacePivot = projectSurface(field, layer, layer.pivot, yawAngle, pitchAngle);
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
  const cagePivot = semanticCage && region
    ? mappedBySemanticCage(field, semanticCage, layer.pivot, region, yawAngle, pitchAngle, yaw, pitch)
    : surfacePivot;
  let posed = {
    x: surfacePosed.x + (cagePosed.x - surfacePosed.x) * cageBlend,
    y: surfacePosed.y + (cagePosed.y - surfacePosed.y) * cageBlend
  };
  posed = applyHeadwearCrownPerspective(field, semanticCage, layer, base, posed, yawAngle, pitchAngle, yaw, pitch);
  if (layer.role === "frontHair") {
    const ahogeWeight = ahogePoseWeight(layer, base);
    const ahogeRoot = layer.secondaryAnchors?.ahogeRoot;
    if (ahogeRoot && ahogeWeight > 1e-6) {
      const rootSurface = projectSurface(field, layer, ahogeRoot, yawAngle, pitchAngle);
      const rootCage = semanticCage
        ? mappedBySemanticCage(field, semanticCage, ahogeRoot, "skull", yawAngle, pitchAngle, yaw, pitch)
        : rootSurface;
      const rootPosed = {
        x: rootSurface.x + (rootCage.x - rootSurface.x) * cageBlend,
        y: rootSurface.y + (rootCage.y - rootSurface.y) * cageBlend
      };
      const lean = -clamp(yaw, -1, 1) * field.maxYawRadians * 0.22;
      const cos = Math.cos(lean);
      const sin = Math.sin(lean);
      const localX = base.x - ahogeRoot.x;
      const localY = base.y - ahogeRoot.y;
      const rigidAhoge = {
        x: rootPosed.x + localX * cos - localY * sin,
        y: rootPosed.y + localX * sin + localY * cos
      };
      posed = {
        x: posed.x + (rigidAhoge.x - posed.x) * ahogeWeight,
        y: posed.y + (rigidAhoge.y - posed.y) * ahogeWeight
      };
    }
  }
  if (semanticCage && layer.role === "frontHair") {
    const bang = frontHairBangProfile(semanticCage, layer, base);
    if (bang.weight > 1e-6) {
      const rootPosed = posedFrontHairAnchor(field, semanticCage, layer, bang.root, yawAngle, pitchAngle, yaw, pitch);
      const curtainTarget = {
        x: base.x + (rootPosed.x - bang.root.x)
          + Math.sign(yaw) * field.radiusX * Math.abs(yaw) * bang.progress * 0.015,
        y: base.y + (rootPosed.y - bang.root.y)
      };
      const curtainWeight = bang.weight * 0.88;
      posed = {
        x: posed.x + (curtainTarget.x - posed.x) * curtainWeight,
        y: posed.y + (curtainTarget.y - posed.y) * curtainWeight
      };
    }
    const strand = frontHairStrandProfile(semanticCage, layer, base);
    if (strand.strandRelease > 1e-6) {
      const rootDisplacement = frontHairAttachmentDisplacement(field, semanticCage, layer, strand.root, yawAngle, pitchAngle, yaw, pitch);
      const hangingTarget = {
        x: base.x + rootDisplacement.x,
        y: base.y + rootDisplacement.y
      };
      posed = {
        x: posed.x + (hangingTarget.x - posed.x) * strand.strandRelease,
        y: posed.y + (hangingTarget.y - posed.y) * strand.strandRelease
      };
    }
    const desired = frontHairAttachmentDisplacement(field, semanticCage, layer, base, yawAngle, pitchAngle, yaw, pitch);
    posed = {
      x: posed.x + (desired.x - (posed.x - base.x)) * strand.faceFollow * 0.72,
      y: posed.y + (desired.y - (posed.y - base.y)) * strand.faceFollow * 0.24
    };
    posed = preserveFrontHairFaceGap(
      semanticCage,
      base,
      posed,
      desired,
      yaw,
      strand.rootLock
    );
  }
  const posedPivot = {
    x: surfacePivot.x + (cagePivot.x - surfacePivot.x) * cageBlend,
    y: surfacePivot.y + (cagePivot.y - surfacePivot.y) * cageBlend
  };
  const perspective = applyEyePerspective(layer, base, posed, posedPivot, yaw);
  return semanticCage ? perspective : applyFaceSilhouette(field, layer, base, perspective, yaw);
}
