import { parsePuppetLoomProject } from "./project-format.js";
import type {
  AuthoringAudit,
  AuthoringOperation,
  AuthoringPatch,
  AuthoringPreview,
  LayerCalibrationOverride,
  ModelBinding,
  ModelBehavior,
  ModelDeformer,
  ModelExpression,
  ModelParameter,
  ModelPhysics,
  PuppetLoomProject
} from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function upsertById<T extends { id: string }>(values: T[], value: T): void {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index < 0) values.push(clone(value));
  else values[index] = clone(value);
}

function requireExisting<T extends { id: string }>(values: T[], id: string, label: string): T {
  const value = values.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`${label}不存在：${id}`);
  return value;
}

function descendantDeformerIds(deformers: ModelDeformer[], rootId: string): Set<string> {
  const result = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const deformer of deformers) {
      if (deformer.parentId && result.has(deformer.parentId) && !result.has(deformer.id)) {
        result.add(deformer.id);
        changed = true;
      }
    }
  }
  return result;
}

function moveLayer(project: PuppetLoomProject, operation: Extract<AuthoringOperation, { op: "move-layer" }>): void {
  const references = [operation.beforeLayerId, operation.afterLayerId].filter((value): value is string => Boolean(value));
  if (references.length !== 1) throw new Error("move-layer 必须且只能提供 beforeLayerId 或 afterLayerId。" );
  const target = requireExisting(project.layers, operation.layerId, "图层");
  const referenceId = references[0]!;
  if (referenceId === target.id) throw new Error("move-layer 的目标图层不能引用自身。" );
  requireExisting(project.layers, referenceId, "参照图层");
  const ordered = project.layers
    .map((layer, index) => ({ layer, index }))
    .sort((left, right) => left.layer.order - right.layer.order || left.index - right.index)
    .map((entry) => entry.layer)
    .filter((layer) => layer.id !== target.id);
  const referenceIndex = ordered.findIndex((layer) => layer.id === referenceId);
  const insertIndex = operation.beforeLayerId ? referenceIndex : referenceIndex + 1;
  ordered.splice(insertIndex, 0, target);
  ordered.forEach((layer, index) => { layer.order = index; });
  project.layers = ordered;
}

/** Applies ordered, semantic authoring operations and validates the complete project graph. */
export function applyAuthoringOperations(project: PuppetLoomProject, operations: AuthoringOperation[]): PuppetLoomProject {
  const next = clone(parsePuppetLoomProject(project));
  for (const operation of operations) {
    if (operation.op === "upsert-parameter") {
      upsertById(next.model.parameters, operation.parameter);
      continue;
    }
    if (operation.op === "remove-parameter") {
      requireExisting(next.model.parameters, operation.id, "参数");
      const hasDependencies = next.model.bindings.some((binding) => binding.parameterIds.includes(operation.id))
        || next.model.expressions.some((expression) => operation.id in expression.parameters)
        || next.model.physics.some((physics) => physics.inputParameterId === operation.id || physics.outputParameterId === operation.id)
        || next.model.behaviors.some((behavior) => behavior.tracks.some((track) => track.target.kind === "parameter" && track.target.id === operation.id));
      if (hasDependencies && !operation.cascade) throw new Error(`参数 ${operation.id} 仍被绑定、表情、物理或行为引用；如需同时移除依赖，请显式设置 cascade。`);
      next.model.parameters = next.model.parameters.filter((parameter) => parameter.id !== operation.id);
      if (operation.cascade) {
        next.model.bindings = next.model.bindings.filter((binding) => !binding.parameterIds.includes(operation.id));
        for (const expression of next.model.expressions) delete expression.parameters[operation.id];
        next.model.physics = next.model.physics.filter((physics) => physics.inputParameterId !== operation.id && physics.outputParameterId !== operation.id);
        next.model.behaviors = next.model.behaviors.flatMap((behavior) => {
          const tracks = behavior.tracks.filter((track) => track.target.kind !== "parameter" || track.target.id !== operation.id);
          return tracks.length > 0 ? [{ ...behavior, tracks }] : [];
        });
      }
      continue;
    }
    if (operation.op === "upsert-deformer") {
      upsertById(next.model.deformers, operation.deformer);
      continue;
    }
    if (operation.op === "remove-deformer") {
      requireExisting(next.model.deformers, operation.id, "变形器");
      const removedIds = operation.cascade ? descendantDeformerIds(next.model.deformers, operation.id) : new Set([operation.id]);
      const children = next.model.deformers.filter((deformer) => deformer.parentId && removedIds.has(deformer.parentId) && !removedIds.has(deformer.id));
      const bindings = next.model.bindings.filter((binding) => binding.target.kind === "deformer" && removedIds.has(binding.target.id));
      const attachedLayers = next.layers.filter((layer) => layer.deformerId && removedIds.has(layer.deformerId));
      if (!operation.cascade && (children.length > 0 || bindings.length > 0 || attachedLayers.length > 0)) {
        throw new Error(`变形器 ${operation.id} 仍有子变形器、绑定或图层引用；如需清理整条依赖链，请显式设置 cascade。`);
      }
      next.model.deformers = next.model.deformers.filter((deformer) => !removedIds.has(deformer.id));
      next.model.bindings = next.model.bindings.filter((binding) => binding.target.kind !== "deformer" || !removedIds.has(binding.target.id));
      for (const layer of next.layers) if (layer.deformerId && removedIds.has(layer.deformerId)) delete layer.deformerId;
      continue;
    }
    if (operation.op === "set-layer-deformer") {
      const layer = requireExisting(next.layers, operation.layerId, "图层");
      if (operation.deformerId !== null) requireExisting(next.model.deformers, operation.deformerId, "变形器");
      if (operation.deformerId === null) delete layer.deformerId;
      else layer.deformerId = operation.deformerId;
      continue;
    }
    if (operation.op === "move-layer") {
      moveLayer(next, operation);
      continue;
    }
    if (operation.op === "upsert-binding") {
      upsertById(next.model.bindings, operation.binding);
      continue;
    }
    if (operation.op === "remove-binding") {
      requireExisting(next.model.bindings, operation.id, "绑定");
      next.model.bindings = next.model.bindings.filter((binding) => binding.id !== operation.id);
      continue;
    }
    if (operation.op === "upsert-expression") {
      upsertById(next.model.expressions, operation.expression);
      continue;
    }
    if (operation.op === "remove-expression") {
      requireExisting(next.model.expressions, operation.id, "表情");
      const dependent = next.model.behaviors.some((behavior) => behavior.tracks.some((track) => track.target.kind === "expression" && track.target.id === operation.id));
      if (dependent && !operation.cascade) throw new Error(`表情 ${operation.id} 仍被行为引用；如需同时移除行为轨道，请显式设置 cascade。`);
      next.model.expressions = next.model.expressions.filter((expression) => expression.id !== operation.id);
      if (operation.cascade) next.model.behaviors = next.model.behaviors.flatMap((behavior) => {
        const tracks = behavior.tracks.filter((track) => track.target.kind !== "expression" || track.target.id !== operation.id);
        return tracks.length > 0 ? [{ ...behavior, tracks }] : [];
      });
      continue;
    }
    if (operation.op === "upsert-physics") {
      upsertById(next.model.physics, operation.physics);
      continue;
    }
    if (operation.op === "remove-physics") {
      requireExisting(next.model.physics, operation.id, "物理组");
      next.model.physics = next.model.physics.filter((physics) => physics.id !== operation.id);
      continue;
    }
    if (operation.op === "upsert-behavior") {
      upsertById(next.model.behaviors, operation.behavior);
      continue;
    }
    if (operation.op === "remove-behavior") {
      requireExisting(next.model.behaviors, operation.id, "行为");
      next.model.behaviors = next.model.behaviors.filter((behavior) => behavior.id !== operation.id);
    }
  }
  return parsePuppetLoomProject(next);
}

function previewId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "preview";
}

function bindingPreviews(binding: ModelBinding, prefix: string): AuthoringPreview[] {
  return binding.keyforms.map((keyform, index) => ({
    id: previewId(`${prefix}-${binding.id}-${index + 1}`),
    label: `${binding.id} · ${keyform.values.join(", ")}`,
    parameters: Object.fromEntries(binding.parameterIds.map((id, axis) => [id, keyform.values[axis]!]))
  }));
}

function validatePreviews(previews: AuthoringPreview[], projects: PuppetLoomProject[]): AuthoringPreview[] {
  const parameters = new Map(projects.flatMap((project) => project.model.parameters).map((parameter) => [parameter.id, parameter]));
  const expressions = new Set(projects.flatMap((project) => project.model.expressions.map((expression) => expression.id)));
  const behaviors = new Set(projects.flatMap((project) => project.model.behaviors.map((behavior) => behavior.id)));
  const ids = new Set<string>();
  for (const preview of previews) {
    if (ids.has(preview.id)) throw new Error(`预览 ID 重复：${preview.id}`);
    ids.add(preview.id);
    for (const [id, value] of Object.entries(preview.parameters ?? {})) {
      const parameter = parameters.get(id);
      if (!parameter) throw new Error(`预览 ${preview.id} 引用了不存在的参数：${id}`);
      if (value < parameter.min || value > parameter.max) throw new Error(`预览 ${preview.id} 的参数 ${id} 超出 ${parameter.min}..${parameter.max}。`);
    }
    for (const id of Object.keys(preview.expressions ?? {})) if (!expressions.has(id)) throw new Error(`预览 ${preview.id} 引用了不存在的表情：${id}`);
    if (preview.behavior && !behaviors.has(preview.behavior.id)) throw new Error(`预览 ${preview.id} 引用了不存在的行为：${preview.behavior.id}`);
  }
  return previews;
}

function bindingFromOperation(operation: AuthoringOperation, before: PuppetLoomProject): ModelBinding | undefined {
  if (operation.op === "upsert-binding") return operation.binding;
  if (operation.op === "remove-binding") return before.model.bindings.find((binding) => binding.id === operation.id);
  return undefined;
}

function expressionFromOperation(operation: AuthoringOperation, before: PuppetLoomProject): ModelExpression | undefined {
  if (operation.op === "upsert-expression") return operation.expression;
  if (operation.op === "remove-expression") return before.model.expressions.find((expression) => expression.id === operation.id);
  return undefined;
}

function physicsFromOperation(operation: AuthoringOperation, before: PuppetLoomProject): ModelPhysics | undefined {
  if (operation.op === "upsert-physics") return operation.physics;
  if (operation.op === "remove-physics") return before.model.physics.find((physics) => physics.id === operation.id);
  return undefined;
}

function behaviorFromOperation(operation: AuthoringOperation, before: PuppetLoomProject): ModelBehavior | undefined {
  if (operation.op === "upsert-behavior") return operation.behavior;
  if (operation.op === "remove-behavior") return before.model.behaviors.find((behavior) => behavior.id === operation.id);
  return undefined;
}

export function buildAuthoringAudit(patch: AuthoringPatch, before: PuppetLoomProject, after: PuppetLoomProject): AuthoringAudit {
  const explicit = patch.previews ?? [];
  const inferred = explicit.length > 0 ? [] : patch.operations.flatMap((operation, index) => {
    const binding = bindingFromOperation(operation, before);
    if (binding) return bindingPreviews(binding, `op-${index + 1}`);
    const expression = expressionFromOperation(operation, before);
    if (expression) return [{ id: previewId(`op-${index + 1}-${expression.id}`), label: expression.name, expressions: { [expression.id]: 1 } }];
    const physics = physicsFromOperation(operation, before);
    if (physics) {
      const parameter = [...before.model.parameters, ...after.model.parameters].find((candidate) => candidate.id === physics.inputParameterId);
      return parameter ? [parameter.min, parameter.max].map((value, previewIndex) => ({
        id: previewId(`op-${index + 1}-${physics.id}-${previewIndex + 1}`),
        label: `${physics.name} · ${physics.inputParameterId} ${value}`,
        parameters: { [physics.inputParameterId]: value },
        settleSeconds: Math.min(5, Math.max(0.5, 6 / physics.response))
      })) : [];
    }
    const behavior = behaviorFromOperation(operation, before);
    if (behavior) {
      const times = [...new Set(behavior.tracks.flatMap((track) => track.keyframes.map((keyframe) => keyframe.time)))].slice(0, 12);
      return times.map((time, previewIndex) => ({
        id: previewId(`op-${index + 1}-${behavior.id}-${previewIndex + 1}`),
        label: `${behavior.name} · ${time.toFixed(2)}s`,
        behavior: { id: behavior.id, timeSeconds: time }
      }));
    }
    return [];
  });
  const deduplicated = [...explicit, ...inferred].filter((preview, index, all) => all.findIndex((candidate) => JSON.stringify({
    parameters: candidate.parameters,
    expressions: candidate.expressions,
    behavior: candidate.behavior,
    settleSeconds: candidate.settleSeconds
  }) === JSON.stringify({
    parameters: preview.parameters,
    expressions: preview.expressions,
    behavior: preview.behavior,
    settleSeconds: preview.settleSeconds
  })) === index).slice(0, 12);
  return { version: 1, operations: clone(patch.operations), previews: validatePreviews(deduplicated, [before, after]) };
}

export function authoringLayerOverrides(before: PuppetLoomProject, after: PuppetLoomProject): Record<string, LayerCalibrationOverride> {
  return Object.fromEntries(after.layers.flatMap((layer) => {
    const previous = before.layers.find((candidate) => candidate.id === layer.id);
    if (!previous) return [];
    const override: LayerCalibrationOverride = {};
    if (previous.deformerId !== layer.deformerId) override.deformerId = layer.deformerId ?? null;
    if (previous.order !== layer.order) override.order = layer.order;
    return Object.keys(override).length > 0 ? [[layer.id, override]] : [];
  }));
}

export function authoringSummary(project: PuppetLoomProject, revision: number): {
  project: string;
  revision: number;
  parameters: ModelParameter[];
  deformers: ModelDeformer[];
  bindings: ModelBinding[];
  expressions: ModelExpression[];
  physics: PuppetLoomProject["model"]["physics"];
  behaviors: PuppetLoomProject["model"]["behaviors"];
  layerAttachments: Array<{ layerId: string; deformerId: string }>;
  layerOrder: Array<{ layerId: string; role: string; order: number }>;
} {
  return {
    project: project.name,
    revision,
    parameters: project.model.parameters,
    deformers: project.model.deformers,
    bindings: project.model.bindings,
    expressions: project.model.expressions,
    physics: project.model.physics,
    behaviors: project.model.behaviors,
    layerAttachments: project.layers.flatMap((layer) => layer.deformerId ? [{ layerId: layer.id, deformerId: layer.deformerId }] : []),
    layerOrder: project.layers.map((layer) => ({ layerId: layer.id, role: layer.role, order: layer.order })).sort((left, right) => left.order - right.order)
  };
}
