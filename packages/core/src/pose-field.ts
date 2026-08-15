import { clamp } from "./math.js";
import type { CoherentPoseField, LayerBinding, Point, SemanticRole } from "./types.js";

const skullRoles = new Set<SemanticRole>(["frontHair", "backHair", "sideHair", "headwear", "ear"]);
const eyeSocketRoles = new Set<SemanticRole>(["eyeWhite", "iris", "eyelash", "eyeClosed"]);

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
  if (role === "ear") return 0.52;
  if (role === "frontHair") return 0.66;
  if (role === "headwear") return 0.54;
  if (role === "sideHair") return 0.58;
  if (role === "backHair") {
    const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
    const freeEnd = v * v * (3 - 2 * v);
    return 0.62 - freeEnd * 0.34;
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
  const pitchY = ny * cosPitch - yawZ * sinPitch;
  const pitchZ = ny * sinPitch + yawZ * cosPitch;
  const perspectiveScale = clamp(1 + (pitchZ - z) * perspective, 0.92, 1.08);
  return {
    x: surface.center.x + yawX * surface.radiusX * perspectiveScale,
    y: surface.center.y + pitchY * surface.radiusY * perspectiveScale
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

function applyEyePerspective(layer: LayerBinding, posed: Point, posedPivot: Point, yaw: number): Point {
  if (layer.side === "center" || (!eyeSocketRoles.has(layer.role) && layer.role !== "eyebrow")) return posed;
  const side = layer.side === "left" ? 1 : -1;
  const strength = eyeSocketRoles.has(layer.role) ? 0.08 : 0.05;
  const near = clamp(yaw, -1, 1) * side;
  const scaleX = clamp(1 + near * strength, 0.88, 1.12);
  const scaleY = clamp(1 + near * strength * 0.22, 0.97, 1.03);
  return {
    x: posedPivot.x + (posed.x - posedPivot.x) * scaleX,
    y: posedPivot.y + (posed.y - posedPivot.y) * scaleY
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
  pitch: number
): Point {
  const yawAngle = clamp(yaw, -1, 1) * field.maxYawRadians;
  const pitchAngle = clamp(pitch, -1, 1) * field.maxPitchRadians;
  if (Math.abs(yawAngle) < 1e-9 && Math.abs(pitchAngle) < 1e-9) return { ...base };
  const posed = projectSurface(field, layer, base, yawAngle, pitchAngle);
  const posedPivot = projectSurface(field, layer, layer.pivot, yawAngle, pitchAngle);
  const perspective = applyEyePerspective(layer, posed, posedPivot, yaw);
  return applyFaceSilhouette(field, layer, base, perspective, yaw);
}
