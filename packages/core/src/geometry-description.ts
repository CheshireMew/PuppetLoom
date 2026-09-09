import { resolve } from "node:path";
import { loadProjectRevision } from "./calibration-store.js";
import { loadCalibration } from "./project-store.js";
import { PuppetLoomError } from "./errors.js";

export interface GeometryDescriptionOptions {
  bindingId?: string;
  layerId?: string;
  deformerId?: string;
  values?: number[];
  revision?: number;
  offset?: number;
  limit?: number;
}

/** A bounded inspection of actual editable points, before any parent transform or pose evaluation. */
export async function describeGeometry(directory: string, options: GeometryDescriptionOptions) {
  const fail = (message: string): never => { throw new PuppetLoomError("INVALID_INPUT", message); };
  if ([options.bindingId, options.layerId, options.deformerId].filter(Boolean).length !== 1) fail("必须且只能指定 binding、layer 或 deformer。" );
  const offset = options.offset ?? 0, limit = options.limit ?? 64;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256) fail("offset 必须为非负整数，limit 必须为 1..256。" );
  const root = resolve(directory);
  const revision = options.revision ?? (await loadCalibration(root)).revision;
  if (!Number.isInteger(revision) || revision < 0) fail("revision 必须为非负整数。" );
  const project = await loadProjectRevision(root, revision);
  const binding = options.bindingId ? project.model.bindings.find((candidate) => candidate.id === options.bindingId) : undefined;
  if (options.bindingId && !binding) fail(`找不到绑定：${options.bindingId}`);
  const target = binding?.target ?? (options.layerId ? { kind: "layer", id: options.layerId } : { kind: "deformer", id: options.deformerId! });
  const layer = target.kind === "layer" ? project.layers.find((candidate) => candidate.id === target.id) : undefined;
  const deformer = target.kind === "deformer" ? project.model.deformers.find((candidate) => candidate.id === target.id) : undefined;
  if (!layer && deformer?.kind !== "warp") fail("找不到图层网格或 warp 控制点。" );
  const points = layer?.mesh.points ?? (deformer?.kind === "warp" ? deformer.controlPoints : []);
  if (offset > points.length) fail("offset 超出顶点数量。" );
  if (options.values && !binding) fail("values 只能与 binding 一起使用。" );
  const keyform = options.values ? binding?.keyforms.find((candidate) => candidate.values.length === options.values!.length && candidate.values.every((value, axis) => value === options.values![axis])) : undefined;
  if (options.values && !keyform) fail("找不到指定参数值对应的关键形。" );
  const deltas = (layer ? keyform?.meshPointDeltas : keyform?.warpPointDeltas) ?? {};
  return {
    project: project.name, revision, target,
    coordinateSystem: { space: "rest-canvas", unit: "normalized-canvas", origin: "top-left", xAxis: "right", yAxis: "down", parentTransformsApplied: false },
    geometryRepresentation: layer ? "triangle-mesh" : "warp-grid", nativeBezier: false,
    parent: layer?.deformerId ?? deformer?.parentId ?? null,
    locked: layer?.locked === true,
    ...(layer ? { bounds: layer.bounds, triangleCount: layer.mesh.triangles.length / 3 } : {}),
    ...(binding ? { bindingId: binding.id, parameterIds: binding.parameterIds, keyforms: binding.keyforms.map((candidate) => ({ values: candidate.values, pointDeltaCount: Object.keys(candidate.meshPointDeltas ?? candidate.warpPointDeltas ?? {}).length })), ...(keyform ? { values: keyform.values } : {}) } : {}),
    pointCount: points.length, offset, limit,
    nextOffset: offset + limit < points.length ? offset + limit : null,
    points: points.slice(offset, offset + limit).map((rest, localIndex) => {
      const index = offset + localIndex;
      const delta = deltas[String(index)] ?? { x: 0, y: 0 };
      return { index, rest, delta, position: { x: rest.x + delta.x, y: rest.y + delta.y } };
    })
  };
}
