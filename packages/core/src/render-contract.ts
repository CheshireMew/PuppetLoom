import { evaluateLayerAuthoring, resolveMotionState } from "./model.js";
import type { LayerBinding, MotionState, PuppetLoomProject } from "./types.js";

const eyeSurfaceRoles = new Set(["eyeWhite", "iris", "eyelash"]);

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
  const offsets = new Map(project.layers.map((layer) => [layer.id, evaluateLayerAuthoring(project, layer, state).drawOrderOffset]));
  const effectiveOrder = (layer: LayerBinding): number => layer.order + (offsets.get(layer.id) ?? 0);
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
  const resolved = resolveMotionState(project, state);
  return Math.max(0, Math.min(1, opacityFor(layer, resolved) * evaluateLayerAuthoring(project, layer, resolved).opacityMultiplier));
}

export type SupportedBlendMode = "normal" | "multiply" | "screen" | "add" | "darken" | "lighten";

export function normalizedBlendMode(mode: string): SupportedBlendMode {
  const normalized = mode.toLowerCase().replace(/[-_]/g, " ").trim();
  if (normalized === "multiply" || normalized === "screen" || normalized === "darken" || normalized === "lighten") return normalized;
  if (normalized === "linear dodge" || normalized === "add" || normalized === "lighter color") return "add";
  return "normal";
}
