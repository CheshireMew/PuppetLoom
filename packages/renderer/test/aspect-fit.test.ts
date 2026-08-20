import { describe, expect, it } from "vitest";
import { aspectFitScale, drawingBufferSize, MAX_DRAWING_BUFFER_PIXELS } from "../src/renderer.js";

describe("aspectFitScale", () => {
  it("keeps a matching viewport unchanged", () => {
    expect(aspectFitScale(1280, 1280, 720, 720)).toEqual({ x: 1, y: 1 });
    expect(aspectFitScale(1600, 900, 1280, 720)).toEqual({ x: 1, y: 1 });
  });

  it("adds transparent space at the sides of a wider viewport", () => {
    expect(aspectFitScale(1000, 1000, 1600, 900)).toEqual({ x: 0.5625, y: 1 });
  });

  it("adds transparent space above and below a taller viewport", () => {
    expect(aspectFitScale(1000, 1000, 900, 1600)).toEqual({ x: 1, y: 0.5625 });
  });

  it("falls back safely for invalid dimensions", () => {
    expect(aspectFitScale(0, 1000, 900, 1600)).toEqual({ x: 1, y: 1 });
  });
});

describe("drawingBufferSize", () => {
  it("keeps normal high-DPI viewers at native device resolution", () => {
    expect(drawingBufferSize(720, 720, 2)).toEqual({ width: 1440, height: 1440 });
  });

  it("scales oversized square buffers to the GPU pixel budget", () => {
    expect(drawingBufferSize(1280, 1280, 2)).toEqual({ width: 2048, height: 2048 });
  });

  it("preserves aspect ratio while enforcing the budget", () => {
    const result = drawingBufferSize(1920, 1080, 2);
    expect(result.width * result.height).toBeLessThanOrEqual(MAX_DRAWING_BUFFER_PIXELS);
    expect(result.width / result.height).toBeCloseTo(16 / 9, 3);
  });

  it("falls back safely for invalid CSS dimensions and pixel ratios", () => {
    expect(drawingBufferSize(0, Number.NaN, 0)).toEqual({ width: 1, height: 1 });
  });
});
