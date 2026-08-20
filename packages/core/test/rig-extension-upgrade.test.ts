import { beforeAll, describe, expect, it } from "vitest";
import { applyCalibrationOverrides } from "../src/calibration.js";
import { importPsd, type ImportedPsd } from "../src/psd.js";
import { buildRigExtensionUpgradePlan } from "../src/rig-extension-upgrade.js";
import { buildRig } from "../src/rig.js";
import { puppetLoomProjectSchema } from "../src/schema.js";
import type { PuppetLoomProject } from "../src/types.js";

let imported: ImportedPsd;
let legacy: PuppetLoomProject;

beforeAll(async () => {
  imported = await importPsd("test/fixtures/semantic.psd");
  legacy = structuredClone(buildRig({
    imported,
    name: "legacy-extension-project",
    seed: 42,
    source: { originalFileName: "semantic.psd", psdSha256: "0".repeat(64), psdPath: "source/source.psd" }
  }));
  for (const layer of legacy.layers) {
    delete layer.hairStrands;
    if (layer.mesh.influences) {
      delete layer.mesh.influences.headAttachment;
      delete layer.mesh.influences.physicsRelease;
    }
  }
  if (legacy.runtime.poseField) delete legacy.runtime.poseField.faceDepthProfile;
});

describe("existing-project rig extension upgrade", () => {
  it("plans revision-only strands, six-point face depth and explicitly requested torso volume", () => {
    const plan = buildRigExtensionUpgradePlan({
      projectDirectory: "workspace/models/legacy-extension-project",
      project: legacy,
      importedLayers: imported.layers,
      baseRevision: 7,
      options: { includeTorsoVolume: true }
    });
    expect(plan.baseRevision).toBe(7);
    expect(plan.additions.faceDepthProfile).toBe(true);
    expect(plan.additions.torsoVolumeProfile).toBe(true);
    expect(plan.additions.hairLayers.map((layer) => layer.role)).toEqual(expect.arrayContaining(["frontHair", "backHair"]));
    expect(plan.additions.hairLayers.every((layer) => layer.strandCount >= 2)).toBe(true);
    const upgraded = applyCalibrationOverrides(legacy, plan.patch!.overrides);
    expect(upgraded.runtime.poseField?.faceDepthProfile?.points).toHaveLength(6);
    expect(upgraded.runtime.torsoVolumeProfile?.points).toHaveLength(4);
    expect(upgraded.layers.filter((layer) => ["frontHair", "backHair"].includes(layer.role)).every((layer) => (layer.hairStrands?.length ?? 0) >= 2)).toBe(true);
    expect(puppetLoomProjectSchema.parse(upgraded)).toBeDefined();
  });

  it("does not silently add torso volume without explicit intent", () => {
    const plan = buildRigExtensionUpgradePlan({ projectDirectory: ".", project: legacy, importedLayers: imported.layers, baseRevision: 7 });
    expect(plan.additions.torsoVolumeProfile).toBe(false);
    expect(plan.patch?.overrides.runtime?.torsoVolumeProfile).toBeUndefined();
  });
});
