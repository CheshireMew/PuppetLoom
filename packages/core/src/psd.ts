import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { initializeCanvas, readPsd, type Layer, type Psd } from "ag-psd";
import { analyzeAlphaComponents, pixelsForComponents, unionComponentBounds, type AlphaComponent, type AlphaComponentAnalysis } from "./alpha-components.js";
import { classifyLayerName, inferSideFromCenter, pairedRoles } from "./classify.js";
import { PuppetLoomError } from "./errors.js";
import { stableSlug } from "./math.js";
import type { AlphaCleanupMode, ImportPreflightSummary, InspectionReport, LayerImportAlphaAnalysis, LayerInspection, PairSplitMethod, Point, Rect, SemanticRole, Side, Size } from "./types.js";

initializeCanvas(
  () => { throw new Error("PuppetLoom 使用原始像素数据，不创建 Canvas。" ); },
  (width, height) => ({ width, height, colorSpace: "srgb", data: new Uint8ClampedArray(width * height * 4) } as never)
);

export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ImportedLayer {
  id: string;
  sourceName: string;
  sourcePath: string[];
  role: SemanticRole;
  side: Side;
  order: number;
  opacity: number;
  blendMode: string;
  bounds: Rect;
  opaquePixels: number;
  pixels: PixelBuffer;
  alpha?: LayerImportAlphaAnalysis;
}

export interface ImportedPsd {
  input: string;
  fileName: string;
  canvas: Size;
  layers: ImportedLayer[];
  composite?: PixelBuffer;
  preflight?: ImportPreflightSummary;
  warnings: string[];
}

export interface ImportPsdOptions {
  /** Default automatically removes only faint isolated components with high noise confidence. */
  alphaCleanup?: AlphaCleanupMode;
  /** @deprecated Use alphaCleanup. true removes every tiny component; false preserves every component. */
  cleanAlpha?: boolean;
}

interface FlatLayer {
  layer: Layer;
  path: string[];
  order: number;
  opacity: number;
}

interface AlphaBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

interface PairSplitOutcome {
  layers: ImportedLayer[];
  method?: Exclude<PairSplitMethod, "not-applicable">;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}

function globalPoint(point: Point, offsetX: number, offsetY: number): Point {
  return { x: roundMetric(point.x + offsetX), y: roundMetric(point.y + offsetY) };
}

function globalRect(rect: Rect, offsetX: number, offsetY: number): Rect {
  return { x: rect.x + offsetX, y: rect.y + offsetY, width: rect.width, height: rect.height };
}

function alphaReport(
  analysis: AlphaComponentAnalysis,
  offsetX: number,
  offsetY: number,
  retained: Set<number>,
  cleanupMode: AlphaCleanupMode,
  method: PairSplitMethod = "not-applicable",
  confidence = 1,
  sourceComponentIndices: number[] = [...retained],
  cleanupAppliedOverride?: boolean
): LayerImportAlphaAnalysis {
  const retainedOpaquePixels = analysis.components
    .filter((component) => retained.has(component.index))
    .reduce((sum, component) => sum + component.pixelCount, 0);
  const removedTinyPixels = analysis.components.filter((component) => !retained.has(component.index)).reduce((sum, component) => sum + component.pixelCount, 0);
  const cleanupApplied = cleanupAppliedOverride ?? removedTinyPixels > 0;
  const confirmedNoiseIndices = new Set(analysis.confirmedNoise.map((component) => component.index));
  const suspectedDetailIndices = new Set(analysis.suspectedDetails.map((component) => component.index));
  return {
    alphaThreshold: analysis.alphaThreshold,
    sourceOpaquePixels: analysis.opaquePixels,
    retainedOpaquePixels,
    removedTinyPixels,
    minimumMeaningfulPixels: analysis.minimumMeaningfulPixels,
    componentCount: analysis.components.length,
    meaningfulComponentCount: analysis.meaningful.length,
    tinyComponentCount: analysis.tiny.length,
    confirmedNoiseComponentCount: analysis.confirmedNoise.length,
    confirmedNoisePixelCount: analysis.confirmedNoise.reduce((sum, component) => sum + component.pixelCount, 0),
    suspectedDetailComponentCount: analysis.suspectedDetails.length,
    suspectedDetailPixelCount: analysis.suspectedDetails.reduce((sum, component) => sum + component.pixelCount, 0),
    cleanupMode,
    cleanupApplied,
    pairSplit: { method, confidence: roundMetric(confidence), sourceComponentIndices },
    components: analysis.components.slice(0, 64).map((component) => ({
      index: component.index,
      pixelCount: component.pixelCount,
      bounds: globalRect(component.bounds, offsetX, offsetY),
      centroid: globalPoint(component.centroid, offsetX, offsetY),
      disposition: confirmedNoiseIndices.has(component.index)
        ? "confirmed-noise" as const
        : suspectedDetailIndices.has(component.index)
          ? "suspected-detail" as const
          : "retained" as const,
      retained: retained.has(component.index)
    }))
  };
}

function cleanupMode(options: ImportPsdOptions): AlphaCleanupMode {
  if (options.alphaCleanup) return options.alphaCleanup;
  if (options.cleanAlpha === true) return "remove-all-tiny";
  if (options.cleanAlpha === false) return "preserve-all";
  return "automatic";
}

function retainedComponents(analysis: AlphaComponentAnalysis, mode: AlphaCleanupMode): AlphaComponent[] {
  if (analysis.tiny.length === 0 || mode === "preserve-all") return analysis.components;
  if (mode === "automatic") {
    const noise = new Set(analysis.confirmedNoise.map((component) => component.index));
    const retained = analysis.components.filter((component) => !noise.has(component.index));
    if (retained.length > 0) return retained;
  }
  if (analysis.meaningful.length > 0) return analysis.meaningful;
  return analysis.components.length > 0 ? [analysis.components.reduce((largest, component) => component.pixelCount > largest.pixelCount ? component : largest)] : [];
}

function flattenLayers(children: Layer[] | undefined, path: string[] = [], output: FlatLayer[] = [], parentOpacity = 1): FlatLayer[] {
  for (const layer of children ?? []) {
    if (layer.hidden) continue;
    const name = layer.name?.trim() || "unnamed";
    const nextPath = [...path, name];
    const opacity = parentOpacity * opacityOf(layer);
    if (layer.children?.length) {
      flattenLayers(layer.children, nextPath, output, opacity);
    } else {
      output.push({ layer, path: nextPath, order: output.length, opacity });
    }
  }
  return output;
}

function toEightBit(data: ArrayLike<number>): Uint8ClampedArray {
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) return new Uint8ClampedArray(data);
  const output = new Uint8ClampedArray(data.length);
  const sixteenBit = data instanceof Uint16Array;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index] ?? 0;
    if (sixteenBit) output[index] = Math.round(value / 257);
    else {
      const channel = index % 4;
      const normalized = Math.max(0, Math.min(1, value));
      const srgb = channel === 3 ? normalized : normalized <= 0.0031308 ? normalized * 12.92 : 1.055 * normalized ** (1 / 2.4) - 0.055;
      output[index] = Math.round(srgb * 255);
    }
  }
  return output;
}

function applyLayerMask(layer: Layer, pixels: PixelBuffer): void {
  const masks = [layer.mask, layer.realMask].filter((mask) => mask?.imageData && !mask.disabled);
  for (const mask of masks) {
    const imageData = mask!.imageData!;
    const maskPixels = toEightBit(imageData.data);
    const channels = Math.max(1, Math.round(maskPixels.length / Math.max(1, imageData.width * imageData.height)));
    const relativeX = mask!.left ?? 0;
    const relativeY = mask!.top ?? 0;
    const maskLeft = mask!.positionRelativeToLayer ? (layer.left ?? 0) + relativeX : relativeX;
    const maskTop = mask!.positionRelativeToLayer ? (layer.top ?? 0) + relativeY : relativeY;
    const defaultValue = mask!.defaultColor ?? 255;
    const density = mask!.userMaskDensity ?? mask!.vectorMaskDensity ?? 1;
    for (let y = 0; y < pixels.height; y += 1) {
      for (let x = 0; x < pixels.width; x += 1) {
        const globalX = (layer.left ?? 0) + x;
        const globalY = (layer.top ?? 0) + y;
        const mx = globalX - maskLeft;
        const my = globalY - maskTop;
        let value = defaultValue;
        if (mx >= 0 && my >= 0 && mx < imageData.width && my < imageData.height) {
          const maskIndex = (my * imageData.width + mx) * channels;
          value = maskPixels[maskIndex] ?? defaultValue;
        }
        const alphaIndex = (y * pixels.width + x) * 4 + 3;
        pixels.data[alphaIndex] = Math.round((pixels.data[alphaIndex] ?? 0) * (value / 255) * density);
      }
    }
  }
}

function pixelDataFromLayer(layer: Layer): PixelBuffer | undefined {
  const imageData = layer.imageData;
  if (!imageData || imageData.width < 1 || imageData.height < 1 || imageData.data.length === 0) return undefined;
  const pixels = {
    width: imageData.width,
    height: imageData.height,
    data: toEightBit(imageData.data)
  };
  applyLayerMask(layer, pixels);
  return pixels;
}

function alphaBounds(pixels: PixelBuffer, predicate: (globalX: number) => boolean = () => true, offsetX = 0): AlphaBounds | undefined {
  let minX = pixels.width;
  let minY = pixels.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      if (!predicate(offsetX + x)) continue;
      const alpha = pixels.data[(y * pixels.width + x) * 4 + 3] ?? 0;
      if (alpha <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
    }
  }
  if (count === 0 || maxX < minX || maxY < minY) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, count };
}

function cropPixels(pixels: PixelBuffer, bounds: AlphaBounds): PixelBuffer {
  const output = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y += 1) {
    const sourceStart = ((bounds.y + y) * pixels.width + bounds.x) * 4;
    const targetStart = y * bounds.width * 4;
    output.set(pixels.data.subarray(sourceStart, sourceStart + bounds.width * 4), targetStart);
  }
  return { width: bounds.width, height: bounds.height, data: output };
}

function opacityOf(layer: Layer): number {
  const opacity = layer.opacity ?? 1;
  return opacity > 1 ? opacity / 255 : opacity;
}

function makeImportedLayer(flat: FlatLayer, canvas: Size, mode: AlphaCleanupMode): ImportedLayer | undefined {
  if (flat.layer.hidden) return undefined;
  const source = pixelDataFromLayer(flat.layer);
  if (!source) return undefined;
  const left = flat.layer.left ?? 0;
  const top = flat.layer.top ?? 0;
  const analysis = analyzeAlphaComponents(source);
  const retained = retainedComponents(analysis, mode);
  const retainedIndices = new Set(retained.map((component) => component.index));
  const selectedBounds = unionComponentBounds(retained);
  const bounds = selectedBounds
    ? { ...selectedBounds, count: retained.reduce((sum, component) => sum + component.pixelCount, 0) }
    : alphaBounds(source, undefined, left);
  if (!bounds) return undefined;
  const classification = classifyLayerName(flat.layer.name || flat.path.at(-1) || "unnamed");
  const x = left + bounds.x;
  const y = top + bounds.y;
  const preparedPixels = retained.length < analysis.components.length
    ? { ...source, data: pixelsForComponents(source, analysis, retainedIndices) }
    : source;
  return {
    id: `layer-${String(flat.order).padStart(3, "0")}-${stableSlug(flat.path.join("-"))}`,
    sourceName: flat.layer.name || flat.path.at(-1) || "unnamed",
    sourcePath: flat.path,
    role: classification.role,
    side: classification.side,
    order: flat.order,
    opacity: flat.opacity,
    blendMode: String(flat.layer.blendMode ?? "normal"),
    bounds: { x, y, width: bounds.width, height: bounds.height },
    opaquePixels: bounds.count,
    pixels: cropPixels(preparedPixels, bounds),
    alpha: alphaReport(analysis, left, top, retainedIndices, mode)
  };
}

function childAlphaReport(
  pixels: PixelBuffer,
  bounds: Rect,
  method: Exclude<PairSplitMethod, "not-applicable">,
  confidence: number,
  sourceComponentIndices: number[],
  cleanupMode: AlphaCleanupMode,
  cleanupApplied: boolean
): LayerImportAlphaAnalysis {
  const analysis = analyzeAlphaComponents(pixels);
  const retained = new Set(analysis.components.map((component) => component.index));
  return alphaReport(analysis, bounds.x, bounds.y, retained, cleanupMode, method, confidence, sourceComponentIndices, cleanupApplied);
}

function makeSplitLayer(
  layer: ImportedLayer,
  pixels: PixelBuffer,
  bounds: AlphaBounds,
  side: Side,
  suffix: string,
  method: Exclude<PairSplitMethod, "not-applicable">,
  confidence: number,
  sourceComponentIndices: number[]
): ImportedLayer {
  const globalBounds = {
    x: layer.bounds.x + bounds.x,
    y: layer.bounds.y + bounds.y,
    width: bounds.width,
    height: bounds.height
  };
  const cropped = cropPixels(pixels, bounds);
  return {
    ...layer,
    id: `${layer.id}-${suffix}`,
    sourceName: `${layer.sourceName}-${suffix}`,
    sourcePath: [...layer.sourcePath, suffix],
    side,
    bounds: globalBounds,
    opaquePixels: bounds.count,
    pixels: cropped,
    alpha: childAlphaReport(cropped, globalBounds, method, confidence, sourceComponentIndices, layer.alpha?.cleanupMode ?? "automatic", layer.alpha?.cleanupApplied ?? false)
  };
}

function splitCombinedPair(layer: ImportedLayer, canvas: Size, faceCenterX: number): PairSplitOutcome {
  if (!pairedRoles.has(layer.role) || layer.side !== "center") return { layers: [layer] };
  const componentAnalysis = analyzeAlphaComponents(layer.pixels);
  const candidates = componentAnalysis.meaningful.length >= 2 ? componentAnalysis.meaningful : [];
  const screenLeft = candidates.filter((component) => layer.bounds.x + component.centroid.x < faceCenterX);
  const screenRight = candidates.filter((component) => layer.bounds.x + component.centroid.x >= faceCenterX);

  if (screenLeft.length > 0 && screenRight.length > 0) {
    const assignTiny = (component: AlphaComponent): "screen-left" | "screen-right" => layer.bounds.x + component.centroid.x < faceCenterX ? "screen-left" : "screen-right";
    const leftComponents = [...screenLeft];
    const rightComponents = [...screenRight];
    for (const component of componentAnalysis.tiny) {
      if (assignTiny(component) === "screen-left") leftComponents.push(component);
      else rightComponents.push(component);
    }
    const leftIndices = new Set(leftComponents.map((component) => component.index));
    const rightIndices = new Set(rightComponents.map((component) => component.index));
    const leftPixels: PixelBuffer = { ...layer.pixels, data: pixelsForComponents(layer.pixels, componentAnalysis, leftIndices) };
    const rightPixels: PixelBuffer = { ...layer.pixels, data: pixelsForComponents(layer.pixels, componentAnalysis, rightIndices) };
    const leftBounds = alphaBounds(leftPixels, undefined, layer.bounds.x);
    const rightBounds = alphaBounds(rightPixels, undefined, layer.bounds.x);
    if (leftBounds && rightBounds) {
      const leftCentroid = screenLeft.reduce((sum, component) => sum + component.centroid.x * component.pixelCount, 0) / screenLeft.reduce((sum, component) => sum + component.pixelCount, 0);
      const rightCentroid = screenRight.reduce((sum, component) => sum + component.centroid.x * component.pixelCount, 0) / screenRight.reduce((sum, component) => sum + component.pixelCount, 0);
      const separation = Math.abs(rightCentroid - leftCentroid) / Math.max(1, layer.pixels.width);
      const confidence = Math.min(1, 0.58 + separation);
      return {
        // Character-right appears on the left side of a front-facing image.
        layers: [
          makeSplitLayer(layer, leftPixels, leftBounds, "right", "r", "components", confidence, leftComponents.map((component) => component.index)),
          makeSplitLayer(layer, rightPixels, rightBounds, "left", "l", "components", confidence, rightComponents.map((component) => component.index))
        ],
        method: "components"
      };
    }
  }

  const splitX = faceCenterX;
  const leftHalf = alphaBounds(layer.pixels, (globalX) => globalX < splitX, layer.bounds.x);
  const rightHalf = alphaBounds(layer.pixels, (globalX) => globalX >= splitX, layer.bounds.x);
  if (leftHalf && rightHalf && leftHalf.count >= 8 && rightHalf.count >= 8) {
    return {
      layers: [
        makeSplitLayer(layer, layer.pixels, leftHalf, "right", "r", "center-fallback", 0.42, []),
        makeSplitLayer(layer, layer.pixels, rightHalf, "left", "l", "center-fallback", 0.42, [])
      ],
      method: "center-fallback"
    };
  }

  const centerX = layer.bounds.x + layer.bounds.width * 0.5;
  const side = inferSideFromCenter(centerX, canvas.width);
  const single = { ...layer, side };
  if (single.alpha) single.alpha = { ...single.alpha, pairSplit: { method: "single-side", confidence: side === "center" ? 0.25 : 0.74, sourceComponentIndices: [] } };
  return { layers: [single], method: "single-side" };
}

function compositePixels(psd: Psd): PixelBuffer | undefined {
  const imageData = psd.imageData;
  if (!imageData) return undefined;
  return { width: imageData.width, height: imageData.height, data: new Uint8ClampedArray(imageData.data) };
}

function summarizePreflight(baseLayers: ImportedLayer[], methods: Array<Exclude<PairSplitMethod, "not-applicable">>, mode: AlphaCleanupMode): ImportPreflightSummary {
  const analyses = baseLayers.map((layer) => layer.alpha).filter((analysis): analysis is LayerImportAlphaAnalysis => Boolean(analysis));
  return {
    analyzedLayerCount: analyses.length,
    sourceComponentCount: analyses.reduce((sum, analysis) => sum + analysis.componentCount, 0),
    meaningfulComponentCount: analyses.reduce((sum, analysis) => sum + analysis.meaningfulComponentCount, 0),
    tinyComponentCount: analyses.reduce((sum, analysis) => sum + analysis.tinyComponentCount, 0),
    tinyPixelCount: analyses.reduce((sum, analysis) => sum + analysis.components.filter((component) => component.pixelCount < analysis.minimumMeaningfulPixels).reduce((total, component) => total + component.pixelCount, 0), 0),
    confirmedNoiseComponentCount: analyses.reduce((sum, analysis) => sum + analysis.confirmedNoiseComponentCount, 0),
    confirmedNoisePixelCount: analyses.reduce((sum, analysis) => sum + analysis.confirmedNoisePixelCount, 0),
    suspectedDetailComponentCount: analyses.reduce((sum, analysis) => sum + analysis.suspectedDetailComponentCount, 0),
    suspectedDetailPixelCount: analyses.reduce((sum, analysis) => sum + analysis.suspectedDetailPixelCount, 0),
    cleanupMode: mode,
    componentSplitCount: methods.filter((method) => method === "components").length,
    fallbackSplitCount: methods.filter((method) => method === "center-fallback").length,
    singleSideCount: methods.filter((method) => method === "single-side").length,
    cleanupApplied: analyses.some((analysis) => analysis.cleanupApplied)
  };
}

export async function importPsd(input: string, options: ImportPsdOptions = {}): Promise<ImportedPsd> {
  let bytes: Buffer;
  try {
    bytes = await readFile(input);
  } catch (error) {
    throw new PuppetLoomError("INVALID_INPUT", `无法读取 PSD：${input}`, { cause: error });
  }

  let psd: Psd;
  try {
    psd = readPsd(bytes, {
      useImageData: true,
      useRawThumbnail: true,
      skipLinkedFilesData: true,
      logMissingFeatures: false
    });
  } catch (error) {
    throw new PuppetLoomError("INVALID_INPUT", `PSD 格式无效或包含无法读取的数据：${input}`, { cause: error });
  }

  if (!Number.isFinite(psd.width) || !Number.isFinite(psd.height) || psd.width < 1 || psd.height < 1) {
    throw new PuppetLoomError("INVALID_INPUT", "PSD 画布尺寸无效。" );
  }

  const canvas = { width: psd.width, height: psd.height };
  const mode = cleanupMode(options);
  const flat = flattenLayers(psd.children);
  const baseLayers = flat
    .map((item) => makeImportedLayer(item, canvas, mode))
    .filter((layer): layer is ImportedLayer => Boolean(layer));
  const face = baseLayers.find((layer) => layer.role === "face");
  const faceCenterX = face ? face.bounds.x + face.bounds.width * 0.5 : canvas.width * 0.5;
  const splitOutcomes = baseLayers.map((layer) => splitCombinedPair(layer, canvas, faceCenterX));
  const layers = splitOutcomes.flatMap((outcome) => outcome.layers);
  const preflight = summarizePreflight(
    baseLayers,
    splitOutcomes.map((outcome) => outcome.method).filter((method): method is Exclude<PairSplitMethod, "not-applicable"> => Boolean(method)),
    mode
  );

  if (layers.length === 0 || layers.every((layer) => layer.opaquePixels === 0)) {
    throw new PuppetLoomError("INVALID_INPUT", "PSD 没有可见像素，无法创建角色。" );
  }

  const warnings: string[] = [];
  const unknownCount = layers.filter((layer) => layer.role === "unknown").length;
  if (unknownCount > 0) warnings.push(`${unknownCount} 个图层无法确定语义，将按普通附属图层保留。`);
  if (!layers.some((layer) => layer.role === "face")) warnings.push("没有识别到脸部图层，将使用保守绑定。" );
  if (preflight.confirmedNoiseComponentCount > 0) warnings.push(mode === "preserve-all"
    ? `检测到 ${preflight.confirmedNoiseComponentCount} 个高置信度 Alpha 噪点区域，共 ${preflight.confirmedNoisePixelCount} 个像素；已按高级选项保留。`
    : `已自动移除 ${preflight.confirmedNoiseComponentCount} 个高置信度 Alpha 噪点区域，共 ${preflight.confirmedNoisePixelCount} 个像素；源 PSD 保持不变。`);
  if (preflight.suspectedDetailComponentCount > 0) warnings.push(mode === "remove-all-tiny"
    ? `高级清理同时移除了 ${preflight.suspectedDetailComponentCount} 个疑似有效细节区域，共 ${preflight.suspectedDetailPixelCount} 个像素；源 PSD 保持不变。`
    : `保留了 ${preflight.suspectedDetailComponentCount} 个可能属于高光、发丝或装饰的微小区域，共 ${preflight.suspectedDetailPixelCount} 个像素。`);
  if (preflight.fallbackSplitCount > 0) warnings.push(`${preflight.fallbackSplitCount} 个成对图层发生粘连，已退回按脸部中心切分。`);
  if (preflight.singleSideCount > 0) warnings.push(`${preflight.singleSideCount} 个成对图层只检测到单侧有效内容，已保留为单侧图层。`);
  const composite = compositePixels(psd);

  return {
    input,
    fileName: basename(input),
    canvas,
    layers,
    preflight,
    ...(composite ? { composite } : {}),
    warnings
  };
}

export function suggestedRigLevel(layers: ImportedLayer[]): "semantic" | "grouped" | "minimal" {
  const roles = new Set(layers.map((layer) => layer.role));
  const paired = (role: SemanticRole) => layers.some((layer) => layer.role === role && layer.side === "left") && layers.some((layer) => layer.role === role && layer.side === "right");
  if (roles.has("face") && paired("eyeWhite") && paired("iris") && roles.has("frontHair") && roles.has("backHair") && roles.has("neck") && roles.has("topWear")) {
    return "semantic";
  }
  if (roles.has("face") || roles.has("frontHair") || roles.has("backHair") || roles.has("topWear")) return "grouped";
  return "minimal";
}

export function inspectionFromImported(imported: ImportedPsd): InspectionReport {
  const layers: LayerInspection[] = imported.layers.map((layer) => ({
    id: layer.id,
    sourceName: layer.sourceName,
    sourcePath: layer.sourcePath,
    role: layer.role,
    side: layer.side,
    bounds: layer.bounds,
    opaquePixels: layer.opaquePixels,
    visible: true,
    alpha: layer.alpha ?? {
      alphaThreshold: 8,
      sourceOpaquePixels: layer.opaquePixels,
      retainedOpaquePixels: layer.opaquePixels,
      removedTinyPixels: 0,
      minimumMeaningfulPixels: 4,
      componentCount: 1,
      meaningfulComponentCount: 1,
      tinyComponentCount: 0,
      confirmedNoiseComponentCount: 0,
      confirmedNoisePixelCount: 0,
      suspectedDetailComponentCount: 0,
      suspectedDetailPixelCount: 0,
      cleanupMode: "automatic",
      cleanupApplied: false,
      pairSplit: { method: "not-applicable", confidence: 1, sourceComponentIndices: [] },
      components: []
    }
  }));
  const unknownLayerCount = layers.filter((layer) => layer.role === "unknown").length;
  return {
    valid: true,
    input: imported.input,
    canvas: imported.canvas,
    visibleLayerCount: layers.length,
    recognizedLayerCount: layers.length - unknownLayerCount,
    unknownLayerCount,
    suggestedRigLevel: suggestedRigLevel(imported.layers),
    preflight: imported.preflight ?? summarizePreflight(imported.layers, [], "automatic"),
    layers,
    warnings: imported.warnings
  };
}

export async function inspectPsd(input: string, options: ImportPsdOptions = {}): Promise<InspectionReport> {
  return inspectionFromImported(await importPsd(input, options));
}
