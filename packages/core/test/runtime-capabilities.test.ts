import { describe, expect, it } from "vitest";
import { isModelBehaviorAvailable, isModelExpressionAvailable, isMotionSemanticAvailable } from "../src/runtime-capabilities.js";
import type { PuppetLoomProject } from "../src/types.js";

function project(blink = false, mouthMotion = false): PuppetLoomProject {
  return {
    runtime: { features: { blink, mouthMotion } },
    model: {
      parameters: [
        { id: "yaw", name: "头部左右", group: "Head", min: -1, default: 0, max: 1, semantic: "head-yaw" },
        { id: "pitch", name: "头部上下", group: "Head", min: -1, default: 0, max: 1, semantic: "head-pitch" },
        { id: "blink", name: "眨眼", group: "Eyes", min: 0, default: 0, max: 1, semantic: "blink" },
        { id: "mouth", name: "张嘴", group: "Mouth", min: 0, default: 0, max: 1, semantic: "mouth-open" }
      ],
      expressions: [
        { id: "closed", name: "闭眼", parameters: { blink: 1 } },
        { id: "speaking", name: "开口", parameters: { mouth: 1 } },
        { id: "surprised", name: "惊讶", parameters: { pitch: -0.2, mouth: 0.8 } }
      ],
      behaviors: [
        { id: "blink-only", name: "眨眼", duration: 1, loop: false, tracks: [{ target: { kind: "parameter", id: "blink" }, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }] },
        { id: "mixed-idle", name: "待机", duration: 1, loop: true, tracks: [{ target: { kind: "parameter", id: "yaw" }, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 0.1 }] }, { target: { kind: "parameter", id: "blink" }, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }] },
        { id: "closed-expression", name: "闭眼表情", duration: 1, loop: false, tracks: [{ target: { kind: "expression", id: "closed" }, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }] }
      ]
    }
  } as PuppetLoomProject;
}

describe("runtime capability truth", () => {
  it("hides blink and mouth targets when the project explicitly disables those materials", () => {
    const fixture = project();
    expect(isMotionSemanticAvailable(fixture, "blink")).toBe(false);
    expect(isMotionSemanticAvailable(fixture, "mouth-open")).toBe(false);
    expect(isModelExpressionAvailable(fixture, fixture.model.expressions[0]!)).toBe(false);
    expect(isModelExpressionAvailable(fixture, fixture.model.expressions[1]!)).toBe(false);
    expect(isModelExpressionAvailable(fixture, fixture.model.expressions[2]!)).toBe(true);
    expect(isModelBehaviorAvailable(fixture, fixture.model.behaviors[0]!)).toBe(false);
    expect(isModelBehaviorAvailable(fixture, fixture.model.behaviors[1]!)).toBe(true);
    expect(isModelBehaviorAvailable(fixture, fixture.model.behaviors[2]!)).toBe(false);
  });

  it("publishes the same targets once their backing materials are enabled", () => {
    const fixture = project(true, true);
    expect(fixture.model.expressions.every((expression) => isModelExpressionAvailable(fixture, expression))).toBe(true);
    expect(fixture.model.behaviors.every((behavior) => isModelBehaviorAvailable(fixture, behavior))).toBe(true);
  });
});
