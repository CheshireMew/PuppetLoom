import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { artifactPath } from "../../../test/support/artifacts.js";
import { characterLayerVisible, characterMotionState, resolveCharacterState } from "../src/character-state.js";
import { applyLayerCollisionConstraints, constrainMotionState } from "../src/collision-constraints.js";
import { applyProductionConfiguration } from "../src/production-config.js";
import { createProject } from "../src/project.js";
import { makeGridMesh } from "../src/rig.js";
import { neutralMotionState } from "../src/deform.js";
import type { LayerBinding, PuppetLoomProject } from "../src/types.js";

function layer(id: string, bounds: LayerBinding["bounds"]): LayerBinding { return { id, sourceName: id, sourcePath: [id], role: "accessory", side: "center", order: 1, opacity: 1, blendMode: "normal", bounds, texture: `textures/${id}.png`, pivot: { x: bounds.x, y: bounds.y }, mesh: makeGridMesh(bounds, 2, 2), weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "root" }; }
function project(): PuppetLoomProject {
  const coatA = layer("coat-a", { x: 0.1, y: 0.2, width: 0.2, height: 0.3 }); const coatB = layer("coat-b", { x: 0.1, y: 0.2, width: 0.2, height: 0.3 });
  const cup = layer("cup", { x: 0.4, y: 0.4, width: 0.08, height: 0.08 }); const body = layer("body", { x: 0.35, y: 0.35, width: 0.3, height: 0.3 });
  return { version: 4, name: "production", canvas: { width: 100, height: 100 }, source: { originalFileName: "x.psd", psdSha256: "a".repeat(64), psdPath: "source/x.psd" }, rigLevel: "minimal", layers: [coatA, coatB, cup, body], model: { parameters: [{ id: "smile", name: "Smile", group: "Face", kind: "continuous", min: 0, default: 0, max: 1 }], deformers: [], bindings: [], expressions: [{ id: "happy", name: "Happy", parameters: { smile: 1 } }], physics: [], behaviors: [] }, anchors: {}, runtime: { seed: 1, profile: "calm-v1", envelope: { headYaw: 1, headPitch: 1, headRollDegrees: 1, bodySway: 1, bodyRollDegrees: 1, gazeX: 1, gazeY: 1, breath: 1, globalScale: 1 }, features: { headTurn: false, bodyFollow: false, gaze: false, hairPhysics: false, blink: false, mouthMotion: false }, constraints: { motionLimits: [{ id: "limit-yaw", semantic: "head-yaw", min: -0.4, max: 0.4 }], collisions: [{ id: "cup-body", name: "杯子避开身体", movingLayerIds: ["cup"], colliderLayerIds: ["body"], padding: 0.01, maxCorrection: 0.2, strength: 1 }] } }, production: { variants: [{ id: "coat", name: "外套", defaultOptionId: "coat-a", options: [{ id: "coat-a", name: "A", layerIds: ["coat-a"] }, { id: "coat-b", name: "B", layerIds: ["coat-b"] }] }], props: [{ id: "cup", name: "杯子", layerIds: ["cup"], slot: "hand-right" }], presets: [{ id: "stage", name: "舞台", variants: { coat: "coat-b" }, props: ["cup"], parameters: { smile: 0.7 }, expressions: { happy: 0.3 } }] }, quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: [] };
}

describe("production variants and constraints", () => {
  it("resolves presets into variant, prop and authored parameter state", () => {
    const fixture = project(); const state = { ...neutralMotionState, characterState: { presetId: "stage" } };
    expect(resolveCharacterState(fixture, state.characterState)).toMatchObject({ variants: { coat: "coat-b" }, props: ["cup"] });
    expect(characterLayerVisible(fixture, "coat-a", state)).toBe(false); expect(characterLayerVisible(fixture, "coat-b", state)).toBe(true); expect(characterLayerVisible(fixture, "cup", state)).toBe(true);
    expect(characterMotionState(fixture, state)).toMatchObject({ parameters: { smile: 0.7 }, expressions: { happy: 0.3 } });
  });
  it("clamps motion and pushes configured moving layers out of collider bounds", () => {
    const fixture = project(); expect(constrainMotionState(fixture, { ...neutralMotionState, headYaw: 0.9 }).headYaw).toBe(0.4);
    const cup = fixture.layers.find((value) => value.id === "cup")!; const corrected = applyLayerCollisionConstraints(fixture, cup, cup.mesh.points);
    expect(corrected).not.toEqual(cup.mesh.points); expect(Math.max(...corrected.map((point, index) => Math.hypot(point.x - cup.mesh.points[index]!.x, point.y - cup.mesh.points[index]!.y)))).toBeLessThanOrEqual(0.200001);
  });
  it("applies configuration atomically and appends recoverable configuration revisions", async () => {
    const root = artifactPath(`production-config-${process.pid}-${Date.now()}`);
    await createProject({ input: "test/fixtures/semantic.psd", output: root, seed: 42 });
    const config = { version: 1, production: { variants: [], props: [], presets: [{ id: "neutral", name: "中立" }] }, constraints: { motionLimits: [{ id: "yaw", semantic: "head-yaw", min: -0.8, max: 0.8 }], collisions: [] } };
    await expect(applyProductionConfiguration(root, config)).resolves.toMatchObject({ revision: 0, configRevision: 1, presets: 1, motionLimits: 1 });
    await expect(applyProductionConfiguration(root, config)).resolves.toMatchObject({ revision: 0, configRevision: 2 });
    expect(await readdir(`${root}/production/config-history`)).toEqual(["revision-0001.json", "revision-0002.json"]);
  });
});
