import { describe, expect, it } from "vitest";
import { applyAuthoringOperations, authoringLayerOverrides, buildAuthoringAudit } from "../src/authoring.js";
import { applyCalibrationOverrides, mergeCalibrationOverrides } from "../src/calibration.js";
import { createDefaultAuthoringModel, sampleBindingKeyform, evaluateLayerAuthoring } from "../src/model.js";
import { deformedPoints, neutralMotionState } from "../src/deform.js";
import type { GeometryEditOperation, LayerBinding, PuppetLoomProject } from "../src/types.js";

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
  it("transports a closed aperture through the head surface instead of adding open-eye offsets", () => {
    const project = applyAuthoringOperations(fixture(), [
      { op: "set-layer-head-pose", layerId: "face", mode: "keyforms" },
      { op: "upsert-binding", binding: { id: "head", target: { kind: "layer", id: "face" }, parameterIds: ["param-head-yaw", "param-head-pitch"],
        keyforms: [0, 1].flatMap(yaw => [0, 1].map(pitch => ({ values: [yaw, pitch] as [number, number], meshPointDeltas: { "2": { x: 0, y: -0.5 * yaw }, "3": { x: 0, y: -0.5 * yaw } } }))) } },
      { op: "upsert-binding", binding: { id: "blink", target: { kind: "layer", id: "face" }, parameterIds: ["param-blink"],
        keyforms: [{ values: [0] }, { values: [1], meshPointDeltas: { "0": { x: 0, y: 0.45 }, "1": { x: 0, y: 0.45 }, "2": { x: 0, y: -0.45 }, "3": { x: 0, y: -0.45 } } }] } }
    ]);
    const points = evaluateLayerAuthoring(project, project.layers[0]!, { ...neutralMotionState, headYaw: 1, blink: 1 }).points;
    expect(points[0]!.y).toBeCloseTo(0.225, 10);
    expect(points[2]!.y).toBeCloseTo(0.275, 10);
    expect(points[2]!.y).toBeGreaterThan(points[0]!.y);
  });
  it("persists complete head keyforms without applying procedural yaw twice, while retaining roll", () => {
    const before = fixture();
    before.layers[0]!.weights.head = 1;
    before.runtime.envelope.headYaw = 1;
    before.runtime.envelope.headPitch = 1;
    before.runtime.envelope.headRollDegrees = 10;
    const after = applyAuthoringOperations(before, [
      { op: "set-layer-head-pose", layerId: "face", mode: "keyforms" },
      { op: "upsert-binding", binding: { id: "reference-head", target: { kind: "layer", id: "face" }, parameterIds: ["param-head-yaw"],
        keyforms: [{ values: [0] }, { values: [1], meshPointDeltas: { "0": { x: 0.04, y: 0.02 } } }] } }
    ]);
    const restored = applyCalibrationOverrides(before, { model: after.model, layers: authoringLayerOverrides(before, after) });
    expect(restored.layers[0]!.headPoseMode).toBe("keyforms");
    const state = { ...neutralMotionState, headYaw: 1, headPitch: 1 };
    const posed = deformedPoints(restored, restored.layers[0]!, state)[0]!;
    expect(posed.x).toBeCloseTo(0.04, 10);
    expect(posed.y).toBeCloseTo(0.02, 10);
    expect(deformedPoints(restored, restored.layers[0]!, { ...state, headRoll: 1 })[0]).not.toEqual({ x: 0.04, y: 0.02 });
    const switched = applyAuthoringOperations(restored, [{ op: "set-layer-head-pose", layerId: "face", mode: "procedural" }]);
    expect(switched.model).toEqual(restored.model);
    expect(applyCalibrationOverrides(restored, { layers: authoringLayerOverrides(restored, switched) }).layers[0]!.headPoseMode).toBeUndefined();
  });
  it("inserts complete two-dimensional key rows using runtime interpolation without changing existing poses", () => {
    const before = applyAuthoringOperations(fixture(), [{ op: "upsert-binding", binding: {
      id: "turn", parameterIds: ["param-head-yaw", "param-head-pitch"], target: { kind: "layer", id: "face" },
      keyforms: [-1, 1].flatMap((x) => [-1, 1].map((y) => ({ values: [x, y] as [number, number], meshPointDeltas: { "1": { x: x * 0.02 + x * y * 0.01, y: y * 0.02 } }, transform: { translation: { x: x * 0.01, y: y * 0.01 }, rotationDegrees: x * 3, scale: { x: 1 + y * 0.01, y: 1 } }, opacityMultiplier: 0.9 + x * 0.05, drawOrderOffset: x * 2 })))
    } }]);
    const after = applyAuthoringOperations(before, [
      { op: "insert-binding-key", bindingId: "turn", parameterId: "param-head-yaw", value: 0 },
      { op: "insert-binding-key", bindingId: "turn", parameterId: "param-head-pitch", value: 0.25 }
    ]);
    expect(after.model.bindings[0]!.keyforms).toHaveLength(9);
    expect(after.model.bindings[0]!.keyforms.slice(0, 4)).toEqual(before.model.bindings[0]!.keyforms);
    for (const x of [-1, -0.63, 0, 0.37, 1]) for (const y of [-1, -0.4, 0.25, 0.8, 1]) {
      const previous = sampleBindingKeyform(before.model.bindings[0]!, [x, y]);
      const current = sampleBindingKeyform(after.model.bindings[0]!, [x, y]);
      expect(current.meshPointDeltas!["1"]!.x).toBeCloseTo(previous.meshPointDeltas!["1"]!.x, 12);
      expect(current.meshPointDeltas!["1"]!.y).toBeCloseTo(previous.meshPointDeltas!["1"]!.y, 12);
      expect(current.transform!.rotationDegrees).toBeCloseTo(previous.transform!.rotationDegrees!, 12);
      expect(current.transform!.scale!.x).toBeCloseTo(previous.transform!.scale!.x, 12);
      expect(current.opacityMultiplier).toBeCloseTo(previous.opacityMultiplier!, 12);
      expect(current.drawOrderOffset).toBeCloseTo(previous.drawOrderOffset!, 12);
    }
    expect(applyAuthoringOperations(after, [{ op: "insert-binding-key", bindingId: "turn", parameterId: "param-head-yaw", value: 0 }])).toEqual(after);
  });
  it("edits an existing keyform with ordered rest-space selection without touching the other poses", () => {
    const before = applyAuthoringOperations(fixture(), [
      { op: "upsert-parameter", parameter: { id: "custom", name: "Custom", group: "Custom", kind: "continuous", min: -1, default: 0, max: 1 } },
      { op: "upsert-binding", binding: { id: "local", parameterIds: ["custom"], target: { kind: "layer", id: "face" }, keyforms: [{ values: [-1], meshPointDeltas: { "3": { x: 0.01, y: 0 } } }, { values: [0] }, { values: [1] }] } }
    ]);
    const operation: GeometryEditOperation = { op: "transform-keyform", bindingId: "local", values: [1], coordinateSpace: "rest-canvas", selection: { kind: "rect", rect: { x: 0.8, y: -0.1, width: 0.4, height: 1.2 } }, transforms: [{ kind: "translate", delta: { x: -0.1, y: 0 } }, { kind: "scale", origin: { x: 0, y: 0 }, factors: { x: 0.5, y: 1 } }] };
    const after = applyAuthoringOperations(before, [operation]);
    const [negative, neutral, edited] = after.model.bindings[0]!.keyforms;
    expect(negative).toEqual(before.model.bindings[0]!.keyforms[0]);
    expect(neutral).toEqual({ values: [0] });
    expect(edited!.meshPointDeltas!["1"]!.x).toBeCloseTo(-0.55);
    expect(edited!.meshPointDeltas!["3"]!.x).toBeCloseTo(-0.55);
    expect(Object.keys(edited!.meshPointDeltas!)).toEqual(["1", "3"]);
    expect(after.layers).toEqual(before.layers);
    expect(before.model.bindings[0]!.keyforms[2]).toEqual({ values: [1] });
    expect(buildAuthoringAudit({ version: 1, baseRevision: 0, operations: [operation] }, before, after).previews[0]!.parameters).toEqual({ custom: 1 });
    expect(() => applyAuthoringOperations(before, [{ ...operation, values: [0.5] }])).toThrow(/已有关键形/);
    expect(() => applyAuthoringOperations(before, [{ ...operation, selection: { kind: "indices", indices: [999] } }])).toThrow(/不存在的顶点/);
    expect(() => applyAuthoringOperations(before, [{ ...operation, selection: { kind: "line", start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, radius: 1 } }])).toThrow(/不能重合/);
  });

  it("applies feathered geometry edits and preserves a zero operation exactly", () => {
    const before = applyAuthoringOperations(fixture(), [
      { op: "upsert-binding", binding: { id: "local", parameterIds: ["param-head-yaw"], target: { kind: "layer", id: "face" }, keyforms: [{ values: [0] }] } }
    ]);
    const operation: GeometryEditOperation = { op: "transform-keyform", bindingId: "local", values: [0], coordinateSpace: "rest-canvas", selection: { kind: "circle", center: { x: 0, y: 0 }, radius: 2, feather: 1 }, transforms: [{ kind: "translate", delta: { x: 0.1, y: 0 } }] };
    const after = applyAuthoringOperations(before, [operation]);
    expect(after.model.bindings[0]!.keyforms[0]!.meshPointDeltas!["0"]!.x).toBeCloseTo(0.1);
    expect(after.model.bindings[0]!.keyforms[0]!.meshPointDeltas!["1"]!.x).toBeCloseTo(0.05);
    const noop = applyAuthoringOperations(before, [{ ...operation, transforms: [{ kind: "translate", delta: { x: 0, y: 0 } }] }]);
    expect(noop).toEqual(before);
  });
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
    const audit = buildAuthoringAudit({ version: 1, baseRevision: 0, operations: [{ op: "move-layer", layerId: "back-hair", beforeLayerId: "face" }] }, before, after);
    expect(audit.changes?.filter((change) => change.collection === "layers").map((change) => change.id).sort()).toEqual(["back-hair", "brow", "face", "neck"]);
    expect(audit.changes).toEqual(before.layers.map((layer) => ({ collection: "layers", id: layer.id, kind: "updated", fields: ["order"] })));
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
