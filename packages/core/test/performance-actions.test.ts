import { describe, expect, it } from "vitest";
import { applyAuthoringOperations } from "../src/authoring.js";
import { deformedPoints, neutralMotionState } from "../src/deform.js";
import { makeGridMesh } from "../src/mesh.js";
import { createDefaultAuthoringModel, evaluateLayerAuthoring, resolveMotionState, resolveParameterValues } from "../src/model.js";
import { planStandardPerformanceActions } from "../src/performance-actions.js";
import type { LayerBinding, PuppetLoomProject, SemanticRole, Side } from "../src/types.js";

function layer(id: string, role: SemanticRole, side: Side, x: number, y: number, extra: Partial<LayerBinding> = {}): LayerBinding {
  const bounds = { x, y, width: 0.12, height: 0.28 };
  return {
    id, sourceName: id, sourcePath: [id], role, side, order: 1, opacity: 1, blendMode: "normal", bounds,
    texture: `textures/${id}.png`, pivot: { x: x + 0.06, y: y + 0.02 }, mesh: makeGridMesh(bounds, 3, 3),
    weights: { head: role === "eyebrow" ? 1 : 0, body: role === "eyebrow" ? 0 : 1, gaze: 0, physics: ["headwear", "tail", "ear"].includes(role) ? 1 : 0 },
    parentGroup: ["eyebrow", "eyeWhite", "eyeClosed", "mouth", "headwear", "ear"].includes(role) ? "head" : "body",
    ...extra
  };
}

function project(): PuppetLoomProject {
  return {
    version: 4, name: "action-fixture", canvas: { width: 1000, height: 1400 },
    source: { originalFileName: "fixture.psd", psdSha256: "7".repeat(64), psdPath: "source/fixture.psd" }, rigLevel: "semantic",
    layers: [
      layer("brow-left", "eyebrow", "left", 0.52, 0.18), layer("brow-right", "eyebrow", "right", 0.36, 0.18),
      layer("eye-left", "eyeWhite", "left", 0.52, 0.23), layer("eye-right", "eyeWhite", "right", 0.36, 0.23),
      layer("eye-closed-left", "eyeClosed", "left", 0.52, 0.23), layer("eye-closed-right", "eyeClosed", "right", 0.36, 0.23),
      layer("mouth-closed", "mouth", "center", 0.44, 0.31, { mouthVariant: "closed" }),
      layer("mouth-slight", "mouth", "center", 0.44, 0.31, { mouthVariant: "slight" }),
      layer("mouth-open", "mouth", "center", 0.44, 0.31, { mouthVariant: "open" }),
      layer("ear-headwear", "headwear", "center", 0.38, 0.08, { secondaryAnchors: { earHingeLeft: { x: 0.41, y: 0.1 }, earHingeRight: { x: 0.47, y: 0.1 } } }),
      layer("arm-left", "hand", "left", 0.58, 0.42), layer("arm-right", "hand", "right", 0.3, 0.42),
      layer("leg-left", "leg", "left", 0.52, 0.68), layer("leg-right", "leg", "right", 0.36, 0.68),
      layer("tail", "tail", "center", 0.64, 0.62)
    ],
    model: createDefaultAuthoringModel(), anchors: {},
    runtime: {
      seed: 1, profile: "coherent-v1",
      envelope: { headYaw: 1, headPitch: 1, headRollDegrees: 3, bodySway: 0.02, bodyRollDegrees: 2, breath: 0.01, gazeX: 0.2, gazeY: 0.12, globalScale: 1 },
      features: { headTurn: true, bodyFollow: true, gaze: true, hairPhysics: false, blink: true, mouthMotion: true }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: []
  };
}

describe("standard performance action library", () => {
  it("authors reusable expressions, gestures, and idempotent limb bindings", () => {
    const before = project();
    const plan = planStandardPerformanceActions(before, 4);
    expect(plan.changed).toBe(true);
    expect(plan.expressions.map((value) => value.id)).toContain("performance-surprised");
    expect(plan.behaviors.map((value) => value.id)).toEqual(expect.arrayContaining(["action-wave-left", "action-wave-right", "action-step-in-place", "action-bow", "action-ear-flick", "action-tail-wag"]));
    expect(plan.parts.filter((part) => part.status === "completed").map((part) => part.part)).toEqual(expect.arrayContaining(["eyes", "mouth", "ears", "tail"]));
    expect(plan.patch?.previews).toHaveLength(12);
    expect(plan.patch?.previews.map((preview) => preview.id)).toEqual(expect.arrayContaining(["action-ear-flick", "action-tail-wag"]));
    const after = applyAuthoringOperations(before, plan.patch!.operations);
    expect(planStandardPerformanceActions(after, 5).changed).toBe(false);
    expect(after.model.bindings.filter((binding) => binding.id.includes("performance-arm-left"))).toHaveLength(1);
  });

  it("moves a separated arm through an authored behavior and returns it to rest", () => {
    const before = project();
    const after = applyAuthoringOperations(before, planStandardPerformanceActions(before, 0).patch!.operations);
    const arm = after.layers.find((value) => value.id === "arm-left")!;
    const activeState = { headYaw: 0, headPitch: 0, headRoll: 0, bodySway: 0, bodyPitch: 0, bodyRoll: 0, gazeX: 0, gazeY: 0, breath: 0, hairX: 0, hairY: 0, backHairX: 0, backHairY: 0, ahogeX: 0, ahogeY: 0, headwearX: 0, headwearY: 0, earX: 0, earY: 0, clothX: 0, clothY: 0, tailX: 0, tailY: 0, accessoryX: 0, accessoryY: 0, blink: 0, mouthOpen: 0, behavior: { id: "action-wave-left", timeSeconds: 0.8 } };
    expect(resolveParameterValues(after, activeState)["param-performance-arm-left"]).toBeCloseTo(1);
    const moved = evaluateLayerAuthoring(after, arm, activeState).points;
    expect(Math.max(...moved.map((point, index) => Math.hypot(point.x - arm.mesh.points[index]!.x, point.y - arm.mesh.points[index]!.y)))).toBeGreaterThan(0.08);
    const rested = evaluateLayerAuthoring(after, arm, { ...activeState, behavior: { id: "action-wave-left", timeSeconds: 2.4 } }).points;
    expect(rested).toEqual(arm.mesh.points);
  });

  it("drives real ear hinges and tail artwork, then returns both to neutral", () => {
    const before = project();
    const after = applyAuthoringOperations(before, planStandardPerformanceActions(before, 0).patch!.operations);
    const ears = after.layers.find((value) => value.id === "ear-headwear")!;
    const tail = after.layers.find((value) => value.id === "tail")!;
    const earState = { ...neutralMotionState, behavior: { id: "action-ear-flick", timeSeconds: 0.12 } };
    const resolvedEar = resolveMotionState(after, earState);
    expect(Math.abs(resolvedEar.earY)).toBeGreaterThan(0.006);
    expect(deformedPoints(after, ears, earState)).not.toEqual(ears.mesh.points);
    const tailState = { ...neutralMotionState, behavior: { id: "action-tail-wag", timeSeconds: 0.55 } };
    expect(Math.abs(resolveParameterValues(after, tailState)["param-performance-tail-wag"]!)).toBeGreaterThan(0.8);
    expect(deformedPoints(after, tail, tailState)).not.toEqual(tail.mesh.points);
    expect(deformedPoints(after, ears, { ...neutralMotionState, behavior: { id: "action-ear-flick", timeSeconds: 0.82 } })).toEqual(ears.mesh.points);
    expect(deformedPoints(after, tail, { ...neutralMotionState, behavior: { id: "action-tail-wag", timeSeconds: 1.9 } })).toEqual(tail.mesh.points);
  });

  it("reports absent parts and missing expression assets without fabricating actions", () => {
    const incomplete = project();
    incomplete.layers = incomplete.layers.filter((value) => !["eye-closed-left", "eye-closed-right", "mouth-slight", "mouth-open", "ear-headwear", "tail"].includes(value.id));
    const plan = planStandardPerformanceActions(incomplete, 0);
    expect(plan.parts.find((part) => part.part === "eyes")?.status).toBe("needs-assets");
    expect(plan.parts.find((part) => part.part === "mouth")?.status).toBe("needs-assets");
    expect(plan.parts.find((part) => part.part === "ears")?.status).toBe("not-present");
    expect(plan.parts.find((part) => part.part === "tail")?.status).toBe("not-present");
    expect(plan.behaviors.map((value) => value.id)).not.toEqual(expect.arrayContaining(["action-double-blink", "action-short-talk", "action-ear-flick", "action-tail-wag"]));
  });
});
