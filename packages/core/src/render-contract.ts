import { evaluateLayerAuthoring, evaluateLayerAuthoringResolved, resolveMotionState, type EvaluatedLayerAuthoring } from "./model.js";
import { characterLayerVisible, characterMotionState } from "./character-state.js";
import { constrainMotionState } from "./collision-constraints.js";
import { poseDependentOpacity, poseDependentOrder } from "./pose-occlusion.js";
import type { LayerBinding, MotionState, PuppetLoomProject } from "./types.js";

const eyeSurfaceRoles = new Set(["eyeWhite", "iris", "eyelash"]);

interface FeatureGateIndex {
  blinkLeftParameterIds: Set<string>;
  blinkRightParameterIds: Set<string>;
}

const featureGateIndexCache = new WeakMap<PuppetLoomProject, FeatureGateIndex>();

function featureGateIndex(project: PuppetLoomProject): FeatureGateIndex {
  const cached = featureGateIndexCache.get(project);
  if (cached) return cached;
  const parameterIds = (semantic: "blink-left" | "blink-right") => new Set([`param-${semantic}`, ...(project.model?.parameters ?? [])
    .filter((parameter) => parameter.semantic === semantic)
    .map((parameter) => parameter.id)]);
  const value = {
    blinkLeftParameterIds: parameterIds("blink-left"),
    blinkRightParameterIds: parameterIds("blink-right")
  };
  featureGateIndexCache.set(project, value);
  return value;
}

/**
 * Missing replacement art must leave the painted neutral face intact. Runtime
 * inputs and review timelines may still contain blink or mouth values, but a
 * project that explicitly disables those features cannot safely render them.
 */
export function featureGatedMotionState(project: PuppetLoomProject, state: MotionState): MotionState {
  const authoredState = characterMotionState(project, state);
  const resolved = resolveMotionState(project, constrainMotionState(project, authoredState));
  const asymmetricControlIsExplicit = (parameterIds: Set<string>, field: "blinkLeft" | "blinkRight"): boolean => {
    if (authoredState[field] !== undefined) return true;
    for (const id of parameterIds) if (authoredState.parameters?.[id] !== undefined) return true;
    const expressionIds = authoredState.expressions
      ? new Set(Object.entries(authoredState.expressions).filter(([, weight]) => weight !== 0).map(([id]) => id))
      : undefined;
    const expressions = project.model?.expressions ?? [];
    if (expressionIds && expressions.some((expression) => expressionIds.has(expression.id)
      && [...parameterIds].some((id) => expression.parameters[id] !== undefined))) return true;
    const behavior = project.model?.behaviors?.find((candidate) => candidate.id === authoredState.behavior?.id);
    if (!behavior) return false;
    return behavior.tracks.some((track) => track.target.kind === "parameter"
      ? parameterIds.has(track.target.id)
      : expressions.some((expression) => expression.id === track.target.id
        && [...parameterIds].some((id) => expression.parameters[id] !== undefined)));
  };
  const { blinkLeftParameterIds, blinkRightParameterIds } = featureGateIndex(project);
  const explicitBlinkLeft = asymmetricControlIsExplicit(blinkLeftParameterIds, "blinkLeft");
  const explicitBlinkRight = asymmetricControlIsExplicit(blinkRightParameterIds, "blinkRight");
  const blink = project.runtime.features.blink ? resolved.blink : 0;
  const blinkLeft = project.runtime.features.blink ? (project.runtime.features.asymmetricBlink && explicitBlinkLeft ? resolved.blinkLeft ?? blink : blink) : 0;
  const blinkRight = project.runtime.features.blink ? (project.runtime.features.asymmetricBlink && explicitBlinkRight ? resolved.blinkRight ?? blink : blink) : 0;
  // Keep the semantic fields and their parameter backing values aligned. Renderers
  // intentionally pass this resolved state through the contract more than once;
  // leaving default asymmetric parameters at zero would reopen both eyes on the
  // second pass even though the global blink had already resolved to one.
  const parameters = { ...(resolved.parameters ?? {}) };
  for (const id of blinkLeftParameterIds) if (parameters[id] !== undefined) parameters[id] = blinkLeft;
  for (const id of blinkRightParameterIds) if (parameters[id] !== undefined) parameters[id] = blinkRight;
  return {
    ...resolved,
    parameters,
    blink,
    blinkLeft,
    blinkRight,
    mouthOpen: project.runtime.features.mouthMotion ? resolved.mouthOpen : 0,
    mouthA: project.runtime.features.visemes ? resolved.mouthA ?? 0 : 0,
    mouthI: project.runtime.features.visemes ? resolved.mouthI ?? 0 : 0,
    mouthU: project.runtime.features.visemes ? resolved.mouthU ?? 0 : 0,
    mouthE: project.runtime.features.visemes ? resolved.mouthE ?? 0 : 0,
    mouthO: project.runtime.features.visemes ? resolved.mouthO ?? 0 : 0
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
  const ordered = project.layers.filter((layer) => layer.visible !== false && characterLayerVisible(project, layer.id, resolved)).sort((left, right) => effectiveOrder(left) - effectiveOrder(right));
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
  const blink = layer.side === "left" ? state.blinkLeft ?? state.blink : layer.side === "right" ? state.blinkRight ?? state.blink : state.blink;
  if (layer.role === "eyeClosed") return layer.opacity === 0 ? blink : layer.opacity * blink;
  if (layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash") return layer.opacity * (1 - blink);
  if (layer.role !== "mouth") return layer.opacity;
  const openness = Math.max(0, Math.min(1, state.mouthOpen));
  const variant = layer.mouthVariant ?? "closed";
  if (variant === "a") return layer.opacity * Math.max(0, Math.min(1, state.mouthA ?? 0));
  if (variant === "i") return layer.opacity * Math.max(0, Math.min(1, state.mouthI ?? 0));
  if (variant === "u") return layer.opacity * Math.max(0, Math.min(1, state.mouthU ?? 0));
  if (variant === "e") return layer.opacity * Math.max(0, Math.min(1, state.mouthE ?? 0));
  if (variant === "o") return layer.opacity * Math.max(0, Math.min(1, state.mouthO ?? 0));
  if (variant === "closed") return layer.opacity * (1 - smoothstep(openness / 0.42));
  if (variant === "slight") return layer.opacity * smoothstep(openness / 0.42) * (1 - smoothstep((openness - 0.5) / 0.38));
  return layer.opacity * smoothstep((openness - 0.42) / 0.58);
}

function projectOpacityFor(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): number {
  if (layer.role === "mouth" && (layer.mouthVariant === "closed" || layer.mouthVariant === "open")) {
    const activeMouthVariants = mouthVariantsFor(project);
    if (activeMouthVariants.has("closed") && activeMouthVariants.has("open") && !activeMouthVariants.has("slight")) {
      const open = state.mouthOpen >= 0.5;
      return layer.opacity * (layer.mouthVariant === "open" ? Number(open) : Number(!open));
    }
  }
  return opacityFor(layer, state);
}

const mouthVariantCache = new WeakMap<PuppetLoomProject, Set<string>>();

function mouthVariantsFor(project: PuppetLoomProject): Set<string> {
  const cached = mouthVariantCache.get(project);
  if (cached) return cached;
  const variants = new Set(project.layers
    .filter((candidate) => candidate.role === "mouth" && candidate.visible !== false)
    .map((candidate) => candidate.mouthVariant ?? "closed"));
  mouthVariantCache.set(project, variants);
  return variants;
}

/** Authoring-aware opacity used by all renderers. */
export function authoredOpacityFor(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): number {
  const resolved = featureGatedMotionState(project, state);
  return Math.max(0, Math.min(1, projectOpacityFor(project, layer, resolved) * evaluateLayerAuthoring(project, layer, resolved).opacityMultiplier * poseDependentOpacity(project, layer, resolved)));
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
  const canReuseResolvedState = previous?.inputState === state
    && previous.project.model === project.model
    && previous.project.runtime === project.runtime;
  const canReuseBuffers = previous?.project === project;
  const resolved = canReuseResolvedState ? previous.frame.state : featureGatedMotionState(project, state);
  const authoringByLayerId = canReuseBuffers ? previous.frame.authoringByLayerId : new Map<string, EvaluatedLayerAuthoring>();
  for (const layer of project.layers) {
    const reusable = canReuseBuffers ? authoringByLayerId.get(layer.id) : undefined;
    authoringByLayerId.set(layer.id, evaluateLayerAuthoringResolved(project, layer, resolved, reusable));
  }
  const authoredOrder = (layer: LayerBinding): number => layer.order + (authoringByLayerId.get(layer.id)?.drawOrderOffset ?? 0);
  const face = project.layers.find((layer) => layer.role === "face");
  const faceOrder = face ? authoredOrder(face) : undefined;
  const effectiveOrder = (layer: LayerBinding): number => poseDependentOrder(project, layer, resolved, authoredOrder(layer), faceOrder);
  const ordered = project.layers.filter((layer) => layer.visible !== false && characterLayerVisible(project, layer.id, resolved)).sort((left, right) => effectiveOrder(left) - effectiveOrder(right));
  const slots = ordered.map((layer, index) => eyeSurfaceRoles.has(layer.role) ? index : -1).filter((index) => index >= 0);
  const eyeLayers = ordered.filter((layer) => eyeSurfaceRoles.has(layer.role))
    .sort((left, right) => eyeSurfaceRank(left) - eyeSurfaceRank(right) || left.side.localeCompare(right.side) || effectiveOrder(left) - effectiveOrder(right));
  slots.forEach((slot, index) => { ordered[slot] = eyeLayers[index]!; });
  return {
    state: resolved,
    authoringByLayerId,
    layers: ordered.map((layer) => {
      const authoring = authoringByLayerId.get(layer.id)!;
      const opacity = Math.max(0, Math.min(1, projectOpacityFor(project, layer, resolved) * authoring.opacityMultiplier * poseDependentOpacity(project, layer, resolved)));
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
