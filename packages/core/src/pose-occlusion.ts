import type { LayerBinding, MotionState, PoseOcclusionProfile, PuppetLoomProject } from "./types.js";

export const defaultPoseOcclusionProfile: PoseOcclusionProfile = {
  kind: "semantic-occlusion-v1",
  fadeStart: 0.58,
  farEyeOpacity: 1,
  farBrowOpacity: 1,
  farEarOpacity: 0.55,
  farSideHairOpacity: 0.72,
  sideHairDepthSwap: true
};

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function screenSide(layer: LayerBinding): -1 | 0 | 1 {
  if (layer.side === "left") return 1;
  if (layer.side === "right") return -1;
  return 0;
}

function farAmount(layer: LayerBinding, yaw: number): number {
  return Math.max(0, Math.max(-1, Math.min(1, yaw)) * screenSide(layer));
}

function profileFor(project: PuppetLoomProject): PoseOcclusionProfile | undefined {
  if (!project.runtime.poseField) return undefined;
  return project.runtime.poseOcclusion ?? defaultPoseOcclusionProfile;
}

function isPaintedFaceFeature(layer: LayerBinding): boolean {
  return layer.role === "eyeWhite"
    || layer.role === "iris"
    || layer.role === "eyelash"
    || layer.role === "eyeClosed"
    || layer.role === "eyebrow";
}

/** Keeps painted face features opaque and only softens peripheral parts near the turned silhouette. */
export function poseDependentOpacity(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): number {
  // Eye and brow textures are already narrowed and displaced by the pose field. Making them
  // translucent reveals the pale face beneath and reads as a white veil instead of occlusion.
  // The early return also protects existing projects that persisted the old sub-1 defaults.
  if (isPaintedFaceFeature(layer)) return 1;
  const profile = profileFor(project);
  if (!profile || layer.side === "center") return 1;
  const amount = farAmount(layer, state.headYaw);
  const fade = smoothstep((amount - profile.fadeStart) / Math.max(1e-6, 1 - profile.fadeStart));
  if (fade <= 0) return 1;
  const floor = layer.role === "ear"
    ? profile.farEarOpacity
    : layer.role === "sideHair"
      ? profile.farSideHairOpacity
      : 1;
  return 1 + (floor - 1) * fade;
}

/** Places far side locks behind the face and near side locks in front without disturbing unrelated PSD order. */
export function poseDependentOrder(
  project: PuppetLoomProject,
  layer: LayerBinding,
  state: MotionState,
  authoredOrder: number,
  faceOrder: number | undefined
): number {
  const profile = profileFor(project);
  if (!profile?.sideHairDepthSwap || faceOrder === undefined || layer.side === "center") return authoredOrder;
  if (layer.role !== "sideHair" && layer.role !== "ear") return authoredOrder;
  const side = screenSide(layer);
  const turn = Math.max(-1, Math.min(1, state.headYaw));
  const near = Math.max(0, -turn * side);
  const far = Math.max(0, turn * side);
  const strength = Math.max(0.4, Math.min(1.6, project.runtime.poseField?.depthStrength ?? 1));
  if (layer.role === "ear") return faceOrder - 0.35 - far * 0.4 * strength + near * 0.08 * strength;
  if (Math.max(near, far) < 0.08) return authoredOrder;
  return faceOrder + near * 0.35 * strength - far * 0.45 * strength;
}
