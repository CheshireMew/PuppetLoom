import { describe, expect, it } from "vitest";
import { deformPoint, invertDeformedPoint, neutralMotionState, torsoVolumeAt } from "../src/deform.js";
import { makeGridMesh } from "../src/rig.js";
import type { LayerBinding, PuppetLoomProject, SemanticRole } from "../src/types.js";

const project = {
  anchors: {},
  runtime: {
    envelope: {
      headYaw: 0,
      headPitch: 0,
      headRollDegrees: 0,
      bodySway: 0,
      bodyRollDegrees: 0,
      gazeX: 0,
      gazeY: 0,
      breath: 0,
      globalScale: 1
    }
  }
} as PuppetLoomProject;

function eyeLayer(role: SemanticRole): LayerBinding {
  const bounds = { x: 0.4, y: 0.2, width: 0.1, height: 0.06 };
  return {
    id: role,
    sourceName: role,
    sourcePath: [role],
    role,
    side: "left",
    order: 0,
    opacity: 1,
    blendMode: "normal",
    bounds,
    texture: `${role}.png`,
    pivot: { x: 0.45, y: 0.23 },
    mesh: makeGridMesh(bounds, 4, 4),
    weights: { head: 0, body: 0, gaze: 0, physics: 0 },
    parentGroup: "head"
  };
}

function secondaryLayer(role: SemanticRole, bounds = { x: 0.35, y: 0.15, width: 0.3, height: 0.35 }): LayerBinding {
  const layer: LayerBinding = {
    ...eyeLayer(role),
    bounds,
    pivot: { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.1 },
    mesh: makeGridMesh(bounds, 10, 10),
    weights: { head: 0, body: 0, gaze: 0, physics: 1 }
  };
  if (role === "frontHair") {
    layer.secondaryAnchors = {
      ahogeRoot: { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.24 },
      frontHairRoot: { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.54 },
      frontHairRootLeft: { x: bounds.x + bounds.width * 0.18, y: bounds.y + bounds.height * 0.5 },
      frontHairRootRight: { x: bounds.x + bounds.width * 0.82, y: bounds.y + bounds.height * 0.5 },
      frontHairTipLeft: { x: bounds.x + bounds.width * 0.1, y: bounds.y + bounds.height },
      frontHairTipRight: { x: bounds.x + bounds.width * 0.9, y: bounds.y + bounds.height }
    };
    layer.pivot = layer.secondaryAnchors.frontHairRoot;
  }
  return layer;
}

function movement(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

describe("posed mesh editing", () => {
  it("maps a dragged on-canvas point back to authoring space without a visible jump", () => {
    const layer = secondaryLayer("frontHair");
    const vertexIndex = 4;
    const authored = { x: layer.bounds.x + layer.bounds.width * 0.47, y: layer.bounds.y + layer.bounds.height * 0.91 };
    const state = { ...neutralMotionState, hairX: 0.045, hairY: 0.018, ahogeX: -0.02 };
    const displayed = deformPoint(project, layer, authored, state, vertexIndex);
    const target = { x: displayed.x + 0.013, y: displayed.y - 0.009 };
    const recovered = invertDeformedPoint(project, layer, target, state, vertexIndex, authored);
    const renderedAgain = deformPoint(project, layer, recovered, state, vertexIndex);
    expect(renderedAgain.x).toBeCloseTo(target.x, 7);
    expect(renderedAgain.y).toBeCloseTo(target.y, 7);
  });
});

describe("blink deformation", () => {
  it("briefly closes the height of open eye artwork around its own center", () => {
    const layer = eyeLayer("eyelash");
    const top = { x: 0.45, y: 0.2 };
    const closed = deformPoint(project, layer, top, { ...neutralMotionState, blink: 1 });
    expect(closed.y).toBeGreaterThan(top.y);
    expect(Math.abs(closed.y - layer.pivot.y)).toBeLessThan(Math.abs(top.y - layer.pivot.y) * 0.3);
  });

  it("does not compress the generated closed-eyelid artwork", () => {
    const layer = eyeLayer("eyeClosed");
    const point = { x: 0.45, y: 0.2 };
    expect(deformPoint(project, layer, point, { ...neutralMotionState, blink: 1 })).toEqual(point);
  });
});

describe("secondary motion anchoring", () => {
  it("pins the ahoge root while moving its tip independently from the bangs", () => {
    const layer = secondaryLayer("frontHair");
    const tip = { x: layer.bounds.x + layer.bounds.width * 0.5, y: layer.bounds.y };
    const root = layer.secondaryAnchors!.ahogeRoot!;
    const state = { ...neutralMotionState, ahogeX: 0.05 };
    expect(movement(tip, deformPoint(project, layer, tip, state))).toBeGreaterThan(movement(root, deformPoint(project, layer, root, state)) * 5);
  });

  it("rotates every ahoge point by one rigid angle around the detected root", () => {
    const layer = secondaryLayer("frontHair");
    const root = layer.secondaryAnchors!.ahogeRoot!;
    const inner = { x: root.x - layer.bounds.width * 0.04, y: root.y - layer.bounds.height * 0.08 };
    const tip = { x: root.x - layer.bounds.width * 0.12, y: root.y - layer.bounds.height * 0.2 };
    const state = { ...neutralMotionState, ahogeX: 0.05, ahogeY: -0.012 };
    const movedInner = deformPoint(project, layer, inner, state);
    const movedTip = deformPoint(project, layer, tip, state);
    const angleChange = (before: typeof inner, after: typeof inner) => Math.atan2(after.y - root.y, after.x - root.x) - Math.atan2(before.y - root.y, before.x - root.x);
    expect(deformPoint(project, layer, root, state)).toEqual(root);
    expect(Math.hypot(movedInner.x - root.x, movedInner.y - root.y)).toBeCloseTo(Math.hypot(inner.x - root.x, inner.y - root.y), 10);
    expect(Math.hypot(movedTip.x - root.x, movedTip.y - root.y)).toBeCloseTo(Math.hypot(tip.x - root.x, tip.y - root.y), 10);
    expect(angleChange(inner, movedInner)).toBeCloseTo(angleChange(tip, movedTip), 10);
  });

  it("does not classify lateral crown vertices above the ahoge root as ahoge", () => {
    const layer = secondaryLayer("frontHair");
    const root = layer.secondaryAnchors!.ahogeRoot!;
    const crown = {
      x: root.x + layer.bounds.width * 0.31,
      y: root.y - layer.bounds.height * 0.1
    };
    const moved = deformPoint(project, layer, crown, { ...neutralMotionState, ahogeX: 0.08, ahogeY: -0.04 });
    expect(moved).toEqual(crown);
  });

  it("bends each face-framing strand around its own root without changing its radial length", () => {
    const layer = secondaryLayer("frontHair");
    const leftRoot = layer.secondaryAnchors!.frontHairRootLeft!;
    const rightRoot = layer.secondaryAnchors!.frontHairRootRight!;
    const leftTip = layer.secondaryAnchors!.frontHairTipLeft!;
    const rightTip = layer.secondaryAnchors!.frontHairTipRight!;
    const state = { ...neutralMotionState, hairX: 0.05 };
    const movedLeft = deformPoint(project, layer, leftTip, state);
    const movedRight = deformPoint(project, layer, rightTip, state);
    expect(Math.hypot(movedLeft.x - leftRoot.x, movedLeft.y - leftRoot.y)).toBeCloseTo(Math.hypot(leftTip.x - leftRoot.x, leftTip.y - leftRoot.y), 10);
    expect(Math.hypot(movedRight.x - rightRoot.x, movedRight.y - rightRoot.y)).toBeCloseTo(Math.hypot(rightTip.x - rightRoot.x, rightTip.y - rightRoot.y), 10);
  });

  it("keeps the scalp between the ahoge and bangs rigid while both free ends move", () => {
    const layer = secondaryLayer("frontHair");
    const scalp = { x: layer.pivot.x, y: layer.bounds.y + layer.bounds.height * 0.4 };
    const bangTip = { x: layer.bounds.x + layer.bounds.width * 0.25, y: layer.bounds.y + layer.bounds.height };
    const ahogeTip = { x: layer.pivot.x, y: layer.bounds.y };
    const state = { ...neutralMotionState, hairX: 0.05, hairY: 0.03, ahogeX: -0.06, ahogeY: 0.04 };
    expect(deformPoint(project, layer, scalp, state)).toEqual(scalp);
    expect(movement(bangTip, deformPoint(project, layer, bangTip, state))).toBeGreaterThan(0.005);
    expect(movement(ahogeTip, deformPoint(project, layer, ahogeTip, state))).toBeGreaterThan(0.005);
  });

  it("pins the skirt waist and moves only the lower hem", () => {
    const layer = secondaryLayer("bottomWear");
    const waist = { x: layer.bounds.x + layer.bounds.width * 0.5, y: layer.bounds.y };
    const hem = { x: layer.bounds.x + layer.bounds.width * 0.5, y: layer.bounds.y + layer.bounds.height };
    const state = { ...neutralMotionState, clothX: 0.05 };
    const movedHem = deformPoint(project, layer, hem, state);
    expect(movement(waist, deformPoint(project, layer, waist, state))).toBeLessThan(1e-8);
    expect(Math.abs(movedHem.x - hem.x)).toBeGreaterThan(0.02);
    expect(Math.abs(movedHem.x - hem.x)).toBeGreaterThan(Math.abs(movedHem.y - hem.y) * 4);
  });

  it("moves a supported bell skirt as one shell without collapsing its span", () => {
    const layer = secondaryLayer("bottomWear");
    layer.garmentStructure = "supported";
    const waist = { x: layer.pivot.x, y: layer.bounds.y + layer.bounds.height * 0.18 };
    const leftHem = { x: layer.bounds.x + layer.bounds.width * 0.12, y: layer.bounds.y + layer.bounds.height * 0.92 };
    const rightHem = { x: layer.bounds.x + layer.bounds.width * 0.88, y: layer.bounds.y + layer.bounds.height * 0.92 };
    const state = { ...neutralMotionState, clothX: 0.05 };
    const movedLeft = deformPoint(project, layer, leftHem, state);
    const movedRight = deformPoint(project, layer, rightHem, state);
    const originalSpan = Math.hypot(rightHem.x - leftHem.x, rightHem.y - leftHem.y);
    const movedSpan = Math.hypot(movedRight.x - movedLeft.x, movedRight.y - movedLeft.y);

    expect(deformPoint(project, layer, waist, state)).toEqual(waist);
    expect(movement(leftHem, movedLeft)).toBeGreaterThan(0.02);
    expect(movedSpan).toBeCloseTo(originalSpan, 10);
  });

  it("lets a supported skirt yield slightly below the waist without becoming soft cloth", () => {
    const layer = secondaryLayer("bottomWear");
    layer.garmentStructure = "supported";
    layer.garmentFlexibility = 0.2;
    const pivot = { ...layer.pivot };
    const upperShell = { x: layer.bounds.x + layer.bounds.width * 0.22, y: layer.bounds.y + layer.bounds.height * 0.54 };
    const lowerShell = { x: layer.bounds.x + layer.bounds.width * 0.22, y: layer.bounds.y + layer.bounds.height * 0.92 };
    const state = { ...neutralMotionState, clothX: 0.05 };
    const movedUpper = deformPoint(project, layer, upperShell, state);
    const movedLower = deformPoint(project, layer, lowerShell, state);
    const angularChange = (before: typeof upperShell, after: typeof upperShell) =>
      Math.atan2(after.y - pivot.y, after.x - pivot.x) - Math.atan2(before.y - pivot.y, before.x - pivot.x);
    const differential = Math.abs(angularChange(lowerShell, movedLower) - angularChange(upperShell, movedUpper));

    expect(differential).toBeGreaterThan(0.0005);
    expect(differential).toBeLessThan(0.025);
    expect(Math.hypot(movedLower.x - pivot.x, movedLower.y - pivot.y)).toBeCloseTo(
      Math.hypot(lowerShell.x - pivot.x, lowerShell.y - pivot.y),
      10
    );
  });

  it("locks both sides of the clothing seam while allowing fabric away from the waist to move", () => {
    const top = secondaryLayer("topWear", { x: 0.42, y: 0.3, width: 0.16, height: 0.2 });
    const skirt = secondaryLayer("bottomWear", { x: 0.35, y: 0.5, width: 0.3, height: 0.3 });
    const seam = { x: 0.5, y: 0.5 };
    const bodiceMiddle = { x: 0.46, y: 0.4 };
    const hem = { x: 0.46, y: 0.8 };
    const state = { ...neutralMotionState, clothX: 0.06, clothY: 0.02 };
    expect(deformPoint(project, top, seam, state)).toEqual(seam);
    expect(deformPoint(project, skirt, seam, state)).toEqual(seam);
    expect(movement(bodiceMiddle, deformPoint(project, top, bodiceMiddle, state))).toBeGreaterThan(0.001);
    expect(movement(hem, deformPoint(project, skirt, hem, state))).toBeGreaterThan(0.01);
  });

  it("pins the tail root and moves its far end mainly up and down", () => {
    const layer = secondaryLayer("tail");
    const root = { x: layer.bounds.x + layer.bounds.width * 0.03, y: layer.bounds.y + layer.bounds.height * 0.08 };
    const tip = { x: layer.bounds.x + layer.bounds.width, y: layer.bounds.y + layer.bounds.height * 0.55 };
    const state = { ...neutralMotionState, tailY: 0.05 };
    const movedTip = deformPoint(project, layer, tip, state);
    expect(movement(root, deformPoint(project, layer, root, state))).toBeLessThan(1e-8);
    expect(Math.abs(movedTip.y - tip.y)).toBeGreaterThan(0.02);
    expect(Math.abs(movedTip.x - tip.x)).toBeGreaterThan(0.01);
    expect(Math.hypot(movedTip.x - layer.pivot.x, movedTip.y - layer.pivot.y)).toBeCloseTo(
      Math.hypot(tip.x - layer.pivot.x, tip.y - layer.pivot.y),
      8
    );
  });

  it("pins merged ears at two face-side hinges and flaps both tips vertically", () => {
    const layer = secondaryLayer("headwear");
    layer.pivot = { x: layer.bounds.x + layer.bounds.width * 0.5, y: layer.bounds.y + layer.bounds.height * 0.5 };
    layer.secondaryAnchors = {
      earHingeLeft: { x: layer.bounds.x + layer.bounds.width * 0.29, y: layer.bounds.y + layer.bounds.height * 0.72 },
      earHingeRight: { x: layer.bounds.x + layer.bounds.width * 0.71, y: layer.bounds.y + layer.bounds.height * 0.72 }
    };
    const bandCenter = { ...layer.pivot };
    const leftTip = { x: layer.bounds.x, y: layer.bounds.y + layer.bounds.height * 0.9 };
    const rightTip = { x: layer.bounds.x + layer.bounds.width, y: layer.bounds.y + layer.bounds.height * 0.9 };
    const state = { ...neutralMotionState, earY: 0.05 };
    expect(movement(bandCenter, deformPoint(project, layer, bandCenter, state))).toBeLessThan(1e-8);
    expect(deformPoint(project, layer, layer.secondaryAnchors.earHingeLeft, state)).toEqual(layer.secondaryAnchors.earHingeLeft);
    expect(deformPoint(project, layer, layer.secondaryAnchors.earHingeRight, state)).toEqual(layer.secondaryAnchors.earHingeRight);
    const movedLeft = deformPoint(project, layer, leftTip, state);
    const movedRight = deformPoint(project, layer, rightTip, state);
    expect(movedLeft.y).toBeGreaterThan(leftTip.y + 0.005);
    expect(movedRight.y).toBeGreaterThan(rightTip.y + 0.005);
  });

  it("does not apply ear parameters to headwear when separate ear layers exist", () => {
    const headwear = secondaryLayer("headwear");
    const ear = secondaryLayer("ear", { x: 0.62, y: 0.24, width: 0.12, height: 0.08 });
    const splitProject = { ...project, layers: [headwear, ear] } as PuppetLoomProject;
    const point = { x: headwear.bounds.x + headwear.bounds.width, y: headwear.bounds.y + headwear.bounds.height };
    const state = { ...neutralMotionState, earX: 0.05, earY: 0.05 };

    expect(deformPoint(splitProject, headwear, point, state)).toEqual(point);
    expect(movement(point, deformPoint(splitProject, ear, point, state))).toBeGreaterThan(0);
  });

  it("can bend front and back hair in opposite directions around fixed roots", () => {
    const front = secondaryLayer("frontHair");
    const back = secondaryLayer("backHair");
    const frontTip = { x: front.pivot.x, y: front.bounds.y + front.bounds.height };
    const backTip = { x: back.pivot.x, y: back.bounds.y + back.bounds.height };
    const state = { ...neutralMotionState, hairX: 0.04, backHairX: -0.04 };
    const movedFront = deformPoint(project, front, frontTip, state);
    const movedBack = deformPoint(project, back, backTip, state);
    expect(Math.sign(movedFront.x - frontTip.x)).toBe(-Math.sign(movedBack.x - backTip.x));
    expect(deformPoint(project, front, front.pivot, state)).toEqual(front.pivot);
    expect(deformPoint(project, back, back.pivot, state)).toEqual(back.pivot);
  });

  it("uses separate multi-stage motion for the left and right hair tips", () => {
    const layer = secondaryLayer("frontHair");
    const root = layer.secondaryAnchors!.frontHairRoot!;
    const leftTip = { x: layer.bounds.x + layer.bounds.width * 0.15, y: layer.bounds.y + layer.bounds.height };
    const rightTip = { x: layer.bounds.x + layer.bounds.width * 0.85, y: layer.bounds.y + layer.bounds.height };
    const state = {
      ...neutralMotionState,
      secondary: {
        frontHairLeft: { x: [0.004, 0.012, 0.024, 0.04], y: [0, 0.002, 0.004, 0.006] },
        frontHairRight: { x: [-0.003, -0.009, -0.018, -0.03], y: [0, -0.001, -0.003, -0.005] },
        backHairLeft: { x: [0, 0, 0, 0, 0], y: [0, 0, 0, 0, 0] },
        backHairRight: { x: [0, 0, 0, 0, 0], y: [0, 0, 0, 0, 0] },
        ahoge: { x: [0, 0, 0, 0, 0], y: [0, 0, 0, 0, 0] },
        headwear: { x: [0, 0, 0], y: [0, 0, 0] },
        topCloth: { x: [0, 0, 0], y: [0, 0, 0] },
        skirt: { x: [0, 0, 0, 0], y: [0, 0, 0, 0] },
        tail: { x: [0, 0, 0, 0, 0], y: [0, 0, 0, 0, 0] },
        accessory: { x: [0, 0, 0, 0], y: [0, 0, 0, 0] }
      }
    };
    const movedLeft = deformPoint(project, layer, leftTip, state);
    const movedRight = deformPoint(project, layer, rightTip, state);
    expect(deformPoint(project, layer, root, state)).toEqual(root);
    expect(Math.sign(movedLeft.x - leftTip.x)).toBe(-Math.sign(movedRight.x - rightTip.x));
    expect(movement(leftTip, movedLeft)).toBeGreaterThan(movement(root, deformPoint(project, layer, root, state)) + 0.003);
  });

  it("keeps both side-lock roots pinned while their tips move freely", () => {
    const layer = secondaryLayer("frontHair");
    const leftRoot = layer.secondaryAnchors!.frontHairRootLeft!;
    const rightRoot = layer.secondaryAnchors!.frontHairRootRight!;
    const leftTip = layer.secondaryAnchors!.frontHairTipLeft!;
    const rightTip = layer.secondaryAnchors!.frontHairTipRight!;
    const state = { ...neutralMotionState, hairX: 0.05, hairY: 0.025 };
    expect(movement(leftRoot, deformPoint(project, layer, leftRoot, state))).toBeLessThan(1e-8);
    expect(movement(rightRoot, deformPoint(project, layer, rightRoot, state))).toBeLessThan(1e-8);
    expect(movement(leftTip, deformPoint(project, layer, leftTip, state))).toBeGreaterThan(0.006);
    expect(movement(rightTip, deformPoint(project, layer, rightTip, state))).toBeGreaterThan(0.006);
  });
});

describe("connected head and upper-body motion", () => {
  const connectedProject = {
    anchors: {
      chin: { x: 0.5, y: 0.28 },
      neck: { x: 0.5, y: 0.33 },
      bodyCenter: { x: 0.5, y: 0.56 },
      cheekLeft: { x: 0.58, y: 0.22 },
      cheekRight: { x: 0.42, y: 0.22 },
      forehead: { x: 0.5, y: 0.11 }
    },
    runtime: {
      envelope: {
        headYaw: 0.84,
        headPitch: 0.64,
        headRollDegrees: 3.2,
        bodySway: 0.012,
        bodyRollDegrees: 2.2,
        gazeX: 0.16,
        gazeY: 0.1,
        breath: 0.004,
        globalScale: 1
      },
      poseField: {
        kind: "head-surfaces-v2",
        center: { x: 0.5, y: 0.2 },
        radiusX: 0.14,
        radiusY: 0.16,
        skullCenter: { x: 0.5, y: 0.17 },
        skullRadiusX: 0.22,
        skullRadiusY: 0.24,
        maxYawRadians: 0.3,
        maxPitchRadians: 0.2,
        perspective: 0.1
      }
    }
  } as PuppetLoomProject;

  it("applies an optional semantic torso volume curve only while the body turns", () => {
    const profile = {
      kind: "torso-volume-v1" as const,
      strength: 1,
      points: [
        { id: "upperChest" as const, position: 0.08, depth: 0.02 },
        { id: "chest" as const, position: 0.3, depth: 0.1 },
        { id: "waist" as const, position: 0.62, depth: -0.03 },
        { id: "hip" as const, position: 0.92, depth: 0.04 }
      ]
    };
    expect(torsoVolumeAt(profile, 0.3)).toBeCloseTo(0.1, 8);
    const volumeProject = { ...connectedProject, runtime: { ...connectedProject.runtime, torsoVolumeProfile: profile } } as PuppetLoomProject;
    const top = secondaryLayer("topWear", { x: 0.4, y: 0.34, width: 0.2, height: 0.28 });
    top.weights = { head: 0, body: 1, gaze: 0, physics: 0 };
    const point = { x: 0.5, y: 0.42 };
    const neutral = deformPoint(volumeProject, top, point, neutralMotionState);
    expect(neutral).toEqual(deformPoint(connectedProject, top, point, neutralMotionState));
    const state = { ...neutralMotionState, bodySway: 0.7 };
    expect(Math.abs(deformPoint(volumeProject, top, point, state).x - deformPoint(connectedProject, top, point, state).x)).toBeGreaterThan(0.0001);
  });

  it("keeps the neck connected between the moving head and the upper body", () => {
    const face = secondaryLayer("face", { x: 0.4, y: 0.1, width: 0.2, height: 0.2 });
    face.weights = { head: 1, body: 0, gaze: 0, physics: 0 };
    face.pivot = { x: 0.5, y: 0.2 };
    const neck = secondaryLayer("neck", { x: 0.47, y: 0.27, width: 0.06, height: 0.13 });
    neck.weights = { head: 1, body: 1, gaze: 0, physics: 0 };
    const state = { ...neutralMotionState, headYaw: 0.85, bodySway: 0.85 * 0.62, bodyRoll: 0.85 * 0.16 };
    const faceCenter = { x: 0.5, y: 0.2 };
    const neckTop = { x: 0.5, y: 0.27 };
    const neckBottom = { x: 0.5, y: 0.4 };
    const faceShift = deformPoint(connectedProject, face, faceCenter, state).x - faceCenter.x;
    const topShift = deformPoint(connectedProject, neck, neckTop, state).x - neckTop.x;
    const bottomShift = deformPoint(connectedProject, neck, neckBottom, state).x - neckBottom.x;
    expect(Math.sign(topShift)).toBe(Math.sign(faceShift));
    expect(Math.sign(bottomShift)).toBe(Math.sign(faceShift));
    expect(Math.abs(bottomShift)).toBeGreaterThan(0.003);
    expect(Math.abs(topShift)).toBeGreaterThan(Math.abs(bottomShift));
    expect(Math.abs(faceShift - topShift)).toBeLessThan(0.02);
  });

  it("pitches the face and connected neck without leaving the upper body behind", () => {
    const face = secondaryLayer("face", { x: 0.4, y: 0.1, width: 0.2, height: 0.2 });
    face.weights = { head: 1, body: 0, gaze: 0, physics: 0 };
    face.pivot = { x: 0.5, y: 0.2 };
    const neck = secondaryLayer("neck", { x: 0.47, y: 0.27, width: 0.06, height: 0.13 });
    neck.weights = { head: 1, body: 1, gaze: 0, physics: 0 };
    const faceCenter = { x: 0.5, y: 0.2 };
    const faceEdge = { x: 0.41, y: 0.2 };
    const neckTop = { x: 0.5, y: 0.27 };
    const neckBottom = { x: 0.5, y: 0.4 };
    const up = { ...neutralMotionState, headPitch: -0.72, bodyPitch: -0.72 * 0.46 };
    const down = { ...neutralMotionState, headPitch: 0.72, bodyPitch: 0.72 * 0.46 };
    const faceUp = deformPoint(connectedProject, face, faceCenter, up);
    const faceDown = deformPoint(connectedProject, face, faceCenter, down);
    const edgeUp = deformPoint(connectedProject, face, faceEdge, up);
    const edgeDown = deformPoint(connectedProject, face, faceEdge, down);
    const neckTopUp = deformPoint(connectedProject, neck, neckTop, up);
    const neckTopDown = deformPoint(connectedProject, neck, neckTop, down);
    const neckBottomUp = deformPoint(connectedProject, neck, neckBottom, up);
    const neckBottomDown = deformPoint(connectedProject, neck, neckBottom, down);
    expect(faceDown.y - faceUp.y).toBeGreaterThan(0.015);
    expect(faceDown.y - faceUp.y).toBeGreaterThan((edgeDown.y - edgeUp.y) * 1.2);
    expect(neckTopDown.y - neckTopUp.y).toBeGreaterThan(0.01);
    expect(neckBottomDown.y - neckBottomUp.y).toBeGreaterThan(0.001);
    expect(neckBottomDown.y - neckBottomUp.y).toBeLessThan(neckTopDown.y - neckTopUp.y);
  });

  it("turns the upper body while keeping the feet planted", () => {
    const top = secondaryLayer("topWear", { x: 0.42, y: 0.38, width: 0.16, height: 0.2 });
    top.weights = { head: 0, body: 1, gaze: 0, physics: 0 };
    const foot = secondaryLayer("foot", { x: 0.45, y: 0.9, width: 0.1, height: 0.06 });
    foot.weights = { head: 0, body: 1, gaze: 0, physics: 0 };
    const state = { ...neutralMotionState, bodySway: 0.4, bodyRoll: 0.12 };
    const topPoint = { x: 0.44, y: 0.4 };
    const footPoint = { x: 0.47, y: 0.93 };
    expect(movement(topPoint, deformPoint(connectedProject, top, topPoint, state))).toBeGreaterThan(0.001);
    expect(deformPoint(connectedProject, foot, footPoint, state)).toEqual(footPoint);
  });

  it("moves the bodice and skirt as one garment at their shared waistline", () => {
    const top = secondaryLayer("topWear", { x: 0.42, y: 0.38, width: 0.16, height: 0.2 });
    const skirt = secondaryLayer("bottomWear", { x: 0.35, y: 0.58, width: 0.3, height: 0.3 });
    top.weights = { head: 0, body: 1, gaze: 0, physics: 0 };
    skirt.weights = { head: 0, body: 1, gaze: 0, physics: 0 };
    const seam = { x: 0.5, y: 0.58 };
    const state = { ...neutralMotionState, bodySway: 0.65, bodyPitch: 0.18, bodyRoll: 0.08 };
    const topSeam = deformPoint(connectedProject, top, seam, state);
    const skirtSeam = deformPoint(connectedProject, skirt, seam, state);
    expect(topSeam.x).toBeCloseTo(skirtSeam.x, 10);
    expect(topSeam.y).toBeCloseTo(skirtSeam.y, 10);
  });
});
