import { describe, expect, it } from "vitest";
import { applyCoherentPoseField } from "../src/pose-field.js";
import { makeGridMesh } from "../src/rig.js";
import type { CoherentPoseField, LayerBinding, SemanticRole } from "../src/types.js";

const field: CoherentPoseField = {
  kind: "head-surfaces-v2",
  center: { x: 0.5, y: 0.3 },
  radiusX: 0.16,
  radiusY: 0.2,
  skullCenter: { x: 0.5, y: 0.24 },
  skullRadiusX: 0.25,
  skullRadiusY: 0.3,
  maxYawRadians: 0.3,
  maxPitchRadians: 0.2,
  perspective: 0.1
};

function layer(role: SemanticRole, side: "left" | "right" | "center" = "center"): LayerBinding {
  const bounds = { x: 0.35, y: 0.1, width: 0.3, height: 0.4 };
  return {
    id: `${role}-${side}`, sourceName: role, sourcePath: [role], role, side, order: 0, opacity: 1,
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
    expect(nose.x).toBeGreaterThan(point.x);
    expect(frontHair.x).toBeGreaterThan(point.x);
    expect(frontHair.x).toBeGreaterThan(backHair.x);
    expect([nose, frontHair, backHair].every((posed) => Number.isFinite(posed.x) && Number.isFinite(posed.y))).toBe(true);
  });

  it("lets the top of the neck follow while keeping the collar edge pinned", () => {
    const neck = layer("neck");
    const top = { x: 0.5, y: neck.bounds.y };
    const bottom = { x: 0.5, y: neck.bounds.y + neck.bounds.height };
    const posedTop = applyCoherentPoseField(field, neck, top, 0.6, 0.45);
    const posedBottom = applyCoherentPoseField(field, neck, bottom, 0.6, 0.45);
    expect(Math.hypot(posedTop.x - top.x, posedTop.y - top.y)).toBeGreaterThan(0);
    expect(posedBottom).toEqual(bottom);
  });

  it("widens the near eye and narrows the far eye during a turn", () => {
    const nearEye = layer("eyelash", "left");
    const farEye = layer("eyelash", "right");
    const widthAfter = (target: LayerBinding) => {
      const left = { x: target.bounds.x, y: target.pivot.y };
      const right = { x: target.bounds.x + target.bounds.width, y: target.pivot.y };
      const posedLeft = applyCoherentPoseField(field, target, left, 0.75, 0);
      const posedRight = applyCoherentPoseField(field, target, right, 0.75, 0);
      return posedRight.x - posedLeft.x;
    };
    expect(widthAfter(nearEye)).toBeGreaterThan(widthAfter(farEye));
  });

  it("bends the hair contour on the skull surface instead of translating it rigidly", () => {
    const hair = layer("frontHair");
    const left = { x: 0.36, y: 0.22 };
    const right = { x: 0.64, y: 0.22 };
    const posedLeft = applyCoherentPoseField(field, hair, left, 0.8, 0.15);
    const posedRight = applyCoherentPoseField(field, hair, right, 0.8, 0.15);
    expect(posedRight.x - posedLeft.x).not.toBeCloseTo(right.x - left.x, 4);
    expect(posedLeft.y).not.toBeCloseTo(left.y, 4);
  });

  it("pulls the far cheek inward and carries the lower face into the turn", () => {
    const face = layer("face");
    const leftCheek = { x: 0.36, y: 0.4 };
    const rightCheek = { x: 0.64, y: 0.4 };
    const chin = { x: 0.5, y: 0.49 };
    const posedLeft = applyCoherentPoseField(field, face, leftCheek, 0.8, 0);
    const posedRight = applyCoherentPoseField(field, face, rightCheek, 0.8, 0);
    const posedChin = applyCoherentPoseField(field, face, chin, 0.8, 0);
    expect(posedLeft.x - leftCheek.x).toBeGreaterThan(posedRight.x - rightCheek.x);
    expect(posedRight.x - posedLeft.x).toBeLessThan(rightCheek.x - leftCheek.x);
    expect(posedChin.x).toBeGreaterThan(chin.x);
  });
});
