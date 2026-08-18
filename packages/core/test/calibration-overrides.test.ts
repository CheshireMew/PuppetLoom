import { describe, expect, it } from "vitest";
import { applyCalibrationOverrides, mergeCalibrationOverrides } from "../src/calibration.js";
import { buildArtMesh } from "../src/art-mesh.js";
import { makeGridMesh } from "../src/rig.js";
import type { LayerBinding, PuppetLoomProject } from "../src/types.js";

function layer(id: string, order: number): LayerBinding {
  return {
    id,
    sourceName: id,
    sourcePath: [id],
    role: "accessory",
    side: "center",
    order,
    opacity: 1,
    blendMode: "normal",
    bounds: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
    texture: `textures/${id}.png`,
    pivot: { x: 0.4, y: 0.4 },
    mesh: makeGridMesh({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, 3, 3),
    weights: { head: 0, body: 0, gaze: 0, physics: 1 },
    parentGroup: "root"
  };
}

function project(): PuppetLoomProject {
  return {
    version: 2,
    name: "calibration-overrides",
    canvas: { width: 512, height: 512 },
    source: { originalFileName: "fixture.psd", psdSha256: "0".repeat(64), psdPath: "source/source.psd" },
    rigLevel: "grouped",
    layers: [layer("parent", 0), layer("child", 1)],
    anchors: {},
    runtime: {
      seed: 42,
      profile: "calm-v1",
      features: { headTurn: true, bodyFollow: true, gaze: true, hairPhysics: true, blink: false, mouthMotion: false },
      envelope: { headYaw: 0.2, headPitch: 0.1, headRollDegrees: 2, bodySway: 0.01, bodyRollDegrees: 1, gazeX: 0.1, gazeY: 0.1, breath: 0.003, globalScale: 1 }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] },
    disabledReasons: []
  };
}

describe("calibration override contract", () => {
  it("applies hierarchy, drawing, visibility, lock and a resampled mesh as runtime data", () => {
    const applied = applyCalibrationOverrides(project(), {
      layers: {
        child: {
          parentLayerId: "parent",
          order: 9,
          visible: false,
          locked: true,
          side: "left",
          meshDensity: { rows: 5, cols: 6 }
        }
      }
    });
    const child = applied.layers.find((entry) => entry.id === "child")!;
    expect(child).toMatchObject({ parentLayerId: "parent", order: 9, visible: false, locked: true, side: "left" });
    expect(child.mesh).toMatchObject({ rows: 5, cols: 6 });
    expect(child.mesh.points).toHaveLength(30);
    expect(child.mesh.triangles).toHaveLength((5 - 1) * (6 - 1) * 6);
    expect(child.mesh.influences?.physics).toHaveLength(30);
  });

  it("rebuilds density from the neutral mesh instead of retaining stale vertex indexes", () => {
    const previous = {
      layers: { child: { meshPointDeltas: { "8": { x: 0.01, y: 0 } }, vertexInfluences: { face: { "8": 0.25 }, skull: { "8": 0.75 }, pin: { "8": 1 } } } }
    };
    const merged = mergeCalibrationOverrides(previous, { layers: { child: { meshDensity: { rows: 2, cols: 2 } } } });
    expect(merged.layers?.child.meshPointDeltas).toBeUndefined();
    expect(merged.layers?.child.vertexInfluences).toBeUndefined();
    expect(() => applyCalibrationOverrides(project(), merged)).not.toThrow();
  });

  it("stores a generated ArtMesh as a non-destructive legacy-grid upgrade", () => {
    const replacement = buildArtMesh(
      { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
      { textureSize: { width: 100, height: 100 }, alphaThreshold: 8, detail: 40, regions: [{ outer: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], holes: [] }] }
    );
    const merged = mergeCalibrationOverrides(
      { layers: { child: { meshDensity: { rows: 5, cols: 5 }, meshPointDeltas: { "0": { x: 0.01, y: 0 } } } } },
      { layers: { child: { mesh: replacement } } }
    );
    expect(merged.layers?.child.meshDensity).toBeUndefined();
    expect(merged.layers?.child.meshPointDeltas).toBeUndefined();
    const upgraded = applyCalibrationOverrides(project(), merged).layers.find((entry) => entry.id === "child")!.mesh;
    expect(upgraded.topology).toBe("art");
    expect(upgraded.points).toEqual(replacement.points);
  });

  it("rebuilds front-hair physics weights by semantic region instead of carrying scalp wobble forward", () => {
    const value = project();
    const target = value.layers.find((entry) => entry.id === "child")!;
    target.role = "frontHair";
    target.parentGroup = "head";
    target.weights = { head: 1, body: 0, gaze: 0, physics: 1 };
    target.secondaryAnchors = {
      ahogeRoot: { x: 0.4, y: 0.3 },
      frontHairRoot: { x: 0.4, y: 0.42 },
      frontHairRootLeft: { x: 0.28, y: 0.42 },
      frontHairRootRight: { x: 0.52, y: 0.42 },
      frontHairTipLeft: { x: 0.23, y: 0.58 },
      frontHairTipRight: { x: 0.57, y: 0.58 }
    };
    target.mesh = buildArtMesh(target.bounds, {
      textureSize: { width: 160, height: 160 }, alphaThreshold: 8, detail: 10,
      regions: [{ outer: [{ x: 0.5, y: 0 }, { x: 1, y: 0.35 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0.35 }], holes: [] }]
    });
    target.mesh.influences!.physics = target.mesh.points.map(() => 1);

    const rebuilt = applyCalibrationOverrides(value, { layers: { child: { meshDetail: 12 } } }).layers.find((entry) => entry.id === "child")!;
    const lateralCrown = rebuilt.mesh.points
      .map((point, index) => ({ point, weight: rebuilt.mesh.influences!.physics![index]! }))
      .filter(({ point }) => point.y < target.secondaryAnchors!.frontHairRoot!.y && Math.abs(point.x - target.secondaryAnchors!.ahogeRoot!.x) > target.bounds.width * 0.2);
    const freeEnds = rebuilt.mesh.points
      .map((point, index) => ({ point, weight: rebuilt.mesh.influences!.physics![index]! }))
      .filter(({ point }) => point.y > target.secondaryAnchors!.frontHairRoot!.y + target.bounds.height * 0.12);
    expect(lateralCrown.length).toBeGreaterThan(0);
    expect(lateralCrown.every(({ weight }) => weight === 0)).toBe(true);
    expect(freeEnds.some(({ weight }) => weight === 1)).toBe(true);
  });

  it("stores independent face and skull control-cage influence per vertex", () => {
    const applied = applyCalibrationOverrides(project(), {
      layers: { child: { vertexInfluences: { face: { "0": 0.2 }, skull: { "0": 0.7 } } } }
    });
    const mesh = applied.layers.find((entry) => entry.id === "child")!.mesh;
    expect(mesh.influences?.face?.[0]).toBe(0.2);
    expect(mesh.influences?.skull?.[0]).toBe(0.7);
    expect(mesh.influences?.face).toHaveLength(mesh.points.length);
    expect(mesh.influences?.skull).toHaveLength(mesh.points.length);
  });

  it("rejects missing, self-referential and cyclic parent relationships", () => {
    expect(() => applyCalibrationOverrides(project(), { layers: { child: { parentLayerId: "missing" } } })).toThrow(/不存在/);
    expect(() => applyCalibrationOverrides(project(), { layers: { child: { parentLayerId: "child" } } })).toThrow(/自己/);
    expect(() => applyCalibrationOverrides(project(), { layers: { child: { parentLayerId: "parent" }, parent: { parentLayerId: "child" } } })).toThrow(/循环/);
  });

  it("merges per-part motion tuning without discarding other parts", () => {
    const merged = mergeCalibrationOverrides(
      { runtime: { secondaryMotionTuning: { frontHair: { amplitude: 0.8 } } } },
      { runtime: { secondaryMotionTuning: { frontHair: { response: 0.9 }, tail: { stability: 0.7 } } } }
    );
    expect(merged.runtime?.secondaryMotionTuning).toEqual({
      frontHair: { amplitude: 0.8, response: 0.9 },
      tail: { stability: 0.7 }
    });
  });
});
