import { describe, expect, it } from "vitest";
import { deformPoint, neutralMotionState } from "../src/deform.js";
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
  return {
    ...eyeLayer(role),
    bounds,
    pivot: { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.1 },
    mesh: makeGridMesh(bounds, 10, 10),
    weights: { head: 0, body: 0, gaze: 0, physics: 1 }
  };
}

function movement(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

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
    const root = { x: layer.bounds.x + layer.bounds.width * 0.5, y: layer.bounds.y + layer.bounds.height * 0.38 };
    const state = { ...neutralMotionState, ahogeX: 0.05 };
    expect(movement(tip, deformPoint(project, layer, tip, state))).toBeGreaterThan(movement(root, deformPoint(project, layer, root, state)) * 5);
  });

  it("pins the skirt waist and moves only the lower hem", () => {
    const layer = secondaryLayer("bottomWear");
    const waist = { x: layer.bounds.x + layer.bounds.width * 0.5, y: layer.bounds.y };
    const hem = { x: layer.bounds.x + layer.bounds.width * 0.5, y: layer.bounds.y + layer.bounds.height };
    const state = { ...neutralMotionState, clothX: 0.05 };
    expect(movement(waist, deformPoint(project, layer, waist, state))).toBeLessThan(1e-8);
    expect(movement(hem, deformPoint(project, layer, hem, state))).toBeGreaterThan(0.001);
  });

  it("pins the tail root and gradually releases its far end", () => {
    const layer = secondaryLayer("tail");
    const root = { x: layer.bounds.x + layer.bounds.width * 0.03, y: layer.bounds.y + layer.bounds.height * 0.08 };
    const tip = { x: layer.bounds.x + layer.bounds.width, y: layer.bounds.y + layer.bounds.height * 0.55 };
    const state = { ...neutralMotionState, tailX: 0.05 };
    expect(movement(root, deformPoint(project, layer, root, state))).toBeLessThan(1e-8);
    expect(movement(tip, deformPoint(project, layer, tip, state))).toBeGreaterThan(0.001);
  });

  it("keeps the maid band centered while the merged ears bob vertically", () => {
    const layer = secondaryLayer("headwear");
    layer.pivot = { x: layer.bounds.x + layer.bounds.width * 0.5, y: layer.bounds.y + layer.bounds.height * 0.5 };
    const bandCenter = { ...layer.pivot };
    const earTip = { x: layer.bounds.x, y: layer.bounds.y + layer.bounds.height };
    const state = { ...neutralMotionState, earY: 0.05 };
    expect(movement(bandCenter, deformPoint(project, layer, bandCenter, state))).toBeLessThan(1e-8);
    const movedTip = deformPoint(project, layer, earTip, state);
    expect(movedTip.y).toBeGreaterThan(earTip.y);
    expect(Math.abs(movedTip.x - earTip.x)).toBeLessThan(1e-8);
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

  it("lets the neck bridge the moving head to the delayed torso", () => {
    const face = secondaryLayer("face", { x: 0.4, y: 0.1, width: 0.2, height: 0.2 });
    face.weights = { head: 1, body: 0, gaze: 0, physics: 0 };
    face.pivot = { x: 0.5, y: 0.2 };
    const neck = secondaryLayer("neck", { x: 0.47, y: 0.27, width: 0.06, height: 0.13 });
    neck.weights = { head: 1, body: 1, gaze: 0, physics: 0 };
    const state = { ...neutralMotionState, headYaw: 0.85, bodySway: 0.425, bodyRoll: 0.1 };
    const faceCenter = { x: 0.5, y: 0.2 };
    const neckTop = { x: 0.5, y: 0.27 };
    const neckBottom = { x: 0.5, y: 0.4 };
    const faceShift = deformPoint(connectedProject, face, faceCenter, state).x - faceCenter.x;
    const topShift = deformPoint(connectedProject, neck, neckTop, state).x - neckTop.x;
    const bottomShift = deformPoint(connectedProject, neck, neckBottom, state).x - neckBottom.x;
    expect(Math.sign(topShift)).toBe(Math.sign(faceShift));
    expect(Math.abs(topShift)).toBeGreaterThan(Math.abs(bottomShift) * 3);
    expect(Math.abs(faceShift - topShift)).toBeLessThan(0.02);
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
});
