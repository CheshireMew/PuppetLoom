import type {
  AuthoringModel,
  KeyformTransform,
  LayerBinding,
  ModelBinding,
  ModelBehavior,
  ModelDeformer,
  ModelKeyform,
  ModelParameter,
  ModelPhysics,
  MotionParameterSemantic,
  MotionState,
  Point,
  PuppetLoomProject,
  WarpDeformer
} from "./types.js";

const semanticFields: Record<MotionParameterSemantic, keyof MotionState> = {
  "head-yaw": "headYaw",
  "head-pitch": "headPitch",
  "head-roll": "headRoll",
  "body-sway": "bodySway",
  "body-pitch": "bodyPitch",
  "body-roll": "bodyRoll",
  "gaze-x": "gazeX",
  "gaze-y": "gazeY",
  breath: "breath",
  blink: "blink",
  "blink-left": "blinkLeft",
  "blink-right": "blinkRight",
  "brow-left": "browLeft",
  "brow-right": "browRight",
  smile: "smile",
  "cheek-puff": "cheekPuff",
  "mouth-open": "mouthOpen",
  "mouth-a": "mouthA",
  "mouth-i": "mouthI",
  "mouth-u": "mouthU",
  "mouth-e": "mouthE",
  "mouth-o": "mouthO",
  "arm-left": "armLeft",
  "arm-right": "armRight",
  "hand-left-x": "handLeftX",
  "hand-left-y": "handLeftY",
  "hand-right-x": "handRightX",
  "hand-right-y": "handRightY",
  "hand-left-open": "handLeftOpen",
  "hand-right-open": "handRightOpen",
  "ear-x": "earX",
  "ear-y": "earY",
  "tail-x": "tailX",
  "tail-y": "tailY"
};

const builtInParameters: Array<Pick<ModelParameter, "id" | "name" | "group" | "min" | "default" | "max" | "semantic">> = [
  { id: "param-head-yaw", name: "Head Yaw", group: "Head", min: -1, default: 0, max: 1, semantic: "head-yaw" },
  { id: "param-head-pitch", name: "Head Pitch", group: "Head", min: -1, default: 0, max: 1, semantic: "head-pitch" },
  { id: "param-head-roll", name: "Head Roll", group: "Head", min: -1, default: 0, max: 1, semantic: "head-roll" },
  { id: "param-body-sway", name: "Body Sway", group: "Body", min: -1, default: 0, max: 1, semantic: "body-sway" },
  { id: "param-body-pitch", name: "Body Pitch", group: "Body", min: -1, default: 0, max: 1, semantic: "body-pitch" },
  { id: "param-body-roll", name: "Body Roll", group: "Body", min: -1, default: 0, max: 1, semantic: "body-roll" },
  { id: "param-gaze-x", name: "Gaze X", group: "Eyes", min: -1, default: 0, max: 1, semantic: "gaze-x" },
  { id: "param-gaze-y", name: "Gaze Y", group: "Eyes", min: -1, default: 0, max: 1, semantic: "gaze-y" },
  { id: "param-breath", name: "Breath", group: "Body", min: -1, default: 0, max: 1, semantic: "breath" },
  { id: "param-blink", name: "Blink", group: "Eyes", min: 0, default: 0, max: 1, semantic: "blink" },
  { id: "param-mouth-open", name: "Mouth Open", group: "Mouth", min: 0, default: 0, max: 1, semantic: "mouth-open" }
  , { id: "param-blink-left", name: "Blink Left", group: "Eyes", min: 0, default: 0, max: 1, semantic: "blink-left" }
  , { id: "param-blink-right", name: "Blink Right", group: "Eyes", min: 0, default: 0, max: 1, semantic: "blink-right" }
  , { id: "param-brow-left", name: "Brow Left", group: "Face", min: -1, default: 0, max: 1, semantic: "brow-left" }
  , { id: "param-brow-right", name: "Brow Right", group: "Face", min: -1, default: 0, max: 1, semantic: "brow-right" }
  , { id: "param-smile", name: "Smile", group: "Face", min: 0, default: 0, max: 1, semantic: "smile" }
  , { id: "param-cheek-puff", name: "Cheek Puff", group: "Face", min: 0, default: 0, max: 1, semantic: "cheek-puff" }
  , { id: "param-mouth-a", name: "Mouth A", group: "Visemes", min: 0, default: 0, max: 1, semantic: "mouth-a" }
  , { id: "param-mouth-i", name: "Mouth I", group: "Visemes", min: 0, default: 0, max: 1, semantic: "mouth-i" }
  , { id: "param-mouth-u", name: "Mouth U", group: "Visemes", min: 0, default: 0, max: 1, semantic: "mouth-u" }
  , { id: "param-mouth-e", name: "Mouth E", group: "Visemes", min: 0, default: 0, max: 1, semantic: "mouth-e" }
  , { id: "param-mouth-o", name: "Mouth O", group: "Visemes", min: 0, default: 0, max: 1, semantic: "mouth-o" }
];

export function createDefaultAuthoringModel(): AuthoringModel {
  return {
    parameters: builtInParameters.map((parameter) => ({ ...parameter, kind: "continuous" })),
    deformers: [],
    bindings: [],
    expressions: [],
    physics: [],
    behaviors: []
  };
}

interface ModelIndex {
  model: AuthoringModel;
  parametersById: Map<string, ModelParameter>;
  behaviorsById: Map<string, ModelBehavior>;
  bindingsByTarget: Map<string, ModelBinding[]>;
}

const normalizedModelCache = new WeakMap<PuppetLoomProject, { source: PuppetLoomProject["model"]; model: AuthoringModel }>();
const modelIndexCache = new WeakMap<AuthoringModel, ModelIndex>();
const emptyBindings: ModelBinding[] = [];

function modelFor(project: PuppetLoomProject): AuthoringModel {
  const source = project.model;
  const cached = normalizedModelCache.get(project);
  if (cached && cached.source === source) return cached.model;
  const model = source
    ? { ...source, expressions: source.expressions ?? [], physics: source.physics ?? [], behaviors: source.behaviors ?? [] }
    : createDefaultAuthoringModel();
  normalizedModelCache.set(project, { source, model });
  return model;
}

function bindingTargetKey(kind: "layer" | "deformer", id: string): string {
  return `${kind}:${id}`;
}

function modelIndexFor(project: PuppetLoomProject): ModelIndex {
  const model = modelFor(project);
  const cached = modelIndexCache.get(model);
  if (cached) return cached;
  const bindingsByTarget = new Map<string, ModelBinding[]>();
  for (const binding of model.bindings) {
    const key = bindingTargetKey(binding.target.kind, binding.target.id);
    const bindings = bindingsByTarget.get(key);
    if (bindings) bindings.push(binding);
    else bindingsByTarget.set(key, [binding]);
  }
  const index = {
    model,
    parametersById: new Map(model.parameters.map((parameter) => [parameter.id, parameter])),
    behaviorsById: new Map(model.behaviors.map((behavior) => [behavior.id, behavior])),
    bindingsByTarget
  };
  modelIndexCache.set(model, index);
  return index;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function wrapped(value: number, parameter: ModelParameter): number {
  if (!parameter.repeat || parameter.max <= parameter.min) return clamp(value, parameter.min, parameter.max);
  const range = parameter.max - parameter.min;
  return ((value - parameter.min) % range + range) % range + parameter.min;
}

function eased(value: number, easing: "linear" | "smoothstep" | "hold"): number {
  if (easing === "hold") return 0;
  if (easing === "linear") return value;
  return value * value * (3 - 2 * value);
}

function behaviorTime(behavior: ModelBehavior, timeSeconds: number): number {
  if (!behavior.loop) return clamp(timeSeconds, 0, behavior.duration);
  return ((timeSeconds % behavior.duration) + behavior.duration) % behavior.duration;
}

function trackValue(track: ModelBehavior["tracks"][number], timeSeconds: number): number {
  const frames = track.keyframes;
  if (timeSeconds <= frames[0]!.time) return frames[0]!.value;
  if (timeSeconds >= frames.at(-1)!.time) return frames.at(-1)!.value;
  for (let index = 0; index < frames.length - 1; index += 1) {
    const left = frames[index]!;
    const right = frames[index + 1]!;
    if (timeSeconds <= right.time) {
      const amount = eased((timeSeconds - left.time) / Math.max(1e-12, right.time - left.time), right.easing ?? "smoothstep");
      return left.value * (1 - amount) + right.value * amount;
    }
  }
  return frames.at(-1)!.value;
}

function activeBehaviorValues(project: PuppetLoomProject, state: MotionState): {
  parameters: Record<string, number>;
  expressions: Record<string, number>;
} {
  const values = { parameters: {} as Record<string, number>, expressions: { ...(state.expressions ?? {}) } };
  const index = modelIndexFor(project);
  const model = index.model;
  const active: Array<{ behavior: ModelBehavior; timeSeconds: number; weight: number }> = [];
  if (state.timeSeconds !== undefined) {
    for (const behavior of model.behaviors) if (behavior.autoplay) active.push({ behavior, timeSeconds: state.timeSeconds, weight: 1 });
  }
  if (state.behavior) {
    const behavior = index.behaviorsById.get(state.behavior.id);
    if (behavior) active.push({ behavior, timeSeconds: state.behavior.timeSeconds, weight: clamp(state.behavior.weight ?? 1, 0, 1) });
  }
  for (const entry of active) {
    const local = behaviorTime(entry.behavior, entry.timeSeconds);
    for (const track of entry.behavior.tracks) {
      const value = trackValue(track, local);
      if (track.target.kind === "parameter") {
        const parameter = index.parametersById.get(track.target.id);
        values.parameters[track.target.id] = parameter ? parameter.default + (value - parameter.default) * entry.weight : value;
      } else values.expressions[track.target.id] = clamp(value * entry.weight, 0, 1);
    }
  }
  return values;
}

export function resolveParameterValues(project: PuppetLoomProject, state: MotionState): Record<string, number> {
  const resolved: Record<string, number> = {};
  const index = modelIndexFor(project);
  const model = index.model;
  const behaviorValues = activeBehaviorValues(project, state);
  for (const parameter of model.parameters) {
    const semanticField = parameter.semantic ? semanticFields[parameter.semantic] : undefined;
    const directSemanticValue = semanticField ? state[semanticField] : undefined;
    const semanticValue = directSemanticValue === undefined && (parameter.semantic === "blink-left" || parameter.semantic === "blink-right")
      ? state.blink
      : directSemanticValue;
    const candidate = typeof semanticValue === "number"
        ? semanticValue
        : parameter.default;
    resolved[parameter.id] = wrapped(candidate, parameter);
  }
  for (const expression of model.expressions) {
    const weight = clamp(behaviorValues.expressions[expression.id] ?? 0, 0, 1);
    if (weight <= 0) continue;
    for (const [parameterId, target] of Object.entries(expression.parameters)) {
      const parameter = index.parametersById.get(parameterId);
      if (!parameter) continue;
      resolved[parameterId] = wrapped((resolved[parameterId] ?? parameter.default) + (target - parameter.default) * weight, parameter);
    }
  }
  for (const [parameterId, value] of Object.entries(behaviorValues.parameters)) {
    const parameter = index.parametersById.get(parameterId);
    if (parameter) resolved[parameterId] = wrapped(value, parameter);
  }
  for (const [parameterId, value] of Object.entries(state.parameters ?? {})) {
    const parameter = index.parametersById.get(parameterId);
    if (parameter) resolved[parameterId] = wrapped(value, parameter);
  }
  return resolved;
}

interface PhysicsAxis {
  value: number;
  velocity: number;
}

function orderedPhysics(groups: ModelPhysics[]): ModelPhysics[] {
  const result: ModelPhysics[] = [];
  const visited = new Set<string>();
  const visit = (group: ModelPhysics): void => {
    if (visited.has(group.id)) return;
    const prerequisite = groups.find((candidate) => candidate.outputParameterId === group.inputParameterId);
    if (prerequisite) visit(prerequisite);
    visited.add(group.id);
    result.push(group);
  };
  groups.forEach(visit);
  return result;
}

/** Stateful, deterministic runtime for authored parameter physics. */
export class ModelPhysicsController {
  private readonly axes = new Map<string, PhysicsAxis>();
  private lastTime: number | undefined;

  constructor(private readonly project: PuppetLoomProject) {
    for (const group of modelFor(project).physics) this.axes.set(group.id, { value: 0, velocity: 0 });
  }

  reset(): void {
    this.lastTime = undefined;
    for (const axis of this.axes.values()) { axis.value = 0; axis.velocity = 0; }
  }

  sample(state: MotionState, timeSeconds = state.timeSeconds ?? 0): MotionState {
    const index = modelIndexFor(this.project);
    const model = index.model;
    if (model.physics.length === 0) return { ...state, timeSeconds };
    const delta = this.lastTime === undefined ? 1 / 60 : clamp(timeSeconds - this.lastTime, 1 / 240, 0.05);
    this.lastTime = timeSeconds;
    const parameters = resolveParameterValues(this.project, { ...state, timeSeconds });
    for (const group of orderedPhysics(model.physics)) {
      const input = index.parametersById.get(group.inputParameterId)!;
      const output = index.parametersById.get(group.outputParameterId)!;
      const axis = this.axes.get(group.id)!;
      const target = ((parameters[input.id] ?? input.default) - input.default) * group.inputScale;
      const acceleration = (target - axis.value) * group.response * group.response - 2 * group.damping * group.response * axis.velocity;
      axis.velocity += acceleration * delta;
      axis.value += axis.velocity * delta;
      if (state.parameters?.[output.id] === undefined) parameters[output.id] = wrapped(output.default + axis.value * group.outputScale, output);
    }
    return { ...state, timeSeconds, parameters };
  }
}

export function resolveMotionState(project: PuppetLoomProject, state: MotionState): MotionState {
  const parameters = resolveParameterValues(project, state);
  const next = { ...state, parameters };
  for (const parameter of modelFor(project).parameters) {
    if (!parameter.semantic) continue;
    const field = semanticFields[parameter.semantic];
    const value = parameters[parameter.id];
    if (value !== undefined) (next as unknown as Record<string, unknown>)[field] = value;
  }
  return next;
}

interface WeightedKeyform {
  keyform: ModelKeyform;
  weight: number;
}

interface BindingKeyformIndex {
  xs: number[];
  ys: number[];
  byX: Map<number, ModelKeyform>;
  byCoordinate: Map<string, ModelKeyform>;
}

const bindingKeyformIndexCache = new WeakMap<ModelBinding, BindingKeyformIndex>();

function bindingKeyformIndex(binding: ModelBinding): BindingKeyformIndex {
  const cached = bindingKeyformIndexCache.get(binding);
  if (cached) return cached;
  const index = {
    xs: [...new Set(binding.keyforms.map((keyform) => keyform.values[0]))].sort((left, right) => left - right),
    ys: [...new Set(binding.keyforms.map((keyform) => keyform.values[1] ?? 0))].sort((left, right) => left - right),
    byX: new Map(binding.keyforms.map((keyform) => [keyform.values[0], keyform])),
    byCoordinate: new Map(binding.keyforms.map((keyform) => [`${keyform.values[0]}:${keyform.values[1] ?? 0}`, keyform]))
  };
  bindingKeyformIndexCache.set(binding, index);
  return index;
}

function interval(values: number[], current: number): [number, number, number] {
  if (values.length === 0) return [0, 0, 0];
  if (current <= values[0]!) return [values[0]!, values[0]!, 0];
  if (current >= values.at(-1)!) return [values.at(-1)!, values.at(-1)!, 0];
  for (let index = 0; index < values.length - 1; index += 1) {
    const lower = values[index]!;
    const upper = values[index + 1]!;
    if (current <= upper) return [lower, upper, (current - lower) / Math.max(1e-12, upper - lower)];
  }
  return [values.at(-1)!, values.at(-1)!, 0];
}

function weightedKeyforms(binding: ModelBinding, parameters: Record<string, number>): WeightedKeyform[] {
  const x = parameters[binding.parameterIds[0]] ?? 0;
  const index = bindingKeyformIndex(binding);
  if (binding.parameterIds.length === 1) {
    const [lower, upper, amount] = interval(index.xs, x);
    const low = index.byX.get(lower)!;
    if (lower === upper) return [{ keyform: low, weight: 1 }];
    const high = index.byX.get(upper)!;
    return [{ keyform: low, weight: 1 - amount }, { keyform: high, weight: amount }];
  }
  const y = parameters[binding.parameterIds[1]] ?? 0;
  const [x0, x1, tx] = interval(index.xs, x);
  const [y0, y1, ty] = interval(index.ys, y);
  const at = (keyX: number, keyY: number): ModelKeyform => index.byCoordinate.get(`${keyX}:${keyY}`)!;
  if (x0 === x1 && y0 === y1) return [{ keyform: at(x0, y0), weight: 1 }];
  if (x0 === x1) return [{ keyform: at(x0, y0), weight: 1 - ty }, { keyform: at(x0, y1), weight: ty }];
  if (y0 === y1) return [{ keyform: at(x0, y0), weight: 1 - tx }, { keyform: at(x1, y0), weight: tx }];
  return [
    { keyform: at(x0, y0), weight: (1 - tx) * (1 - ty) },
    { keyform: at(x1, y0), weight: tx * (1 - ty) },
    { keyform: at(x0, y1), weight: (1 - tx) * ty },
    { keyform: at(x1, y1), weight: tx * ty }
  ];
}

function addPoint(target: Point, source: Point | undefined, weight: number): void {
  if (!source) return;
  target.x += source.x * weight;
  target.y += source.y * weight;
}

function addSampledPoint(target: Point, weights: WeightedKeyform[], property: "meshPointDeltas" | "warpPointDeltas", index: number): void {
  for (const entry of weights) addPoint(target, entry.keyform[property]?.[String(index)], entry.weight);
}

function sampledNumber(weights: WeightedKeyform[], property: "opacityMultiplier" | "drawOrderOffset", fallback: number): number {
  return weights.reduce((sum, entry) => sum + (entry.keyform[property] ?? fallback) * entry.weight, 0);
}

function sampledTransform(weights: WeightedKeyform[]): Required<KeyformTransform> {
  const transform = { translation: { x: 0, y: 0 }, rotationDegrees: 0, scale: { x: 1, y: 1 } };
  for (const entry of weights) {
    addPoint(transform.translation, entry.keyform.transform?.translation, entry.weight);
    transform.rotationDegrees += (entry.keyform.transform?.rotationDegrees ?? 0) * entry.weight;
    transform.scale.x += ((entry.keyform.transform?.scale?.x ?? 1) - 1) * entry.weight;
    transform.scale.y += ((entry.keyform.transform?.scale?.y ?? 1) - 1) * entry.weight;
  }
  return transform;
}

function transformPoint(point: Point, pivot: Point, transform: Required<KeyformTransform>): Point {
  const radians = transform.rotationDegrees * Math.PI / 180;
  const x = (point.x - pivot.x) * transform.scale.x;
  const y = (point.y - pivot.y) * transform.scale.y;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: pivot.x + x * cosine - y * sine + transform.translation.x,
    y: pivot.y + x * sine + y * cosine + transform.translation.y
  };
}

function warpPoint(point: Point, deformer: WarpDeformer, controlPoints: Point[]): Point {
  const u = clamp((point.x - deformer.bounds.x) / deformer.bounds.width, 0, 1) * (deformer.cols - 1);
  const v = clamp((point.y - deformer.bounds.y) / deformer.bounds.height, 0, 1) * (deformer.rows - 1);
  const column = Math.min(deformer.cols - 2, Math.floor(u));
  const row = Math.min(deformer.rows - 2, Math.floor(v));
  const tx = u - column;
  const ty = v - row;
  const at = (x: number, y: number): Point => controlPoints[y * deformer.cols + x]!;
  const topLeft = at(column, row);
  const topRight = at(column + 1, row);
  const bottomLeft = at(column, row + 1);
  const bottomRight = at(column + 1, row + 1);
  return {
    x: topLeft.x * (1 - tx) * (1 - ty) + topRight.x * tx * (1 - ty) + bottomLeft.x * (1 - tx) * ty + bottomRight.x * tx * ty,
    y: topLeft.y * (1 - tx) * (1 - ty) + topRight.y * tx * (1 - ty) + bottomLeft.y * (1 - tx) * ty + bottomRight.y * tx * ty
  };
}

function bindingsFor(project: PuppetLoomProject, kind: "layer" | "deformer", id: string): ModelBinding[] {
  return modelIndexFor(project).bindingsByTarget.get(bindingTargetKey(kind, id)) ?? emptyBindings;
}

function applyDeformer(project: PuppetLoomProject, deformer: ModelDeformer, point: Point, parameters: Record<string, number>): Point {
  const bindingWeights = bindingsFor(project, "deformer", deformer.id).map((binding) => weightedKeyforms(binding, parameters));
  let current = point;
  if (deformer.kind === "rotation") {
    for (const weights of bindingWeights) current = transformPoint(current, deformer.pivot, sampledTransform(weights));
  } else {
    const controlPoints = deformer.controlPoints.map((base, index) => {
      const next = { ...base };
      for (const weights of bindingWeights) addSampledPoint(next, weights, "warpPointDeltas", index);
      return next;
    });
    current = warpPoint(current, deformer, controlPoints);
    for (const weights of bindingWeights) current = transformPoint(current, {
      x: deformer.bounds.x + deformer.bounds.width * 0.5,
      y: deformer.bounds.y + deformer.bounds.height * 0.5
    }, sampledTransform(weights));
  }
  if (!deformer.parentId) return current;
  const parent = modelFor(project).deformers.find((candidate) => candidate.id === deformer.parentId);
  return parent ? applyDeformer(project, parent, current, parameters) : current;
}

export interface EvaluatedLayerAuthoring {
  points: Point[];
  opacityMultiplier: number;
  drawOrderOffset: number;
}

function evaluateLayerAuthoringParameters(project: PuppetLoomProject, layer: LayerBinding, parameters: Record<string, number>, reusable?: EvaluatedLayerAuthoring): EvaluatedLayerAuthoring {
  const bindings = bindingsFor(project, "layer", layer.id);
  if (bindings.length === 0 && !layer.deformerId) {
    if (reusable) {
      reusable.points = layer.mesh.points;
      reusable.opacityMultiplier = 1;
      reusable.drawOrderOffset = 0;
      return reusable;
    }
    return { points: layer.mesh.points, opacityMultiplier: 1, drawOrderOffset: 0 };
  }
  const bindingWeights = bindings.map((binding) => weightedKeyforms(binding, parameters));
  const points = reusable?.points !== layer.mesh.points && reusable?.points.length === layer.mesh.points.length
    ? reusable.points
    : new Array<Point>(layer.mesh.points.length);
  for (let index = 0; index < layer.mesh.points.length; index += 1) {
    const base = layer.mesh.points[index]!;
    let current = points[index] ?? { x: base.x, y: base.y };
    current.x = base.x;
    current.y = base.y;
    for (const weights of bindingWeights) addSampledPoint(current, weights, "meshPointDeltas", index);
    for (const weights of bindingWeights) {
      const transformed = transformPoint(current, layer.pivot, sampledTransform(weights));
      current.x = transformed.x;
      current.y = transformed.y;
    }
    if (layer.deformerId) {
      const deformer = modelFor(project).deformers.find((candidate) => candidate.id === layer.deformerId);
      if (deformer) {
        const deformed = applyDeformer(project, deformer, current, parameters);
        current.x = deformed.x;
        current.y = deformed.y;
      }
    }
    points[index] = current;
  }
  const result = reusable ?? { points, opacityMultiplier: 1, drawOrderOffset: 0 };
  result.points = points;
  result.opacityMultiplier = bindingWeights.reduce((value, weights) => value * sampledNumber(weights, "opacityMultiplier", 1), 1);
  result.drawOrderOffset = bindingWeights.reduce((value, weights) => value + sampledNumber(weights, "drawOrderOffset", 0), 0);
  return result;
}

export function evaluateLayerAuthoring(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): EvaluatedLayerAuthoring {
  return evaluateLayerAuthoringParameters(project, layer, resolveParameterValues(project, state));
}

/** Hot-path variant for a state already returned by resolveMotionState. */
export function evaluateLayerAuthoringResolved(project: PuppetLoomProject, layer: LayerBinding, resolvedState: MotionState, reusable?: EvaluatedLayerAuthoring): EvaluatedLayerAuthoring {
  return evaluateLayerAuthoringParameters(project, layer, resolvedState.parameters ?? resolveParameterValues(project, resolvedState), reusable);
}
