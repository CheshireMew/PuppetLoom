import { evaluateLayerAuthoring, evaluateLayerAuthoringResolved, resolveMotionState, type EvaluatedLayerAuthoring } from "./model.js";
import { poseDependentOpacity, poseDependentOrder } from "./pose-occlusion.js";
import type { LayerBinding, MotionState, PuppetLoomProject } from "./types.js";

const eyeSurfaceRoles = new Set(["eyeWhite", "iris", "eyelash"]);

/**
 * Missing replacement art must leave the painted neutral face intact. Runtime
 * inputs and review timelines may still contain blink or mouth values, but a
 * project that explicitly disables those features cannot safely render them.
 */
export function featureGatedMotionState(project: PuppetLoomProject, state: MotionState): MotionState {
  const resolved = resolveMotionState(project, state);
  return {
    ...resolved,
    blink: project.runtime.features.blink ? resolved.blink : 0,
    mouthOpen: project.runtime.features.mouthMotion ? resolved.mouthOpen : 0
  };
}

function eyeSurfaceRank(layer: LayerBinding): number {
  if (layer.role === "eyeWhite") return 0;
  if (layer.role === "iris") return 1;
  return 2;
}

/** The single layer-order contract used by both WebGL playback and offline evidence. */
export function layersInRenderOrder(layers: LayerBinding[]): LayerBinding[] {
  const ordered = layers.filter((layer) => layer.visible !== false).sort((left, right) => left.order - right.order);
  const slots = ordered.map((layer, index) => eyeSurfaceRoles.has(layer.role) ? index : -1).filter((index) => index >= 0);
  const eyeLayers = ordered
    .filter((layer) => eyeSurfaceRoles.has(layer.role))
    .sort((left, right) => eyeSurfaceRank(left) - eyeSurfaceRank(right) || left.side.localeCompare(right.side) || left.order - right.order);
  slots.forEach((slot, index) => { ordered[slot] = eyeLayers[index]!; });
  return ordered;
}

/** Authoring-aware order used by all renderers. */
export function authoredLayersInRenderOrder(project: PuppetLoomProject, state: MotionState): LayerBinding[] {
  const resolved = featureGatedMotionState(project, state);
  const offsets = new Map(project.layers.map((layer) => [layer.id, evaluateLayerAuthoring(project, layer, resolved).drawOrderOffset]));
  const authoredOrder = (layer: LayerBinding): number => layer.order + (offsets.get(layer.id) ?? 0);
  const face = project.layers.find((layer) => layer.role === "face");
  const faceOrder = face ? authoredOrder(face) : undefined;
  const effectiveOrder = (layer: LayerBinding): number => poseDependentOrder(project, layer, resolved, authoredOrder(layer), faceOrder);
  const ordered = project.layers.filter((layer) => layer.visible !== false).sort((left, right) => effectiveOrder(left) - effectiveOrder(right));
  const slots = ordered.map((layer, index) => eyeSurfaceRoles.has(layer.role) ? index : -1).filter((index) => index >= 0);
  const eyeLayers = ordered
    .filter((layer) => eyeSurfaceRoles.has(layer.role))
    .sort((left, right) => eyeSurfaceRank(left) - eyeSurfaceRank(right) || left.side.localeCompare(right.side) || effectiveOrder(left) - effectiveOrder(right));
  slots.forEach((slot, index) => { ordered[slot] = eyeLayers[index]!; });
  return ordered;
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function opacityFor(layer: LayerBinding, state: MotionState): number {
  if (layer.role === "eyeClosed") return layer.opacity === 0 ? state.blink : layer.opacity * state.blink;
  if (layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash") return layer.opacity * (1 - state.blink);
  if (layer.role !== "mouth") return layer.opacity;
  const openness = Math.max(0, Math.min(1, state.mouthOpen));
  const variant = layer.mouthVariant ?? "closed";
  if (variant === "closed") return layer.opacity * (1 - smoothstep(openness / 0.42));
  if (variant === "slight") return layer.opacity * smoothstep(openness / 0.42) * (1 - smoothstep((openness - 0.5) / 0.38));
  return layer.opacity * smoothstep((openness - 0.42) / 0.58);
}

/** Authoring-aware opacity used by all renderers. */
export function authoredOpacityFor(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): number {
  const resolved = featureGatedMotionState(project, state);
  return Math.max(0, Math.min(1, opacityFor(layer, resolved) * evaluateLayerAuthoring(project, layer, resolved).opacityMultiplier * poseDependentOpacity(project, layer, resolved)));
}

export interface AuthoredRenderFrameLayer {
  layer: LayerBinding;
  authoring: EvaluatedLayerAuthoring;
  opacity: number;
}

export interface AuthoredRenderFrame {
  state: MotionState;
  layers: AuthoredRenderFrameLayer[];
  authoringByLayerId: Map<string, EvaluatedLayerAuthoring>;
}

export interface AuthoredRenderFrameReuse {
  project: PuppetLoomProject;
  inputState: MotionState;
  frame: AuthoredRenderFrame;
}

/** Resolves parameters and expensive authored geometry once for an entire render frame. */
export function authoredRenderFrame(project: PuppetLoomProject, state: MotionState, previous?: AuthoredRenderFrameReuse): AuthoredRenderFrame {
  const canReuse = previous?.inputState === state
    && previous.project.model === project.model
    && previous.project.runtime === project.runtime;
  const resolved = canReuse ? previous.frame.state : featureGatedMotionState(project, state);
  const previousLayers = canReuse ? new Map(previous.project.layers.map((layer) => [layer.id, layer])) : undefined;
  const authoringByLayerId = new Map(project.layers.map((layer) => {
    const reusable = previousLayers?.get(layer.id) === layer ? previous?.frame.authoringByLayerId.get(layer.id) : undefined;
    return [layer.id, reusable ?? evaluateLayerAuthoringResolved(project, layer, resolved)];
  }));
  const authoredOrder = (layer: LayerBinding): number => layer.order + (authoringByLayerId.get(layer.id)?.drawOrderOffset ?? 0);
  const face = project.layers.find((layer) => layer.role === "face");
  const faceOrder = face ? authoredOrder(face) : undefined;
  const effectiveOrder = (layer: LayerBinding): number => poseDependentOrder(project, layer, resolved, authoredOrder(layer), faceOrder);
  const ordered = project.layers.filter((layer) => layer.visible !== false).sort((left, right) => effectiveOrder(left) - effectiveOrder(right));
  const slots = ordered.map((layer, index) => eyeSurfaceRoles.has(layer.role) ? index : -1).filter((index) => index >= 0);
  const eyeLayers = ordered.filter((layer) => eyeSurfaceRoles.has(layer.role))
    .sort((left, right) => eyeSurfaceRank(left) - eyeSurfaceRank(right) || left.side.localeCompare(right.side) || effectiveOrder(left) - effectiveOrder(right));
  slots.forEach((slot, index) => { ordered[slot] = eyeLayers[index]!; });
  return {
    state: resolved,
    authoringByLayerId,
    layers: ordered.map((layer) => {
      const authoring = authoringByLayerId.get(layer.id)!;
      const opacity = Math.max(0, Math.min(1, opacityFor(layer, resolved) * authoring.opacityMultiplier * poseDependentOpacity(project, layer, resolved)));
      return { layer, authoring, opacity };
    })
  };
}

export type SupportedBlendMode = "normal" | "multiply" | "screen" | "add" | "darken" | "lighten";

export function normalizedBlendMode(mode: string): SupportedBlendMode {
  const normalized = mode.toLowerCase().replace(/[-_]/g, " ").trim();
  if (normalized === "multiply" || normalized === "screen" || normalized === "darken" || normalized === "lighten") return normalized;
  if (normalized === "linear dodge" || normalized === "add" || normalized === "lighter color") return "add";
  return "normal";
}
