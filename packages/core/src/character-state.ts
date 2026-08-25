import type { CharacterStateSelection, MotionState, PuppetLoomProject } from "./types.js";

export interface ResolvedCharacterState {
  presetId?: string;
  variants: Record<string, string>;
  props: string[];
  parameters: Record<string, number>;
  expressions: Record<string, number>;
}

export function resolveCharacterState(project: PuppetLoomProject, selection: CharacterStateSelection | undefined): ResolvedCharacterState {
  const production = project.production;
  if (!production) return { variants: {}, props: [], parameters: {}, expressions: {} };
  const preset = selection?.presetId ? production.presets.find((candidate) => candidate.id === selection.presetId) : undefined;
  const variants = Object.fromEntries(production.variants.map((group) => [group.id, group.defaultOptionId]));
  Object.assign(variants, preset?.variants ?? {}, selection?.variants ?? {});
  const props = selection?.props ?? preset?.props ?? production.props.filter((prop) => prop.defaultEnabled).map((prop) => prop.id);
  return {
    ...(preset ? { presetId: preset.id } : {}),
    variants,
    props: [...new Set(props)],
    parameters: { ...(preset?.parameters ?? {}) },
    expressions: { ...(preset?.expressions ?? {}) }
  };
}

export function characterLayerVisible(project: PuppetLoomProject, layerId: string, state: MotionState): boolean {
  if (!project.production) return true;
  const selected = resolveCharacterState(project, state.characterState);
  for (const group of project.production.variants) {
    const containing = group.options.filter((option) => option.layerIds.includes(layerId));
    if (containing.length > 0 && !containing.some((option) => option.id === selected.variants[group.id])) return false;
  }
  const props = project.production.props.filter((prop) => prop.layerIds.includes(layerId));
  if (props.length > 0 && !props.some((prop) => selected.props.includes(prop.id))) return false;
  return true;
}

/** Applies preset-authored parameter and expression values before ordinary per-frame controls. */
export function characterMotionState(project: PuppetLoomProject, state: MotionState): MotionState {
  const selected = resolveCharacterState(project, state.characterState);
  if (Object.keys(selected.parameters).length === 0 && Object.keys(selected.expressions).length === 0) return state;
  return {
    ...state,
    parameters: { ...selected.parameters, ...(state.parameters ?? {}) },
    expressions: { ...selected.expressions, ...(state.expressions ?? {}) }
  };
}
