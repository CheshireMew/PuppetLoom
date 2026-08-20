import { calibrationOverridesSchema } from "./schema.js";
import { parsePuppetLoomProject } from "./project-format.js";
import { remeshArtMesh } from "./art-mesh.js";
import { frontHairPhysicsMask } from "./front-hair-geometry.js";
import { hairAttachmentInfluences } from "./hair-strands.js";
import { makeGridMesh, reprojectMeshInfluences } from "./mesh.js";
import type {
  CalibrationOverrides,
  CalibrationPatch,
  LayerBinding,
  LayerCalibrationOverride,
  MeshInfluenceChannel,
  MeshBinding,
  HairStrandSpec,
  Point,
  PuppetLoomProject
} from "./types.js";
import { PUPPETLOOM_PROJECT_VERSION } from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeIndexed<T>(base: Record<string, T> | undefined, patch: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!base && !patch) return undefined;
  return { ...(base ?? {}), ...(patch ?? {}) };
}

function mergeLayerOverride(base: LayerCalibrationOverride | undefined, patch: LayerCalibrationOverride): LayerCalibrationOverride {
  const meshChanged = patch.mesh !== undefined || (patch.meshDensity !== undefined
    && (patch.meshDensity.rows !== base?.meshDensity?.rows || patch.meshDensity.cols !== base?.meshDensity?.cols))
    || (patch.meshDetail !== undefined && patch.meshDetail !== base?.meshDetail);
  const mergeBase = meshChanged && base
    ? Object.fromEntries(Object.entries(base).filter(([key]) => key !== "meshPointDeltas"
      && key !== "vertexInfluences"
      && (!patch.mesh || (key !== "meshDensity" && key !== "meshDetail")))) as LayerCalibrationOverride
    : base;
  const vertexChannels = new Set<MeshInfluenceChannel>([
    ...Object.keys(mergeBase?.vertexInfluences ?? {}) as MeshInfluenceChannel[],
    ...Object.keys(patch.vertexInfluences ?? {}) as MeshInfluenceChannel[]
  ]);
  const vertexInfluences = Object.fromEntries([...vertexChannels].map((channel) => [
    channel,
    mergeIndexed(mergeBase?.vertexInfluences?.[channel], patch.vertexInfluences?.[channel])
  ]).filter(([, value]) => value !== undefined)) as LayerCalibrationOverride["vertexInfluences"];
  return {
    ...(mergeBase ?? {}),
    ...patch,
    ...(mergeBase?.secondaryAnchors || patch.secondaryAnchors ? {
      secondaryAnchors: { ...(mergeBase?.secondaryAnchors ?? {}), ...(patch.secondaryAnchors ?? {}) }
    } : {}),
    ...(mergeBase?.weights || patch.weights ? { weights: { ...(mergeBase?.weights ?? {}), ...(patch.weights ?? {}) } } : {}),
    ...(mergeBase?.meshPointDeltas || patch.meshPointDeltas ? {
      meshPointDeltas: mergeIndexed(mergeBase?.meshPointDeltas, patch.meshPointDeltas)!
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
    ...(patch.model ? { model: clone(patch.model) } : base.model ? { model: clone(base.model) } : {}),
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
        } : {}),
        ...(base.runtime?.poseField || patch.runtime?.poseField ? {
          poseField: { ...(base.runtime?.poseField ?? {}), ...(patch.runtime?.poseField ?? {}) }
        } : {}),
        ...(base.runtime?.poseOcclusion || patch.runtime?.poseOcclusion ? {
          poseOcclusion: { ...(base.runtime?.poseOcclusion ?? {}), ...(patch.runtime?.poseOcclusion ?? {}) }
        } : {}),
        ...(base.runtime?.secondaryMotionTuning || patch.runtime?.secondaryMotionTuning ? {
          secondaryMotionTuning: Object.fromEntries([...new Set([
            ...Object.keys(base.runtime?.secondaryMotionTuning ?? {}),
            ...Object.keys(patch.runtime?.secondaryMotionTuning ?? {})
          ])].map((part) => [part, {
            ...(base.runtime?.secondaryMotionTuning?.[part as keyof NonNullable<typeof base.runtime.secondaryMotionTuning>] ?? {}),
            ...(patch.runtime?.secondaryMotionTuning?.[part as keyof NonNullable<typeof patch.runtime.secondaryMotionTuning>] ?? {})
          }]))
        } : {})
      }
    } : {})
  }) as CalibrationOverrides;
}

export function clearCalibrationOverrides(base: CalibrationOverrides, clear: CalibrationPatch["clear"]): CalibrationOverrides {
  if (!clear) return clone(base);
  const next = clone(base);
  if (clear.model) delete next.model;
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

function meshAtDensity(layer: LayerBinding, rows: number, cols: number): MeshBinding {
  if (layer.mesh.topology !== "grid") throw new Error(`${layer.sourceName} 使用 Alpha ArtMesh，不能按行列重建。`);
  const rebuilt = makeGridMesh(layer.bounds, rows, cols);
  rebuilt.influences = reprojectMeshInfluences(layer.mesh, rebuilt);
  return rebuilt;
}

function reprojectHairStrands(previous: MeshBinding, next: MeshBinding, strands: HairStrandSpec[]): HairStrandSpec[] {
  return strands.map((strand) => ({
    ...strand,
    weights: next.points.map((point) => {
      let nearest = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < previous.points.length; index += 1) {
        const candidate = previous.points[index]!;
        const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
        if (distance < nearestDistance) {
          nearest = index;
          nearestDistance = distance;
        }
      }
      return strand.weights[nearest] ?? 0;
    }),
    release: next.points.map((point) => {
      let nearest = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < previous.points.length; index += 1) {
        const candidate = previous.points[index]!;
        const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
        if (distance < nearestDistance) {
          nearest = index;
          nearestDistance = distance;
        }
      }
      return strand.release[nearest] ?? 0;
    })
  }));
}

function applyHairStrandInfluences(layer: LayerBinding): void {
  if (!layer.hairStrands || layer.hairStrands.length < 2) return;
  const attachment = hairAttachmentInfluences(layer, layer.hairStrands);
  layer.mesh.influences = {
    ...(layer.mesh.influences ?? {}),
    headAttachment: attachment.headAttachment,
    physicsRelease: attachment.physicsRelease,
    physics: layer.mesh.points.map((point, index) => Math.max(
      layer.mesh.influences?.physics?.[index] ?? 0,
      attachment.physicsRelease[index] ?? 0,
      layer.role === "frontHair" ? frontHairPhysicsMask(layer, point) : 0
    ))
  };
}

function applyLayerOverride(layer: LayerBinding, override: LayerCalibrationOverride): LayerBinding {
  const next = clone(layer);
  const previousMesh = next.mesh;
  if (override.role) next.role = override.role;
  if (override.side) next.side = override.side;
  if (override.parentGroup) next.parentGroup = override.parentGroup;
  if (override.parentLayerId === null) delete next.parentLayerId;
  else if (override.parentLayerId !== undefined) next.parentLayerId = override.parentLayerId;
  if (override.deformerId === null) delete next.deformerId;
  else if (override.deformerId !== undefined) next.deformerId = override.deformerId;
  if (override.order !== undefined) next.order = override.order;
  if (override.visible !== undefined) next.visible = override.visible;
  if (override.locked !== undefined) next.locked = override.locked;
  if (override.pivot) {
    assertNormalized(override.pivot, `${layer.sourceName} 的轴心`);
    next.pivot = { ...override.pivot };
  }
  if (override.secondaryAnchors) {
    for (const [name, point] of Object.entries(override.secondaryAnchors)) if (point) assertNormalized(point, `${layer.sourceName} 的 ${name}`);
    next.secondaryAnchors = { ...(next.secondaryAnchors ?? {}), ...clone(override.secondaryAnchors) };
  }
  if (override.weights) next.weights = { ...next.weights, ...override.weights };
  if (override.mesh) next.mesh = clone(override.mesh);
  if (override.meshDensity) next.mesh = meshAtDensity(next, override.meshDensity.rows, override.meshDensity.cols);
  if (override.meshDetail !== undefined) {
    next.mesh = remeshArtMesh(next.mesh, next.bounds, override.meshDetail);
    if (next.role === "frontHair" && next.mesh.influences) {
      next.mesh.influences.physics = next.mesh.points.map((point) => frontHairPhysicsMask(next, point));
    }
  }
  if (override.hairStrands) next.hairStrands = clone(override.hairStrands);
  else if (next.mesh !== previousMesh && next.hairStrands) next.hairStrands = reprojectHairStrands(previousMesh, next.mesh, next.hairStrands);
  for (const [rawIndex, delta] of Object.entries(override.meshPointDeltas ?? {})) {
    const index = Number(rawIndex);
    const base = next.mesh.points[index];
    if (!Number.isInteger(index) || !base) throw new Error(`${layer.sourceName} 不存在网格顶点 ${rawIndex}。`);
    const point = { x: base.x + delta.x, y: base.y + delta.y };
    assertNormalized(point, `${layer.sourceName} 的网格顶点 ${rawIndex}`);
    next.mesh.points[index] = point;
  }
  applyHairStrandInfluences(next);
  for (const [channel, values] of Object.entries(override.vertexInfluences ?? {}) as Array<[MeshInfluenceChannel, Record<string, number>]>) {
    const fallback = channel === "pin" || channel === "physicsRelease" ? 0 : 1;
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
  const next = clone(parsePuppetLoomProject(project));
  next.version = PUPPETLOOM_PROJECT_VERSION;
  if (overrides.model) next.model = clone(overrides.model);
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
    const ids = new Set(next.layers.map((layer) => layer.id));
    for (const layer of next.layers) {
      if (layer.parentLayerId === layer.id) throw new Error(`${layer.sourceName} 不能把自己设为父图层。`);
      if (layer.parentLayerId && !ids.has(layer.parentLayerId)) throw new Error(`${layer.sourceName} 的父图层不存在。`);
      const visited = new Set([layer.id]);
      let current = layer;
      while (current.parentLayerId) {
        if (visited.has(current.parentLayerId)) throw new Error(`${layer.sourceName} 的父图层关系形成循环。`);
        visited.add(current.parentLayerId);
        current = next.layers.find((candidate) => candidate.id === current.parentLayerId)!;
      }
    }
  }
  if (overrides.runtime?.envelope) next.runtime.envelope = { ...next.runtime.envelope, ...overrides.runtime.envelope };
  if (overrides.runtime?.poseField) {
    if (!next.runtime.poseField) throw new Error("当前项目没有可校准的统一头部姿态场。");
    next.runtime.poseField = { ...next.runtime.poseField, ...overrides.runtime.poseField };
  }
  if (overrides.runtime?.poseOcclusion) {
    next.runtime.poseOcclusion = {
      kind: "semantic-occlusion-v1",
      fadeStart: 0.58,
      farEyeOpacity: 0.68,
      farBrowOpacity: 0.76,
      farEarOpacity: 0.55,
      farSideHairOpacity: 0.72,
      sideHairDepthSwap: true,
      ...(next.runtime.poseOcclusion ?? {}),
      ...overrides.runtime.poseOcclusion
    };
  }
  if (overrides.runtime?.torsoVolumeProfile) next.runtime.torsoVolumeProfile = clone(overrides.runtime.torsoVolumeProfile);
  if (overrides.runtime?.motionTuning) {
    next.runtime.motionTuning = {
      amplitude: 1,
      response: 0.72,
      stability: 0.42,
      ...(next.runtime.motionTuning ?? {}),
      ...overrides.runtime.motionTuning
    };
  }
  if (overrides.runtime?.secondaryMotionTuning) {
    const defaults = { amplitude: 1, response: 0.5, stability: 0.5 };
    const parts = new Set([
      ...Object.keys(next.runtime.secondaryMotionTuning ?? {}),
      ...Object.keys(overrides.runtime.secondaryMotionTuning)
    ]);
    next.runtime.secondaryMotionTuning = Object.fromEntries([...parts].map((part) => [part, {
      ...defaults,
      ...(next.runtime.secondaryMotionTuning?.[part as keyof typeof next.runtime.secondaryMotionTuning] ?? {}),
      ...(overrides.runtime?.secondaryMotionTuning?.[part as keyof typeof overrides.runtime.secondaryMotionTuning] ?? {})
    }]));
  }
  return parsePuppetLoomProject(next);
}
