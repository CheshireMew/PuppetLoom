import { eyeClosureBinding } from "./eye-closure-authoring.js";
import { loadProjectTextureSources } from "./offline-render.js";
import type { AuthoringOperation, CalibrationOverrides, LayerBinding, PuppetLoomProject } from "./types.js";

export interface EyeClosureProposal { operations: AuthoringOperation[]; overrides: CalibrationOverrides; }

/** Prepare original-art closure without mutating meshes or overwriting existing expression authoring. */
export async function prepareEyeClosure(projectDirectory: string, project: PuppetLoomProject, selected: LayerBinding[]): Promise<EyeClosureProposal> {
  const surfaces = selected.filter((layer) => ["eyeWhite", "eyelash", "iris", "eyeClosed"].includes(layer.role));
  const textures = await loadProjectTextureSources(projectDirectory, project);
  const operations: AuthoringOperation[] = [];
  const layers: NonNullable<CalibrationOverrides["layers"]> = {};
  for (const side of ["left", "right"] as const) {
    const eye = surfaces.filter((layer) => layer.side === side && layer.visible !== false);
    if (!eye.length) continue;
    const whites = eye.filter((layer) => layer.role === "eyeWhite");
    const lashes = eye.filter((layer) => layer.role === "eyelash");
    if (whites.length !== 1 || lashes.length !== 1) throw new Error(`${side} 眼需要明确的一层眼白和一层睫毛，不能猜测变体配对。`);
    const white = whites[0]!;
    const blinkIds = new Set(project.model.parameters.filter((p) => ["blink", "blink-left", "blink-right"].includes(p.semantic ?? "")).map((p) => p.id));
    for (const layer of eye) {
      const ancestors = new Set<string>();
      let parent = layer.deformerId;
      while (parent && !ancestors.has(parent)) {
        ancestors.add(parent);
        parent = project.model.deformers.find((deformer) => deformer.id === parent)?.parentId;
      }
      if (project.model.bindings.some((binding) => binding.target.kind === "deformer" && ancestors.has(binding.target.id)
        && binding.parameterIds.some((id) => blinkIds.has(id)))) {
        throw new Error(`${layer.sourceName} 的父级已有眨眼绑定，保留原绑定，不能叠加自动闭合。`);
      }
      const existing = project.model.bindings.filter((binding) => binding.target.kind === "layer" && binding.target.id === layer.id && binding.parameterIds.some((id) => blinkIds.has(id)));
      if (existing.some((binding) => binding.id !== `eye-closure-${layer.id}`)) throw new Error(`${layer.sourceName} 已有自定义眨眼绑定，保留原绑定；请先明确采用哪套闭合造型。`);
      layers[layer.id] = { blinkMode: "geometry", ...(layer.role === "iris" ? { clipLayerId: white.id } : {}) };
      for (const binding of existing) if (binding.blinkMode !== "geometry") {
        operations.push({ op: "upsert-binding", binding: { ...binding, blinkMode: "geometry" } });
      }
      if (!["eyeWhite", "eyelash"].includes(layer.role) || existing.length) continue;
      operations.push({ op: "upsert-binding", binding: eyeClosureBinding(layer, textures.get(layer.id)!, white, textures.get(white.id)!, `param-blink-${side}`) });
    }
  }
  return { operations, overrides: { layers, runtime: { features: { blink: true } } } };
}
