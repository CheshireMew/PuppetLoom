import { clamp } from "./math.js";
import type { CoherentPoseField, LayerBinding, Point, SemanticRole } from "./types.js";

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

function rolePoseBlend(role: SemanticRole): number {
  if (role === "face" || role === "nose" || role === "mouth" || role === "eyeWhite" || role === "iris" || role === "eyelash" || role === "eyeClosed" || role === "eyebrow") return 1;
  if (role === "ear") return 0.85;
  if (role === "frontHair" || role === "headwear") return 0.72;
  if (role === "sideHair") return 0.64;
  if (role === "backHair") return 0.52;
  if (role === "neck") return 0.28;
  return 0.4;
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

  const nx = (base.x - field.center.x) / field.radiusX;
  const ny = (base.y - field.center.y) / field.radiusY;
  const radial = nx * nx + ny * ny;
  const surfaceDepth = Math.sqrt(Math.max(0, 1 - Math.min(1, radial)));
  const z = surfaceDepth + roleDepth(layer.role);

  const cosYaw = Math.cos(yawAngle);
  const sinYaw = Math.sin(yawAngle);
  const yawX = nx * cosYaw + z * sinYaw;
  const yawZ = -nx * sinYaw + z * cosYaw;

  const cosPitch = Math.cos(pitchAngle);
  const sinPitch = Math.sin(pitchAngle);
  const pitchY = ny * cosPitch - yawZ * sinPitch;
  const pitchZ = ny * sinPitch + yawZ * cosPitch;
  const perspectiveScale = clamp(1 + (pitchZ - z) * field.perspective, 0.92, 1.08);

  const projected = {
    x: field.center.x + yawX * field.radiusX * perspectiveScale,
    y: field.center.y + pitchY * field.radiusY * perspectiveScale
  };
  const blend = rolePoseBlend(layer.role) * layer.weights.head;
  return {
    x: base.x + (projected.x - base.x) * blend,
    y: base.y + (projected.y - base.y) * blend
  };
}
