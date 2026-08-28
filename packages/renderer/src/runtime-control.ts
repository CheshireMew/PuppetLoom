import type { CharacterStateSelection, PuppetLoomProject, RuntimeControlSnapshot, RuntimeControlSource, RuntimeMotionInputKey } from "@puppetloom/core/browser";

export interface ResolvedRuntimeControl {
  sources: RuntimeControlSource[];
  motion: Partial<Record<RuntimeMotionInputKey, number>>;
  parameters: Record<string, number>;
  expressions: Record<string, number>;
  behavior?: { id: string; timeSeconds: number; weight?: number };
  characterState?: CharacterStateSelection;
}

const emptyResolvedRuntimeControl: ResolvedRuntimeControl = { sources: [], motion: {}, parameters: {}, expressions: {} };
const emptyRuntimeAuthoredState = {};
const nonnegativeMotionKeys = new Set<RuntimeMotionInputKey>([
  "blink", "mouthOpen", "blinkLeft", "blinkRight", "smile", "cheekPuff",
  "mouthA", "mouthI", "mouthU", "mouthE", "mouthO", "handLeftOpen", "handRightOpen"
]);

function blendValue(current: number, target: number, blend: number): number {
  return current + (target - current) * Math.max(0, Math.min(1, blend));
}

function activeSources(snapshot: RuntimeControlSnapshot | undefined, nowMs: number): RuntimeControlSource[] {
  if (!snapshot) return [];
  return snapshot.sources
    .filter((source) => source.expiresAtMs === undefined || source.expiresAtMs > nowMs)
    .sort((left, right) => left.priority - right.priority || left.updatedAtMs - right.updatedAtMs || left.id.localeCompare(right.id));
}

/** Resolves all live sources deterministically; higher priority sources are applied last. */
export function resolveRuntimeControl(snapshot: RuntimeControlSnapshot | undefined, nowMs = Date.now()): ResolvedRuntimeControl {
  if (!snapshot || snapshot.sources.length === 0) return emptyResolvedRuntimeControl;
  const sources = activeSources(snapshot, nowMs);
  if (sources.length === 0) return emptyResolvedRuntimeControl;
  const motion: Partial<Record<RuntimeMotionInputKey, number>> = {};
  const parameters: Record<string, number> = {};
  const expressions: Record<string, number> = {};
  let behavior: ResolvedRuntimeControl["behavior"];
  let characterState: CharacterStateSelection | undefined;
  for (const source of sources) {
    const blend = Math.max(0, Math.min(1, source.blend));
    for (const [key, value] of Object.entries(source.motion ?? {}) as Array<[RuntimeMotionInputKey, number]>) {
      motion[key] = blendValue(motion[key] ?? 0, value, blend);
    }
    for (const [key, value] of Object.entries(source.parameters ?? {})) parameters[key] = blendValue(parameters[key] ?? 0, value, blend);
    for (const [key, value] of Object.entries(source.expressions ?? {})) expressions[key] = blendValue(expressions[key] ?? 0, value, blend);
    if (source.behavior) behavior = { id: source.behavior.id, timeSeconds: Math.max(0, (nowMs - source.behavior.startedAtMs) / 1000), weight: blend };
    if (source.characterState) characterState = structuredClone(source.characterState);
  }
  return { sources, motion, parameters, expressions, ...(behavior ? { behavior } : {}), ...(characterState ? { characterState } : {}) };
}

export function controlledMotionValue(base: number, key: RuntimeMotionInputKey, control: ResolvedRuntimeControl): number {
  let value = base;
  for (const source of control.sources) {
    const target = source.motion?.[key];
    if (target === undefined) continue;
    value = blendValue(value, target, source.blend);
  }
  const minimum = nonnegativeMotionKeys.has(key) ? 0 : -1;
  return Math.max(minimum, Math.min(1, value));
}

export function runtimeAuthoredState(project: PuppetLoomProject, control: ResolvedRuntimeControl): {
  parameters?: Record<string, number>;
  expressions?: Record<string, number>;
  behavior?: { id: string; timeSeconds: number; weight?: number };
  characterState?: CharacterStateSelection;
} {
  // Runtime callers normally receive a migrated v4 project, but pure motion consumers and
  // older embedded fixtures may intentionally provide only runtime settings and layers.
  if (!project.model || (control.sources.length === 0 && !control.behavior && !control.characterState)) return emptyRuntimeAuthoredState;
  const parameters: Record<string, number> = {};
  for (const parameter of project.model.parameters) {
    let value = parameter.default;
    let changed = false;
    for (const source of control.sources) {
      const target = source.parameters?.[parameter.id];
      if (target === undefined) continue;
      value = blendValue(value, target, source.blend);
      changed = true;
    }
    if (changed) parameters[parameter.id] = Math.max(parameter.min, Math.min(parameter.max, value));
  }
  const expressions: Record<string, number> = {};
  for (const expression of project.model.expressions) {
    let value = 0;
    let changed = false;
    for (const source of control.sources) {
      const target = source.expressions?.[expression.id];
      if (target === undefined) continue;
      value = blendValue(value, target, source.blend);
      changed = true;
    }
    if (changed) expressions[expression.id] = Math.max(0, Math.min(1, value));
  }
  return {
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
    ...(Object.keys(expressions).length > 0 ? { expressions } : {}),
    ...(control.behavior ? { behavior: control.behavior } : {}),
    ...(control.characterState ? { characterState: control.characterState } : {})
  };
}
