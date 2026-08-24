import type { ModelBehavior, ModelExpression, MotionParameterSemantic, PuppetLoomProject } from "./types.js";

/**
 * Returns whether a semantic parameter can produce a visible result in the
 * current project. Blink and mouth motion are replacement-art capabilities;
 * their parameters may still exist in older projects even when the required
 * artwork is absent.
 */
export function isMotionSemanticAvailable(project: PuppetLoomProject, semantic: MotionParameterSemantic | undefined): boolean {
  if (semantic === "blink") return project.runtime.features.blink;
  if (semantic === "mouth-open") return project.runtime.features.mouthMotion;
  return true;
}

export function isModelParameterAvailable(project: PuppetLoomProject, parameterId: string): boolean {
  const parameter = project.model.parameters.find((candidate) => candidate.id === parameterId);
  return Boolean(parameter && isMotionSemanticAvailable(project, parameter.semantic));
}

export function isModelExpressionAvailable(project: PuppetLoomProject, expression: ModelExpression): boolean {
  return Object.entries(expression.parameters).some(([parameterId, value]) => value !== 0 && isModelParameterAvailable(project, parameterId));
}

export function isModelBehaviorAvailable(project: PuppetLoomProject, behavior: ModelBehavior): boolean {
  return behavior.tracks.some((track) => track.target.kind === "parameter"
    ? isModelParameterAvailable(project, track.target.id)
    : project.model.expressions.some((expression) => expression.id === track.target.id && isModelExpressionAvailable(project, expression)));
}
