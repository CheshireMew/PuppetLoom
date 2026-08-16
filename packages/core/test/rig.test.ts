import { describe, expect, it } from "vitest";
import { buildRig } from "../src/rig.js";
import type { ImportedLayer, ImportedPsd } from "../src/psd.js";
import type { SemanticRole, Side } from "../src/types.js";

function importedLayer(id: string, role: SemanticRole, side: Side, x: number, y: number, width: number, height: number): ImportedLayer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;
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
    pixels: { width, height, data }
  };
}

function frontHairLayer(): ImportedLayer {
  const layer = importedLayer("front", "frontHair", "center", 400, 40, 200, 300);
  layer.pixels.data.fill(0);
  let opaquePixels = 0;
  for (let y = 0; y < layer.pixels.height; y += 1) {
    const ranges = y < 60
      ? [[92, 108]]
      : y < 160
        ? [[28, 172]]
        : [[12, 60], [76, 124], [140, 188]];
    for (const [start, end] of ranges) {
      for (let x = start ?? 0; x < (end ?? 0); x += 1) {
        layer.pixels.data[(y * layer.pixels.width + x) * 4 + 3] = 255;
        opaquePixels += 1;
      }
    }
  }
  layer.opaquePixels = opaquePixels;
  return layer;
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
        frontHairLayer(),
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
    const frontHair = project.layers.find((layer) => layer.role === "frontHair");
    expect(frontHair?.secondaryAnchors).toEqual({
      ahogeRoot: { x: 0.5, y: 0.1 },
      frontHairRoot: { x: 0.5, y: 0.2 }
    });
    expect(frontHair?.pivot).toEqual(frontHair?.secondaryAnchors?.frontHairRoot);
    expect(frontHair?.mesh.rows).toBeGreaterThanOrEqual(18);
    expect(frontHair?.mesh.cols).toBeGreaterThanOrEqual(12);
    expect(project.layers.find((layer) => layer.role === "topWear")?.pivot.y).toBeCloseTo(0.5396, 6);
    expect(project.layers.find((layer) => layer.role === "bottomWear")?.pivot.y).toBeCloseTo(0.686, 6);
  });

  it("derives two ear hinges from the face edges for merged headwear", () => {
    const imported: ImportedPsd = {
      input: "fixture.psd",
      fileName: "fixture.psd",
      canvas: { width: 1000, height: 1000 },
      warnings: [],
      layers: [
        importedLayer("headwear", "headwear", "center", 300, 120, 400, 300),
        importedLayer("face", "face", "center", 400, 200, 200, 260)
      ]
    };
    const project = buildRig({
      imported,
      name: "fixture",
      seed: 42,
      source: { originalFileName: "fixture.psd", psdSha256: "fixture", psdPath: "source/source.psd" }
    });
    expect(project.layers.find((layer) => layer.role === "headwear")?.secondaryAnchors).toEqual({
      earHingeLeft: { x: 0.406, y: 0.33 },
      earHingeRight: { x: 0.594, y: 0.33 }
    });
  });
});
