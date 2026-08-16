import { calibrationOverridesSchema } from "./schema.js";
import type {
  CalibrationOverrides,
  CalibrationPatch,
  LayerBinding,
  LayerCalibrationOverride,
  MeshInfluenceChannel,
  Point,
  PuppetLoomProject
} from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeIndexed<T>(base: Record<string, T> | undefined, patch: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!base && !patch) return undefined;
  return { ...(base ?? {}), ...(patch ?? {}) };
}

function mergeLayerOverride(base: LayerCalibrationOverride | undefined, patch: LayerCalibrationOverride): LayerCalibrationOverride {
  const vertexChannels = new Set<MeshInfluenceChannel>([
    ...Object.keys(base?.vertexInfluences ?? {}) as MeshInfluenceChannel[],
    ...Object.keys(patch.vertexInfluences ?? {}) as MeshInfluenceChannel[]
  ]);
  const vertexInfluences = Object.fromEntries([...vertexChannels].map((channel) => [
    channel,
    mergeIndexed(base?.vertexInfluences?.[channel], patch.vertexInfluences?.[channel])
  ]).filter(([, value]) => value !== undefined)) as LayerCalibrationOverride["vertexInfluences"];
  return {
    ...(base ?? {}),
    ...patch,
    ...(base?.secondaryAnchors || patch.secondaryAnchors ? {
      secondaryAnchors: { ...(base?.secondaryAnchors ?? {}), ...(patch.secondaryAnchors ?? {}) }
    } : {}),
    ...(base?.weights || patch.weights ? { weights: { ...(base?.weights ?? {}), ...(patch.weights ?? {}) } } : {}),
    ...(base?.meshPointDeltas || patch.meshPointDeltas ? {
      meshPointDeltas: mergeIndexed(base?.meshPointDeltas, patch.meshPointDeltas)!
    } : {}),
    ...(Object.keys(vertexInfluences ?? {}).length > 0 ? { vertexInfluences } : {})
  } as LayerCalibrationOverride;
}

export function mergeCalibrationOverrides(base: CalibrationOverrides, patch: CalibrationOverrides): CalibrationOverrides {
  const layerIds = new Set([...Object.keys(base.layers ?? {}), ...Object.keys(patch.layers ?? {})]);
  const layers = Object.fromEntries([...layerIds].map((id) => {
    const next = patch.layers?.[id];
    return [id, next ? mergeLayerOverride(base.layers?.[id], next) : base.layers![id]!];
  }));
  return calibrationOverridesSchema.parse({
    ...(base.anchors || patch.anchors ? { anchors: { ...(base.anchors ?? {}), ...(patch.anchors ?? {}) } } : {}),
    ...(base.semanticPoints || patch.semanticPoints ? {
      semanticPoints: { ...(base.semanticPoints ?? {}), ...(patch.semanticPoints ?? {}) }
    } : {}),
    ...(Object.keys(layers).length > 0 ? { layers } : {}),
    ...(base.runtime || patch.runtime ? {
      runtime: {
        ...(base.runtime ?? {}),
        ...(patch.runtime ?? {}),
        ...(base.runtime?.envelope || patch.runtime?.envelope ? {
          envelope: { ...(base.runtime?.envelope ?? {}), ...(patch.runtime?.envelope ?? {}) }
        } : {}),
        ...(base.runtime?.motionTuning || patch.runtime?.motionTuning ? {
          motionTuning: { ...(base.runtime?.motionTuning ?? {}), ...(patch.runtime?.motionTuning ?? {}) }
        } : {})
      }
    } : {})
  }) as CalibrationOverrides;
}

export function clearCalibrationOverrides(base: CalibrationOverrides, clear: CalibrationPatch["clear"]): CalibrationOverrides {
  if (!clear) return clone(base);
  const next = clone(base);
  for (const key of clear.anchors ?? []) if (next.anchors) delete next.anchors[key];
  for (const key of clear.semanticPoints ?? []) if (next.semanticPoints) delete next.semanticPoints[key];
  for (const id of clear.layers ?? []) if (next.layers) delete next.layers[id];
  for (const key of clear.runtime ?? []) if (next.runtime) delete next.runtime[key];
  if (next.anchors && Object.keys(next.anchors).length === 0) delete next.anchors;
  if (next.semanticPoints && Object.keys(next.semanticPoints).length === 0) delete next.semanticPoints;
  if (next.layers && Object.keys(next.layers).length === 0) delete next.layers;
  if (next.runtime && Object.keys(next.runtime).length === 0) delete next.runtime;
  return next;
}

function assertNormalized(point: Point, label: string): void {
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) throw new Error(`${label} 必须位于项目画布的 0..1 范围内。`);
}

function applyLayerOverride(layer: LayerBinding, override: LayerCalibrationOverride): LayerBinding {
  const next = clone(layer);
  if (override.role) next.role = override.role;
  if (override.side) next.side = override.side;
  if (override.parentGroup) next.parentGroup = override.parentGroup;
  if (override.pivot) {
    assertNormalized(override.pivot, `${layer.sourceName} 的轴心`);
    next.pivot = { ...override.pivot };
  }
  if (override.secondaryAnchors) {
    for (const [name, point] of Object.entries(override.secondaryAnchors)) if (point) assertNormalized(point, `${layer.sourceName} 的 ${name}`);
    next.secondaryAnchors = { ...(next.secondaryAnchors ?? {}), ...clone(override.secondaryAnchors) };
  }
  if (override.weights) next.weights = { ...next.weights, ...override.weights };
  for (const [rawIndex, delta] of Object.entries(override.meshPointDeltas ?? {})) {
    const index = Number(rawIndex);
    const base = next.mesh.points[index];
    if (!Number.isInteger(index) || !base) throw new Error(`${layer.sourceName} 不存在网格顶点 ${rawIndex}。`);
    const point = { x: base.x + delta.x, y: base.y + delta.y };
    assertNormalized(point, `${layer.sourceName} 的网格顶点 ${rawIndex}`);
    next.mesh.points[index] = point;
  }
  for (const [channel, values] of Object.entries(override.vertexInfluences ?? {}) as Array<[MeshInfluenceChannel, Record<string, number>]>) {
    const fallback = channel === "pin" ? 0 : 1;
    const target = [...(next.mesh.influences?.[channel] ?? Array(next.mesh.points.length).fill(fallback))];
    if (target.length !== next.mesh.points.length) throw new Error(`${layer.sourceName} 的 ${channel} 权重数量与网格不一致。`);
    for (const [rawIndex, value] of Object.entries(values)) {
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0 || index >= target.length) throw new Error(`${layer.sourceName} 不存在权重顶点 ${rawIndex}。`);
      target[index] = value;
    }
    next.mesh.influences = { ...(next.mesh.influences ?? {}), [channel]: target };
  }
  return next;
}

export function applyCalibrationOverrides(project: PuppetLoomProject, rawOverrides: CalibrationOverrides): PuppetLoomProject {
  const overrides = calibrationOverridesSchema.parse(rawOverrides) as CalibrationOverrides;
  const next = clone(project);
  next.version = 2;
  if (overrides.anchors) {
    for (const [name, point] of Object.entries(overrides.anchors)) if (point) assertNormalized(point, `锚点 ${name}`);
    next.anchors = { ...next.anchors, ...clone(overrides.anchors) };
  }
  if (overrides.semanticPoints) {
    if (!next.runtime.semanticCage) throw new Error("当前项目没有可校准的语义控制笼。" );
    for (const [id, position] of Object.entries(overrides.semanticPoints)) {
      if (!position || !(id in next.runtime.semanticCage.points)) throw new Error(`未知语义控制点：${id}`);
      assertNormalized(position, `语义控制点 ${id}`);
      const pointId = id as keyof typeof next.runtime.semanticCage.points;
      next.runtime.semanticCage.points[pointId] = {
        ...next.runtime.semanticCage.points[pointId],
        position: { ...position },
        source: "corrected",
        confidence: Math.max(0.9, next.runtime.semanticCage.points[pointId].confidence)
      };
    }
  }
  if (overrides.layers) {
    const known = new Set(next.layers.map((layer) => layer.id));
    for (const id of Object.keys(overrides.layers)) if (!known.has(id)) throw new Error(`未知图层：${id}`);
    next.layers = next.layers.map((layer) => overrides.layers?.[layer.id] ? applyLayerOverride(layer, overrides.layers[layer.id]!) : layer);
  }
  if (overrides.runtime?.envelope) next.runtime.envelope = { ...next.runtime.envelope, ...overrides.runtime.envelope };
  if (overrides.runtime?.motionTuning) {
    next.runtime.motionTuning = {
      amplitude: 1,
      response: 0.72,
      stability: 0.42,
      ...(next.runtime.motionTuning ?? {}),
      ...overrides.runtime.motionTuning
    };
  }
  return next;
}
