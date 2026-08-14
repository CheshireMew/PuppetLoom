import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadProject } from "./project.js";
import { applySafetyLimits } from "./safety.js";
import type { VerifyResult } from "./types.js";

export async function verifyProject(projectDirectory: string): Promise<VerifyResult> {
  const root = resolve(projectDirectory);
  const project = applySafetyLimits(await loadProject(root));
  const missingTextures: string[] = [];
  for (const layer of project.layers) {
    try {
      await access(join(root, layer.texture));
    } catch {
      missingTextures.push(layer.texture);
    }
  }
  const failedPoses = project.quality.poseValidations.filter((pose) => !pose.passed);
  const warnings = [
    ...project.disabledReasons,
    ...(failedPoses.length > 0 ? [`${failedPoses.length} 个姿态未通过安全检查。`] : []),
    ...(missingTextures.length > 0 ? [`缺少 ${missingTextures.length} 个纹理文件。`] : [])
  ];
  return {
    valid: missingTextures.length === 0 && failedPoses.length === 0,
    project: project.name,
    rigLevel: project.rigLevel,
    textureCount: project.layers.length,
    missingTextures,
    quality: project.quality,
    warnings
  };
}
