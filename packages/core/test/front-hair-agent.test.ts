import { describe, expect, it } from "vitest";
import { modelAgentCapabilities, requestedModelAgentParts } from "../src/agent.js";
import { assessAgentMesh } from "../src/agent-mesh.js";
import { createFrontHairAgentProposal } from "../src/front-hair-agent.js";
import { frontHairSideGeometry } from "../src/front-hair-geometry.js";
import { createSecondaryPartAgentProposal } from "../src/secondary-part-agent.js";
import { neutralMotionState, deformedPoints } from "../src/deform.js";
import { makeGridMesh } from "../src/mesh.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import type { LayerBinding, PuppetLoomProject } from "../src/types.js";

function frontHairLayer(): LayerBinding {
  const bounds = { x: 0.3, y: 0.12, width: 0.4, height: 0.4 };
  return {
    id: "front-hair",
    sourceName: "front hair",
    sourcePath: ["front hair"],
    role: "frontHair",
    side: "center",
    order: 1,
    opacity: 1,
    blendMode: "normal",
    bounds,
    texture: "textures/front-hair.png",
    pivot: { x: 0.5, y: 0.29 },
    secondaryAnchors: {
      frontHairRoot: { x: 0.5, y: 0.31 },
      frontHairRootLeft: { x: 0.39, y: 0.31 },
      frontHairRootRight: { x: 0.61, y: 0.31 },
      frontHairTipLeft: { x: 0.34, y: 0.5 },
      frontHairTipRight: { x: 0.66, y: 0.5 },
      ahogeRoot: { x: 0.5, y: 0.23 }
    },
    mesh: makeGridMesh(bounds, 6, 6),
    weights: { head: 1, body: 0, gaze: 0, physics: 1 },
    parentGroup: "head"
  };
}

function project(): PuppetLoomProject {
  return {
    version: 4,
    name: "front-hair-agent-fixture",
    canvas: { width: 1000, height: 1000 },
    source: { originalFileName: "fixture.psd", psdSha256: "0".repeat(64), psdPath: "source/fixture.psd" },
    rigLevel: "semantic",
    layers: [frontHairLayer()],
    model: createDefaultAuthoringModel(),
    anchors: { forehead: { x: 0.5, y: 0.28 }, chin: { x: 0.5, y: 0.5 }, neck: { x: 0.5, y: 0.56 } },
    runtime: {
      seed: 42,
      profile: "coherent-v3",
      envelope: {
        headYaw: 0.45,
        headPitch: 0.3,
        headRollDegrees: 5,
        bodySway: 0.01,
        bodyRollDegrees: 2,
        gazeX: 0,
        gazeY: 0,
        breath: 0,
        globalScale: 1
      },
      features: { headTurn: true, bodyFollow: true, gaze: false, hairPhysics: true, blink: false, mouthMotion: false }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] },
    disabledReasons: []
  };
}

describe("front hair Agent", () => {
  it("gives a short central fringe its own local length instead of treating it as scalp or side hair", () => {
    const layer = frontHairLayer();
    layer.bounds = { x: 0.432031, y: 0.028125, width: 0.125781, height: 0.203125 };
    layer.secondaryAnchors = {
      frontHairRoot: { x: 0.494922, y: 0.134375 },
      frontHairRootLeft: { x: 0.450781, y: 0.135938 },
      frontHairRootRight: { x: 0.539063, y: 0.135938 },
      frontHairTipLeft: { x: 0.450781, y: 0.230469 },
      frontHairTipRight: { x: 0.539063, y: 0.230469 },
      ahogeRoot: { x: 0.494922, y: 0.076563 }
    };
    layer.mesh = {
      topology: "art",
      detail: 12,
      points: [
        { x: 0.4475, y: 0.1125 }, { x: 0.4795, y: 0.1125 }, { x: 0.5105, y: 0.1125 }, { x: 0.5425, y: 0.1125 },
        { x: 0.4725, y: 0.1335 }, { x: 0.4955, y: 0.145 }, { x: 0.4825, y: 0.161 }, { x: 0.5095, y: 0.164 },
        { x: 0.466, y: 0.192 }, { x: 0.4565, y: 0.222 }, { x: 0.5335, y: 0.207 }, { x: 0.542, y: 0.224 }
      ],
      triangles: []
    };

    const root = frontHairSideGeometry(layer, layer.mesh.points[1]!);
    const leftBangTip = frontHairSideGeometry(layer, layer.mesh.points[6]!);
    const rightBangTip = frontHairSideGeometry(layer, layer.mesh.points[7]!);
    const sideLockTip = frontHairSideGeometry(layer, layer.mesh.points[9]!);

    expect(root.bangRelease).toBeLessThan(0.1);
    expect(leftBangTip.bangRelease).toBeGreaterThan(0.8);
    expect(rightBangTip.bangRelease).toBeGreaterThan(0.8);
    expect(leftBangTip.sideRelease).toBeLessThan(leftBangTip.bangRelease * 0.25);
    expect(sideLockTip.bangRelease).toBeLessThan(0.05);
    expect(sideLockTip.sideRelease).toBeGreaterThan(0.5);
  });

  it("marks a legacy rectangular mesh for automatic Alpha ArtMesh rebuilding", () => {
    expect(assessAgentMesh(frontHairLayer())).toMatchObject({
      topology: "grid",
      shouldRebuild: true,
      issues: expect.arrayContaining(["仍是矩形网格，未贴合 Alpha 轮廓"])
    });
  });

  it("uses the shared whole-model task registry instead of a front-hair-only protocol", () => {
    const value = project();
    expect(requestedModelAgentParts(value, "whole")).toEqual(["headFace", "frontHair", "ahoge"]);
    expect(requestedModelAgentParts(value)).toEqual(["headFace", "frontHair", "ahoge"]);
    expect(modelAgentCapabilities(value).find((capability) => capability.part === "frontHair")).toMatchObject({ available: true, targetLayerIds: ["front-hair"] });
    expect(modelAgentCapabilities(value).find((capability) => capability.part === "tail")).toMatchObject({ available: false });
  });

  it("builds a complete, safe and neutral-preserving authoring proposal", () => {
    const value = createFrontHairAgentProposal(project(), "让前发自然转向，并增加轻微滞后和回弹");
    expect(value.checks.every((check) => check.passed)).toBe(true);
    expect(value.operations.map((operation) => operation.op)).toEqual([
      "upsert-parameter",
      "upsert-binding",
      "upsert-binding",
      "upsert-binding",
      "upsert-physics"
    ]);
    const poseBinding = value.project.model.bindings.find((binding) => binding.id.includes("front-hair-pose"));
    expect(poseBinding?.keyforms).toHaveLength(9);
    expect(value.project.model.physics).toHaveLength(1);
    expect(value.project.runtime.secondaryMotionTuning?.frontHair?.amplitude).toBe(0.74);
    expect(value.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "central-bang-motion", passed: true }),
      expect.objectContaining({ id: "side-perspective", passed: true }),
      expect.objectContaining({ id: "side-hang", passed: true })
    ]));
    const layer = value.project.layers[0]!;
    expect(deformedPoints(value.project, layer, neutralMotionState)).toEqual(layer.mesh.points);
  });

  it("does not pretend to understand prose in the legacy compatibility entry", () => {
    const stronger = createFrontHairAgentProposal(project(), "前发滞后明显一点，回弹更强");
    const steadier = createFrontHairAgentProposal(project(), "不要回弹，完全稳定");
    expect(stronger.intent).toEqual(steadier.intent);
    expect(stronger.intent.explanation[0]).toContain("结构化规格");
    expect(stronger.checks.every((check) => check.passed)).toBe(true);
  });

  it("executes an external Agent's explicit intent without reinterpreting its prose", () => {
    const intent = {
      amplitude: 0.74, response: 0.42, stability: 0.46,
      ahogeAmplitude: 0.7992, ahogeResponse: 0.36, ahogeStability: 0.38,
      lagResponse: 8.2, lagDamping: 0.78, deformationScale: 0.88,
      explanation: ["外部 Agent 看图后决定收敛发梢。"]
    };
    const value = createFrontHairAgentProposal(project(), "夸张一点、回弹更强", undefined, intent);
    expect(value.intent).toMatchObject({
      amplitude: intent.amplitude,
      response: intent.response,
      stability: intent.stability,
      ahogeAmplitude: intent.ahogeAmplitude,
      ahogeResponse: intent.ahogeResponse,
      ahogeStability: intent.ahogeStability,
      lagResponse: intent.lagResponse,
      lagDamping: intent.lagDamping
    });
    expect(value.intent.deformationScale).toBeLessThanOrEqual(intent.deformationScale);
    expect(value.intent.explanation[0]).toBe(intent.explanation[0]);
    expect(value.checks.every((check) => check.passed)).toBe(true);
  });

  it("lets an external Agent restore symmetric neutral crown volume without moving the central fringe", () => {
    const intent = {
      amplitude: 0.68, response: 0.72, stability: 0.82,
      ahogeAmplitude: 0.78, ahogeResponse: 0.46, ahogeStability: 0.76,
      lagResponse: 9, lagDamping: 0.82, deformationScale: 0.88,
      crownOutset: 0.04,
      explanation: ["外部 Agent 看图确认两侧头顶轮廓需要对称外扩。"]
    };
    const value = createFrontHairAgentProposal(project(), "恢复头顶饱满弧度", undefined, intent);
    const layer = value.project.layers[0]!;
    const base = frontHairLayer();
    const displacements = layer.mesh.points.map((point, index) => point.x - base.mesh.points[index]!.x);
    expect(Math.min(...displacements)).toBeLessThan(-0.01);
    expect(Math.max(...displacements)).toBeGreaterThan(0.01);
    expect(displacements[14]).toBeCloseTo(0, 8);
    expect(value.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "crown-volume", passed: true })
    ]));
    expect(value.checks.every((check) => check.passed)).toBe(true);
  });

  it("runs another secondary part through the shared repair and physics policy", () => {
    const value = createSecondaryPartAgentProposal(project(), { part: "ahoge", instruction: "让呆毛轻微滞后并自然回弹" });
    expect(value.layers.map((layer) => layer.id)).toEqual(["front-hair"]);
    expect(value.operations.map((operation) => operation.op)).toEqual([
      "upsert-parameter", "upsert-binding", "upsert-binding", "upsert-physics"
    ]);
    expect(value.checks.every((check) => check.passed)).toBe(true);
    expect(value.project.runtime.secondaryMotionTuning?.ahoge?.amplitude).toBeGreaterThan(0);
    expect(value.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rigid-root-hinge", passed: true })
    ]));
  });
});
