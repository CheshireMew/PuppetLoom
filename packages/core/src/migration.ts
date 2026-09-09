import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createProject, loadBaseProject, loadCalibration, saveCalibrationPatch } from "./project.js";
import { PuppetLoomError } from "./errors.js";
import { importPsd } from "./psd.js";
import { copyRegisteredAsset } from "./asset-workflow.js";
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
  const warnings: string[] = [];
  if (sourceBase.layers.some((layer) => !layer.sourceLayerId)) {
    try {
      const sourcePsd = resolve(sourceDirectory, sourceBase.source.psdPath);
      if (await fileSha256(sourcePsd) !== sourceBase.source.psdSha256) throw new Error("源 PSD 与项目保存的哈希不一致");
      const imported = await importPsd(sourcePsd);
      for (const layer of sourceBase.layers) {
        if (layer.sourceLayerId) continue;
        const candidates = imported.layers.filter((candidate) => candidate.id === layer.id && sourcePathKey(candidate.sourcePath) === sourcePathKey(layer.sourcePath));
        if (candidates.length === 1 && candidates[0]!.sourceLayerId) layer.sourceLayerId = candidates[0]!.sourceLayerId;
      }
    } catch (error) {
      warnings.push(`旧项目的原生图层身份无法补读，继续使用可证明的路径匹配：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await createProject({
    input: resolve(options.input),
    output: outputDirectory,
    seed: options.seed ?? sourceBase.runtime.seed,
    name: options.name?.trim() || sourceBase.name,
    ...(options.reference ? { reference: resolve(options.reference) } : {})
  });
  const targetBase = await loadBaseProject(outputDirectory);
  const targetByPath = new Map<string, LayerBinding[]>();
  const targetBySourceId = new Map<string, LayerBinding[]>();
  const sourceIdCounts = new Map<string, number>();
  for (const layer of sourceBase.layers) if (layer.sourceLayerId) sourceIdCounts.set(layer.sourceLayerId, (sourceIdCounts.get(layer.sourceLayerId) ?? 0) + 1);
  for (const layer of targetBase.layers) {
    const key = sourcePathKey(layer.sourcePath);
    targetByPath.set(key, [...(targetByPath.get(key) ?? []), layer]);
    if (layer.sourceLayerId) targetBySourceId.set(layer.sourceLayerId, [...(targetBySourceId.get(layer.sourceLayerId) ?? []), layer]);
  }

  const explicit = options.layerMapping ?? {};
  if (Object.keys(explicit).some((id) => !sourceBase.layers.some((layer) => layer.id === id))
    || Object.values(explicit).some((id) => typeof id !== "string" || !targetBase.layers.some((layer) => layer.id === id))
    || new Set(Object.values(explicit)).size !== Object.values(explicit).length) {
    throw new PuppetLoomError("INVALID_INPUT", "layerMapping 必须是已有旧图层到已有新图层的一对一映射。" );
  }

  const idMapping = new Map<string, string>();
  const statuses = new Map<string, MigrationLayerMatch["status"]>();
  const matchedBy = new Map<string, NonNullable<MigrationLayerMatch["matchedBy"]>>();
  const sameCanvas = sourceBase.canvas.width === targetBase.canvas.width && sourceBase.canvas.height === targetBase.canvas.height;
  for (const sourceLayer of sourceBase.layers) {
    const sourceIdCandidates = sourceLayer.sourceLayerId ? targetBySourceId.get(sourceLayer.sourceLayerId) : undefined;
    const by = explicit[sourceLayer.id] ? "explicit" : sourceIdCandidates ? "source-id" : "path";
    const candidates = by === "explicit" ? targetBase.layers.filter((layer) => layer.id === explicit[sourceLayer.id])
      : by === "source-id" ? sourceIdCandidates!
      : (targetByPath.get(sourcePathKey(sourceLayer.sourcePath)) ?? []).filter((target) => !sourceLayer.sourceLayerId || !target.sourceLayerId || target.sourceLayerId === sourceLayer.sourceLayerId);
    if (by === "source-id" && sourceIdCounts.get(sourceLayer.sourceLayerId!) !== 1) { statuses.set(sourceLayer.id, "ambiguous"); continue; }
    if (candidates.length === 1) {
      const target = candidates[0]!;
      idMapping.set(sourceLayer.id, target.id);
      matchedBy.set(sourceLayer.id, by);
      const sameGeometry = sameCanvas
        && sameRect(sourceLayer.bounds, target.bounds)
        && sameMeshLayout(sourceLayer.mesh, target.mesh);
      const sameTexture = await fileSha256(join(sourceDirectory, sourceLayer.texture)) === await fileSha256(join(outputDirectory, target.texture));
      statuses.set(sourceLayer.id, sameGeometry ? sameTexture ? "exact" : "texture-changed" : "geometry-changed");
    } else statuses.set(sourceLayer.id, candidates.length === 0 ? "missing" : "ambiguous");
  }

  // Automatic matches must also be injective; explicit ownership wins over a fallback match.
  for (const target of new Set(idMapping.values())) {
    const sources = [...idMapping].filter(([, id]) => id === target).map(([id]) => id);
    if (sources.length < 2) continue;
    for (const source of sources) if (matchedBy.get(source) !== "explicit") {
      idMapping.delete(source); matchedBy.delete(source); statuses.set(source, "ambiguous");
    }
  }

  const migratedLayers: NonNullable<CalibrationOverrides["layers"]> = {};
  const mapping: MigrationLayerMatch[] = sourceBase.layers.map((sourceLayer) => {
    const status = statuses.get(sourceLayer.id) ?? "missing";
    const targetLayerId = idMapping.get(sourceLayer.id);
    const original = sourceCalibration.overrides.layers?.[sourceLayer.id];
    let migratedFields: string[] = [];
    let skippedFields: string[] = [];
    if (original && targetLayerId) {
      const candidate = status === "exact" || status === "texture-changed" ? clone(original) : conservativeOverride(original);
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
      ...(matchedBy.has(sourceLayer.id) ? { matchedBy: matchedBy.get(sourceLayer.id)! } : {}),
      ...(targetLayerId ? { renamed: sourcePathKey(sourceLayer.sourcePath) !== sourcePathKey(targetBase.layers.find((layer) => layer.id === targetLayerId)!.sourcePath) } : {}),
      migratedFields,
      skippedFields
    };
  });

  const allGeometryExact = sameCanvas
    && sourceBase.layers.every((layer) => statuses.get(layer.id) === "exact" || statuses.get(layer.id) === "texture-changed");
  const skippedBindingIds: string[] = [];
  const assetLayers: NonNullable<CalibrationOverrides["assetLayers"]> = {};
  const sourceAssets = sourceCalibration.overrides.assetLayers ?? {};
  const pendingAssets = new Map(Object.entries(sourceAssets));
  // Resolve dependencies before their consumers; missing or cyclic relationships stay unadopted.
  while (pendingAssets.size > 0) {
    let progressed = false;
    for (const [id, asset] of pendingAssets) {
      if (!sameCanvas || !asset.generatedAsset) continue;
      const references = [asset.generatedAsset.templateLayerId, asset.parentLayerId, asset.clipLayerId].filter((value): value is string => Boolean(value));
      if (!references.every((reference) => idMapping.has(reference) && ["exact", "texture-changed"].includes(statuses.get(reference) ?? ""))) continue;
      if (targetBase.layers.some((layer) => layer.id === id)) continue;
      const adopted = clone(asset);
      adopted.generatedAsset!.templateLayerId = idMapping.get(asset.generatedAsset.templateLayerId)!;
      if (asset.parentLayerId) adopted.parentLayerId = idMapping.get(asset.parentLayerId)!;
      if (asset.clipLayerId) adopted.clipLayerId = idMapping.get(asset.clipLayerId)!;
      await copyRegisteredAsset(sourceDirectory, outputDirectory, asset.generatedAsset.registrationId);
      assetLayers[id] = adopted;
      idMapping.set(id, id); statuses.set(id, "exact");
      const override = sourceCalibration.overrides.layers?.[id];
      if (override) migratedLayers[id] = remapParent(override, idMapping, warnings, asset);
      mapping.push({ sourceLayerId: id, targetLayerId: id, sourcePath: asset.sourcePath, status: "exact", migratedFields: ["assetLayer", ...fields(override ?? {})], skippedFields: [] });
      pendingAssets.delete(id); progressed = true;
    }
    if (!progressed) break;
  }
  for (const [id, asset] of pendingAssets) {
    mapping.push({ sourceLayerId: id, sourcePath: asset.sourcePath, status: "geometry-changed", migratedFields: [], skippedFields: ["assetLayer", ...fields(sourceCalibration.overrides.layers?.[id] ?? {})] });
    warnings.push(`补件 ${asset.sourceName} 的原画或连接关系不再兼容，未自动迁移；需要重新配准。`);
    // Do not leave the source artwork hidden when its replacement could not migrate.
    const targetTemplate = asset.generatedAsset && idMapping.get(asset.generatedAsset.templateLayerId);
    if (targetTemplate && migratedLayers[targetTemplate]?.visible === false) delete migratedLayers[targetTemplate]!.visible;
  }
  const migratedModel = sourceCalibration.overrides.model ? clone(sourceCalibration.overrides.model) : undefined;
  if (migratedModel) {
    migratedModel.bindings = migratedModel.bindings.flatMap((binding) => {
      const targetId = binding.target.kind === "layer" ? idMapping.get(binding.target.id) : binding.target.id;
      const compatible = binding.target.kind === "layer"
        ? targetId && ["exact", "texture-changed"].includes(statuses.get(binding.target.id) ?? "")
        : allGeometryExact;
      if (!compatible) { skippedBindingIds.push(binding.id); return []; }
      return [{ ...binding, target: { ...binding.target, id: targetId! } }];
    });
    if (!sameCanvas) {
      migratedModel.deformers = [];
      for (const override of Object.values(migratedLayers)) delete override.deformerId;
    }
    if (skippedBindingIds.length) warnings.push(`几何或目标身份不能证明兼容，未迁移绑定：${skippedBindingIds.join("、")}；参数、表情和动作仍保留。`);
  }
  const overrides: CalibrationOverrides = {
    ...(Object.keys(assetLayers).length > 0 ? { assetLayers } : {}),
    ...(migratedModel ? { model: migratedModel } : {}),
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
    reportPath,
    addedLayerIds: targetBase.layers.filter((layer) => ![...idMapping.values()].includes(layer.id)).map((layer) => layer.id),
    skippedBindingIds
  };
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
