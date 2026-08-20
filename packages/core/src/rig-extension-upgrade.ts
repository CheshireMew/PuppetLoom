import { join, resolve } from "node:path";
import { inferHairStrands } from "./hair-strands.js";
import { loadCalibration, loadProject } from "./project.js";
import { importPsd, type ImportedLayer } from "./psd.js";
import { defaultFaceDepthProfile, defaultTorsoVolumeProfile } from "./rig-extension-defaults.js";
import type { CalibrationPatch, LayerBinding, PuppetLoomProject } from "./types.js";

export interface RigExtensionUpgradeOptions {
  /** Torso volume is never inferred silently because flat or loose clothing may not need it. */
  includeTorsoVolume?: boolean;
}

export interface RigExtensionUpgradePlan {
  version: 1;
  task: "rig-extension-upgrade";
  project: string;
  projectDirectory: string;
  baseRevision: number;
  upToDate: boolean;
  additions: {
    hairLayers: Array<{ id: string; sourceName: string; role: LayerBinding["role"]; strandCount: number }>;
    faceDepthProfile: boolean;
    torsoVolumeProfile: boolean;
  };
  skipped: string[];
  patch?: CalibrationPatch;
}

export interface BuildRigExtensionUpgradePlanInput {
  projectDirectory: string;
  project: PuppetLoomProject;
  importedLayers: ImportedLayer[];
  baseRevision: number;
  options?: RigExtensionUpgradeOptions;
}

function sameSourcePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function sourceLayerFor(projectLayer: LayerBinding, importedLayers: ImportedLayer[]): ImportedLayer | undefined {
  return importedLayers.find((layer) => layer.id === projectLayer.id)
    ?? importedLayers.find((layer) => sameSourcePath(layer.sourcePath, projectLayer.sourcePath));
}

function canUseTorsoVolume(project: PuppetLoomProject): boolean {
  return Boolean(
    project.runtime.features.bodyFollow
    && project.layers.some((layer) => layer.role === "topWear" || layer.role === "bottomWear")
  );
}

/**
 * Plans a revision-only adoption of extension fields for an existing project.
 * It reads the project's own preserved PSD and never rebuilds or replaces the project directory.
 */
export function buildRigExtensionUpgradePlan(input: BuildRigExtensionUpgradePlanInput): RigExtensionUpgradePlan {
  const root = resolve(input.projectDirectory);
  const { project, importedLayers, baseRevision } = input;
  const options = input.options ?? {};
  const layerOverrides: NonNullable<CalibrationPatch["overrides"]["layers"]> = {};
  const hairLayers: RigExtensionUpgradePlan["additions"]["hairLayers"] = [];
  const skipped: string[] = [];

  for (const layer of project.layers.filter((candidate) => ["frontHair", "sideHair", "backHair"].includes(candidate.role))) {
    if ((layer.hairStrands?.length ?? 0) >= 2) continue;
    const importedLayer = sourceLayerFor(layer, importedLayers);
    if (!importedLayer) {
      skipped.push(`${layer.sourceName}：在项目源 PSD 中找不到对应图层。`);
      continue;
    }
    const strands = inferHairStrands(importedLayer, layer, project.canvas);
    if (strands.length < 2) {
      skipped.push(`${layer.sourceName}：轮廓不足以形成至少两条可靠房束，继续使用旧物理。`);
      continue;
    }
    layerOverrides[layer.id] = { hairStrands: strands };
    hairLayers.push({ id: layer.id, sourceName: layer.sourceName, role: layer.role, strandCount: strands.length });
  }

  const addFaceDepth = Boolean(project.runtime.poseField && !project.runtime.poseField.faceDepthProfile);
  const addTorsoVolume = Boolean(options.includeTorsoVolume && !project.runtime.torsoVolumeProfile && canUseTorsoVolume(project));
  if (options.includeTorsoVolume && !addTorsoVolume && !project.runtime.torsoVolumeProfile && !canUseTorsoVolume(project)) {
    skipped.push("当前项目没有识别出会跟随身体的上装或下装，因此没有套用躯干体积曲线。");
  }
  const overrides: CalibrationPatch["overrides"] = {
    ...(Object.keys(layerOverrides).length > 0 ? { layers: layerOverrides } : {}),
    ...(addFaceDepth || addTorsoVolume ? {
      runtime: {
        ...(addFaceDepth ? { poseField: { faceDepthProfile: defaultFaceDepthProfile() } } : {}),
        ...(addTorsoVolume ? { torsoVolumeProfile: defaultTorsoVolumeProfile() } : {})
      }
    } : {})
  };
  const additions = { hairLayers, faceDepthProfile: addFaceDepth, torsoVolumeProfile: addTorsoVolume };
  const upToDate = Object.keys(overrides).length === 0;
  return {
    version: 1,
    task: "rig-extension-upgrade",
    project: project.name,
    projectDirectory: root,
    baseRevision,
    upToDate,
    additions,
    skipped,
    ...(!upToDate ? { patch: { baseRevision, label: "接入多房束、侧脸深度与躯干体积曲线", overrides } } : {})
  };
}

export async function planRigExtensionUpgrade(projectDirectory: string, options: RigExtensionUpgradeOptions = {}): Promise<RigExtensionUpgradePlan> {
  const root = resolve(projectDirectory);
  const [project, calibration] = await Promise.all([loadProject(root), loadCalibration(root)]);
  const imported = await importPsd(join(root, project.source.psdPath));
  return buildRigExtensionUpgradePlan({ projectDirectory: root, project, importedLayers: imported.layers, baseRevision: calibration.revision, options });
}
