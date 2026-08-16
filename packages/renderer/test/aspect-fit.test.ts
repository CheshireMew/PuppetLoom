import { describe, expect, it } from "vitest";
import { aspectFitScale } from "../src/renderer.js";

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
