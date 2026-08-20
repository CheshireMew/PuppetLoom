import type {
  AuthoringOperation,
  AuthoringPatch,
  AuthoringPreview,
  BehaviorTrack,
  LayerBinding,
  ModelBehavior,
  ModelBinding,
  ModelExpression,
  ModelParameter,
  MotionParameterSemantic,
  PuppetLoomProject,
  Side
} from "./types.js";

export interface StandardPerformanceActionPlan {
  version: 1;
  project: string;
  baseRevision: number;
  changed: boolean;
  expressions: Array<{ id: string; name: string }>;
  behaviors: Array<{ id: string; name: string; duration: number }>;
  limbLayers: Array<{ id: string; name: string; role: string; side: Side }>;
  warnings: string[];
  patch?: AuthoringPatch;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parameter(id: string, name: string, min: number, max: number): ModelParameter {
  return { id, name, group: "Performance Actions", kind: "continuous", min, default: 0, max };
}

function layerBinding(id: string, parameterId: string, layer: LayerBinding, values: Array<{ value: number; rotation?: number; x?: number; y?: number }>): ModelBinding {
  return {
    id,
    parameterIds: [parameterId],
    target: { kind: "layer", id: layer.id },
    keyforms: values.map(({ value, rotation = 0, x = 0, y = 0 }) => ({
      values: [value],
      transform: { translation: { x, y }, rotationDegrees: rotation, scale: { x: 1, y: 1 } }
    }))
  };
}

function track(id: string, keyframes: Array<[number, number, ("linear" | "smoothstep" | "hold")?]>): BehaviorTrack {
  return {
    target: { kind: "parameter", id },
    keyframes: keyframes.map(([time, value, easing]) => ({ time, value, ...(easing ? { easing } : {}) }))
  };
}

function expressionTrack(id: string, keyframes: Array<[number, number, ("linear" | "smoothstep" | "hold")?]>): BehaviorTrack {
  return { ...track(id, keyframes), target: { kind: "expression", id } };
}

function behavior(id: string, name: string, duration: number, tracks: BehaviorTrack[]): ModelBehavior {
  return { id, name, duration, loop: false, tracks };
}

function semantic(project: PuppetLoomProject, value: MotionParameterSemantic): string | undefined {
  return project.model.parameters.find((candidate) => candidate.semantic === value)?.id;
}

function sideLayers(project: PuppetLoomProject, roles: Set<string>, side: Side): LayerBinding[] {
  return project.layers.filter((layer) => roles.has(layer.role) && layer.side === side && layer.visible !== false);
}

function pushIfChanged(operations: AuthoringOperation[], project: PuppetLoomProject, operation: AuthoringOperation): void {
  let current: unknown;
  if (operation.op === "upsert-parameter") current = project.model.parameters.find((value) => value.id === operation.parameter.id);
  else if (operation.op === "upsert-binding") current = project.model.bindings.find((value) => value.id === operation.binding.id);
  else if (operation.op === "upsert-expression") current = project.model.expressions.find((value) => value.id === operation.expression.id);
  else if (operation.op === "upsert-behavior") current = project.model.behaviors.find((value) => value.id === operation.behavior.id);
  if (!same(current, operation.op === "upsert-parameter" ? operation.parameter : operation.op === "upsert-binding" ? operation.binding : operation.op === "upsert-expression" ? operation.expression : operation.op === "upsert-behavior" ? operation.behavior : undefined)) operations.push(operation);
}

/** Builds an idempotent authored action library from the layers actually present in one character. */
export function planStandardPerformanceActions(project: PuppetLoomProject, baseRevision: number): StandardPerformanceActionPlan {
  const operations: AuthoringOperation[] = [];
  const warnings: string[] = [];
  const browLayers = project.layers.filter((layer) => layer.role === "eyebrow" && layer.visible !== false);
  const browParameter = parameter("param-performance-brow", "表演 · 眉形", -1, 1);
  if (browLayers.length > 0) {
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: browParameter });
    for (const layer of browLayers) {
      const sideSign = layer.side === "left" ? -1 : layer.side === "right" ? 1 : 0;
      pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(
        `binding-performance-brow-${layer.id}`,
        browParameter.id,
        layer,
        [{ value: -1, rotation: sideSign * 7, y: 0.006 }, { value: 0 }, { value: 1, rotation: sideSign * -3, y: -0.006 }]
      ) });
    }
  } else warnings.push("没有独立眉毛图层，表情仍会使用眼睛和嘴型，但不会改变眉形。");

  const blink = semantic(project, "blink");
  const mouth = semantic(project, "mouth-open");
  const expressionValues = (brow: number, blinkValue: number, mouthValue: number): Record<string, number> => ({
    ...(browLayers.length > 0 ? { [browParameter.id]: brow } : {}),
    ...(blink ? { [blink]: blinkValue } : {}),
    ...(mouth ? { [mouth]: mouthValue } : {})
  });
  const expressions: ModelExpression[] = [
    { id: "performance-soft-smile", name: "表情 · 柔和", parameters: expressionValues(0.3, 0.08, 0.32) },
    { id: "performance-surprised", name: "表情 · 惊讶", parameters: expressionValues(1, 0, 0.9) },
    { id: "performance-determined", name: "表情 · 认真", parameters: expressionValues(-0.75, 0.14, 0.06) },
    { id: "performance-sleepy", name: "表情 · 困倦", parameters: expressionValues(0.1, 0.68, 0.12) }
  ].filter((value) => Object.keys(value.parameters).length > 0);
  for (const value of expressions) pushIfChanged(operations, project, { op: "upsert-expression", expression: value });

  const limbLayers: StandardPerformanceActionPlan["limbLayers"] = [];
  const behaviors: ModelBehavior[] = [];
  const armRoles = new Set(["arm", "hand"]);
  for (const side of ["left", "right"] as const) {
    const layers = sideLayers(project, armRoles, side);
    if (layers.length === 0) continue;
    limbLayers.push(...layers.map((layer) => ({ id: layer.id, name: layer.sourceName, role: layer.role, side: layer.side })));
    const raise = parameter(`param-performance-arm-${side}`, `表演 · ${side === "left" ? "左" : "右"}臂抬起`, 0, 1);
    const wave = parameter(`param-performance-wave-${side}`, `表演 · ${side === "left" ? "左" : "右"}臂摆动`, -1, 1);
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: raise });
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: wave });
    const direction = side === "left" ? -1 : 1;
    for (const layer of layers) {
      pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-performance-arm-${side}-${layer.id}`, raise.id, layer, [{ value: 0 }, { value: 1, rotation: direction * 52, y: -0.008 }]) });
      pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-performance-wave-${side}-${layer.id}`, wave.id, layer, [{ value: -1, rotation: -direction * 9 }, { value: 0 }, { value: 1, rotation: direction * 9 }]) });
    }
    behaviors.push(behavior(`action-wave-${side}`, `动作 · ${side === "left" ? "左" : "右"}手挥手`, 2.4, [
      track(raise.id, [[0, 0], [0.34, 1], [2.08, 1, "hold"], [2.4, 0]]),
      track(wave.id, [[0, 0], [0.42, 0], [0.68, 1], [0.92, -1], [1.16, 1], [1.4, -1], [1.64, 1], [1.9, -0.5], [2.08, 0], [2.4, 0]]),
      ...(expressions.some((value) => value.id === "performance-soft-smile") ? [expressionTrack("performance-soft-smile", [[0, 0], [0.3, 1], [2.08, 1, "hold"], [2.4, 0]])] : [])
    ]));
  }
  if (!limbLayers.some((layer) => layer.role === "arm" || layer.role === "hand")) warnings.push("没有独立手臂或手部图层，未生成挥手动作。");

  const legRoles = new Set(["leg", "foot"]);
  const legParameters: Partial<Record<"left" | "right", ModelParameter>> = {};
  for (const side of ["left", "right"] as const) {
    const layers = sideLayers(project, legRoles, side);
    if (layers.length === 0) continue;
    limbLayers.push(...layers.map((layer) => ({ id: layer.id, name: layer.sourceName, role: layer.role, side: layer.side })));
    const lift = parameter(`param-performance-leg-${side}`, `表演 · ${side === "left" ? "左" : "右"}腿抬起`, 0, 1);
    legParameters[side] = lift;
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: lift });
    for (const layer of layers) pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(
      `binding-performance-leg-${side}-${layer.id}`,
      lift.id,
      layer,
      [{ value: 0 }, { value: 1, rotation: side === "left" ? -3 : 3, y: -0.014 }]
    ) });
  }
  if (legParameters.left && legParameters.right) behaviors.push(behavior("action-step-in-place", "动作 · 原地踏步", 1.8, [
    track(legParameters.left.id, [[0, 0], [0.25, 1], [0.55, 0], [1.15, 0], [1.45, 1], [1.8, 0]]),
    track(legParameters.right.id, [[0, 0], [0.55, 0], [0.85, 1], [1.15, 0], [1.8, 0]])
  ]));
  else warnings.push("左右腿或脚图层不完整，未生成原地踏步动作。");

  const headYaw = semantic(project, "head-yaw");
  const headPitch = semantic(project, "head-pitch");
  const bodyPitch = semantic(project, "body-pitch");
  const bodySway = semantic(project, "body-sway");
  const gazeX = semantic(project, "gaze-x");
  if (headPitch) behaviors.push(behavior("action-nod", "动作 · 点头", 1.25, [track(headPitch, [[0, 0], [0.28, 0.55], [0.55, -0.12], [0.84, 0.5], [1.25, 0]])]));
  if (headYaw) behaviors.push(behavior("action-shake-head", "动作 · 摇头", 1.45, [track(headYaw, [[0, 0], [0.25, -0.55], [0.53, 0.55], [0.81, -0.5], [1.1, 0.42], [1.45, 0]])]));
  if (headPitch && bodyPitch) behaviors.push(behavior("action-bow", "动作 · 鞠躬", 2.1, [
    track(headPitch, [[0, 0], [0.55, 0.62], [1.35, 0.62, "hold"], [2.1, 0]]),
    track(bodyPitch, [[0, 0], [0.62, 0.5], [1.32, 0.5, "hold"], [2.1, 0]])
  ]));
  if (gazeX && headYaw) behaviors.push(behavior("action-look-around", "动作 · 左右观察", 2.5, [
    track(gazeX, [[0, 0], [0.25, -0.8], [0.62, -0.8, "hold"], [1.05, 0.85], [1.55, 0.85, "hold"], [2.05, -0.25], [2.5, 0]]),
    track(headYaw, [[0, 0], [0.52, -0.32], [1.2, 0.38], [2.05, -0.12], [2.5, 0]])
  ]));
  if (blink) behaviors.push(behavior("action-double-blink", "动作 · 双眨眼", 0.72, [track(blink, [[0, 0], [0.1, 1], [0.2, 0], [0.36, 0], [0.46, 1], [0.58, 0], [0.72, 0]])]));
  if (mouth) behaviors.push(behavior("action-short-talk", "动作 · 短句口型", 1.4, [track(mouth, [[0, 0], [0.14, 0.65], [0.28, 0.12], [0.46, 0.82], [0.62, 0.2], [0.84, 0.72], [1.05, 0.08], [1.22, 0.5], [1.4, 0]])]));
  if (bodySway) behaviors.push(behavior("action-body-bounce", "动作 · 轻快摆动", 1.6, [track(bodySway, [[0, 0], [0.35, -0.45], [0.78, 0.45], [1.2, -0.28], [1.6, 0]])]));
  for (const value of behaviors) pushIfChanged(operations, project, { op: "upsert-behavior", behavior: value });

  const previews: AuthoringPreview[] = [
    ...expressions.map((value) => ({ id: value.id, label: value.name, expressions: { [value.id]: 1 } })),
    ...behaviors.slice(0, Math.max(0, 12 - expressions.length)).map((value) => ({ id: value.id, label: value.name, behavior: { id: value.id, timeSeconds: value.duration * 0.55 } }))
  ];
  return {
    version: 1,
    project: project.name,
    baseRevision,
    changed: operations.length > 0,
    expressions: expressions.map(({ id, name }) => ({ id, name })),
    behaviors: behaviors.map(({ id, name, duration }) => ({ id, name, duration })),
    limbLayers,
    warnings,
    ...(operations.length > 0 ? { patch: { version: 1, baseRevision, label: "建立标准表情、行为与肢体动作库", operations, previews } } : {})
  };
}
