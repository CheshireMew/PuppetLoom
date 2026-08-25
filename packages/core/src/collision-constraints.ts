import type { LayerBinding, MotionParameterSemantic, MotionState, Point, PuppetLoomProject, Rect } from "./types.js";

const semanticFields: Partial<Record<MotionParameterSemantic, keyof MotionState>> = {
  "head-yaw": "headYaw", "head-pitch": "headPitch", "head-roll": "headRoll", "body-sway": "bodySway", "body-pitch": "bodyPitch", "body-roll": "bodyRoll",
  "gaze-x": "gazeX", "gaze-y": "gazeY", breath: "breath", blink: "blink", "blink-left": "blinkLeft", "blink-right": "blinkRight",
  "brow-left": "browLeft", "brow-right": "browRight", smile: "smile", "cheek-puff": "cheekPuff", "mouth-open": "mouthOpen",
  "mouth-a": "mouthA", "mouth-i": "mouthI", "mouth-u": "mouthU", "mouth-e": "mouthE", "mouth-o": "mouthO", "arm-left": "armLeft", "arm-right": "armRight",
  "hand-left-x": "handLeftX", "hand-left-y": "handLeftY", "hand-right-x": "handRightX", "hand-right-y": "handRightY", "hand-left-open": "handLeftOpen", "hand-right-open": "handRightOpen",
  "ear-x": "earX", "ear-y": "earY", "tail-x": "tailX", "tail-y": "tailY"
};

export function constrainMotionState(project: PuppetLoomProject, state: MotionState): MotionState {
  const limits = project.runtime.constraints?.motionLimits ?? [];
  if (limits.length === 0) return state;
  const next = { ...state };
  for (const limit of limits) {
    const field = semanticFields[limit.semantic];
    const value = field ? next[field] : undefined;
    if (field && typeof value === "number") (next as unknown as Record<string, unknown>)[field] = Math.max(limit.min, Math.min(limit.max, value));
  }
  return next;
}

function bounds(points: Point[]): Rect | undefined {
  if (points.length === 0) return undefined;
  const xs = points.map((point) => point.x); const ys = points.map((point) => point.y);
  const x = Math.min(...xs); const y = Math.min(...ys); const right = Math.max(...xs); const bottom = Math.max(...ys);
  return { x, y, width: right - x, height: bottom - y };
}

function overlapCorrection(moving: Rect, collider: Rect, padding: number): Point {
  const left = collider.x - padding - (moving.x + moving.width);
  const right = collider.x + collider.width + padding - moving.x;
  const up = collider.y - padding - (moving.y + moving.height);
  const down = collider.y + collider.height + padding - moving.y;
  if (left >= 0 || right <= 0 || up >= 0 || down <= 0) return { x: 0, y: 0 };
  const candidates = [{ x: left, y: 0 }, { x: right, y: 0 }, { x: 0, y: up }, { x: 0, y: down }];
  return candidates.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0]!;
}

/** Resolves configured layer collisions as bounded translations after deformation. */
export function applyLayerCollisionConstraints(project: PuppetLoomProject, layer: LayerBinding, points: Point[]): Point[] {
  const rules = project.runtime.constraints?.collisions.filter((rule) => rule.movingLayerIds.includes(layer.id)) ?? [];
  if (rules.length === 0) return points;
  let shifted = points;
  for (const rule of rules) {
    for (const colliderId of rule.colliderLayerIds) {
      const collider = project.layers.find((candidate) => candidate.id === colliderId && candidate.visible !== false);
      const movingBounds = bounds(shifted);
      if (!collider || !movingBounds) continue;
      const correction = overlapCorrection(movingBounds, collider.bounds, rule.padding);
      const magnitude = Math.hypot(correction.x, correction.y);
      if (magnitude <= 1e-9) continue;
      const scale = Math.min(1, rule.maxCorrection / magnitude) * rule.strength;
      shifted = shifted.map((point) => ({ x: point.x + correction.x * scale, y: point.y + correction.y * scale }));
    }
  }
  return shifted;
}
