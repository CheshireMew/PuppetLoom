import sharp from "sharp";
import type { LayerAlphaTopology, LayerBinding, Rect } from "./types.js";

interface PixelComponent {
  pixelCount: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function normalizedComponentBounds(component: PixelComponent, width: number, height: number, layerBounds: Rect): Rect {
  return {
    x: layerBounds.x + layerBounds.width * component.left / width,
    y: layerBounds.y + layerBounds.height * component.top / height,
    width: layerBounds.width * (component.right - component.left + 1) / width,
    height: layerBounds.height * (component.bottom - component.top + 1) / height
  };
}

export async function inspectLayerAlphaTopology(texturePath: string, layer: LayerBinding): Promise<LayerAlphaTopology> {
  const { data, info } = await sharp(texturePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const visited = new Uint8Array(width * height);
  const components: PixelComponent[] = [];
  let opaquePixels = 0;

  const isOpaque = (index: number): boolean => (data[index * 4 + 3] ?? 0) >= 8;
  for (let index = 0; index < visited.length; index += 1) {
    if (visited[index] || !isOpaque(index)) continue;
    const queue = [index];
    visited[index] = 1;
    const component: PixelComponent = {
      pixelCount: 0,
      left: width,
      top: height,
      right: 0,
      bottom: 0
    };
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      const x = current % width;
      const y = Math.floor(current / width);
      component.pixelCount += 1;
      opaquePixels += 1;
      component.left = Math.min(component.left, x);
      component.top = Math.min(component.top, y);
      component.right = Math.max(component.right, x);
      component.bottom = Math.max(component.bottom, y);
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || !isOpaque(neighbor)) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    components.push(component);
  }

  const minimumMeaningfulPixels = Math.max(4, Math.floor(opaquePixels * 0.0001));
  const meaningful = components
    .filter((component) => component.pixelCount >= minimumMeaningfulPixels)
    .sort((left, right) => right.pixelCount - left.pixelCount);
  return {
    textureSize: { width, height },
    opaquePixels,
    alphaThreshold: 8,
    minimumMeaningfulPixels,
    componentCount: meaningful.length,
    ignoredTinyComponentCount: components.length - meaningful.length,
    components: meaningful.slice(0, 64).map((component, index) => ({
      index,
      pixelCount: component.pixelCount,
      bounds: normalizedComponentBounds(component, width, height, layer.bounds)
    }))
  };
}
