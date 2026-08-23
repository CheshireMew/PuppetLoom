import { describe, expect, it } from "vitest";
import { applyAuthoringOperations, authoringLayerOverrides, buildAuthoringAudit } from "../src/authoring.js";
import { applyCalibrationOverrides, mergeCalibrationOverrides } from "../src/calibration.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import type { LayerBinding, PuppetLoomProject } from "../src/types.js";

function fixture(): PuppetLoomProject {
  const layer: LayerBinding = {
    id: "face", sourceName: "face", sourcePath: ["face"], role: "face", side: "center", order: 0, opacity: 1, blendMode: "normal",
    bounds: { x: 0, y: 0, width: 1, height: 1 }, texture: "textures/face.png", pivot: { x: 0.5, y: 0.5 },
    mesh: {
      rows: 2, cols: 2,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }], triangles: [0, 1, 2, 1, 3, 2]
    },
    weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "root"
  };
  return {
    version: 3, name: "authoring", canvas: { width: 100, height: 100 },
    source: { originalFileName: "fixture.psd", psdSha256: "0".repeat(64), psdPath: "source/fixture.psd" },
    rigLevel: "minimal", layers: [layer], model: createDefaultAuthoringModel(), anchors: {},
    runtime: {
      seed: 1, profile: "calm-v1",
      envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, gazeX: 0, gazeY: 0, breath: 0, globalScale: 1 },
      features: { headTurn: false, bodyFollow: false, gaze: false, hairPhysics: false, blink: false, mouthMotion: false }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: []
  };
}

describe("authoring operations", () => {
  it("builds parameters, deformers, attachments and bindings as one validated graph", () => {
    const before = fixture();
    const after = applyAuthoringOperations(before, [
      { op: "upsert-parameter", parameter: { id: "smile", name: "Smile", group: "Expression", kind: "continuous", min: 0, default: 0, max: 1 } },
      { op: "upsert-deformer", deformer: { id: "face-warp", name: "Face Warp", kind: "warp", bounds: { x: 0, y: 0, width: 1, height: 1 }, rows: 2, cols: 2, controlPoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] } },
      { op: "set-layer-deformer", layerId: "face", deformerId: "face-warp" },
      { op: "upsert-binding", binding: { id: "smile-face", parameterIds: ["smile"], target: { kind: "layer", id: "face" }, keyforms: [{ values: [0] }, { values: [1], meshPointDeltas: { "2": { x: 0.03, y: -0.02 } } }] } }
    ]);
    expect(after.model.parameters.some((parameter) => parameter.id === "smile")).toBe(true);
    expect(after.layers[0]!.deformerId).toBe("face-warp");
    expect(after.model.bindings[0]!.id).toBe("smile-face");
    expect(before.layers[0]!.deformerId).toBeUndefined();
  });

  it("requires explicit cascading before removing referenced graph nodes", () => {
    const built = applyAuthoringOperations(fixture(), [
      { op: "upsert-parameter", parameter: { id: "custom", name: "Custom", group: "Custom", kind: "continuous", min: 0, default: 0, max: 1 } },
      { op: "upsert-binding", binding: { id: "custom-face", parameterIds: ["custom"], target: { kind: "layer", id: "face" }, keyforms: [{ values: [0] }, { values: [1] }] } }
    ]);
    expect(() => applyAuthoringOperations(built, [{ op: "remove-parameter", id: "custom" }])).toThrow(/cascade/);
    const removed = applyAuthoringOperations(built, [{ op: "remove-parameter", id: "custom", cascade: true }]);
    expect(removed.model.parameters.some((parameter) => parameter.id === "custom")).toBe(false);
    expect(removed.model.bindings).toHaveLength(0);
  });

  it("moves complete layers in recoverable back-to-front order without mutating the baseline", () => {
    const before = fixture();
    const face = before.layers[0]!;
    before.layers = [
      { ...face, id: "face", sourceName: "face", sourcePath: ["face"], role: "face", order: 0 },
      { ...face, id: "brow", sourceName: "brow", sourcePath: ["brow"], role: "eyebrow", order: 1 },
      { ...face, id: "neck", sourceName: "neck", sourcePath: ["neck"], role: "neck", order: 2 },
      { ...face, id: "back-hair", sourceName: "back_hair", sourcePath: ["back_hair"], role: "backHair", order: 3 }
    ];
    const after = applyAuthoringOperations(before, [
      { op: "move-layer", layerId: "back-hair", beforeLayerId: "face" }
    ]);
    expect(after.layers.map((layer) => layer.id)).toEqual(["back-hair", "face", "brow", "neck"]);
    expect(after.layers.map((layer) => layer.order)).toEqual([0, 1, 2, 3]);
    expect(before.layers.map((layer) => layer.id)).toEqual(["face", "brow", "neck", "back-hair"]);
    expect(authoringLayerOverrides(before, after)).toMatchObject({
      "back-hair": { order: 0 },
      face: { order: 1 },
      brow: { order: 2 },
      neck: { order: 3 }
    });
  });

  it("rejects ambiguous or self-referencing layer moves", () => {
    expect(() => applyAuthoringOperations(fixture(), [{ op: "move-layer", layerId: "face" }])).toThrow(/必须且只能/);
    expect(() => applyAuthoringOperations(fixture(), [{ op: "move-layer", layerId: "face", beforeLayerId: "face" }])).toThrow(/不能引用自身/);
  });

  it("turns keyform coordinates into visual evidence previews and persists intent in calibration", () => {
    const before = fixture();
    const patch = {
      version: 1 as const,
      baseRevision: 0,
      label: "增加笑容参数",
      operations: [
        { op: "upsert-parameter" as const, parameter: { id: "smile", name: "Smile", group: "Expression", kind: "continuous" as const, min: 0, default: 0, max: 1 } },
        { op: "upsert-binding" as const, binding: { id: "smile-face", parameterIds: ["smile"] as [string], target: { kind: "layer" as const, id: "face" }, keyforms: [{ values: [0] as [number] }, { values: [1] as [number], opacityMultiplier: 0.8 }] } }
      ]
    };
    const after = applyAuthoringOperations(before, patch.operations);
    const audit = buildAuthoringAudit(patch, before, after);
    expect(audit.previews.map((preview) => preview.parameters)).toEqual([{ smile: 0 }, { smile: 1 }]);

    const attachments = authoringLayerOverrides(before, after);
    const overrides = mergeCalibrationOverrides({}, { model: after.model, ...(Object.keys(attachments).length > 0 ? { layers: attachments } : {}) });
    const reopened = applyCalibrationOverrides(before, overrides);
    expect(reopened.model).toEqual(after.model);
  });
});
