import { reprojectSparsePointDeltas } from "./mesh.js";
import type { AuthoringModel, MeshBinding, ModelBinding, ModelKeyform, MotionParameterSemantic, Point } from "./types.js";

const correctionGrid = [-1, 0, 1] as const;
const correctionPrefix = "pose-correction:";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parameterId(model: AuthoringModel, semantic: MotionParameterSemantic): string {
  const parameter = model.parameters.find((candidate) => candidate.semantic === semantic);
  if (!parameter) throw new Error(`模型缺少 ${semantic} 参数，无法记录姿态校正。`);
  return parameter.id;
}

function isCorrectionBinding(binding: ModelBinding, layerId: string): boolean {
  return binding.id === poseCorrectionBindingId(layerId)
    && binding.target.kind === "layer"
    && binding.target.id === layerId;
}

function canonical(value: number): -1 | 0 | 1 {
  if (value <= -0.5) return -1;
  if (value >= 0.5) return 1;
  return 0;
}

function gridKeyform(yaw: number, pitch: number): ModelKeyform {
  return { values: [yaw, pitch] };
}

export function poseCorrectionBindingId(layerId: string): string {
  return `${correctionPrefix}${layerId}`;
}

/** Returns a complete 3x3 head-yaw/head-pitch correction grid for a layer. */
export function ensurePoseCorrectionBinding(model: AuthoringModel, layerId: string): AuthoringModel {
  const next = clone(model);
  const existing = next.bindings.find((binding) => isCorrectionBinding(binding, layerId));
  if (existing) return next;
  next.bindings.push({
    id: poseCorrectionBindingId(layerId),
    parameterIds: [parameterId(next, "head-yaw"), parameterId(next, "head-pitch")],
    target: { kind: "layer", id: layerId },
    keyforms: correctionGrid.flatMap((yaw) => correctionGrid.map((pitch) => gridKeyform(yaw, pitch)))
  });
  return next;
}

export function poseCorrectionPointDeltas(
  model: AuthoringModel,
  layerId: string,
  yaw: number,
  pitch: number
): Record<string, Point> {
  const binding = model.bindings.find((candidate) => isCorrectionBinding(candidate, layerId));
  const keyform = binding?.keyforms.find((candidate) => candidate.values[0] === canonical(yaw)
    && (candidate.values[1] ?? 0) === canonical(pitch));
  return clone(keyform?.meshPointDeltas ?? {});
}

/** Replaces one canonical sample's sparse offsets, while preserving the other eight samples. */
export function setPoseCorrectionPointDeltas(
  model: AuthoringModel,
  layerId: string,
  yaw: number,
  pitch: number,
  deltas: Record<string, Point>
): AuthoringModel {
  const next = ensurePoseCorrectionBinding(model, layerId);
  const binding = next.bindings.find((candidate) => isCorrectionBinding(candidate, layerId))!;
  const keyform = binding.keyforms.find((candidate) => candidate.values[0] === canonical(yaw)
    && (candidate.values[1] ?? 0) === canonical(pitch))!;
  const cleaned = Object.fromEntries(Object.entries(deltas)
    .filter(([, point]) => Math.hypot(point.x, point.y) > 1e-9)
    .map(([index, point]) => [index, { x: point.x, y: point.y }]));
  if (Object.keys(cleaned).length > 0) keyform.meshPointDeltas = cleaned;
  else delete keyform.meshPointDeltas;
  return next;
}

export function poseCorrectionSamples(model: AuthoringModel, layerId: string): Array<{ yaw: number; pitch: number; pointCount: number }> {
  const binding = model.bindings.find((candidate) => isCorrectionBinding(candidate, layerId));
  if (!binding) return [];
  return binding.keyforms.map((keyform) => ({
    yaw: keyform.values[0],
    pitch: keyform.values[1] ?? 0,
    pointCount: Object.keys(keyform.meshPointDeltas ?? {}).length
  }));
}

/** Carries all nine pose samples onto a replacement mesh. */
export function reprojectLayerPoseCorrections(
  model: AuthoringModel,
  layerId: string,
  source: MeshBinding,
  target: MeshBinding
): AuthoringModel {
  const next = clone(model);
  const binding = next.bindings.find((candidate) => isCorrectionBinding(candidate, layerId));
  if (!binding) return next;
  for (const keyform of binding.keyforms) {
    const projected = reprojectSparsePointDeltas(source, target, keyform.meshPointDeltas);
    if (projected) keyform.meshPointDeltas = projected;
    else delete keyform.meshPointDeltas;
  }
  return next;
}
