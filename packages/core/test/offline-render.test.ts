import { describe, expect, it } from "vitest";
import { neutralMotionState } from "../src/deform.js";
import { renderProjectPoseWithSources } from "../src/offline-render.js";
import { featureGatedMotionState } from "../src/render-contract.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import type { LayerBinding, PuppetLoomProject } from "../src/types.js";

function layer(id: string, order: number, blendMode = "normal"): LayerBinding {
  return {
    id, sourceName: id, sourcePath: [id], role: "accessory", side: "center", order, opacity: 1, blendMode,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, texture: `textures/${id}.png`, pivot: { x: 0.5, y: 0.5 },
    mesh: {
      rows: 2, cols: 2,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      triangles: [0, 1, 2, 1, 3, 2]
    },
    weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "root"
  };
}

function project(layers: LayerBinding[]): PuppetLoomProject {
  return {
    version: 2, name: "render-contract", canvas: { width: 10, height: 10 },
    source: { originalFileName: "fixture.psd", psdSha256: "0".repeat(64), psdPath: "source/fixture.psd" },
    rigLevel: "minimal", layers, anchors: {},
    runtime: {
      seed: 1, profile: "calm-v1",
      envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, gazeX: 0, gazeY: 0, breath: 0, globalScale: 1 },
      features: { headTurn: false, bodyFollow: false, gaze: false, hairPhysics: false, blink: false, mouthMotion: false }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: []
  };
}

function pixel(red: number, green: number, blue: number, alpha: number) {
  return { width: 1, height: 1, data: new Uint8ClampedArray([red, green, blue, alpha]) };
}

describe("offline renderer contract", () => {
  it("occludes a saturated iris during partial closure instead of crossfading it into the face", () => {
    const skin = layer("skin", 0), white = { ...layer("white", 1), role: "eyeWhite" as const };
    const iris = { ...layer("iris", 2), role: "iris" as const, clipLayerId: white.id };
    const closed = { ...layer("closed", 3), role: "eyeClosed" as const };
    closed.mesh = { ...closed.mesh, topology: "art" };
    const value = project([skin, white, iris, closed]);
    for (const surface of [white, iris, closed]) (surface as LayerBinding).blinkMode = "geometry";
    value.model = createDefaultAuthoringModel();
    value.model.bindings.push({ id: "test-aperture", parameterIds: ["param-blink"], target: { kind: "layer", id: white.id }, keyforms: [
      { values: [0] }, { values: [1], transform: { scale: { x: 1, y: 0.02 } } }
    ] });
    value.runtime.features.blink = true;
    const sources = new Map([[skin.id, pixel(250, 220, 210, 255)], [white.id, pixel(255, 255, 255, 255)], [iris.id, pixel(240, 0, 0, 255)], [closed.id, pixel(0, 0, 0, 255)]]);
    const result = renderProjectPoseWithSources(value, sources, { ...neutralMotionState, blink: 0.65 }, 40, 40);
    const colors = Array.from({ length: 1600 }, (_, i) => Array.from(result.data.slice(i * 4, i * 4 + 3)).join(","));
    expect(colors).toContain("240,0,0");
    expect(colors).toContain("250,220,210");
    expect(colors.every((color) => ["240,0,0", "250,220,210", "255,255,255"].includes(color))).toBe(true);
  });
  it("lets the global blink drive both eyes until an asymmetric side is explicitly controlled", () => {
    const value = project([]);
    value.runtime.features.blink = true;
    value.runtime.features.asymmetricBlink = true;
    const global = featureGatedMotionState(value, { ...neutralMotionState, parameters: { "param-blink": 1 } });
    expect(global.blink).toBe(1);
    expect(global.blinkLeft).toBe(1);
    expect(global.blinkRight).toBe(1);
    const globalSecondPass = featureGatedMotionState(value, global);
    expect(globalSecondPass.blink).toBe(1);
    expect(globalSecondPass.blinkLeft).toBe(1);
    expect(globalSecondPass.blinkRight).toBe(1);

    const asymmetric = featureGatedMotionState(value, {
      ...neutralMotionState,
      parameters: { "param-blink": 1, "param-blink-left": 0.25 }
    });
    expect(asymmetric.blinkLeft).toBe(0.25);
    expect(asymmetric.blinkRight).toBe(1);
  });

  it.each([
    ["normal", [128, 0, 127]],
    ["multiply", [0, 0, 127]],
    ["screen", [128, 0, 255]],
    ["add", [128, 0, 255]],
    ["darken", [0, 0, 0]],
    ["lighten", [128, 0, 255]]
  ])("matches premultiplied WebGL %s blending", (mode, expected) => {
    const bottom = layer("bottom", 0);
    const top = layer("top", 1, mode);
    const result = renderProjectPoseWithSources(project([bottom, top]), new Map([
      [bottom.id, pixel(0, 0, 255, 255)],
      [top.id, pixel(255, 0, 0, 128)]
    ]), neutralMotionState, 1, 1);
    expect(Array.from(result.data.slice(0, 3))).toEqual(expected);
    expect(result.data[3]).toBe(255);
  });

  it("uses the deformed clip texture alpha instead of its rectangular bounds", () => {
    const clip = { ...layer("clip", 0), visible: false };
    const child = { ...layer("child", 1), clipLayerId: clip.id };
    const result = renderProjectPoseWithSources(project([clip, child]), new Map([
      [clip.id, { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 0, 255, 255, 255, 255]) }],
      [child.id, pixel(255, 0, 0, 255)]
    ]), neutralMotionState, 10, 2);
    expect(result.data[3]).toBe(0);
    expect(result.data[(0 * 10 + 5) * 4 + 3]).toBe(255);
  });
});
