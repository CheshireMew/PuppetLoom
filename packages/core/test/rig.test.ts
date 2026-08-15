import { describe, expect, it } from "vitest";
import { buildRig } from "../src/rig.js";
import type { ImportedLayer, ImportedPsd } from "../src/psd.js";
import type { SemanticRole, Side } from "../src/types.js";

function importedLayer(id: string, role: SemanticRole, side: Side, x: number, y: number, width: number, height: number): ImportedLayer {
  return {
    id,
    sourceName: id,
    sourcePath: [id],
    role,
    side,
    order: 0,
    opacity: 1,
    blendMode: "normal",
    bounds: { x, y, width, height },
    opaquePixels: width * height,
    pixels: { width, height, data: new Uint8ClampedArray(width * height * 4) }
  };
}

describe("rig attachment pivots", () => {
  it("uses one eye-socket pivot for white, iris, lashes, and closed artwork", () => {
    const imported: ImportedPsd = {
      input: "fixture.psd",
      fileName: "fixture.psd",
      canvas: { width: 1000, height: 1000 },
      warnings: [],
      layers: [
        importedLayer("face", "face", "center", 350, 180, 300, 340),
        importedLayer("white-left", "eyeWhite", "left", 500, 270, 70, 42),
        importedLayer("iris-left", "iris", "left", 520, 274, 28, 38),
        importedLayer("lash-left", "eyelash", "left", 492, 258, 90, 54),
        importedLayer("closed-left", "eyeClosed", "left", 490, 260, 92, 50),
        importedLayer("white-right", "eyeWhite", "right", 430, 270, 70, 42)
      ]
    };
    const project = buildRig({
      imported,
      name: "fixture",
      seed: 42,
      source: { originalFileName: "fixture.psd", psdSha256: "fixture", psdPath: "source/source.psd" }
    });
    const left = project.layers.filter((layer) => layer.side === "left" && ["eyeWhite", "iris", "eyelash", "eyeClosed"].includes(layer.role));
    expect(left).toHaveLength(4);
    for (const layer of left) expect(layer.pivot).toEqual(project.anchors.eyeLeft);
  });

  it("places front-hair and clothing pivots at their attachment roots", () => {
    const imported: ImportedPsd = {
      input: "fixture.psd",
      fileName: "fixture.psd",
      canvas: { width: 1000, height: 1000 },
      warnings: [],
      layers: [
        importedLayer("front", "frontHair", "center", 400, 40, 200, 300),
        importedLayer("top", "topWear", "center", 400, 500, 200, 220),
        importedLayer("skirt", "bottomWear", "center", 340, 650, 320, 300)
      ]
    };
    const project = buildRig({
      imported,
      name: "fixture",
      seed: 42,
      source: { originalFileName: "fixture.psd", psdSha256: "fixture", psdPath: "source/source.psd" }
    });
    expect(project.layers.find((layer) => layer.role === "frontHair")?.pivot.y).toBeCloseTo(0.154, 6);
    expect(project.layers.find((layer) => layer.role === "topWear")?.pivot.y).toBeCloseTo(0.5396, 6);
    expect(project.layers.find((layer) => layer.role === "bottomWear")?.pivot.y).toBeCloseTo(0.686, 6);
  });
});
