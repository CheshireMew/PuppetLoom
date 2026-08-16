import { clamp } from "./math.js";
import type { CoherentPoseField, LayerBinding, Point, SemanticCagePointId, SemanticControlCage, SemanticRole } from "./types.js";

const skullRoles = new Set<SemanticRole>(["frontHair", "backHair", "sideHair", "headwear", "ear"]);
const eyeSocketRoles = new Set<SemanticRole>(["eyeWhite", "iris", "eyelash", "eyeClosed"]);

function smoothstep01(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
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
  const pitchY = ny * cosPitch + yawZ * sinPitch;
  const pitchZ = -ny * sinPitch + yawZ * cosPitch;
  const perspectiveScale = clamp(1 + (pitchZ - z) * perspective, 0.92, 1.08);
  return {
    x: surface.center.x + yawX * surface.radiusX * perspectiveScale,
    y: surface.center.y + pitchY * surface.radiusY * perspectiveScale
  };
}

function semanticLandmarkAdjustment(field: CoherentPoseField, id: SemanticCagePointId, base: Point, projected: Point, yaw: number): Point {
  const turn = clamp(yaw, -1, 1);
  const amount = Math.abs(turn);
  if (amount < 1e-9) return projected;
  const direction = Math.sign(turn);
  const side = base.x < field.center.x ? -1 : base.x > field.center.x ? 1 : 0;
  const outlineIds = new Set<SemanticCagePointId>(["faceLeft", "faceRight", "cheekLeft", "cheekRight", "jawLeft", "jawRight"]);
  if (outlineIds.has(id)) {
    const farSide = Math.max(0, -turn * side);
    const nearSide = Math.max(0, turn * side);
    return { x: projected.x + direction * field.radiusX * (farSide * 0.13 + nearSide * 0.025), y: projected.y };
  }
  const centerShift = id === "chin" ? 0.07 : id === "mouth" || id === "mouthLeft" || id === "mouthRight" ? 0.045 : id === "nose" ? 0.025 : 0;
  return centerShift > 0 ? { x: projected.x + direction * field.radiusX * amount * centerShift, y: projected.y } : projected;
}

function projectedCagePoint(
  field: CoherentPoseField,
  cage: SemanticControlCage,
  id: SemanticCagePointId,
  region: "face" | "skull",
  yawAngle: number,
  pitchAngle: number,
  yaw: number
): Point {
  const base = cage.points[id].position;
  const surface = region === "skull" && field.skullCenter && field.skullRadiusX && field.skullRadiusY
    ? { center: field.skullCenter, radiusX: field.skullRadiusX, radiusY: field.skullRadiusY }
    : { center: field.center, radiusX: field.radiusX, radiusY: field.radiusY };
  const nx = (base.x - surface.center.x) / surface.radiusX;
  const ny = (base.y - surface.center.y) / surface.radiusY;
  const radial = nx * nx + ny * ny;
  const z = Math.sqrt(Math.max(0, 1 - Math.min(1, radial)));
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
  return region === "face" ? semanticLandmarkAdjustment(field, id, base, projected, yaw) : projected;
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
  yaw: number
): Point {
  const triangles = region === "face" ? cage.faceTriangles : cage.skullTriangles;
  for (const [aId, bId, cId] of triangles) {
    const a = cage.points[aId].position;
    const b = cage.points[bId].position;
    const c = cage.points[cId].position;
    const weights = barycentric(base, a, b, c);
    if (!weights || Math.min(weights.a, weights.b, weights.c) < -0.015) continue;
    const targetA = projectedCagePoint(field, cage, aId, region, yawAngle, pitchAngle, yaw);
    const targetB = projectedCagePoint(field, cage, bId, region, yawAngle, pitchAngle, yaw);
    const targetC = projectedCagePoint(field, cage, cId, region, yawAngle, pitchAngle, yaw);
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
    if (distanceSquared < 1e-12) return projectedCagePoint(field, cage, id, region, yawAngle, pitchAngle, yaw);
    const weight = source.confidence / (distanceSquared + softening);
    const target = projectedCagePoint(field, cage, id, region, yawAngle, pitchAngle, yaw);
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

function frontHairFaceCoupling(cage: SemanticControlCage, base: Point): number {
  const forehead = cage.points.forehead.position;
  const eyeY = (cage.points.eyeLeft.position.y + cage.points.eyeRight.position.y) * 0.5;
  const faceLeft = cage.points.faceLeft.position.x;
  const faceRight = cage.points.faceRight.position.x;
  const centerX = (faceLeft + faceRight) * 0.5;
  const halfWidth = Math.max(1e-6, (faceRight - faceLeft) * 0.5);
  const side = Math.abs(base.x - centerX) / halfWidth;
  const vertical = smoothstep01((base.y - (forehead.y + (eyeY - forehead.y) * 0.16)) / Math.max(1e-6, (eyeY - forehead.y) * 0.84));
  const faceFramingSide = smoothstep01((side - 0.2) / 0.62);
  return vertical * faceFramingSide;
}

function frontHairAttachmentDisplacement(
  field: CoherentPoseField,
  cage: SemanticControlCage,
  layer: LayerBinding,
  base: Point,
  yawAngle: number,
  pitchAngle: number,
  yaw: number
): Point {
  const centerX = (cage.points.faceLeft.position.x + cage.points.faceRight.position.x) * 0.5;
  const edge = base.x < centerX ? cage.points.faceLeft.position : cage.points.faceRight.position;
  const anchor = { x: edge.x, y: base.y };
  const faceLayer = { ...layer, role: "face" as const, side: "center" as const };
  const surfaceTarget = projectSurface(field, faceLayer, anchor, yawAngle, pitchAngle);
  const cageTarget = mappedBySemanticCage(field, cage, anchor, "face", yawAngle, pitchAngle, yaw);
  const blend = cageBlendFor("face");
  return {
    x: surfaceTarget.x + (cageTarget.x - surfaceTarget.x) * blend - anchor.x,
    y: surfaceTarget.y + (cageTarget.y - surfaceTarget.y) * blend - anchor.y
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
  const side = layer.side === "left" ? 1 : -1;
  const facing = clamp(yaw, -1, 1) * side;
  const near = Math.max(0, facing);
  const far = Math.max(0, -facing);
  const scaleX = eyeSocketRoles.has(layer.role)
    ? clamp(1 + near * 0.07 - far * 0.27, 0.72, 1.07)
    : clamp(1 + near * 0.045 - far * 0.18, 0.81, 1.05);
  const scaleY = eyeSocketRoles.has(layer.role)
    ? clamp(1 + near * 0.014 - far * 0.045, 0.95, 1.02)
    : clamp(1 + near * 0.009 - far * 0.025, 0.97, 1.02);
  const localX = base.x - layer.pivot.x;
  const localY = base.y - layer.pivot.y;
  const turn = clamp(yaw, -1, 1);
  return {
    x: posedPivot.x + localX * scaleX,
    y: posedPivot.y + localY * scaleY + localX * turn * 0.055
  };
}

function applyFaceSilhouette(field: CoherentPoseField, layer: LayerBinding, base: Point, posed: Point, yaw: number): Point {
  if (layer.role !== "face") return posed;
  const turn = clamp(yaw, -1, 1);
  const amount = Math.abs(turn);
  if (amount < 1e-9) return posed;
  const localX = clamp((base.x - field.center.x) / Math.max(1e-6, field.radiusX), -1, 1);
  const side = localX < -1e-6 ? -1 : localX > 1e-6 ? 1 : 0;
  const edge = Math.abs(localX);
  const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
  const cheekWeight = clamp((v - 0.18) / 0.72, 0, 1);
  const jawWeight = clamp((v - 0.55) / 0.45, 0, 1);
  const farSide = Math.max(0, -turn * side);
  const nearSide = Math.max(0, turn * side);
  const direction = Math.sign(turn);
  const cheekShift = direction * field.radiusX * edge * cheekWeight * (farSide * 0.18 + nearSide * 0.035);
  const chinShift = direction * field.radiusX * (1 - edge) * jawWeight * amount * 0.08;
  return { x: posed.x + cheekShift + chinShift, y: posed.y };
}

export function applyCoherentPoseField(
  field: CoherentPoseField,
  layer: LayerBinding,
  base: Point,
  yaw: number,
  pitch: number,
  semanticCage?: SemanticControlCage
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
  const cageBlend = semanticCage && region ? cageBlendFor(layer.role) : 0;
  const cagePosed = semanticCage && region
    ? mappedBySemanticCage(field, semanticCage, base, region, yawAngle, pitchAngle, yaw)
    : surfacePosed;
  const cagePivot = semanticCage && region
    ? mappedBySemanticCage(field, semanticCage, layer.pivot, region, yawAngle, pitchAngle, yaw)
    : surfacePivot;
  let posed = {
    x: surfacePosed.x + (cagePosed.x - surfacePosed.x) * cageBlend,
    y: surfacePosed.y + (cagePosed.y - surfacePosed.y) * cageBlend
  };
  if (semanticCage && layer.role === "frontHair") {
    const coupling = frontHairFaceCoupling(semanticCage, base);
    const desired = frontHairAttachmentDisplacement(field, semanticCage, layer, base, yawAngle, pitchAngle, yaw);
    posed = {
      x: posed.x + (desired.x - (posed.x - base.x)) * coupling * 0.86,
      y: posed.y + (desired.y - (posed.y - base.y)) * coupling * 0.32
    };
  }
  const posedPivot = {
    x: surfacePivot.x + (cagePivot.x - surfacePivot.x) * cageBlend,
    y: surfacePivot.y + (cagePivot.y - surfacePivot.y) * cageBlend
  };
  const perspective = applyEyePerspective(layer, base, posed, posedPivot, yaw);
  return semanticCage ? perspective : applyFaceSilhouette(field, layer, base, perspective, yaw);
}
