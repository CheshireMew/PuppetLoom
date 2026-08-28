import { describe, expect, it } from "vitest";
import { parseModelAgentSpecification } from "../src/agent-spec.js";

function validSpecification() {
  return {
    version: 1,
    kind: "puppetloom-rig-spec",
    scope: "selected",
    baseRevision: 3,
    goal: "让前发更克制，并保留自然回弹",
    anatomy: { layers: { "front-hair": { pivot: { x: 0.5, y: 0.22 } } } },
    parts: [{
      part: "frontHair",
      layerIds: ["front-hair"],
      rationale: ["看过连续转头证据后，发梢摆幅偏大。"],
      intent: {
        amplitude: 0.66,
        response: 0.48,
        stability: 0.58,
        ahogeAmplitude: 0.78,
        ahogeResponse: 0.4,
        ahogeStability: 0.44,
        lagResponse: 8.8,
        lagDamping: 0.9,
        deformationScale: 0.72,
        crownOutset: 0.04,
        bangLagDegrees: 5.5
      }
    }]
  };
}

describe("external Agent rig specification", () => {
  it("accepts a revision-pinned, numeric and explainable specification", () => {
    expect(parseModelAgentSpecification(validSpecification())).toEqual(validSpecification());
  });

  it("rejects ambiguous or unsafe documents before project mutation", () => {
    expect(() => parseModelAgentSpecification({ ...validSpecification(), baseRevision: -1 })).toThrow("baseRevision");
    expect(() => parseModelAgentSpecification({ ...validSpecification(), scope: "maybe" })).toThrow("scope");
    expect(() => parseModelAgentSpecification({ ...validSpecification(), parts: [...validSpecification().parts, ...validSpecification().parts] })).toThrow("重复");
    const excessive = validSpecification();
    excessive.parts[0]!.intent.deformationScale = 9;
    expect(() => parseModelAgentSpecification(excessive)).toThrow("deformationScale");
    const excessiveOutset = validSpecification();
    excessiveOutset.parts[0]!.intent.crownOutset = 0.2;
    expect(() => parseModelAgentSpecification(excessiveOutset)).toThrow("crownOutset");
    const excessiveBang = validSpecification();
    excessiveBang.parts[0]!.intent.bangLagDegrees = 30;
    expect(() => parseModelAgentSpecification(excessiveBang)).toThrow("bangLagDegrees");
    const multipleFrontLayers = validSpecification();
    multipleFrontLayers.parts[0]!.layerIds = ["front-a", "front-b"];
    expect(() => parseModelAgentSpecification(multipleFrontLayers)).toThrow("最多只能指定一个图层");
  });

  it("requires real visual review instead of accepting an unfinished template", () => {
    const missingRationale = validSpecification() as unknown as { parts: Array<Record<string, unknown>> };
    delete missingRationale.parts[0]!.rationale;
    expect(() => parseModelAgentSpecification(missingRationale)).toThrow("rationale");

    const unchangedTemplate = validSpecification();
    unchangedTemplate.goal = "由外部 Agent 看图、理解用户目标后填写；不要原样执行模板。";
    expect(() => parseModelAgentSpecification(unchangedTemplate)).toThrow("未审查模板");

    const placeholderRationale = validSpecification();
    placeholderRationale.parts[0]!.rationale = ["自然、克制的前发基线；外部 Agent 应在看图后调整。"];
    expect(() => parseModelAgentSpecification(placeholderRationale)).toThrow("模板占位内容");
  });

  it("accepts explicit head contour, depth and far-side occlusion decisions", () => {
    const head = {
      version: 1, kind: "puppetloom-rig-spec", scope: "selected", baseRevision: 8, goal: "收紧远侧轮廓并保留双眼可读性",
      anatomy: { semanticPoints: { nose: { x: 0.502, y: 0.31 }, mouthLeft: { x: 0.47, y: 0.38 }, mouthRight: { x: 0.535, y: 0.376 } } },
      parts: [{
        part: "headFace", rationale: ["右转证据中远侧眼接近脸缘，但仍应保留约七成可见度。"],
        intent: {
          amplitude: 0.9, response: 0.72, stability: 0.7, yawDegrees: 14, pitchUpDegrees: 12, pitchDownDegrees: 15,
          contourStrength: 1.15, depthStrength: 1.08, farEyeOpacity: 0.7, farBrowOpacity: 0.78,
          farEarOpacity: 0.5, farSideHairOpacity: 0.68, occlusionFadeStart: 0.56, sideHairDepthSwap: true
        }
      }]
    };
    expect(parseModelAgentSpecification(head)).toEqual(head);
    head.parts[0]!.intent.contourStrength = 3;
    expect(() => parseModelAgentSpecification(head)).toThrow("contourStrength");
  });

  it("rejects geometry-sensitive work that omits character-specific anatomy", () => {
    const missing = validSpecification();
    delete (missing as { anatomy?: unknown }).anatomy;
    expect(() => parseModelAgentSpecification(missing)).toThrow("必须提供 anatomy");
  });

  it("accepts an explicit supported-skirt decision and rejects unknown structures", () => {
    const skirt = {
      version: 1, kind: "puppetloom-rig-spec", scope: "selected", baseRevision: 35, goal: "保持裙撑体积",
      parts: [{
        part: "skirt", rationale: ["连续运动中裙摆被分段拉斜，钟形轮廓没有保持。"],
        intent: {
          amplitude: 0.34, response: 0.62, stability: 0.84,
          lagResponse: 10.2, lagDamping: 0.92, deformationScale: 0.7,
          garmentStructure: "supported", garmentFlexibility: 0.2
        }
      }]
    };
    expect(parseModelAgentSpecification(skirt)).toEqual(skirt);
    skirt.parts[0]!.intent.garmentFlexibility = 0.8;
    expect(() => parseModelAgentSpecification(skirt)).toThrow("garmentFlexibility");
    skirt.parts[0]!.intent.garmentFlexibility = 0.2;
    skirt.parts[0]!.intent.garmentStructure = "rubber";
    expect(() => parseModelAgentSpecification(skirt)).toThrow("garmentStructure");
  });
});
