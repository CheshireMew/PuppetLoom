import { describe, expect, it } from "vitest";
import { applyAuthoringOperations } from "../src/authoring.js";
import { makeGridMesh } from "../src/mesh.js";
import { createDefaultAuthoringModel, evaluateLayerAuthoring, resolveParameterValues } from "../src/model.js";
import { planStandardPerformanceActions } from "../src/performance-actions.js";
import type { LayerBinding, PuppetLoomProject, SemanticRole, Side } from "../src/types.js";

function layer(id: string, role: SemanticRole, side: Side, x: number, y: number): LayerBinding {
  const bounds = { x, y, width: 0.12, height: 0.28 };
  return {
    id, sourceName: id, sourcePath: [id], role, side, order: 1, opacity: 1, blendMode: "normal", bounds,
    texture: `textures/${id}.png`, pivot: { x: x + 0.06, y: y + 0.02 }, mesh: makeGridMesh(bounds, 3, 3),
    weights: { head: role === "eyebrow" ? 1 : 0, body: role === "eyebrow" ? 0 : 1, gaze: 0, physics: 0 },
    parentGroup: role === "eyebrow" ? "head" : "body"
  };
}

function project(): PuppetLoomProject {
  return {
    version: 4, name: "action-fixture", canvas: { width: 1000, height: 1400 },
    source: { originalFileName: "fixture.psd", psdSha256: "7".repeat(64), psdPath: "source/fixture.psd" }, rigLevel: "semantic",
    layers: [
      layer("brow-left", "eyebrow", "left", 0.52, 0.18), layer("brow-right", "eyebrow", "right", 0.36, 0.18),
      layer("arm-left", "hand", "left", 0.58, 0.42), layer("arm-right", "hand", "right", 0.3, 0.42),
      layer("leg-left", "leg", "left", 0.52, 0.68), layer("leg-right", "leg", "right", 0.36, 0.68)
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
    expect(plan.behaviors.map((value) => value.id)).toEqual(expect.arrayContaining(["action-wave-left", "action-wave-right", "action-step-in-place", "action-bow"]));
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
});
