import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { solveAssetRegistration, rasterizeRegisteredAsset, type AssetRegistrationInput } from "./asset-registration.js";
import { loadCalibration } from "./project-store.js";
import { loadProjectRevision, projectFingerprint, saveCalibrationPatch } from "./calibration-store.js";
import { applyCalibrationOverrides } from "./calibration.js";
import { neutralMotionState } from "./deform.js";
import { renderProjectDirectoryPosePng } from "./offline-render.js";
import { makeAdaptiveMesh } from "./art-mesh.js";
import { reprojectMeshInfluences, reprojectSparsePointDeltas } from "./mesh.js";
import { applySafetyLimits } from "./safety.js";
import { compareProjectStates } from "./render-suite.js";
import { PuppetLoomError } from "./errors.js";
import type { CalibrationPatch, LayerBinding, Rect, Size } from "./types.js";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
const assemblySchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  additions: z.array(z.object({ registrationId: idSchema, layerId: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string().min(1).optional(), order: z.number().int().optional() }).strict()).min(1).max(64),
  replaceLayerIds: z.array(z.string().min(1)).default([]),
  label: z.string().min(1).max(160).optional()
}).strict();
export type AssetAssemblyInput = z.input<typeof assemblySchema>;

interface AssetReference {
  version: 1; baseRevision: number; fingerprint: string; templateLayerId: string; canvas: Size;
  sourceRect: Rect; cleanPath: string; cleanSha256: string; contextPath: string; contextSha256: string;
  annotationPath: string; annotationSha256: string;
}
interface RegisteredAsset {
  version: 1; referenceId: string; originalPath: string; originalSha256: string;
  texture: string; textureSha256: string; bounds: Rect;
  registration: ReturnType<typeof solveAssetRegistration>;
}
interface AssemblyPlan {
  version: 1; baseFingerprint: string; afterFingerprint: string; patch: CalibrationPatch;
  registrations: string[]; textures: Record<string, string>;
}

async function immutableFile(root: string, path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  try { await writeFile(join(root, path), bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (sha(await readFile(join(root, path))) !== sha(bytes)) throw new Error(`不可变素材内容不一致：${path}`);
  }
}
async function imageFile(root: string, bytes: Uint8Array, kind = "assets/images") {
  const hash = sha(bytes), path = `${kind}/${hash}.png`;
  await immutableFile(root, path, bytes);
  return { path, hash };
}
async function documentFile(root: string, kind: string, body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body)), id = sha(bytes), path = `assets/${kind}/${id}.json`;
  await immutableFile(root, path, bytes);
  return { id, path };
}
async function readDocument<T>(root: string, kind: string, id: string): Promise<T> {
  idSchema.parse(id);
  const bytes = await readFile(join(root, "assets", kind, `${id}.json`));
  if (sha(bytes) !== id) throw new Error(`素材记录已被修改：${kind}/${id}`);
  return JSON.parse(bytes.toString("utf8")) as T;
}
async function checkedImage(root: string, path: string, hash: string): Promise<Buffer> {
  const bytes = await readFile(join(root, path));
  if (sha(bytes) !== hash) throw new Error(`素材像素已变化：${path}`);
  return bytes;
}

/** Preserve generated artwork provenance when a source-PSD migration retains its layer snapshots. */
export async function copyRegisteredAsset(sourceDirectory: string, targetDirectory: string, registrationId: string): Promise<void> {
  const source = resolve(sourceDirectory), target = resolve(targetDirectory);
  const registration = await readDocument<RegisteredAsset>(source, "registrations", registrationId);
  const reference = await readDocument<AssetReference>(source, "references", registration.referenceId);
  for (const [path, hash] of [
    [registration.originalPath, registration.originalSha256], [registration.texture, registration.textureSha256],
    [reference.cleanPath, reference.cleanSha256], [reference.contextPath, reference.contextSha256],
    [reference.annotationPath, reference.annotationSha256]
  ] as const) await immutableFile(target, path, await checkedImage(source, path, hash));
  for (const [kind, id] of [["references", registration.referenceId], ["registrations", registrationId]] as const) {
    const path = `assets/${kind}/${id}.json`;
    await immutableFile(target, path, await readFile(join(source, path)));
  }
}

export async function prepareAssetReference(directory: string, templateLayerId: string) {
  const root = resolve(directory), revision = (await loadCalibration(root)).revision;
  const project = await loadProjectRevision(root, revision);
  const template = project.layers.find((layer) => layer.id === templateLayerId);
  if (!template) throw new PuppetLoomError("INVALID_INPUT", `找不到参考图层：${templateLayerId}`);
  const clean = await imageFile(root, await readFile(join(root, template.texture)));
  const context = await imageFile(root, await renderProjectDirectoryPosePng(root, project, neutralMotionState, project.canvas.width, project.canvas.height));
  // Imported bounds are stored at six decimal places; recover integer source-pixel edges
  // only within that known quantization interval, leaving genuine fractional placements intact.
  const sourcePixel = (value: number, extent: number) => {
    const pixel = value * extent;
    return Math.abs(pixel - Math.round(pixel)) <= extent * 0.0000005 + 1e-8 ? Math.round(pixel) : pixel;
  };
  const sourceRect = { x: sourcePixel(template.bounds.x, project.canvas.width), y: sourcePixel(template.bounds.y, project.canvas.height), width: sourcePixel(template.bounds.width, project.canvas.width), height: sourcePixel(template.bounds.height, project.canvas.height) };
  const annotation = await imageFile(root, await sharp(join(root, context.path)).composite([{ input: Buffer.from(`<svg width="${project.canvas.width}" height="${project.canvas.height}"><rect x="${sourceRect.x}" y="${sourceRect.y}" width="${sourceRect.width}" height="${sourceRect.height}" fill="none" stroke="#ff2b8a" stroke-width="2"/></svg>`) }]).png().toBuffer());
  const body: AssetReference = { version: 1, baseRevision: revision, fingerprint: projectFingerprint(project), templateLayerId, canvas: project.canvas, sourceRect, cleanPath: clean.path, cleanSha256: clean.hash, contextPath: context.path, contextSha256: context.hash, annotationPath: annotation.path, annotationSha256: annotation.hash };
  return { ...await documentFile(root, "references", body), ...body, coordinateSystem: "pixel edges, top-left origin; clean image frame maps to sourceRect" };
}

export async function registerAssetImage(directory: string, referenceId: string, imagePath: string, registration: AssetRegistrationInput) {
  const root = resolve(directory), reference = await readDocument<AssetReference>(root, "references", referenceId);
  const bytes = await readFile(resolve(imagePath));
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "png") throw new PuppetLoomError("INVALID_INPUT", "补件必须是 PNG。" );
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const solved = solveAssetRegistration(registration, info);
  const raster = rasterizeRegisteredAsset(data, info.width, info.height, solved.matrix, reference.canvas);
  const texture = await imageFile(root, await sharp(raster.data, { raw: { width: raster.bounds.width, height: raster.bounds.height, channels: 4 } }).png().toBuffer(), "textures/assets");
  const original = await imageFile(root, bytes, "assets/originals");
  const body: RegisteredAsset = { version: 1, referenceId, originalPath: original.path, originalSha256: original.hash, texture: texture.path, textureSha256: texture.hash, bounds: raster.bounds, registration: solved };
  return { ...await documentFile(root, "registrations", body), ...body };
}

export async function planAssetAssembly(directory: string, raw: AssetAssemblyInput) {
  const input = assemblySchema.parse(raw), root = resolve(directory);
  const current = await loadCalibration(root);
  if (current.revision !== input.baseRevision) throw new PuppetLoomError("REVISION_CONFLICT", "补件试装的基线版本已经变化。" );
  const before = await loadProjectRevision(root, input.baseRevision);
  const baseFingerprint = projectFingerprint(before);
  const assetLayers: Record<string, LayerBinding> = {}, textures: Record<string, string> = {};
  const model = structuredClone(before.model);
  for (const addition of input.additions) {
    if (before.layers.some((layer) => layer.id === addition.layerId) || assetLayers[addition.layerId]) throw new Error(`新补件需要未占用的图层 ID：${addition.layerId}`);
    const asset = await readDocument<RegisteredAsset>(root, "registrations", addition.registrationId);
    const reference = await readDocument<AssetReference>(root, "references", asset.referenceId);
    if (reference.baseRevision !== current.revision || reference.fingerprint !== baseFingerprint) throw new PuppetLoomError("REVISION_CONFLICT", "参考图不属于当前模型版本，请重新准备参考。" );
    const template = before.layers.find((layer) => layer.id === reference.templateLayerId)!;
    if (template.locked) throw new Error(`参考图层已锁定：${template.id}`);
    await checkedImage(root, asset.originalPath, asset.originalSha256);
    const { data, info } = await sharp(await checkedImage(root, asset.texture, asset.textureSha256)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const bounds = { x: asset.bounds.x / before.canvas.width, y: asset.bounds.y / before.canvas.height, width: asset.bounds.width / before.canvas.width, height: asset.bounds.height / before.canvas.height };
    const mesh = makeAdaptiveMesh({ bounds, pixels: { width: info.width, height: info.height, data: new Uint8ClampedArray(data) }, detail: template.mesh.art?.detail ?? 24, fallbackRows: 4, fallbackCols: 4 });
    // Transfer by canvas position, not by each image's unrelated crop UV coordinates.
    const sourceSampling = { ...template.mesh, uvs: template.mesh.uvs.map((uv) => ({
      x: template.bounds.x + uv.x * template.bounds.width,
      y: template.bounds.y + uv.y * template.bounds.height
    })) }, targetSampling = { ...mesh, uvs: mesh.points };
    mesh.influences = reprojectMeshInfluences(sourceSampling, targetSampling);
    const neutralDeltas = Object.fromEntries(template.mesh.points.map((point, index) => [String(index), {
      x: point.x - sourceSampling.uvs[index]!.x, y: point.y - sourceSampling.uvs[index]!.y
    }]));
    const projectedNeutral = reprojectSparsePointDeltas(sourceSampling, targetSampling, neutralDeltas);
    mesh.points = mesh.points.map((point, index) => ({
      x: point.x + (projectedNeutral?.[String(index)]?.x ?? 0),
      y: point.y + (projectedNeutral?.[String(index)]?.y ?? 0)
    }));
    const layer: LayerBinding = {
      ...structuredClone(template), id: addition.layerId, sourceName: addition.name ?? addition.layerId,
      sourcePath: ["generated", addition.layerId], texture: asset.texture, bounds, mesh,
      visible: true, locked: false, order: addition.order ?? template.order,
      generatedAsset: { referenceId: asset.referenceId, registrationId: addition.registrationId, imageSha256: asset.originalSha256, templateLayerId: template.id }
    };
    delete layer.sourceLayerId;
    if (template.hairStrands) layer.hairStrands = template.hairStrands.map((strand) => {
      const projected = reprojectMeshInfluences({ ...sourceSampling, influences: { head: strand.weights, physics: strand.release } }, targetSampling);
      return { ...structuredClone(strand), id: `${layer.id}/${strand.id}`, weights: projected.head!, release: projected.physics! };
    });
    assetLayers[layer.id] = layer;
    textures[asset.texture] = asset.textureSha256;
    for (const binding of before.model.bindings.filter((candidate) => candidate.target.kind === "layer" && candidate.target.id === template.id)) {
      model.bindings.push({ ...structuredClone(binding), id: `${binding.id}/asset/${layer.id}`, target: { kind: "layer", id: layer.id }, keyforms: binding.keyforms.map((keyform) => {
        const next = structuredClone(keyform);
        if (keyform.meshPointDeltas) { const deltas = reprojectSparsePointDeltas(sourceSampling, targetSampling, keyform.meshPointDeltas); if (deltas) next.meshPointDeltas = deltas; else delete next.meshPointDeltas; }
        return next;
      }) });
    }
  }
  const layers: NonNullable<CalibrationPatch["overrides"]["layers"]> = {};
  for (const id of input.replaceLayerIds) {
    const layer = before.layers.find((candidate) => candidate.id === id);
    if (!layer || layer.locked) throw new Error(`替换图层不存在或已锁定：${id}`);
    layers[id] = { visible: false };
  }
  const patch: CalibrationPatch = { baseRevision: input.baseRevision, label: input.label ?? "应用已配准补件", overrides: { assetLayers, model, layers } };
  const after = applySafetyLimits(applyCalibrationOverrides(before, patch.overrides));
  const plan: AssemblyPlan = { version: 1, baseFingerprint, afterFingerprint: projectFingerprint(after), patch, registrations: input.additions.map((addition) => addition.registrationId), textures };
  const record = await documentFile(root, "assemblies", plan);
  const evidence = await compareProjectStates(root, before, after, current.revision, current.revision + 1, join(root, "reports", "asset-assembly", record.id));
  return { ...record, baseRevision: current.revision, additions: Object.keys(assetLayers), replaced: input.replaceLayerIds, afterFingerprint: plan.afterFingerprint, evidence };
}

export async function applyAssetAssembly(directory: string, planId: string) {
  const root = resolve(directory), plan = await readDocument<AssemblyPlan>(root, "assemblies", planId);
  const current = await loadCalibration(root);
  if (current.revision !== plan.patch.baseRevision) throw new PuppetLoomError("REVISION_CONFLICT", "试装之后模型版本已经变化，本次没有应用。" );
  const before = await loadProjectRevision(root, current.revision);
  if (projectFingerprint(before) !== plan.baseFingerprint) throw new PuppetLoomError("REVISION_CONFLICT", "试装之后模型内容已经变化。" );
  for (const [path, hash] of Object.entries(plan.textures)) await checkedImage(root, path, hash);
  for (const id of plan.registrations) {
    const asset = await readDocument<RegisteredAsset>(root, "registrations", id);
    await checkedImage(root, asset.originalPath, asset.originalSha256);
  }
  const after = applySafetyLimits(applyCalibrationOverrides(before, plan.patch.overrides));
  if (projectFingerprint(after) !== plan.afterFingerprint) throw new Error("当前实现与试装结果不一致，请重新试装。" );
  return saveCalibrationPatch(root, plan.patch);
}
