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
