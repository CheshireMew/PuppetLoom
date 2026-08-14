import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { initializeCanvas, readPsd, type Layer, type Psd } from "ag-psd";
import { classifyLayerName, inferSideFromCenter, pairedRoles } from "./classify.js";
import { PuppetLoomError } from "./errors.js";
import { stableSlug } from "./math.js";
import type { InspectionReport, LayerInspection, Rect, SemanticRole, Side, Size } from "./types.js";

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
}

export interface ImportedPsd {
  input: string;
  fileName: string;
  canvas: Size;
  layers: ImportedLayer[];
  composite?: PixelBuffer;
  warnings: string[];
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

function makeImportedLayer(flat: FlatLayer, canvas: Size): ImportedLayer | undefined {
  if (flat.layer.hidden) return undefined;
  const source = pixelDataFromLayer(flat.layer);
  if (!source) return undefined;
  const left = flat.layer.left ?? 0;
  const top = flat.layer.top ?? 0;
  const bounds = alphaBounds(source, undefined, left);
  if (!bounds) return undefined;
  const classification = classifyLayerName(flat.layer.name || flat.path.at(-1) || "unnamed");
  const x = left + bounds.x;
  const y = top + bounds.y;
  const centerX = x + bounds.width * 0.5;
  const side = classification.side === "center" && pairedRoles.has(classification.role) ? inferSideFromCenter(centerX, canvas.width) : classification.side;
  return {
    id: `layer-${String(flat.order).padStart(3, "0")}-${stableSlug(flat.path.join("-"))}`,
    sourceName: flat.layer.name || flat.path.at(-1) || "unnamed",
    sourcePath: flat.path,
    role: classification.role,
    side,
    order: flat.order,
    opacity: flat.opacity,
    blendMode: String(flat.layer.blendMode ?? "normal"),
    bounds: { x, y, width: bounds.width, height: bounds.height },
    opaquePixels: bounds.count,
    pixels: cropPixels(source, bounds)
  };
}

function splitCombinedPair(layer: ImportedLayer, canvas: Size): ImportedLayer[] {
  if (!pairedRoles.has(layer.role) || layer.side !== "center") return [layer];
  const splitX = canvas.width * 0.5;
  const leftHalf = alphaBounds(layer.pixels, (globalX) => globalX < splitX, layer.bounds.x);
  const rightHalf = alphaBounds(layer.pixels, (globalX) => globalX >= splitX, layer.bounds.x);
  if (!leftHalf || !rightHalf || leftHalf.count < 8 || rightHalf.count < 8) return [layer];

  const makeHalf = (bounds: AlphaBounds, side: Side, suffix: string): ImportedLayer => ({
    ...layer,
    id: `${layer.id}-${suffix}`,
    sourceName: `${layer.sourceName}-${suffix}`,
    sourcePath: [...layer.sourcePath, suffix],
    side,
    bounds: {
      x: layer.bounds.x + bounds.x,
      y: layer.bounds.y + bounds.y,
      width: bounds.width,
      height: bounds.height
    },
    opaquePixels: bounds.count,
    pixels: cropPixels(layer.pixels, bounds)
  });

  // Character-right appears on the left side of a front-facing image.
  return [makeHalf(leftHalf, "right", "r"), makeHalf(rightHalf, "left", "l")];
}

function compositePixels(psd: Psd): PixelBuffer | undefined {
  const imageData = psd.imageData;
  if (!imageData) return undefined;
  return { width: imageData.width, height: imageData.height, data: new Uint8ClampedArray(imageData.data) };
}

export async function importPsd(input: string): Promise<ImportedPsd> {
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
  const flat = flattenLayers(psd.children);
  const layers = flat
    .map((item) => makeImportedLayer(item, canvas))
    .filter((layer): layer is ImportedLayer => Boolean(layer))
    .flatMap((layer) => splitCombinedPair(layer, canvas));

  if (layers.length === 0 || layers.every((layer) => layer.opaquePixels === 0)) {
    throw new PuppetLoomError("INVALID_INPUT", "PSD 没有可见像素，无法创建角色。" );
  }

  const warnings: string[] = [];
  const unknownCount = layers.filter((layer) => layer.role === "unknown").length;
  if (unknownCount > 0) warnings.push(`${unknownCount} 个图层无法确定语义，将按普通附属图层保留。`);
  if (!layers.some((layer) => layer.role === "face")) warnings.push("没有识别到脸部图层，将使用保守绑定。" );
  const composite = compositePixels(psd);

  return {
    input,
    fileName: basename(input),
    canvas,
    layers,
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
    visible: true
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
    layers,
    warnings: imported.warnings
  };
}

export async function inspectPsd(input: string): Promise<InspectionReport> {
  return inspectionFromImported(await importPsd(input));
}
