import { describe, expect, it } from "vitest";
import { applyCoherentPoseField, faceDepthAt } from "../src/pose-field.js";
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
  it("interpolates the authored semantic side-depth curve without changing neutral points", () => {
    const profiled: CoherentPoseField = {
      ...field,
      faceDepthProfile: {
        kind: "semantic-depth-v1",
        points: [
          { id: "forehead", position: 0.1, depth: 0 },
          { id: "noseRoot", position: 0.3, depth: 0.05 },
          { id: "noseTip", position: 0.5, depth: 0.2 },
          { id: "upperLip", position: 0.65, depth: 0.08 },
          { id: "lowerLip", position: 0.74, depth: 0.06 },
          { id: "chin", position: 0.92, depth: 0.02 }
        ]
      }
    };
    expect(faceDepthAt(profiled, 0.5)).toBeCloseTo(0.2, 8);
    expect(faceDepthAt(profiled, 0.4)).toBeGreaterThan(0.05);
    const face = layer("face");
    const point = { x: 0.5, y: 0.3 };
    expect(applyCoherentPoseField(profiled, face, point, 0, 0)).toEqual(point);
    expect(applyCoherentPoseField(profiled, face, point, 0.8, 0).x).toBeGreaterThan(applyCoherentPoseField(field, face, point, 0.8, 0).x);
  });

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

  it("uses surface depth for real up and down pitch instead of translating the head", () => {
    const face = layer("face");
    const nose = { x: 0.5, y: 0.3 };
    const outline = { x: 0.36, y: 0.3 };
    const upNose = applyCoherentPoseField(field, face, nose, 0, -0.9);
    const downNose = applyCoherentPoseField(field, face, nose, 0, 0.9);
    const upOutline = applyCoherentPoseField(field, face, outline, 0, -0.9);
    const downOutline = applyCoherentPoseField(field, face, outline, 0, 0.9);
    expect(upNose.y).toBeLessThan(nose.y);
    expect(downNose.y).toBeGreaterThan(nose.y);
    expect(downNose.y - upNose.y).toBeGreaterThan(downOutline.y - upOutline.y);
    expect(upNose.x).toBeCloseTo(nose.x, 6);
    expect(downNose.x).toBeCloseTo(nose.x, 6);
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

  it("widens the screen-left near eye and narrows the screen-right far eye when the nose turns right", () => {
    const screenLeftEye = layer("eyelash", "right");
    const screenRightEye = layer("eyelash", "left");
    const widthAfter = (target: LayerBinding, yaw: number) => {
      const left = { x: target.bounds.x, y: target.pivot.y };
      const right = { x: target.bounds.x + target.bounds.width, y: target.pivot.y };
      const posedLeft = applyCoherentPoseField(field, target, left, yaw, 0);
      const posedRight = applyCoherentPoseField(field, target, right, yaw, 0);
      return posedRight.x - posedLeft.x;
    };
    const neutralWidth = widthAfter(screenLeftEye, 0);
    const nearWidth = widthAfter(screenLeftEye, 0.75);
    const farWidth = widthAfter(screenRightEye, 0.75);
    expect(nearWidth).toBeGreaterThan(neutralWidth * 1.005);
    expect(farWidth).toBeLessThan(neutralWidth * 0.95);
    expect(farWidth).toBeGreaterThan(neutralWidth * 0.86);
    expect(nearWidth).toBeGreaterThan(farWidth * 1.08);
  });

  it("mirrors eye perspective when the nose turns left", () => {
    const screenRight = layer("eyelash", "left");
    const screenLeft = layer("eyelash", "right");
    const widthAfter = (target: LayerBinding) => {
      const left = { x: 0.4, y: target.pivot.y };
      const right = { x: 0.6, y: target.pivot.y };
      return applyCoherentPoseField(field, target, right, -0.85, 0).x - applyCoherentPoseField(field, target, left, -0.85, 0).x;
    };
    expect(widthAfter(screenLeft)).toBeLessThan(0.2 * 0.94);
    expect(widthAfter(screenLeft)).toBeGreaterThan(0.2 * 0.86);
    expect(widthAfter(screenRight)).toBeGreaterThan(0.2 * 1.01);
    expect(widthAfter(screenLeft)).toBeLessThan(widthAfter(screenRight) * 0.9);
  });

  it("keeps the eye line stable when yaw and pitch are combined", () => {
    const screenLeft = layer("eyelash", "right");
    const screenRight = layer("eyelash", "left");
    for (const pitch of [-0.75, 0.75]) {
      const leftCenter = applyCoherentPoseField(field, screenLeft, screenLeft.pivot, 0.85, pitch);
      const rightCenter = applyCoherentPoseField(field, screenRight, screenRight.pivot, 0.85, pitch);
      expect(Math.abs(leftCenter.y - rightCenter.y)).toBeLessThan(field.radiusY * 0.01);
    }
  });

  it("deforms the painted scalp on the skull surface without secondary drift", () => {
    const hair = layer("frontHair");
    const left = { x: 0.36, y: 0.22 };
    const right = { x: 0.64, y: 0.22 };
    const widthAt = (yaw: number) => {
      const posedLeft = applyCoherentPoseField(field, hair, left, yaw, 0.15);
      const posedRight = applyCoherentPoseField(field, hair, right, yaw, 0.15);
      return { width: posedRight.x - posedLeft.x, center: (posedRight.x + posedLeft.x) * 0.5 };
    };
    const neutral = widthAt(0);
    const rightTurn = widthAt(0.8);
    const leftTurn = widthAt(-0.8);
    expect(rightTurn.width).toBeLessThan(neutral.width);
    expect(rightTurn.width).toBeCloseTo(leftTurn.width, 8);
    expect(rightTurn.center - neutral.center).toBeCloseTo(neutral.center - leftTurn.center, 8);
  });

  it("keeps the near face-framing hair wider than the far side and mirrors the relationship", () => {
    const hair = layer("frontHair");
    const left = { x: 0.36, y: 0.38 };
    const center = { x: 0.5, y: 0.38 };
    const right = { x: 0.64, y: 0.38 };
    const spans = (yaw: number) => {
      const posedLeft = applyCoherentPoseField(field, hair, left, yaw, 0);
      const posedCenter = applyCoherentPoseField(field, hair, center, yaw, 0);
      const posedRight = applyCoherentPoseField(field, hair, right, yaw, 0);
      return { left: posedCenter.x - posedLeft.x, right: posedRight.x - posedCenter.x };
    };
    const rightTurn = spans(0.8);
    const leftTurn = spans(-0.8);
    expect(rightTurn.left).toBeGreaterThan(rightTurn.right);
    expect(leftTurn.right).toBeGreaterThan(leftTurn.left);
    expect(rightTurn.left).toBeCloseTo(leftTurn.right, 6);
    expect(rightTurn.right).toBeCloseTo(leftTurn.left, 6);
  });

  it("applies bounded up/down skull perspective to the painted scalp", () => {
    const hair = layer("frontHair");
    const top = { x: 0.5, y: 0.12 };
    const forehead = { x: 0.5, y: 0.23 };
    const crownHeight = (pitch: number) => {
      const posedTop = applyCoherentPoseField(field, hair, top, 0, pitch);
      const posedForehead = applyCoherentPoseField(field, hair, forehead, 0, pitch);
      return posedForehead.y - posedTop.y;
    };
    const neutral = crownHeight(0);
    expect(crownHeight(-0.8)).toBeLessThan(neutral);
    expect(crownHeight(0.8)).toBeGreaterThan(neutral);
    expect(crownHeight(-0.8)).toBeGreaterThan(neutral * 0.9);
    expect(crownHeight(0.8)).toBeLessThan(neutral * 1.1);
  });

  it("preserves ahoge length through combined head poses", () => {
    const hair = layer("frontHair");
    hair.secondaryAnchors = {
      ahogeRoot: { x: 0.5, y: 0.18 },
      frontHairRoot: { x: 0.5, y: 0.32 }
    };
    const root = hair.secondaryAnchors.ahogeRoot;
    const tip = { x: 0.46, y: 0.1 };
    const neutralLength = Math.hypot(tip.x - root.x, tip.y - root.y);
    for (const pose of [{ yaw: -0.85, pitch: -0.75 }, { yaw: 0.85, pitch: 0.75 }]) {
      const posedRoot = applyCoherentPoseField(field, hair, root, pose.yaw, pose.pitch);
      const posedTip = applyCoherentPoseField(field, hair, tip, pose.yaw, pose.pitch);
      expect(Math.hypot(posedTip.x - posedRoot.x, posedTip.y - posedRoot.y)).toBeCloseTo(neutralLength, 8);
    }
  });

  it("keeps the ahoge rigid with the painted scalp during primary head turns", () => {
    const hair = layer("frontHair");
    hair.secondaryAnchors = {
      ahogeRoot: { x: 0.5, y: 0.18 },
      frontHairRoot: { x: 0.5, y: 0.32 }
    };
    const root = hair.secondaryAnchors.ahogeRoot;
    const tip = { x: 0.46, y: 0.1 };
    const rootRight = applyCoherentPoseField(field, hair, root, 0.85, 0);
    const tipRight = applyCoherentPoseField(field, hair, tip, 0.85, 0);
    const rootLeft = applyCoherentPoseField(field, hair, root, -0.85, 0);
    const tipLeft = applyCoherentPoseField(field, hair, tip, -0.85, 0);

    expect(tipRight.x - rootRight.x).toBeCloseTo(tipLeft.x - rootLeft.x, 8);
    expect(tipRight.y - rootRight.y).toBeCloseTo(tipLeft.y - rootLeft.y, 8);
  });

  it("makes the near half of crown headwear larger and the far half smaller", () => {
    const headwear = layer("headwear");
    headwear.headwearPerspective = "crown";
    const y = headwear.bounds.y + headwear.bounds.height * 0.16;
    const center = { x: headwear.bounds.x + headwear.bounds.width * 0.5, y };
    const left = { x: center.x - headwear.bounds.width * 0.24, y };
    const right = { x: center.x + headwear.bounds.width * 0.24, y };
    const spans = (yaw: number) => {
      const posedLeft = applyCoherentPoseField(field, headwear, left, yaw, 0);
      const posedCenter = applyCoherentPoseField(field, headwear, center, yaw, 0);
      const posedRight = applyCoherentPoseField(field, headwear, right, yaw, 0);
      return { left: posedCenter.x - posedLeft.x, right: posedRight.x - posedCenter.x };
    };
    const noseRight = spans(0.85);
    const noseLeft = spans(-0.85);
    expect(noseRight.left).toBeGreaterThan(noseRight.right * 1.08);
    expect(noseLeft.right).toBeGreaterThan(noseLeft.left * 1.08);
  });

  it("pulls the far cheek inward and carries the lower face into the turn", () => {
    const face = layer("face");
    const leftCheek = { x: 0.36, y: 0.4 };
    const rightCheek = { x: 0.64, y: 0.4 };
    const chin = { x: 0.5, y: 0.49 };
    const posedLeft = applyCoherentPoseField(field, face, leftCheek, 0.8, 0);
    const posedRight = applyCoherentPoseField(field, face, rightCheek, 0.8, 0);
    const posedChin = applyCoherentPoseField(field, face, chin, 0.8, 0);
    expect(posedRight.x - rightCheek.x).toBeLessThan(posedLeft.x - leftCheek.x);
    expect(posedRight.x - posedLeft.x).toBeLessThan(rightCheek.x - leftCheek.x);
    expect(posedChin.x).toBeGreaterThan(chin.x);
  });
});
