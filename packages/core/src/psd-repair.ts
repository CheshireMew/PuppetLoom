import { createHash } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { readPsd, type Layer } from "ag-psd";
import { PuppetLoomError } from "./errors.js";
import { importPsd, inspectionFromImported, type ImportedLayer, type ImportedPsd, type PixelBuffer } from "./psd.js";

const layerSelectorSchema = z.union([
  z.string().trim().min(1),
  z.array(z.string().trim().min(1)).min(1)
]);

const placementSchema = z.object({
  relativeTo: layerSelectorSchema,
  position: z.enum(["before", "after"])
}).strict();

const boundsSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.number().int().positive()
]).refine(([left, top, right, bottom]) => right > left && bottom > top, "bounds 必须满足 right > left 且 bottom > top");

const canvasPolicySchema = z.enum(["require-match", "fit-full-canvas"]).default("require-match");

const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("delete-layer"), layer: layerSelectorSchema }).strict(),
  z.object({ op: z.literal("rename-layer"), layer: layerSelectorSchema, name: z.string().trim().min(1) }).strict(),
  z.object({ op: z.literal("set-visibility"), layer: layerSelectorSchema, visible: z.boolean() }).strict(),
  z.object({ op: z.literal("move-layer"), layer: layerSelectorSchema, placement: placementSchema }).strict(),
  z.object({
    op: z.literal("duplicate-layer"),
    source: z.string().trim().min(1),
    layer: layerSelectorSchema,
    name: z.string().trim().min(1),
    placement: placementSchema.optional()
  }).strict(),
  z.object({
    op: z.literal("split-layer-x"),
    layer: layerSelectorSchema,
    splitX: z.number().int().positive(),
    leftName: z.string().trim().min(1),
    rightName: z.string().trim().min(1)
  }).strict(),
  z.object({ op: z.literal("clear-region"), layer: layerSelectorSchema, bounds: boundsSchema }).strict(),
  z.object({
    op: z.literal("extract-white-region"),
    sourceImage: z.string().trim().min(1),
    canvasPolicy: canvasPolicySchema,
    bounds: boundsSchema,
    name: z.string().trim().min(1),
    tolerance: z.number().int().min(0).max(255).default(12),
    method: z.enum(["magic-wand", "select-subject"]).default("magic-wand"),
    placement: placementSchema.optional()
  }).strict(),
  z.object({ op: z.literal("remove-white-matte"), layer: layerSelectorSchema }).strict(),
  z.object({ op: z.literal("defringe"), layer: layerSelectorSchema, pixels: z.number().int().min(1).max(10) }).strict(),
  z.object({
    op: z.literal("merge-layers"),
    layers: z.array(layerSelectorSchema).min(2),
    name: z.string().trim().min(1),
    placement: placementSchema.optional()
  }).strict()
]);

const opacityCheckSchema = z.union([
  z.string().trim().min(1).transform((layer) => ({ layer, maxInteriorPartialRatio: 0.02 })),
  z.object({
    layer: z.string().trim().min(1),
    maxInteriorPartialRatio: z.number().min(0).max(1).default(0.02),
    bounds: boundsSchema.optional()
  }).strict()
]);

export const photoshopPsdRepairRecipeSchema = z.object({
  version: z.literal(1),
  kind: z.literal("puppetloom-photoshop-psd-repair"),
  basePsd: z.string().trim().min(1),
  referenceImage: z.string().trim().min(1).optional(),
  sources: z.array(z.object({
    id: z.string().trim().min(1),
    path: z.string().trim().min(1),
    canvasPolicy: canvasPolicySchema
  }).strict()).default([]),
  operations: z.array(operationSchema).min(1),
  checks: z.object({
    requiredLayers: z.array(z.string().trim().min(1)).default([]),
    opaqueInteriorLayers: z.array(opacityCheckSchema).default([])
  }).strict().default({ requiredLayers: [], opaqueInteriorLayers: [] })
}).strict();

export type PhotoshopPsdRepairRecipe = z.infer<typeof photoshopPsdRepairRecipeSchema>;
export type PhotoshopPsdRepairOperation = PhotoshopPsdRepairRecipe["operations"][number];
export type PhotoshopPsdCanvasPolicy = z.infer<typeof canvasPolicySchema>;

export interface PsdRepairCanvas {
  width: number;
  height: number;
}

export interface PsdRepairInputManifestEntry {
  id: string;
  role: "base" | "donor" | "extraction" | "reference" | "review-output";
  path: string;
  sha256: string;
  canvas: PsdRepairCanvas;
  canvasPolicy: PhotoshopPsdCanvasPolicy | "base" | "comparison-only";
  transform: {
    applied: boolean;
    target: PsdRepairCanvas;
    scaleX: number;
    scaleY: number;
  };
}

export interface ResolvedPhotoshopPsdRepairRecipe extends Omit<PhotoshopPsdRepairRecipe, "basePsd" | "referenceImage" | "sources" | "operations"> {
  recipePath: string;
  basePsd: string;
  referenceImage?: string;
  sources: Array<{ id: string; path: string; canvasPolicy: PhotoshopPsdCanvasPolicy }>;
  operations: PhotoshopPsdRepairOperation[];
}

export interface PhotoshopPsdRepairPlan {
  mode: "repair" | "review";
  engine: "photoshop-com" | "existing-psd";
  recipe: ResolvedPhotoshopPsdRepairRecipe;
  output: string;
  workDirectory: string;
  inputManifest: PsdRepairInputManifestEntry[];
  estimatedBytes: number;
}

export interface PsdRepairAlphaCheck {
  layer: string;
  found: boolean;
  visiblePixels: number;
  partialAlphaPixels: number;
  interiorPartialAlphaPixels: number;
  interiorPartialRatio: number;
  maximumAllowedRatio: number;
  passed: boolean;
}

export interface PsdRepairReview {
  valid: boolean;
  output: string;
  canvas: { width: number; height: number };
  layerCount: number;
  requiredLayerChecks: Array<{ layer: string; found: boolean }>;
  alphaChecks: PsdRepairAlphaCheck[];
  artifacts: {
    recomposition: string;
    white: string;
    dark: string;
    checker: string;
    layerContactSheet: string;
    layerDetailSheet: string;
    layerAlphaSheet: string;
    comparison?: string;
  };
  structuralInspection: {
    valid: boolean;
    visibleLayerCount: number;
    recognizedLayerCount: number;
    unknownLayerCount: number;
    suggestedRigLevel: "semantic" | "grouped" | "minimal";
    layerOrderIssues: ReturnType<typeof inspectionFromImported>["layerOrderIssues"];
    warnings: string[];
  };
  requiresVisualReview: true;
}

export interface LayeredPsdReview extends PsdRepairReview {
  roles: string[];
  layers: Array<{ id: string; name: string; role: string; side: string }>;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function canvasOf(path: string): Promise<PsdRepairCanvas> {
  if (extname(path).toLowerCase() === ".psd") {
    const psd = readPsd(await readFile(path), {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
      logMissingFeatures: false
    });
    return { width: psd.width, height: psd.height };
  }
  const metadata = await sharp(path).metadata();
  if (!metadata.width || !metadata.height) throw new PuppetLoomError("INVALID_INPUT", `无法读取 PSD 修复输入的画布尺寸：${path}`);
  return { width: metadata.width, height: metadata.height };
}

function sameCanvas(left: PsdRepairCanvas, right: PsdRepairCanvas): boolean {
  return left.width === right.width && left.height === right.height;
}

function sameAspectRatio(left: PsdRepairCanvas, right: PsdRepairCanvas): boolean {
  const cross = Math.abs(left.width * right.height - right.width * left.height);
  return cross / Math.max(1, left.width * right.height, right.width * left.height) <= 0.001;
}

function validateBounds(label: string, bounds: readonly [number, number, number, number], canvas: PsdRepairCanvas): void {
  if (bounds[2] > canvas.width || bounds[3] > canvas.height) {
    throw new PuppetLoomError("INVALID_INPUT", `${label} 超出规范画布 ${canvas.width}x${canvas.height}：${bounds.join(",")}`);
  }
}

function validateCanonicalCoordinates(recipe: ResolvedPhotoshopPsdRepairRecipe, canvas: PsdRepairCanvas): void {
  for (const [index, operation] of recipe.operations.entries()) {
    if (operation.op === "clear-region" || operation.op === "extract-white-region") validateBounds(`operation #${index} ${operation.op}`, operation.bounds, canvas);
    if (operation.op === "split-layer-x" && operation.splitX >= canvas.width) throw new PuppetLoomError("INVALID_INPUT", `operation #${index} split-layer-x 的 splitX 必须小于规范画布宽度 ${canvas.width}。`);
  }
  for (const check of recipe.checks.opaqueInteriorLayers) if ("bounds" in check && check.bounds) validateBounds(`opaqueInteriorLayers ${check.layer}`, check.bounds, canvas);
}

async function buildInputManifest(recipe: ResolvedPhotoshopPsdRepairRecipe, reviewOutput?: string): Promise<PsdRepairInputManifestEntry[]> {
  const baseCanvas = await canvasOf(recipe.basePsd);
  validateCanonicalCoordinates(recipe, baseCanvas);
  const declarations: Array<{
    id: string;
    role: PsdRepairInputManifestEntry["role"];
    path: string;
    canvasPolicy: PsdRepairInputManifestEntry["canvasPolicy"];
  }> = [
    { id: "base", role: "base", path: recipe.basePsd, canvasPolicy: "base" },
    ...recipe.sources.map((source) => ({ id: source.id, role: "donor" as const, path: source.path, canvasPolicy: source.canvasPolicy })),
    ...recipe.operations.flatMap((operation, index) => operation.op === "extract-white-region"
      ? [{ id: `extract-white-region-${index + 1}`, role: "extraction" as const, path: operation.sourceImage, canvasPolicy: operation.canvasPolicy }]
      : []),
    ...(recipe.referenceImage ? [{ id: "reference", role: "reference" as const, path: recipe.referenceImage, canvasPolicy: "comparison-only" as const }] : []),
    ...(reviewOutput ? [{ id: "review-output", role: "review-output" as const, path: reviewOutput, canvasPolicy: "require-match" as const }] : [])
  ];
  const identities = new Map<string, Promise<{ sha256: string; canvas: PsdRepairCanvas }>>();
  const identity = (path: string): Promise<{ sha256: string; canvas: PsdRepairCanvas }> => {
    const key = path.toLowerCase();
    const current = identities.get(key);
    if (current) return current;
    const created = Promise.all([sha256(path), canvasOf(path)]).then(([hash, canvas]) => ({ sha256: hash, canvas }));
    identities.set(key, created);
    return created;
  };
  return Promise.all(declarations.map(async (declaration) => {
    const current = await identity(declaration.path);
    const matches = sameCanvas(current.canvas, baseCanvas);
    if (!matches && declaration.canvasPolicy === "require-match") {
      throw new PuppetLoomError("INVALID_INPUT", `${declaration.id} 画布为 ${current.canvas.width}x${current.canvas.height}，与规范画布 ${baseCanvas.width}x${baseCanvas.height} 不一致；请显式使用 fit-full-canvas 或更换 donor。`);
    }
    if (!matches && declaration.canvasPolicy === "fit-full-canvas" && !sameAspectRatio(current.canvas, baseCanvas)) {
      throw new PuppetLoomError("INVALID_INPUT", `${declaration.id} 与规范画布宽高比不一致，禁止拉伸或目测重摆：${current.canvas.width}x${current.canvas.height} -> ${baseCanvas.width}x${baseCanvas.height}`);
    }
    return {
      ...declaration,
      sha256: current.sha256,
      canvas: current.canvas,
      transform: {
        applied: !matches && declaration.canvasPolicy === "fit-full-canvas",
        target: baseCanvas,
        scaleX: Number((baseCanvas.width / current.canvas.width).toFixed(8)),
        scaleY: Number((baseCanvas.height / current.canvas.height).toFixed(8))
      }
    };
  }));
}

function resolvedPath(recipeDirectory: string, path: string): string {
  return resolve(recipeDirectory, path);
}

function resolveOperation(recipeDirectory: string, operation: PhotoshopPsdRepairOperation): PhotoshopPsdRepairOperation {
  if (operation.op !== "extract-white-region") return operation;
  return { ...operation, sourceImage: resolvedPath(recipeDirectory, operation.sourceImage) };
}

export async function readPhotoshopPsdRepairRecipe(recipePath: string): Promise<ResolvedPhotoshopPsdRepairRecipe> {
  const absoluteRecipe = resolve(recipePath);
  let value: unknown;
  try { value = JSON.parse(await readFile(absoluteRecipe, "utf8")); }
  catch (cause) { throw new PuppetLoomError("INVALID_INPUT", `无法读取 PSD 修复配方：${absoluteRecipe}`, { cause }); }
  const parsed = photoshopPsdRepairRecipeSchema.safeParse(value);
  if (!parsed.success) throw new PuppetLoomError("INVALID_INPUT", `PSD 修复配方无效：${z.prettifyError(parsed.error)}`);
  const directory = dirname(absoluteRecipe);
  const sourceIds = new Set<string>();
  for (const source of parsed.data.sources) {
    if (sourceIds.has(source.id)) throw new PuppetLoomError("INVALID_INPUT", `PSD 修复配方包含重复 source id：${source.id}`);
    sourceIds.add(source.id);
  }
  for (const operation of parsed.data.operations) {
    if (operation.op === "duplicate-layer" && !sourceIds.has(operation.source)) {
      throw new PuppetLoomError("INVALID_INPUT", `duplicate-layer 引用了不存在的 source：${operation.source}`);
    }
  }
  const recipe: ResolvedPhotoshopPsdRepairRecipe = {
    version: parsed.data.version,
    kind: parsed.data.kind,
    checks: parsed.data.checks,
    recipePath: absoluteRecipe,
    basePsd: resolvedPath(directory, parsed.data.basePsd),
    ...(parsed.data.referenceImage ? { referenceImage: resolvedPath(directory, parsed.data.referenceImage) } : {}),
    sources: parsed.data.sources.map((source) => ({ ...source, path: resolvedPath(directory, source.path) })),
    operations: parsed.data.operations.map((operation) => resolveOperation(directory, operation))
  };
  const inputs = [recipe.basePsd, ...(recipe.referenceImage ? [recipe.referenceImage] : []), ...recipe.sources.map((source) => source.path), ...recipe.operations.filter((operation): operation is Extract<PhotoshopPsdRepairOperation, { op: "extract-white-region" }> => operation.op === "extract-white-region").map((operation) => operation.sourceImage)];
  for (const input of new Set(inputs)) if (!(await exists(input))) throw new PuppetLoomError("INVALID_INPUT", `PSD 修复输入不存在：${input}`);
  return recipe;
}

export async function planPhotoshopPsdRepair(options: { recipe: string; output: string; workDirectory: string }): Promise<PhotoshopPsdRepairPlan> {
  if (process.platform !== "win32") throw new PuppetLoomError("INVALID_INPUT", "Photoshop COM 修复引擎当前只支持 Windows。" );
  const recipe = await readPhotoshopPsdRepairRecipe(options.recipe);
  const output = resolve(options.output);
  const workDirectory = resolve(options.workDirectory);
  if (extname(output).toLowerCase() !== ".psd") throw new PuppetLoomError("INVALID_INPUT", `PSD 修复输出必须使用 .psd 扩展名：${output}`);
  const operationExists = await exists(join(workDirectory, "operation.json"));
  if (await exists(output) && !operationExists) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `PSD 修复输出已经存在，拒绝覆盖：${output}`);
  if (await exists(workDirectory) && !operationExists) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `PSD 修复工作目录已经存在但没有 operation.json：${workDirectory}`);
  const protectedInputs = [recipe.basePsd, ...recipe.sources.map((source) => source.path), ...recipe.operations.filter((operation): operation is Extract<PhotoshopPsdRepairOperation, { op: "extract-white-region" }> => operation.op === "extract-white-region").map((operation) => operation.sourceImage)];
  if (protectedInputs.some((input) => input.toLowerCase() === output.toLowerCase())) throw new PuppetLoomError("INVALID_INPUT", "PSD 修复输出不能指向基础 PSD 或候选 PSD。" );
  const inputManifest = await buildInputManifest(recipe);
  return {
    mode: "repair",
    engine: "photoshop-com",
    recipe,
    output,
    workDirectory,
    inputManifest,
    estimatedBytes: await estimatePsdRepairBytes(recipe, inputManifest)
  };
}

export async function planPhotoshopPsdReview(options: { input: string; recipe: string; workDirectory: string }): Promise<PhotoshopPsdRepairPlan> {
  const recipe = await readPhotoshopPsdRepairRecipe(options.recipe);
  const output = resolve(options.input);
  const workDirectory = resolve(options.workDirectory);
  if (extname(output).toLowerCase() !== ".psd" || !(await exists(output))) throw new PuppetLoomError("INVALID_INPUT", `找不到要复核的 PSD：${output}`);
  const operationExists = await exists(join(workDirectory, "operation.json"));
  if (await exists(workDirectory) && !operationExists) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `PSD 复核目录已经存在但没有 operation.json：${workDirectory}`);
  const inputManifest = await buildInputManifest(recipe, output);
  return {
    mode: "review",
    engine: "existing-psd",
    recipe,
    output,
    workDirectory,
    inputManifest,
    estimatedBytes: await estimatePsdRepairBytes(recipe, inputManifest)
  };
}

async function estimatePsdRepairBytes(recipe: ResolvedPhotoshopPsdRepairRecipe, inputs: Array<{ path: string }>): Promise<number> {
  const uniquePaths = [...new Map(inputs.map((item) => [item.path.toLowerCase(), item.path])).values()];
  const inputBytes = (await Promise.all(uniquePaths.map(async (path) => (await stat(path)).size))).reduce((sum, bytes) => sum + bytes, 0);
  const raw = readPsd(await readFile(recipe.basePsd), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true, logMissingFeatures: false });
  const canvasPixels = Math.max(1, raw.width * raw.height);
  const leafLayers = flattenRawLayers(raw.children).length;
  const overviewBytes = 1040 * Math.max(250, Math.ceil(Math.max(1, leafLayers) / 4) * 250) * 4;
  const detailBytes = 1680 * Math.max(460, Math.ceil(Math.max(1, leafLayers) / 4) * 460) * 4 * 2;
  const reviewImageUpperBound = canvasPixels * 4 * 6 + overviewBytes + detailBytes;
  return Math.ceil(inputBytes * 4 + reviewImageUpperBound + 16 * 1024 ** 2);
}

async function encodeRawPng(pixels: PixelBuffer): Promise<Buffer> {
  return sharp(Buffer.from(pixels.data), { raw: { width: pixels.width, height: pixels.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

async function neutralPng(imported: ImportedPsd): Promise<Buffer> {
  if (imported.composite) return encodeRawPng(imported.composite);
  const composites = await Promise.all(imported.layers.slice().sort((a, b) => a.order - b.order).map(async (layer) => ({
    input: await encodeRawPng(layer.pixels),
    left: Math.round(layer.bounds.x),
    top: Math.round(layer.bounds.y),
    blend: "over" as const,
    opacity: layer.opacity
  })));
  return sharp({ create: { width: imported.canvas.width, height: imported.canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composites).png().toBuffer();
}

function backgroundBuffer(width: number, height: number, first: [number, number, number], second?: [number, number, number]): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = second && ((Math.floor(x / 24) + Math.floor(y / 24)) % 2 === 1) ? second : first;
      const index = (y * width + x) * 4;
      data[index] = color[0]; data[index + 1] = color[1]; data[index + 2] = color[2]; data[index + 3] = 255;
    }
  }
  return data;
}

async function onBackground(neutral: Buffer, width: number, height: number, first: [number, number, number], second?: [number, number, number]): Promise<Buffer> {
  return sharp(backgroundBuffer(width, height, first, second), { raw: { width, height, channels: 4 } }).composite([{ input: neutral }]).png({ compressionLevel: 9 }).toBuffer();
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function layerContactSheet(imported: ImportedPsd): Promise<Buffer> {
  const tileWidth = 260;
  const tileHeight = 250;
  const imageHeight = 214;
  const columns = 4;
  const cards = await Promise.all(imported.layers.map(async (layer, index) => {
    const image = await sharp(await encodeRawPng(layer.pixels)).resize(tileWidth - 28, imageHeight - 18, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const metadata = await sharp(image).metadata();
    const left = Math.floor((tileWidth - (metadata.width ?? 0)) / 2);
    const top = 8 + Math.floor((imageHeight - 16 - (metadata.height ?? 0)) / 2);
    const label = Buffer.from(`<svg width="${tileWidth}" height="36" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#101722"/><text x="10" y="23" fill="#edf2f8" font-family="Arial, sans-serif" font-size="14">${String(index + 1).padStart(2, "0")} ${xml(layer.sourceName)}</text></svg>`);
    return sharp(backgroundBuffer(tileWidth, tileHeight, [230, 233, 238], [185, 191, 201]), { raw: { width: tileWidth, height: tileHeight, channels: 4 } })
      .composite([{ input: image, left, top }, { input: label, left: 0, top: tileHeight - 36 }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  }));
  const rows = Math.ceil(cards.length / columns);
  return sharp({ create: { width: columns * tileWidth, height: rows * tileHeight, channels: 4, background: { r: 15, g: 20, b: 30, alpha: 1 } } })
    .composite(cards.map((input, index) => ({ input, left: index % columns * tileWidth, top: Math.floor(index / columns) * tileHeight })))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function alphaPreview(layer: ImportedLayer): Buffer {
  const { data, width, height } = layer.pixels;
  const output = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const alpha = data[pixel * 4 + 3] ?? 0;
    output[pixel * 4] = alpha;
    output[pixel * 4 + 1] = alpha;
    output[pixel * 4 + 2] = alpha;
    output[pixel * 4 + 3] = 255;
  }
  return output;
}

function touchingCanvasEdges(layer: ImportedLayer, imported: ImportedPsd): string {
  const edges: string[] = [];
  if (layer.bounds.x <= 0) edges.push("L");
  if (layer.bounds.y <= 0) edges.push("T");
  if (layer.bounds.x + layer.bounds.width >= imported.canvas.width) edges.push("R");
  if (layer.bounds.y + layer.bounds.height >= imported.canvas.height) edges.push("B");
  return edges.length ? edges.join("") : "none";
}

async function layerDetailSheet(imported: ImportedPsd, mode: "color" | "alpha"): Promise<Buffer> {
  const tileWidth = 420;
  const tileHeight = 460;
  const imageHeight = 392;
  const columns = 4;
  const cards = await Promise.all(imported.layers.map(async (layer, index) => {
    const raw = mode === "color"
      ? await encodeRawPng(layer.pixels)
      : await sharp(alphaPreview(layer), { raw: { width: layer.pixels.width, height: layer.pixels.height, channels: 4 } }).png().toBuffer();
    const image = await sharp(raw).resize(tileWidth - 32, imageHeight - 24, {
      fit: "contain",
      background: mode === "color" ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 0, g: 0, b: 0, alpha: 1 }
    }).png().toBuffer();
    const metadata = await sharp(image).metadata();
    const left = Math.floor((tileWidth - (metadata.width ?? 0)) / 2);
    const top = 10 + Math.floor((imageHeight - 20 - (metadata.height ?? 0)) / 2);
    const bounds = `${Math.round(layer.bounds.x)},${Math.round(layer.bounds.y)} ${Math.round(layer.bounds.width)}x${Math.round(layer.bounds.height)}`;
    const label = Buffer.from(`<svg width="${tileWidth}" height="68" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#101722"/><text x="10" y="25" fill="#edf2f8" font-family="Arial, sans-serif" font-size="15">${String(index + 1).padStart(2, "0")} ${xml(layer.sourceName)}</text><text x="10" y="50" fill="#a8b4c5" font-family="Arial, sans-serif" font-size="12">${xml(layer.role)} | ${bounds} | canvas edges: ${touchingCanvasEdges(layer, imported)}</text></svg>`);
    const background = mode === "color"
      ? backgroundBuffer(tileWidth, tileHeight, [230, 233, 238], [185, 191, 201])
      : backgroundBuffer(tileWidth, tileHeight, [8, 12, 18]);
    return sharp(background, { raw: { width: tileWidth, height: tileHeight, channels: 4 } })
      .composite([{ input: image, left, top }, { input: label, left: 0, top: tileHeight - 68 }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  }));
  const rows = Math.ceil(cards.length / columns);
  return sharp({ create: { width: columns * tileWidth, height: rows * tileHeight, channels: 4, background: { r: 8, g: 12, b: 18, alpha: 1 } } })
    .composite(cards.map((input, index) => ({ input, left: index % columns * tileWidth, top: Math.floor(index / columns) * tileHeight })))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function alphaAudit(layer: ImportedLayer, maximumAllowedRatio: number, globalBounds?: [number, number, number, number]): PsdRepairAlphaCheck {
  const { data, width, height } = layer.pixels;
  let visiblePixels = 0;
  let partialAlphaPixels = 0;
  let interiorPartialAlphaPixels = 0;
  const alphaAt = (x: number, y: number): number => data[(y * width + x) * 4 + 3] ?? 0;
  const left = globalBounds ? Math.max(0, globalBounds[0] - layer.bounds.x) : 0;
  const top = globalBounds ? Math.max(0, globalBounds[1] - layer.bounds.y) : 0;
  const right = globalBounds ? Math.min(width, globalBounds[2] - layer.bounds.x) : width;
  const bottom = globalBounds ? Math.min(height, globalBounds[3] - layer.bounds.y) : height;
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const alpha = alphaAt(x, y);
    if (alpha <= 8) continue;
    visiblePixels += 1;
    if (alpha >= 247) continue;
    partialAlphaPixels += 1;
    if (x < 2 || y < 2 || x + 2 >= width || y + 2 >= height) continue;
    let surrounded = true;
    for (let offsetY = -2; offsetY <= 2 && surrounded; offsetY += 1) for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      if (alphaAt(x + offsetX, y + offsetY) <= 8) { surrounded = false; break; }
    }
    if (surrounded) interiorPartialAlphaPixels += 1;
  }
  const interiorPartialRatio = visiblePixels === 0 ? 1 : interiorPartialAlphaPixels / visiblePixels;
  return {
    layer: layer.sourceName,
    found: true,
    visiblePixels,
    partialAlphaPixels,
    interiorPartialAlphaPixels,
    interiorPartialRatio: Number(interiorPartialRatio.toFixed(6)),
    maximumAllowedRatio: maximumAllowedRatio,
    passed: visiblePixels > 0 && interiorPartialRatio <= maximumAllowedRatio
  };
}

function flattenRawLayers(children: Layer[] | undefined, output: Layer[] = []): Layer[] {
  for (const layer of children ?? []) {
    if (layer.children?.length) flattenRawLayers(layer.children, output);
    else output.push(layer);
  }
  return output;
}

export async function reviewPhotoshopPsdRepair(options: { output: string; workDirectory: string; recipe: ResolvedPhotoshopPsdRepairRecipe }): Promise<PsdRepairReview> {
  const output = resolve(options.output);
  const workDirectory = resolve(options.workDirectory);
  const imported = await importPsd(output, { alphaCleanup: "preserve-all" });
  const inspection = inspectionFromImported(imported);
  const rawPsd = readPsd(await readFile(output), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true, logMissingFeatures: false });
  const rawLayers = flattenRawLayers(rawPsd.children);
  const neutral = await neutralPng(imported);
  const white = await onBackground(neutral, imported.canvas.width, imported.canvas.height, [255, 255, 255]);
  const dark = await onBackground(neutral, imported.canvas.width, imported.canvas.height, [15, 20, 30]);
  const checker = await onBackground(neutral, imported.canvas.width, imported.canvas.height, [230, 233, 238], [185, 191, 201]);
  const recompositionPath = resolve(workDirectory, "recomposition.png");
  const whitePath = resolve(workDirectory, "on-white.png");
  const darkPath = resolve(workDirectory, "on-dark.png");
  const checkerPath = resolve(workDirectory, "on-checker.png");
  const layerContactSheetPath = resolve(workDirectory, "layer-contact-sheet.png");
  const layerDetailSheetPath = resolve(workDirectory, "layer-detail-sheet.png");
  const layerAlphaSheetPath = resolve(workDirectory, "layer-alpha-sheet.png");
  await Promise.all([
    writeFile(recompositionPath, neutral),
    writeFile(whitePath, white),
    writeFile(darkPath, dark),
    writeFile(checkerPath, checker),
    writeFile(layerContactSheetPath, await layerContactSheet(imported)),
    writeFile(layerDetailSheetPath, await layerDetailSheet(imported, "color")),
    writeFile(layerAlphaSheetPath, await layerDetailSheet(imported, "alpha"))
  ]);
  let comparisonPath: string | undefined;
  if (options.recipe.referenceImage) {
    const reference = await sharp(options.recipe.referenceImage).resize(imported.canvas.width, imported.canvas.height, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
    comparisonPath = resolve(workDirectory, "reference-comparison.png");
    await sharp({ create: { width: imported.canvas.width * 2, height: imported.canvas.height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .composite([{ input: reference, left: 0, top: 0 }, { input: white, left: imported.canvas.width, top: 0 }])
      .png({ compressionLevel: 9 })
      .toFile(comparisonPath);
  }
  const rawNames = new Set(rawLayers.map((layer) => layer.name?.trim() || "unnamed"));
  const requiredLayerChecks = options.recipe.checks.requiredLayers.map((layer) => ({ layer, found: rawNames.has(layer) }));
  const alphaChecks = options.recipe.checks.opaqueInteriorLayers.map((check) => {
    const candidates = imported.layers.filter((layer) => layer.sourceName === check.layer);
    if (candidates.length === 0) return { layer: check.layer, found: false, visiblePixels: 0, partialAlphaPixels: 0, interiorPartialAlphaPixels: 0, interiorPartialRatio: 1, maximumAllowedRatio: check.maxInteriorPartialRatio, passed: false };
    const audits = candidates.map((layer) => alphaAudit(layer, check.maxInteriorPartialRatio, "bounds" in check ? check.bounds : undefined));
    return audits.reduce((worst, audit) => audit.interiorPartialRatio > worst.interiorPartialRatio ? audit : worst);
  });
  const valid = inspection.valid && requiredLayerChecks.every((check) => check.found) && alphaChecks.every((check) => check.passed);
  return {
    valid,
    output,
    canvas: imported.canvas,
    layerCount: rawLayers.length,
    requiredLayerChecks,
    alphaChecks,
    artifacts: {
      recomposition: recompositionPath,
      white: whitePath,
      dark: darkPath,
      checker: checkerPath,
      layerContactSheet: layerContactSheetPath,
      layerDetailSheet: layerDetailSheetPath,
      layerAlphaSheet: layerAlphaSheetPath,
      ...(comparisonPath ? { comparison: comparisonPath } : {})
    },
    structuralInspection: {
      valid: inspection.valid,
      visibleLayerCount: inspection.visibleLayerCount,
      recognizedLayerCount: inspection.recognizedLayerCount,
      unknownLayerCount: inspection.unknownLayerCount,
      suggestedRigLevel: inspection.suggestedRigLevel,
      layerOrderIssues: inspection.layerOrderIssues,
      warnings: inspection.warnings
    },
    requiresVisualReview: true
  };
}

/** Generates the same structural and visual evidence for a decomposition candidate without requiring a repair recipe. */
export async function reviewLayeredPsd(options: { input: string; reference?: string; outputDirectory: string }): Promise<LayeredPsdReview> {
  const input = resolve(options.input);
  const outputDirectory = resolve(options.outputDirectory);
  const imported = await importPsd(input, { alphaCleanup: "preserve-all" });
  const review = await reviewPhotoshopPsdRepair({
    output: input,
    workDirectory: outputDirectory,
    recipe: {
      version: 1,
      kind: "puppetloom-photoshop-psd-repair",
      checks: { requiredLayers: [], opaqueInteriorLayers: [] },
      recipePath: join(outputDirectory, "source-review.generated.json"),
      basePsd: input,
      ...(options.reference ? { referenceImage: resolve(options.reference) } : {}),
      sources: [],
      operations: []
    }
  });
  return {
    ...review,
    roles: [...new Set(imported.layers.map((layer) => layer.role))],
    layers: imported.layers.map((layer) => ({ id: layer.id, name: layer.sourceName, role: layer.role, side: layer.side }))
  };
}
