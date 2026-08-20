import sharp from "sharp";
import { analyzeAlphaComponents } from "./alpha-components.js";
import type { LayerAlphaTopology, LayerBinding, Rect } from "./types.js";

function normalizedComponentBounds(component: { bounds: Rect }, width: number, height: number, layerBounds: Rect): Rect {
  return {
    x: layerBounds.x + layerBounds.width * component.bounds.x / width,
    y: layerBounds.y + layerBounds.height * component.bounds.y / height,
    width: layerBounds.width * component.bounds.width / width,
    height: layerBounds.height * component.bounds.height / height
  };
}

export async function inspectLayerAlphaTopology(texturePath: string, layer: LayerBinding): Promise<LayerAlphaTopology> {
  const { data, info } = await sharp(texturePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const analysis = analyzeAlphaComponents({ width, height, data });
  return {
    textureSize: { width, height },
    opaquePixels: analysis.opaquePixels,
    alphaThreshold: analysis.alphaThreshold,
    minimumMeaningfulPixels: analysis.minimumMeaningfulPixels,
    componentCount: analysis.meaningful.length,
    ignoredTinyComponentCount: analysis.tiny.length,
    components: analysis.meaningful.slice(0, 64).map((component, index) => ({
      index,
      pixelCount: component.pixelCount,
      bounds: normalizedComponentBounds(component, width, height, layer.bounds)
    }))
  };
}
