import { describe, expect, it } from "vitest";
import { makeGridMesh } from "../src/mesh.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import { evaluateModelAgentCoherence, modelAgentConstraints } from "../src/model-agent-coherence.js";
import { createPrimaryPartAgentProposal, type PrimaryModelAgentPart } from "../src/primary-part-agent.js";
import type { LayerBinding, MouthVariant, PuppetLoomProject, SemanticRole, Side } from "../src/types.js";

function layer(id: string, role: SemanticRole, side: Side, bounds: { x: number; y: number; width: number; height: number }, mouthVariant?: MouthVariant): LayerBinding {
  const head = !["topWear", "bottomWear", "arm", "hand", "leg", "foot"].includes(role);
  return {
    id,
    sourceName: id,
    sourcePath: [id],
    role,
    side,
    order: 1,
    opacity: id === "mouth-source" ? 0 : 1,
    blendMode: "normal",
    bounds,
    texture: `textures/${id}.png`,
    pivot: { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.5 },
    mesh: makeGridMesh(bounds, 5, 5),
    weights: { head: head ? 1 : 0, body: head ? 0 : 1, gaze: role === "iris" ? 1 : 0, physics: 0 },
    ...(mouthVariant ? { mouthVariant } : {}),
    parentGroup: head ? "head" : "body"
  };
}

function project(): PuppetLoomProject {
  return {
    version: 4,
    name: "primary-agent-fixture",
    canvas: { width: 1000, height: 1400 },
    source: { originalFileName: "fixture.psd", psdSha256: "2".repeat(64), psdPath: "source/fixture.psd" },
    rigLevel: "semantic",
    layers: [
      layer("face", "face", "center", { x: 0.32, y: 0.12, width: 0.36, height: 0.34 }),
      layer("eye-white-left", "eyeWhite", "left", { x: 0.52, y: 0.24, width: 0.08, height: 0.04 }),
      layer("eye-white-right", "eyeWhite", "right", { x: 0.4, y: 0.24, width: 0.08, height: 0.04 }),
      layer("iris-left", "iris", "left", { x: 0.54, y: 0.245, width: 0.03, height: 0.035 }),
      layer("iris-right", "iris", "right", { x: 0.43, y: 0.245, width: 0.03, height: 0.035 }),
      layer("lash-left", "eyelash", "left", { x: 0.51, y: 0.23, width: 0.1, height: 0.05 }),
      layer("lash-right", "eyelash", "right", { x: 0.39, y: 0.23, width: 0.1, height: 0.05 }),
      layer("closed-eye-left", "eyeClosed", "left", { x: 0.51, y: 0.23, width: 0.1, height: 0.05 }),
      layer("closed-eye-right", "eyeClosed", "right", { x: 0.39, y: 0.23, width: 0.1, height: 0.05 }),
      layer("mouth-source", "mouth", "center", { x: 0.45, y: 0.36, width: 0.1, height: 0.04 }, "closed"),
      layer("mouth-neutral", "mouth", "center", { x: 0.45, y: 0.36, width: 0.1, height: 0.04 }, "closed"),
      layer("mouth-slight", "mouth", "center", { x: 0.45, y: 0.36, width: 0.1, height: 0.04 }, "slight"),
      layer("mouth-open", "mouth", "center", { x: 0.45, y: 0.36, width: 0.1, height: 0.04 }, "open"),
      layer("neck", "neck", "center", { x: 0.46, y: 0.44, width: 0.08, height: 0.12 }),
      layer("top", "topWear", "center", { x: 0.3, y: 0.52, width: 0.4, height: 0.28 }),
      layer("foot-left", "foot", "left", { x: 0.52, y: 0.88, width: 0.08, height: 0.08 }),
      layer("foot-right", "foot", "right", { x: 0.4, y: 0.88, width: 0.08, height: 0.08 })
    ],
    model: createDefaultAuthoringModel(),
    anchors: { forehead: { x: 0.5, y: 0.16 }, cheekLeft: { x: 0.59, y: 0.32 }, cheekRight: { x: 0.41, y: 0.32 }, chin: { x: 0.5, y: 0.44 }, neck: { x: 0.5, y: 0.48 }, bodyCenter: { x: 0.5, y: 0.68 } },
    runtime: {
      seed: 7,
      profile: "coherent-v1",
      envelope: { headYaw: 0.48, headPitch: 0.38, headRollDegrees: 2.4, bodySway: 0.009, bodyRollDegrees: 1.2, gazeX: 0.13, gazeY: 0.08, breath: 0.004, globalScale: 1 },
      features: { headTurn: true, bodyFollow: true, gaze: true, hairPhysics: false, blink: true, mouthMotion: true }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] },
    disabledReasons: []
  };
}

describe("primary model Agent", () => {
  it.each(["headFace", "eyes", "mouth", "body"] satisfies PrimaryModelAgentPart[])("builds and validates %s", (part) => {
    const proposal = createPrimaryPartAgentProposal(project(), { part, instruction: "自然、协调、克制" });
    expect(proposal.layers.length).toBeGreaterThan(0);
    expect(proposal.assetRequests).toHaveLength(0);
    expect(proposal.checks.every((check) => check.passed)).toBe(true);
  });

  it("creates reusable eye and mouth expressions", () => {
    const eyes = createPrimaryPartAgentProposal(project(), { part: "eyes", instruction: "自然" });
    const mouth = createPrimaryPartAgentProposal(project(), { part: "mouth", instruction: "自然" });
    expect(eyes.operations).toEqual(expect.arrayContaining([expect.objectContaining({ op: "upsert-expression" })]));
    expect(mouth.operations.filter((operation) => operation.op === "upsert-expression")).toHaveLength(3);
  });

  it("reports the exact failed pose ids and reasons instead of only a count", () => {
    const value = project();
    const iris = value.layers.find((candidate) => candidate.id === "iris-left")!;
    iris.bounds.x = 1.2;
    iris.mesh = makeGridMesh(iris.bounds, 5, 5);
    const proposal = createPrimaryPartAgentProposal(value, { part: "eyes", instruction: "自然" });
    const poseSafety = proposal.checks.find((check) => check.id === "pose-safety")!;
    expect(poseSafety.passed).toBe(false);
    expect(poseSafety.details.failedPoseIds).toContain("neutral");
    expect(poseSafety.details.failureReasons).toContain("超出安全画布");
  });

  it("does not enlarge an existing gaze envelope while adding blink authoring", () => {
    const value = project();
    value.runtime.envelope.gazeX = 0.064;
    value.runtime.envelope.gazeY = 0.04;
    const proposal = createPrimaryPartAgentProposal(value, {
      part: "eyes",
      instruction: "自然眨眼",
      intent: { amplitude: 0.7, response: 0.82, stability: 0.9, explanation: [] }
    });
    expect(proposal.overrides.runtime?.envelope).toMatchObject({ gazeX: 0.064, gazeY: 0.04 });
  });

  it("carries head contour, depth and occlusion decisions into runtime calibration", () => {
    const value = project();
    value.runtime.poseField = { kind: "ellipsoid-v1", center: { x: 0.5, y: 0.3 }, radiusX: 0.2, radiusY: 0.22, maxYawRadians: 0.2, maxPitchRadians: 0.2, perspective: 0.12 };
    const proposal = createPrimaryPartAgentProposal(value, {
      part: "headFace",
      instruction: "远侧眼不要穿出轮廓",
      intent: {
        amplitude: 0.9, response: 0.72, stability: 0.7, yawDegrees: 14, pitchUpDegrees: 12, pitchDownDegrees: 15,
        contourStrength: 1.2, depthStrength: 1.1, farEyeOpacity: 0.66, farBrowOpacity: 0.75,
        farEarOpacity: 0.5, farSideHairOpacity: 0.7, occlusionFadeStart: 0.55, sideHairDepthSwap: true,
        explanation: ["检查了九向姿态。"]
      }
    });
    expect(proposal.overrides.runtime?.poseField).toEqual(expect.objectContaining({ contourStrength: 1.2, depthStrength: 1.1 }));
    expect(proposal.overrides.runtime?.poseOcclusion).toEqual(expect.objectContaining({
      farEyeOpacity: 1, farBrowOpacity: 1, fadeStart: 0.55, sideHairDepthSwap: true
    }));
  });

  it("does not erase accepted front-hair authoring while improving the head", () => {
    const value = project();
    value.layers.push(layer("front-hair", "frontHair", "center", { x: 0.3, y: 0.08, width: 0.4, height: 0.34 }));
    value.model.parameters.push({ id: "param-agent-front-hair-follow-main", name: "前发跟随", group: "hair", kind: "continuous", min: -1, default: 0, max: 1 });
    value.model.bindings.push({
      id: "agent-front-hair-lag-follow-main",
      parameterIds: ["param-agent-front-hair-follow-main"],
      target: { kind: "layer", id: "front-hair" },
      keyforms: [{ values: [-1] }, { values: [0] }, { values: [1] }]
    });
    value.model.physics.push({
      id: "agent-front-hair-physics-main",
      name: "前发物理",
      inputParameterId: value.model.parameters.find((parameter) => parameter.semantic === "head-yaw")!.id,
      outputParameterId: "param-agent-front-hair-follow-main",
      inputScale: 1,
      outputScale: 1,
      response: 8,
      damping: 0.82
    });
    const before = JSON.stringify(value.model);
    const proposal = createPrimaryPartAgentProposal(value, { part: "headFace", instruction: "改善头部透视，但保留前发" });
    expect(JSON.stringify(proposal.overrides.model)).toBe(before);
  });

  it("declares and verifies cross-part preservation for a selected head task", () => {
    const before = project();
    before.layers.push(layer("front-hair", "frontHair", "center", { x: 0.3, y: 0.08, width: 0.4, height: 0.34 }));
    before.model.bindings.push({ id: "agent-front-hair-lag-main", parameterIds: [before.model.parameters.find((parameter) => parameter.semantic === "head-yaw")!.id], target: { kind: "layer", id: "front-hair" }, keyforms: [{ values: [-1] }, { values: [1] }] });
    const requested = ["headFace", "eyes", "headwear"] as const;
    expect(modelAgentConstraints([...requested]).map((constraint) => constraint.id)).toEqual(expect.arrayContaining(["head-chain-coherence", "accepted-front-hair-preserved"]));
    const preserved = evaluateModelAgentCoherence(before, JSON.parse(JSON.stringify(before)) as PuppetLoomProject, [...requested]);
    expect(preserved.find((check) => check.id === "accepted-front-hair-preserved")?.passed).toBe(true);
    const changed = JSON.parse(JSON.stringify(before)) as PuppetLoomProject;
    changed.model.bindings.find((binding) => binding.id === "agent-front-hair-lag-main")!.keyforms.push({ values: [0] });
    const rejected = evaluateModelAgentCoherence(before, changed, [...requested]);
    expect(rejected.find((check) => check.id === "accepted-front-hair-preserved")?.passed).toBe(false);
  });
});
