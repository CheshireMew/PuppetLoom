import { describe, expect, it } from "vitest";
import { makeGridMesh } from "../src/rig.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import {
  ensurePoseCorrectionBinding,
  poseCorrectionBindingId,
  poseCorrectionPointDeltas,
  poseCorrectionSamples,
  reprojectLayerPoseCorrections,
  setPoseCorrectionPointDeltas
} from "../src/pose-corrections.js";

describe("nine-pose mesh corrections", () => {
  it("creates one complete canonical yaw/pitch grid without duplicating it", () => {
    const model = ensurePoseCorrectionBinding(createDefaultAuthoringModel(), "front-hair");
    const ensuredAgain = ensurePoseCorrectionBinding(model, "front-hair");
    const bindings = ensuredAgain.bindings.filter((binding) => binding.id === poseCorrectionBindingId("front-hair"));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.parameterIds).toEqual(["param-head-yaw", "param-head-pitch"]);
    expect(bindings[0]?.keyforms.map((keyform) => keyform.values)).toEqual([
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1], [0, 0], [0, 1],
      [1, -1], [1, 0], [1, 1]
    ]);
  });

  it("replaces only the requested canonical sample and removes zero-only edits", () => {
    const first = setPoseCorrectionPointDeltas(createDefaultAuthoringModel(), "front-hair", 0.82, -0.91, {
      "2": { x: 0.012, y: -0.004 },
      "5": { x: 0, y: 0 }
    });
    expect(poseCorrectionPointDeltas(first, "front-hair", 1, -1)).toEqual({ "2": { x: 0.012, y: -0.004 } });
    expect(poseCorrectionPointDeltas(first, "front-hair", -1, -1)).toEqual({});

    const cleared = setPoseCorrectionPointDeltas(first, "front-hair", 1, -1, { "2": { x: 0, y: 0 } });
    expect(poseCorrectionPointDeltas(cleared, "front-hair", 1, -1)).toEqual({});
    expect(poseCorrectionSamples(cleared, "front-hair")).toHaveLength(9);
  });

  it("carries every authored pose correction onto a replacement mesh by UV", () => {
    const source = makeGridMesh({ x: 0, y: 0, width: 1, height: 1 }, 2, 2);
    const target = makeGridMesh({ x: 0, y: 0, width: 1, height: 1 }, 3, 3);
    let model = setPoseCorrectionPointDeltas(createDefaultAuthoringModel(), "front-hair", -1, 0, {
      "0": { x: 0.12, y: -0.04 },
      "1": { x: 0.06, y: -0.02 }
    });
    model = setPoseCorrectionPointDeltas(model, "front-hair", 1, 1, {
      "3": { x: -0.08, y: 0.03 }
    });

    const projected = reprojectLayerPoseCorrections(model, "front-hair", source, target);
    const left = poseCorrectionPointDeltas(projected, "front-hair", -1, 0);
    const corner = poseCorrectionPointDeltas(projected, "front-hair", 1, 1);
    expect(left["0"]).toEqual({ x: 0.12, y: -0.04 });
    expect(left["1"]).toEqual({ x: 0.09, y: -0.03 });
    expect(corner["8"]).toEqual({ x: -0.08, y: 0.03 });
    expect(poseCorrectionSamples(projected, "front-hair").filter((sample) => sample.pointCount > 0)).toHaveLength(2);
  });
});
