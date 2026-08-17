import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createProject, loadBaseProject, loadCalibration, saveCalibrationPatch } from "./project.js";
import type {
  CalibrationOverrides,
  LayerBinding,
  LayerCalibrationOverride,
  MigrationLayerMatch,
  MigrationOptions,
  MigrationResult,
  Rect
} from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourcePathKey(path: string[]): string {
  return path.map((part) => part.trim().toLocaleLowerCase()).join("\u0000");
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-8;
}

function sameRect(left: Rect, right: Rect): boolean {
  return close(left.x, right.x) && close(left.y, right.y) && close(left.width, right.width) && close(left.height, right.height);
}

function sameMeshLayout(left: LayerBinding["mesh"], right: LayerBinding["mesh"]): boolean {
  return left.topology === right.topology
    && left.uvs.length === right.uvs.length
    && left.triangles.length === right.triangles.length
    && left.uvs.every((point, index) => {
      const candidate = right.uvs[index];
      return candidate !== undefined && close(point.x, candidate.x) && close(point.y, candidate.y);
    })
    && left.triangles.every((vertex, index) => vertex === right.triangles[index]);
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function remapParent(
  override: LayerCalibrationOverride,
  idMapping: Map<string, string>,
  warnings: string[],
  sourceLayer: LayerBinding
): LayerCalibrationOverride {
  const next = clone(override);
  if (typeof next.parentLayerId === "string") {
    const targetParent = idMapping.get(next.parentLayerId);
    if (targetParent) next.parentLayerId = targetParent;
    else {
      delete next.parentLayerId;
      warnings.push(`${sourceLayer.sourceName} 的父图层无法映射，已跳过 parentLayerId。`);
    }
  }
  return next;
}

function conservativeOverride(override: LayerCalibrationOverride): LayerCalibrationOverride {
  const next: LayerCalibrationOverride = {};
  for (const key of ["role", "side", "parentGroup", "parentLayerId", "order", "visible", "locked", "weights"] as const) {
    if (override[key] !== undefined) Object.assign(next, { [key]: clone(override[key]) });
  }
  return next;
}

function fields(value: object): string[] {
  return Object.keys(value).sort();
}

export async function migrateProject(options: MigrationOptions): Promise<MigrationResult> {
  const sourceDirectory = resolve(options.project);
  const outputDirectory = resolve(options.output);
  const [sourceBase, sourceCalibration] = await Promise.all([
    loadBaseProject(sourceDirectory),
    loadCalibration(sourceDirectory)
  ]);
  await createProject({
    input: resolve(options.input),
    output: outputDirectory,
    seed: options.seed ?? sourceBase.runtime.seed,
    name: options.name?.trim() || sourceBase.name,
    ...(options.reference ? { reference: resolve(options.reference) } : {})
  });
  const targetBase = await loadBaseProject(outputDirectory);
  const targetByPath = new Map<string, LayerBinding[]>();
  for (const layer of targetBase.layers) {
    const key = sourcePathKey(layer.sourcePath);
    targetByPath.set(key, [...(targetByPath.get(key) ?? []), layer]);
  }

  const idMapping = new Map<string, string>();
  const statuses = new Map<string, MigrationLayerMatch["status"]>();
  const sameCanvas = sourceBase.canvas.width === targetBase.canvas.width && sourceBase.canvas.height === targetBase.canvas.height;
  for (const sourceLayer of sourceBase.layers) {
    const candidates = targetByPath.get(sourcePathKey(sourceLayer.sourcePath)) ?? [];
    if (candidates.length === 1) {
      const target = candidates[0]!;
      idMapping.set(sourceLayer.id, target.id);
      const exact = sameCanvas
        && sameRect(sourceLayer.bounds, target.bounds)
        && sameMeshLayout(sourceLayer.mesh, target.mesh)
        && await fileSha256(join(sourceDirectory, sourceLayer.texture)) === await fileSha256(join(outputDirectory, target.texture));
      statuses.set(sourceLayer.id, exact ? "exact" : "geometry-changed");
    } else statuses.set(sourceLayer.id, candidates.length === 0 ? "missing" : "ambiguous");
  }

  const warnings: string[] = [];
  const migratedLayers: NonNullable<CalibrationOverrides["layers"]> = {};
  const mapping: MigrationLayerMatch[] = sourceBase.layers.map((sourceLayer) => {
    const status = statuses.get(sourceLayer.id) ?? "missing";
    const targetLayerId = idMapping.get(sourceLayer.id);
    const original = sourceCalibration.overrides.layers?.[sourceLayer.id];
    let migratedFields: string[] = [];
    let skippedFields: string[] = [];
    if (original && targetLayerId) {
      const candidate = status === "exact" ? clone(original) : conservativeOverride(original);
      const remapped = remapParent(candidate, idMapping, warnings, sourceLayer);
      migratedFields = fields(remapped);
      skippedFields = fields(original).filter((field) => !migratedFields.includes(field));
      if (migratedFields.length > 0) migratedLayers[targetLayerId] = remapped;
    } else if (original) {
      skippedFields = fields(original);
      warnings.push(`${sourceLayer.sourceName} 没有唯一的新图层映射，相关校准未迁移。`);
    }
    if (status === "geometry-changed" && skippedFields.length > 0) {
      warnings.push(`${sourceLayer.sourceName} 的几何范围已变化，跳过 ${skippedFields.join("、")}。`);
    }
    return {
      sourceLayerId: sourceLayer.id,
      ...(targetLayerId ? { targetLayerId } : {}),
      sourcePath: sourceLayer.sourcePath,
      status,
      migratedFields,
      skippedFields
    };
  });

  const allGeometryExact = sameCanvas
    && sourceBase.layers.every((layer) => statuses.get(layer.id) === "exact");
  const overrides: CalibrationOverrides = {
    ...(Object.keys(migratedLayers).length > 0 ? { layers: migratedLayers } : {}),
    ...(sourceCalibration.overrides.runtime ? { runtime: clone(sourceCalibration.overrides.runtime) } : {}),
    ...(allGeometryExact && sourceCalibration.overrides.anchors ? { anchors: clone(sourceCalibration.overrides.anchors) } : {}),
    ...(allGeometryExact && sourceCalibration.overrides.semanticPoints ? { semanticPoints: clone(sourceCalibration.overrides.semanticPoints) } : {})
  };
  if (!allGeometryExact && sourceCalibration.overrides.anchors) warnings.push("画布或图层几何发生变化，身体锚点未自动迁移。" );
  if (!allGeometryExact && sourceCalibration.overrides.semanticPoints) warnings.push("画布或图层几何发生变化，语义控制点未自动迁移。" );

  const reportsDirectory = join(outputDirectory, "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const patchPath = join(reportsDirectory, "migration-patch.json");
  const reportPath = join(reportsDirectory, "migration.json");
  const patch: import("./types.js").CalibrationPatch = { baseRevision: 0, label: `从 ${sourceBase.name} revision ${sourceCalibration.revision} 安全迁移`, overrides };
  await writeFile(patchPath, `${JSON.stringify(patch, null, 2)}\n`, "utf8");

  let appliedRevision: number | undefined;
  if (Object.keys(overrides).length > 0) {
    try {
      appliedRevision = (await saveCalibrationPatch(outputDirectory, patch)).calibration.revision;
    } catch (error) {
      warnings.push(`迁移补丁未自动应用：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const result: MigrationResult = {
    sourceProject: sourceDirectory,
    sourceRevision: sourceCalibration.revision,
    outputDirectory,
    ...(appliedRevision !== undefined ? { appliedRevision } : {}),
    mapping,
    warnings,
    patchPath,
    reportPath
  };
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
