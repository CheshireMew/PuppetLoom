import { describe, expect, it } from "vitest";
import { detectLayerOrderIssues, type LayerOrderSource } from "../src/layer-order.js";

function layer(id: string, role: LayerOrderSource["role"], order: number, sourceName = id): LayerOrderSource {
  return { id, role, order, sourceName, sourcePath: [sourceName] };
}

describe("semantic layer-order diagnostics", () => {
  it("reports back hair behind neither neck nor face and brows behind the face", () => {
    const issues = detectLayerOrderIssues([
      layer("brow", "eyebrow", 0),
      layer("face", "face", 1),
      layer("neck", "neck", 2),
      layer("back-hair", "backHair", 3, "back_hair")
    ]);
    expect(issues.map((issue) => issue.id)).toEqual([
      "back-hair-behind-neck",
      "back-hair-behind-face",
      "face-behind-brow"
    ]);
  });

  it("distinguishes named back and front skirt layers around exposed legs", () => {
    const issues = detectLayerOrderIssues([
      layer("leg", "leg", 1),
      layer("back-skirt", "bottomWear", 2, "skirt_back"),
      layer("front-skirt", "bottomWear", 0, "skirt_front")
    ]);
    expect(issues.map((issue) => issue.id)).toEqual([
      "back-skirt-behind-leg",
      "leg-behind-front-skirt"
    ]);
  });

  it("leaves a correct back-to-front order without warnings", () => {
    expect(detectLayerOrderIssues([
      layer("back-hair", "backHair", 0, "back_hair"),
      layer("back-skirt", "bottomWear", 1, "skirt_back"),
      layer("leg", "leg", 2),
      layer("neck", "neck", 3),
      layer("face", "face", 4),
      layer("brow", "eyebrow", 5),
      layer("front-skirt", "bottomWear", 6, "skirt_front")
    ])).toEqual([]);
  });
});
