import { describe, expect, it } from "vitest";
import { applyCoherentPoseField } from "../src/pose-field.js";
import { makeGridMesh } from "../src/rig.js";
import type { CoherentPoseField, LayerBinding, SemanticRole } from "../src/types.js";

const field: CoherentPoseField = {
  kind: "ellipsoid-v1",
  center: { x: 0.5, y: 0.3 },
  radiusX: 0.16,
  radiusY: 0.2,
  maxYawRadians: 0.3,
  maxPitchRadians: 0.2,
  perspective: 0.1
};

function layer(role: SemanticRole): LayerBinding {
  const bounds = { x: 0.35, y: 0.1, width: 0.3, height: 0.4 };
  return {
    id: role, sourceName: role, sourcePath: [role], role, side: "center", order: 0, opacity: 1,
    blendMode: "normal", bounds, texture: `${role}.png`, pivot: { x: 0.5, y: 0.3 },
    mesh: makeGridMesh(bounds, 4, 4), weights: { head: 1, body: 0, gaze: 0, physics: 0 }, parentGroup: "head"
  };
}

describe("coherent semantic pose field", () => {
  it("preserves every point exactly at the neutral pose", () => {
    const face = layer("face");
    for (const point of face.mesh.points) expect(applyCoherentPoseField(field, face, point, 0, 0)).toEqual(point);
  });

  it("produces mirrored left and right turns from one head surface", () => {
    const face = layer("face");
    const center = { x: 0.5, y: 0.3 };
    const right = applyCoherentPoseField(field, face, center, 0.8, 0);
    const left = applyCoherentPoseField(field, face, center, -0.8, 0);
    expect(right.x).toBeGreaterThan(center.x);
    expect(left.x).toBeLessThan(center.x);
    expect(right.x - center.x).toBeCloseTo(center.x - left.x, 6);
  });

  it("moves facial features and attached hair as one pose with different depth", () => {
    const point = { x: 0.5, y: 0.3 };
    const nose = applyCoherentPoseField(field, layer("nose"), point, 0.7, 0.2);
    const frontHair = applyCoherentPoseField(field, layer("frontHair"), point, 0.7, 0.2);
    const backHair = applyCoherentPoseField(field, layer("backHair"), point, 0.7, 0.2);
    expect(nose.x).toBeGreaterThan(frontHair.x);
    expect(frontHair.x).toBeGreaterThan(backHair.x);
    expect([nose, frontHair, backHair].every((posed) => Number.isFinite(posed.x) && Number.isFinite(posed.y))).toBe(true);
  });
});
