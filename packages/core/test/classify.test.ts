import { describe, expect, it } from "vitest";
import { classifyLayerName, explicitSideFromName, normalizeLayerName } from "../src/classify.js";

describe("layer name classification", () => {
  it.each([
    ["eye_white_right", "eyeWhite", "right"],
    ["左 瞳", "iris", "left"],
    ["front-hair copy", "frontHair", "center"],
    ["後ろ髪", "backHair", "center"],
    ["衣服", "topWear", "center"],
    ["闭眼-left", "eyeClosed", "left"],
    ["tail", "tail", "center"],
    ["鲸鱼尾巴", "tail", "center"],
    ["mystery layer", "unknown", "center"]
  ])("classifies %s", (name, role, side) => {
    expect(classifyLayerName(name)).toMatchObject({ role, side });
  });

  it("normalizes full-width and copy suffixes", () => {
    expect(normalizeLayerName("Ｆｒｏｎｔ＿Ｈａｉｒ 副本")).toBe("front-hair");
  });

  it("does not invent a side when none is named", () => {
    expect(explicitSideFromName("iris")).toBeUndefined();
  });
});
