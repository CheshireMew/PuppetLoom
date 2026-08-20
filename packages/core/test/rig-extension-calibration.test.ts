import { beforeAll, describe, expect, it } from "vitest";
import { applyCalibrationOverrides } from "../src/calibration.js";
import { importPsd } from "../src/psd.js";
import { buildRig } from "../src/rig.js";
import { puppetLoomProjectSchema } from "../src/schema.js";
import type { PuppetLoomProject } from "../src/types.js";

let base: PuppetLoomProject;

beforeAll(async () => {
  const imported = await importPsd("test/fixtures/semantic.psd");
  base = buildRig({
    imported,
    name: "extensions",
    seed: 42,
    source: { originalFileName: "semantic.psd", psdSha256: "0".repeat(64), psdPath: "source/source.psd" }
  });
});

describe("rig extension calibration", () => {
  it("persists corrected strands, semantic face depth, torso volume and explicit attachment masks", () => {
    const front = base.layers.find((layer) => layer.role === "frontHair")!;
    const strands = front.hairStrands!.map((strand, index) => index === 0
      ? { ...strand, source: "corrected" as const, root: { ...strand.root, x: strand.root.x + 0.001 } }
      : strand);
    const faceDepthProfile = {
      ...base.runtime.poseField!.faceDepthProfile!,
      points: base.runtime.poseField!.faceDepthProfile!.points.map((point) => point.id === "noseTip" ? { ...point, depth: 0.19 } : point)
    };
    const project = applyCalibrationOverrides(base, {
      layers: {
        [front.id]: {
          hairStrands: strands,
          vertexInfluences: { headAttachment: { "0": 0.85 }, physicsRelease: { "0": 0.15 } }
        }
      },
      runtime: {
        poseField: { faceDepthProfile },
        torsoVolumeProfile: {
          kind: "torso-volume-v1",
          strength: 0.8,
          points: [
            { id: "upperChest", position: 0.08, depth: 0.02 },
            { id: "chest", position: 0.3, depth: 0.08 },
            { id: "waist", position: 0.62, depth: -0.025 },
            { id: "hip", position: 0.92, depth: 0.045 }
          ]
        }
      }
    });
    const calibrated = project.layers.find((layer) => layer.id === front.id)!;
    expect(calibrated.hairStrands![0]!.source).toBe("corrected");
    expect(calibrated.mesh.influences!.headAttachment![0]).toBe(0.85);
    expect(calibrated.mesh.influences!.physicsRelease![0]).toBe(0.15);
    expect(project.runtime.poseField!.faceDepthProfile!.points.find((point) => point.id === "noseTip")!.depth).toBe(0.19);
    expect(project.runtime.torsoVolumeProfile?.strength).toBe(0.8);
    expect(puppetLoomProjectSchema.parse(project)).toBeDefined();
  });
});
