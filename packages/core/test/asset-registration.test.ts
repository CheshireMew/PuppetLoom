import { describe, expect, it } from "vitest";
import { mapAssetPoint, rasterizeRegisteredAsset, solveAssetRegistration } from "../src/asset-registration.js";

describe("asset registration", () => {
  it("maps padded/resized image frames into source canvas coordinates and rejects accidental stretching", () => {
    const { matrix } = solveAssetRegistration({ kind: "frame", generatedRect: { x: 20, y: 40, width: 200, height: 100 }, sourceRect: { x: 100, y: 80, width: 100, height: 50 } }, { width: 240, height: 180 });
    expect(mapAssetPoint(matrix, { x: 20, y: 40 })).toEqual({ x: 100, y: 80 });
    expect(mapAssetPoint(matrix, { x: 220, y: 140 })).toEqual({ x: 200, y: 130 });
    expect(() => solveAssetRegistration({ kind: "frame", generatedRect: { x: 0, y: 0, width: 100, height: 100 }, sourceRect: { x: 0, y: 0, width: 100, height: 50 } }, { width: 100, height: 100 })).toThrow(/非等比/);
  });
  it("solves rotation and scale from landmarks and requires explicit reflection", () => {
    const anchors = [{ generated: { x: 10, y: 10 }, source: { x: 80, y: 30 } }, { generated: { x: 30, y: 10 }, source: { x: 80, y: 70 } }, { generated: { x: 10, y: 30 }, source: { x: 40, y: 30 } }];
    const solved = solveAssetRegistration({ kind: "landmarks", anchors, maxErrorPixels: 0.01 }, { width: 40, height: 40 });
    expect(solved.rmsErrorPixels).toBeLessThan(1e-10);
    expect(mapAssetPoint(solved.matrix, { x: 20, y: 20 }).x).toBeCloseTo(60);
    const reflected = anchors.map((anchor) => ({ ...anchor, source: { ...anchor.source, x: 120 - anchor.source.x } }));
    expect(() => solveAssetRegistration({ kind: "landmarks", anchors: reflected, maxErrorPixels: 0.01 }, { width: 40, height: 40 })).toThrow(/配准误差/);
    expect(solveAssetRegistration({ kind: "landmarks", anchors: reflected, mirrorX: true, maxErrorPixels: 0.01 }, { width: 40, height: 40 }).rmsErrorPixels).toBeLessThan(1e-10);
  });
  it("preserves premultiplied color and refuses clipping instead of silently discarding pixels", () => {
    const pixels = new Uint8Array([255, 80, 20, 128]);
    const matrix = { a: 1, b: 0, c: 0, d: 1, tx: 2, ty: 3 };
    const result = rasterizeRegisteredAsset(pixels, 1, 1, matrix, { width: 10, height: 10 });
    expect([...result.data]).toEqual([...pixels]);
    expect(result.bounds).toEqual({ x: 2, y: 3, width: 1, height: 1 });
    expect(() => rasterizeRegisteredAsset(pixels, 1, 1, { ...matrix, tx: -1 }, { width: 10, height: 10 })).toThrow(/超出角色画布/);
  });
});
