import { describe, expect, it } from "vitest";
import { analyzeAlphaComponents, pixelsForComponents } from "../src/alpha-components.js";

function raster(): { width: number; height: number; data: Uint8ClampedArray } {
  const width = 20;
  const height = 10;
  const data = new Uint8ClampedArray(width * height * 4);
  const set = (x: number, y: number, alpha = 255) => { data[(y * width + x) * 4 + 3] = alpha; };
  for (let y = 2; y <= 4; y += 1) for (let x = 2; x <= 4; x += 1) set(x, y);
  for (let y = 3; y <= 5; y += 1) for (let x = 14; x <= 16; x += 1) set(x, y);
  set(10, 8, 12);
  set(19, 9);
  set(5, 3, 5);
  return { width, height, data };
}

describe("Alpha connected components", () => {
  it("separates meaningful regions from tiny dust with stable centroids", () => {
    const analysis = analyzeAlphaComponents(raster());
    expect(analysis.opaquePixels).toBe(20);
    expect(analysis.meaningful.map((component) => component.pixelCount)).toEqual([9, 9]);
    expect(analysis.tiny.map((component) => component.pixelCount)).toEqual([1, 1]);
    expect(analysis.confirmedNoise.map((component) => component.alphaSum)).toEqual([12]);
    expect(analysis.suspectedDetails.map((component) => component.alphaSum)).toEqual([255]);
    expect(analysis.meaningful.map((component) => component.centroid.x)).toEqual([3, 15]);
  });

  it("keeps the antialias fringe only with its selected component", () => {
    const source = raster();
    const analysis = analyzeAlphaComponents(source);
    const left = analysis.meaningful.find((component) => component.centroid.x < 10)!;
    const output = pixelsForComponents(source, analysis, new Set([left.index]));
    expect(output[(3 * source.width + 5) * 4 + 3]).toBe(5);
    expect(output[(4 * source.width + 15) * 4 + 3]).toBe(0);
  });
});
