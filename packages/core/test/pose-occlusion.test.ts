import { describe, expect, it } from "vitest";
import { applyCoherentPoseField } from "../src/pose-field.js";
import { authoredLayersInRenderOrder, authoredOpacityFor } from "../src/render-contract.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import { neutralMotionState } from "../src/deform.js";
import { makeGridMesh } from "../src/mesh.js";
import type { LayerBinding, PuppetLoomProject, SemanticRole, Side } from "../src/types.js";

function layer(id: string, role: SemanticRole, side: Side, order: number): LayerBinding {
  const bounds = { x: 0.3, y: 0.1, width: 0.4, height: 0.4 };
  return {
    id, sourceName: id, sourcePath: [id], role, side, order, opacity: 1, blendMode: "normal", bounds,
    texture: `textures/${id}.png`, pivot: { x: 0.5, y: 0.3 }, mesh: makeGridMesh(bounds, 3, 3),
    weights: { head: 1, body: 0, gaze: 0, physics: 0 }, parentGroup: "head"
  };
}

function project(): PuppetLoomProject {
  return {
    version: 4, name: "occlusion", canvas: { width: 100, height: 100 },
    source: { originalFileName: "fixture.psd", psdSha256: "9".repeat(64), psdPath: "source/fixture.psd" }, rigLevel: "semantic",
    layers: [layer("hair-left", "sideHair", "left", 9), layer("hair-right", "sideHair", "right", 9), layer("face", "face", "center", 10), layer("eye-left", "eyeWhite", "left", 15), layer("eye-right", "eyeWhite", "right", 15)],
    model: createDefaultAuthoringModel(), anchors: {},
    runtime: {
      seed: 1, profile: "coherent-v1", features: { headTurn: true, bodyFollow: true, gaze: true, hairPhysics: false, blink: true, mouthMotion: true },
      envelope: { headYaw: 1, headPitch: 1, headRollDegrees: 3, bodySway: 0, bodyRollDegrees: 0, gazeX: 0, gazeY: 0, breath: 0, globalScale: 1 },
      poseField: { kind: "ellipsoid-v1", center: { x: 0.5, y: 0.3 }, radiusX: 0.2, radiusY: 0.2, maxYawRadians: 0.3, maxPitchRadians: 0.2, perspective: 0.12 }
    }, quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: []
  };
}

describe("pose-dependent depth and occlusion", () => {
  it("fades only the far eye after the configured turn threshold", () => {
    const value = project();
    const far = value.layers.find((candidate) => candidate.id === "eye-left")!;
    const near = value.layers.find((candidate) => candidate.id === "eye-right")!;
    expect(authoredOpacityFor(value, far, { ...neutralMotionState, headYaw: 0.5 })).toBe(1);
    expect(authoredOpacityFor(value, far, { ...neutralMotionState, headYaw: 1 })).toBeCloseTo(0.68);
    expect(authoredOpacityFor(value, near, { ...neutralMotionState, headYaw: 1 })).toBe(1);
  });

  it("moves far side hair behind the face and near side hair in front", () => {
    const order = authoredLayersInRenderOrder(project(), { ...neutralMotionState, headYaw: 1 }).map((value) => value.id);
    expect(order.indexOf("hair-left")).toBeLessThan(order.indexOf("face"));
    expect(order.indexOf("hair-right")).toBeGreaterThan(order.indexOf("face"));
  });

  it("lets an authored contour strength change the side-jaw correction without changing angle limits", () => {
    const face = layer("face", "face", "center", 10);
    const base = { x: 0.66, y: 0.46 };
    const field = { kind: "ellipsoid-v1" as const, center: { x: 0.5, y: 0.3 }, radiusX: 0.2, radiusY: 0.2, maxYawRadians: 0.3, maxPitchRadians: 0.2, perspective: 0.12 };
    const soft = applyCoherentPoseField({ ...field, contourStrength: 0.4 }, face, base, 1, 0);
    const strong = applyCoherentPoseField({ ...field, contourStrength: 1.6 }, face, base, 1, 0);
    expect(Math.abs(strong.x - soft.x)).toBeGreaterThan(0.005);
  });
});
