import { clamp } from "./math.js";
import { applyCoherentPoseField } from "./pose-field.js";
import type { LayerBinding, MotionState, Point, PuppetLoomProject } from "./types.js";

function rotate(point: Point, pivot: Point, radians: number): Point {
  if (Math.abs(radians) < 1e-8) return point;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x = point.x - pivot.x;
  const y = point.y - pivot.y;
  return { x: pivot.x + x * cos - y * sin, y: pivot.y + x * sin + y * cos };
}

function featureParallax(layer: LayerBinding): number {
  if (layer.role === "nose") return 1;
  if (layer.role === "mouth") return 0.78;
  if (layer.role === "iris" || layer.role === "eyeWhite" || layer.role === "eyelash" || layer.role === "eyeClosed") return 0.62;
  if (layer.role === "eyebrow") return 0.55;
  if (layer.role === "frontHair" || layer.role === "headwear") return 0.18;
  if (layer.role === "backHair") return -0.16;
  return 0;
}

function pitchParallax(layer: LayerBinding): number {
  if (layer.role === "nose") return 1;
  if (layer.role === "mouth") return 0.78;
  if (layer.role === "iris" || layer.role === "eyeWhite" || layer.role === "eyelash" || layer.role === "eyeClosed" || layer.role === "eyebrow") return 0.55;
  if (layer.role === "frontHair" || layer.role === "headwear") return 0.18;
  if (layer.role === "backHair") return -0.12;
  return 0;
}

function smoothstep01(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function breathInfluence(layer: LayerBinding): number {
  if (layer.role === "topWear") return 1;
  if (layer.role === "neck") return 0.2;
  if (layer.role === "arm") return 0.18;
  if (layer.role === "bottomWear") return 0.08;
  if (layer.role === "unknown") return 0.12;
  return 0;
}

function physicsOffset(layer: LayerBinding, state: MotionState): Point {
  if (layer.role === "backHair") return { x: state.backHairX, y: state.backHairY };
  if (layer.role === "headwear" || layer.role === "ear") return { x: state.earX, y: state.earY };
  if (layer.role === "accessory") return { x: state.accessoryX, y: state.accessoryY };
  return { x: state.hairX, y: state.hairY };
}

function secondaryFree(layer: LayerBinding, base: Point): number {
  const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
  const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
  if (layer.role === "headwear" || layer.role === "ear") {
    const outer = smoothstep01((Math.abs(u - 0.5) - 0.18) / 0.32);
    const belowBand = smoothstep01((v - 0.18) / 0.72);
    return outer * belowBand;
  }
  return v * v;
}

function hasSidePerspective(layer: LayerBinding): boolean {
  return layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash" || layer.role === "eyeClosed" || layer.role === "eyebrow" || layer.role === "ear";
}

export function deformPoint(project: PuppetLoomProject, layer: LayerBinding, base: Point, state: MotionState): Point {
  const envelope = project.runtime.envelope;
  const faceWidth = Math.max(0.08, Math.abs((project.anchors.cheekLeft?.x ?? 0.6) - (project.anchors.cheekRight?.x ?? 0.4)) / 0.64);
  const faceHeight = Math.max(0.1, Math.abs((project.anchors.chin?.y ?? 0.5) - (project.anchors.forehead?.y ?? 0.25)) / 0.78);
  const headPivot = project.anchors.neck ?? project.anchors.chin ?? { x: 0.5, y: 0.42 };
  const bodyPivot = project.anchors.bodyCenter ?? { x: 0.5, y: 0.65 };
  const yaw = clamp(state.headYaw, -1, 1) * envelope.headYaw;
  const pitch = clamp(state.headPitch, -1, 1) * envelope.headPitch;
  const headRoll = (clamp(state.headRoll, -1, 1) * envelope.headRollDegrees * Math.PI) / 180;
  const bodyRoll = (clamp(state.bodyRoll, -1, 1) * envelope.bodyRollDegrees * Math.PI) / 180;
  let point = { ...base };

  if (layer.weights.body > 0) {
    const breath = clamp(state.breath, -1, 1);
    const breathWeight = breathInfluence(layer) * layer.weights.body;
    if (breathWeight > 0) {
      const scaleX = 1 + breath * envelope.breath * breathWeight;
      const scaleY = 1 + breath * envelope.breath * 0.28 * breathWeight;
      point.x = bodyPivot.x + (point.x - bodyPivot.x) * scaleX;
      point.y = bodyPivot.y + (point.y - bodyPivot.y) * scaleY - Math.max(0, breath) * envelope.breath * 0.05 * breathWeight;
    }
    point.x += state.bodySway * envelope.bodySway * layer.weights.body;
    const rotated = rotate(point, bodyPivot, bodyRoll * layer.weights.body);
    point = rotated;
  }

  if (layer.weights.head > 0) {
    const headWeight = layer.weights.head;
    if (project.runtime.poseField) point = applyCoherentPoseField(project.runtime.poseField, layer, point, yaw, pitch);
    else {
      if (layer.side !== "center" && hasSidePerspective(layer)) {
        const side = layer.side === "left" ? 1 : -1;
        const perspectiveScale = 1 + yaw * side * 0.045 * headWeight;
        point.x = layer.pivot.x + (point.x - layer.pivot.x) * perspectiveScale;
      }
      const horizontalCompression = 1 - Math.abs(yaw) * 0.055 * headWeight;
      point.x = headPivot.x + (point.x - headPivot.x) * horizontalCompression;
      const upperHeadLever = clamp((headPivot.y - base.y) / Math.max(0.1, faceHeight * 1.35), 0, 1);
      point.x += yaw * faceWidth * (0.028 + featureParallax(layer) * 0.07 + upperHeadLever * 0.012) * headWeight;
      if (layer.role === "face") {
        const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
        const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
        const center = 1 - Math.abs(u * 2 - 1);
        const cheekAndChin = smoothstep01((v - 0.12) / 0.78);
        point.x += yaw * faceWidth * (0.012 + center * cheekAndChin * 0.014) * headWeight;
        point.y += pitch * faceHeight * smoothstep01((v - 0.36) / 0.64) * 0.01 * headWeight;
      }
      point.y += pitch * faceHeight * (0.012 + upperHeadLever * 0.009 + pitchParallax(layer) * 0.011) * headWeight;
    }
    point = rotate(point, headPivot, headRoll * headWeight);
  }

  if (layer.weights.gaze > 0) {
    const eyeWidth = layer.bounds.width;
    const eyeHeight = layer.bounds.height;
    point.x += clamp(state.gazeX, -1, 1) * envelope.gazeX * eyeWidth;
    point.y += clamp(state.gazeY, -1, 1) * envelope.gazeY * eyeHeight;
  }

  if (layer.weights.physics > 0) {
    const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
    const free = secondaryFree(layer, base);
    const physics = physicsOffset(layer, state);
    const flexibleFeature = layer.role === "headwear" || layer.role === "ear";
    const flexibility = flexibleFeature ? 1.35 : 1;
    point.x += physics.x * faceWidth * 1.6 * flexibility * layer.weights.physics * free;
    point.y += physics.y * faceHeight * 0.84 * flexibility * layer.weights.physics * free;
    if (layer.role === "frontHair" || layer.role === "backHair" || layer.role === "sideHair" || flexibleFeature) {
      const twist = flexibleFeature ? 0.22 : 0.14;
      point.y += physics.x * (u - 0.5) * faceHeight * twist * layer.weights.physics * free;
    }
  }

  return point;
}

export function deformedPoints(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): Point[] {
  return layer.mesh.points.map((point) => deformPoint(project, layer, point, state));
}

export const neutralMotionState: MotionState = {
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  bodySway: 0,
  bodyRoll: 0,
  gazeX: 0,
  gazeY: 0,
  breath: 0,
  hairX: 0,
  hairY: 0,
  backHairX: 0,
  backHairY: 0,
  earX: 0,
  earY: 0,
  accessoryX: 0,
  accessoryY: 0,
  blink: 0
};
