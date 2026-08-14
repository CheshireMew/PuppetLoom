import { describe, expect, it } from "vitest";
import { deformedPoints } from "../src/deform.js";
import { makeGridMesh } from "../src/rig.js";
import { applySafetyLimits, safetyPoseState } from "../src/safety.js";
import type { PuppetLoomProject } from "../src/types.js";

describe("mesh and safety", () => {
  it("creates a complete rectangular triangle grid", () => {
    const mesh = makeGridMesh({ x: 0.2, y: 0.1, width: 0.4, height: 0.5 }, 4, 5);
    expect(mesh.points).toHaveLength(20);
    expect(mesh.uvs).toHaveLength(20);
    expect(mesh.triangles).toHaveLength((4 - 1) * (5 - 1) * 6);
    expect(Math.max(...mesh.triangles)).toBeLessThan(mesh.points.length);
  });

  it("preserves neutral mesh points exactly", () => {
    const layer = {
      id: "layer", sourceName: "face", sourcePath: ["face"], role: "face" as const, side: "center" as const, order: 0, opacity: 1,
      blendMode: "normal", bounds: { x: 0.2, y: 0.1, width: 0.5, height: 0.6 }, texture: "textures/layer.png",
      pivot: { x: 0.45, y: 0.4 }, mesh: makeGridMesh({ x: 0.2, y: 0.1, width: 0.5, height: 0.6 }, 4, 4),
      weights: { head: 1, body: 0, gaze: 0, physics: 0 }, parentGroup: "head" as const
    };
    const project = {
      canvas: { width: 512, height: 512 }, layers: [layer], anchors: {},
      runtime: { seed: 42, profile: "calm-v1", envelope: { headYaw: 0.2, headPitch: 0.1, headRollDegrees: 5, bodySway: 0.1, bodyRollDegrees: 3, breath: 0.02, gazeX: 0.2, gazeY: 0.1, globalScale: 1 } }
    } as PuppetLoomProject;
    expect(deformedPoints(project, layer, safetyPoseState(0, 0, 0))).toEqual(layer.mesh.points);
  });

  it("keeps legs and feet fixed during breathing", () => {
    const makeLayer = (role: "topWear" | "leg" | "foot", y: number) => ({
      id: role, sourceName: role, sourcePath: [role], role, side: "center" as const, order: 0, opacity: 1,
      blendMode: "normal", bounds: { x: 0.35, y, width: 0.3, height: 0.18 }, texture: `textures/${role}.png`,
      pivot: { x: 0.5, y: y + 0.09 }, mesh: makeGridMesh({ x: 0.35, y, width: 0.3, height: 0.18 }, 4, 4),
      weights: { head: 0, body: 1, gaze: 0, physics: 0 }, parentGroup: "body" as const
    });
    const layers = [makeLayer("topWear", 0.42), makeLayer("leg", 0.65), makeLayer("foot", 0.82)];
    const project = {
      canvas: { width: 512, height: 512 }, layers, anchors: { bodyCenter: { x: 0.5, y: 0.55 } },
      runtime: { seed: 42, profile: "calm-v1", envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, breath: 0.01, gazeX: 0, gazeY: 0, globalScale: 1 } }
    } as PuppetLoomProject;
    const breathing = { ...safetyPoseState(0, 0, 0), breath: 1 };
    expect(deformedPoints(project, layers[1]!, breathing)).toEqual(layers[1]!.mesh.points);
    expect(deformedPoints(project, layers[2]!, breathing)).toEqual(layers[2]!.mesh.points);
    expect(deformedPoints(project, layers[0]!, breathing)).not.toEqual(layers[0]!.mesh.points);
  });

  it("pins the headband while flexible ear tips follow secondary motion", () => {
    const layer = {
      id: "headwear", sourceName: "headwear", sourcePath: ["headwear"], role: "headwear" as const, side: "center" as const, order: 0, opacity: 1,
      blendMode: "normal", bounds: { x: 0.2, y: 0.08, width: 0.6, height: 0.28 }, texture: "textures/headwear.png",
      pivot: { x: 0.5, y: 0.15 }, mesh: makeGridMesh({ x: 0.2, y: 0.08, width: 0.6, height: 0.28 }, 5, 5),
      weights: { head: 1, body: 0, gaze: 0, physics: 0.55 }, parentGroup: "head" as const
    };
    const project = {
      canvas: { width: 512, height: 512 }, layers: [layer], anchors: { neck: { x: 0.5, y: 0.35 }, cheekLeft: { x: 0.62, y: 0.24 }, cheekRight: { x: 0.38, y: 0.24 }, forehead: { x: 0.5, y: 0.12 }, chin: { x: 0.5, y: 0.3 } },
      runtime: { seed: 42, profile: "calm-v1", envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, breath: 0, gazeX: 0, gazeY: 0, globalScale: 1 } }
    } as PuppetLoomProject;
    const state = { ...safetyPoseState(0, 0, 0), earX: 1, earY: 0.4 };
    const moved = deformedPoints(project, layer, state);
    expect(moved[2]).toEqual(layer.mesh.points[2]);
    expect(moved[20]).not.toEqual(layer.mesh.points[20]);
    expect(moved[24]).not.toEqual(layer.mesh.points[24]);
  });

  it("shrinks or downgrades an unsafe envelope", () => {
    const mesh = makeGridMesh({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, 4, 4);
    const project = {
      version: 1, generator: { name: "PuppetLoom", version: "0.1.0" }, name: "unsafe", createdAt: "deterministic",
      canvas: { width: 512, height: 512 }, source: { originalFileName: "unsafe.psd", psdSha256: "0".repeat(64), psdPath: "source/source.psd" },
      rigLevel: "semantic", layers: [{ id: "face", sourceName: "face", sourcePath: ["face"], role: "face", side: "center", order: 0, opacity: 1, blendMode: "normal", bounds: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, texture: "textures/face.png", pivot: { x: 0.5, y: 0.5 }, mesh, weights: { head: 1, body: 0, gaze: 0, physics: 0 }, parentGroup: "head" }],
      anchors: { neck: { x: 0.5, y: 0.9 }, cheekLeft: { x: 0.9, y: 0.5 }, cheekRight: { x: 0.1, y: 0.5 }, forehead: { x: 0.5, y: 0.1 }, chin: { x: 0.5, y: 0.9 } },
      runtime: { seed: 1, profile: "calm-v1", envelope: { headYaw: 18, headPitch: 12, headRollDegrees: 160, bodySway: 3, bodyRollDegrees: 90, breath: 1, gazeX: 4, gazeY: 4, globalScale: 1 }, features: { headTurn: true, bodyFollow: true, gaze: false, hairPhysics: false, blink: false, mouthMotion: false } },
      quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: []
    } as PuppetLoomProject;
    const safe = applySafetyLimits(project);
    expect(safe.quality.poseValidations).toHaveLength(13);
    expect(safe.quality.poseValidations.every((pose) => pose.passed)).toBe(true);
    expect(safe.quality.safetyScale < 1 || safe.rigLevel !== "semantic").toBe(true);
  });
});
