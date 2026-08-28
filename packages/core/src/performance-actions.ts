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
  parts: StandardPerformancePartStatus[];
  warnings: string[];
  patch?: AuthoringPatch;
}

export type StandardPerformancePart =
  | "eyebrows"
  | "eyes"
  | "mouth"
  | "arm-left"
  | "arm-right"
  | "leg-left"
  | "leg-right"
  | "head-motion"
  | "body-motion"
  | "ears"
  | "tail";

export interface StandardPerformancePartStatus {
  part: StandardPerformancePart;
  status: "completed" | "not-present" | "needs-assets";
  layerIds: string[];
  expressionIds?: string[];
  behaviorIds?: string[];
  message: string;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parameter(id: string, name: string, min: number, max: number, semantic?: MotionParameterSemantic): ModelParameter {
  return { id, name, group: "Performance Actions", kind: "continuous", min, default: 0, max, ...(semantic ? { semantic } : {}) };
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
  const parts: StandardPerformancePartStatus[] = [];
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
    parts.push({ part: "eyebrows", status: "completed", layerIds: browLayers.map((layer) => layer.id), expressionIds: ["performance-soft-smile", "performance-surprised", "performance-determined", "performance-sleepy"], message: "已用真实眉毛图层建立可复用眉形参数。" });
  } else {
    warnings.push("没有独立眉毛图层，表情仍会使用眼睛和嘴型，但不会改变眉形。");
    parts.push({ part: "eyebrows", status: "not-present", layerIds: [], message: "项目没有独立眉毛图层，未伪造眉毛动作。" });
  }

  const eyeLayers = project.layers.filter((layer) => ["eyeWhite", "iris", "eyelash", "eyeClosed"].includes(layer.role) && layer.visible !== false);
  const hasOpenEyes = eyeLayers.some((layer) => layer.role !== "eyeClosed");
  const hasClosedEyes = eyeLayers.some((layer) => layer.role === "eyeClosed");
  const blink = hasOpenEyes && hasClosedEyes ? semantic(project, "blink") : undefined;
  if (eyeLayers.length === 0) parts.push({ part: "eyes", status: "not-present", layerIds: [], message: "项目没有眼睛图层，未生成眨眼动作。" });
  else if (!blink) parts.push({ part: "eyes", status: "needs-assets", layerIds: eyeLayers.map((layer) => layer.id), message: hasClosedEyes ? "眼睛图层缺少可用的 blink 语义参数。" : "缺少闭眼素材；保留现有眼睛，不用透明消失冒充眨眼。" });
  else parts.push({ part: "eyes", status: "completed", layerIds: eyeLayers.map((layer) => layer.id), expressionIds: ["performance-soft-smile", "performance-surprised", "performance-determined", "performance-sleepy"], behaviorIds: ["action-double-blink"], message: "已使用开眼与闭眼素材建立表情和双眨眼动作。" });

  const mouthLayers = project.layers.filter((layer) => layer.role === "mouth" && layer.visible !== false);
  const mouthVariants = new Set(mouthLayers.map((layer) => layer.mouthVariant ?? "closed"));
  const hasMouthSet = ["closed", "open"].every((variant) => mouthVariants.has(variant as "closed" | "open"));
  const hasSlightMouth = mouthVariants.has("slight");
  const mouth = hasMouthSet ? semantic(project, "mouth-open") : undefined;
  if (mouthLayers.length === 0) parts.push({ part: "mouth", status: "not-present", layerIds: [], message: "项目没有嘴部图层，未生成口型动作。" });
  else if (!mouth) parts.push({ part: "mouth", status: "needs-assets", layerIds: mouthLayers.map((layer) => layer.id), message: hasMouthSet ? "嘴部图层缺少可用的 mouth-open 语义参数。" : "缺少闭合与张开两态嘴形；嘴部保持不动，不用透明消失冒充口型。" });
  else parts.push({ part: "mouth", status: "completed", layerIds: mouthLayers.map((layer) => layer.id), expressionIds: ["performance-soft-smile", "performance-surprised", "performance-determined", "performance-sleepy"], behaviorIds: ["action-short-talk"], message: hasSlightMouth ? "已使用三态嘴形建立表情和短句口型。" : "已使用闭口与张口两态素材建立表情和短句口型。" });
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
    if (layers.length === 0) {
      parts.push({ part: `arm-${side}`, status: "not-present", layerIds: [], message: `项目没有独立${side === "left" ? "左" : "右"}臂或手部图层，未伪造挥手动作。` });
      continue;
    }
    limbLayers.push(...layers.map((layer) => ({ id: layer.id, name: layer.sourceName, role: layer.role, side: layer.side })));
    const raise = parameter(`param-performance-arm-${side}`, `表演 · ${side === "left" ? "左" : "右"}臂抬起`, 0, 1, `arm-${side}`);
    const wave = parameter(`param-performance-wave-${side}`, `表演 · ${side === "left" ? "左" : "右"}臂摆动`, -1, 1);
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: raise });
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: wave });
    const direction = side === "left" ? -1 : 1;
    for (const layer of layers) {
      pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-performance-arm-${side}-${layer.id}`, raise.id, layer, [{ value: 0 }, { value: 1, rotation: direction * 52, y: -0.008 }]) });
      pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-performance-wave-${side}-${layer.id}`, wave.id, layer, [{ value: -1, rotation: -direction * 9 }, { value: 0 }, { value: 1, rotation: direction * 9 }]) });
    }
    const handLayers = layers.filter((layer) => layer.role === "hand");
    if (handLayers.length > 0) {
      const handX = parameter(`param-tracking-hand-${side}-x`, `追踪 · ${side === "left" ? "左" : "右"}手横向`, -1, 1, `hand-${side}-x`);
      const handY = parameter(`param-tracking-hand-${side}-y`, `追踪 · ${side === "left" ? "左" : "右"}手纵向`, -1, 1, `hand-${side}-y`);
      pushIfChanged(operations, project, { op: "upsert-parameter", parameter: handX });
      pushIfChanged(operations, project, { op: "upsert-parameter", parameter: handY });
      for (const layer of handLayers) {
        pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-tracking-hand-${side}-x-${layer.id}`, handX.id, layer, [{ value: -1, x: -0.035 }, { value: 0 }, { value: 1, x: 0.035 }]) });
        pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-tracking-hand-${side}-y-${layer.id}`, handY.id, layer, [{ value: -1, y: -0.045 }, { value: 0 }, { value: 1, y: 0.045 }]) });
      }
    }
    behaviors.push(behavior(`action-wave-${side}`, `动作 · ${side === "left" ? "左" : "右"}手挥手`, 2.4, [
      track(raise.id, [[0, 0], [0.34, 1], [2.08, 1, "hold"], [2.4, 0]]),
      track(wave.id, [[0, 0], [0.42, 0], [0.68, 1], [0.92, -1], [1.16, 1], [1.4, -1], [1.64, 1], [1.9, -0.5], [2.08, 0], [2.4, 0]]),
      ...(expressions.some((value) => value.id === "performance-soft-smile") ? [expressionTrack("performance-soft-smile", [[0, 0], [0.3, 1], [2.08, 1, "hold"], [2.4, 0]])] : [])
    ]));
    parts.push({ part: `arm-${side}`, status: "completed", layerIds: layers.map((layer) => layer.id), behaviorIds: [`action-wave-${side}`], message: `已用独立${side === "left" ? "左" : "右"}臂/手图层建立抬臂与挥手动作。` });
  }
  if (!limbLayers.some((layer) => layer.role === "arm" || layer.role === "hand")) warnings.push("没有独立手臂或手部图层，未生成挥手动作。");

  const legRoles = new Set(["leg", "foot"]);
  const legParameters: Partial<Record<"left" | "right", ModelParameter>> = {};
  for (const side of ["left", "right"] as const) {
    const layers = sideLayers(project, legRoles, side);
    if (layers.length === 0) {
      parts.push({ part: `leg-${side}`, status: "not-present", layerIds: [], message: `项目没有独立${side === "left" ? "左" : "右"}腿或脚图层，未伪造腿部动作。` });
      continue;
    }
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
    parts.push({ part: `leg-${side}`, status: "completed", layerIds: layers.map((layer) => layer.id), behaviorIds: ["action-step-in-place"], message: `已用独立${side === "left" ? "左" : "右"}腿/脚图层建立踏步参数。` });
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
  parts.push(headYaw && headPitch
    ? { part: "head-motion", status: "completed", layerIds: project.layers.filter((layer) => layer.parentGroup === "head" && layer.visible !== false).map((layer) => layer.id), behaviorIds: ["action-nod", "action-shake-head", "action-look-around"], message: "已使用头部语义参数建立点头、摇头和观察动作。" }
    : { part: "head-motion", status: "needs-assets", layerIds: project.layers.filter((layer) => layer.parentGroup === "head" && layer.visible !== false).map((layer) => layer.id), message: "项目缺少完整的 head-yaw/head-pitch 语义绑定，不能安全生成完整头部动作。" });
  parts.push(bodyPitch && bodySway
    ? { part: "body-motion", status: "completed", layerIds: project.layers.filter((layer) => layer.parentGroup === "body" && layer.visible !== false).map((layer) => layer.id), behaviorIds: ["action-bow", "action-body-bounce"], message: "已使用身体语义参数建立鞠躬和轻快摆动。" }
    : { part: "body-motion", status: "needs-assets", layerIds: project.layers.filter((layer) => layer.parentGroup === "body" && layer.visible !== false).map((layer) => layer.id), message: "项目缺少完整的 body-pitch/body-sway 语义绑定，不能安全生成完整身体动作。" });
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

  const earLayers = project.layers.filter((layer) => layer.visible !== false && (layer.role === "ear" || (layer.role === "headwear" && Boolean(layer.secondaryAnchors?.earHingeLeft || layer.secondaryAnchors?.earHingeRight))));
  if (earLayers.length > 0) {
    const mergedEarLayers = earLayers.filter((layer) => layer.role === "headwear");
    const separateEarLayers = earLayers.filter((layer) => layer.role === "ear");
    const earX = parameter("param-performance-ear-x", "表演 · 耳部侧摆", -0.005, 0.005, mergedEarLayers.length > 0 ? "ear-x" : undefined);
    const earY = parameter("param-performance-ear-y", "表演 · 耳部抬落", -0.012, 0.012, mergedEarLayers.length > 0 ? "ear-y" : undefined);
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: earX });
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: earY });
    for (const layer of separateEarLayers) {
      const mirror = layer.side === "left" ? 1 : layer.side === "right" ? -1 : 1;
      pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-performance-ear-x-${layer.id}`, earX.id, layer, [
        { value: -0.005, rotation: -1 }, { value: 0 }, { value: 0.005, rotation: 1 }
      ]) });
      pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-performance-ear-y-${layer.id}`, earY.id, layer, [
        { value: -0.012, rotation: 8 * mirror }, { value: 0 }, { value: 0.012, rotation: -5 * mirror }
      ]) });
    }
    behaviors.push(behavior("action-ear-flick", "动作 · 耳朵轻弹", 0.82, [
      track(earX.id, [[0, 0], [0.12, -0.0025], [0.26, 0.003], [0.42, -0.0015], [0.62, 0.0008], [0.82, 0]]),
      track(earY.id, [[0, 0], [0.1, -0.009], [0.24, 0.005], [0.39, -0.007], [0.58, 0.002], [0.82, 0]])
    ]));
    parts.push({ part: "ears", status: "completed", layerIds: earLayers.map((layer) => layer.id), behaviorIds: ["action-ear-flick"], message: "已用真实耳部图层或头饰耳部铰点建立局部轻弹动作。" });
  } else parts.push({ part: "ears", status: "not-present", layerIds: [], message: "项目没有独立耳朵图层或可定位的耳部铰点，未伪造耳朵动作。" });

  const tailLayers = project.layers.filter((layer) => layer.role === "tail" && layer.visible !== false);
  if (tailLayers.length > 0) {
    const tailWag = parameter("param-performance-tail-wag", "表演 · 尾巴左右摆", -1, 1);
    const tailLift = parameter("param-performance-tail-lift", "表演 · 尾巴抬起", 0, 1);
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: tailWag });
    pushIfChanged(operations, project, { op: "upsert-parameter", parameter: tailLift });
    for (const layer of tailLayers) {
      pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-performance-tail-wag-${layer.id}`, tailWag.id, layer, [{ value: -1, rotation: -18 }, { value: 0 }, { value: 1, rotation: 18 }]) });
      pushIfChanged(operations, project, { op: "upsert-binding", binding: layerBinding(`binding-performance-tail-lift-${layer.id}`, tailLift.id, layer, [{ value: 0 }, { value: 1, rotation: -7, y: -0.009 }]) });
    }
    behaviors.push(behavior("action-tail-wag", "动作 · 尾巴摇摆", 1.9, [
      track(tailWag.id, [[0, 0], [0.25, -0.9], [0.55, 0.95], [0.85, -1], [1.15, 0.9], [1.45, -0.65], [1.7, 0.35], [1.9, 0]]),
      track(tailLift.id, [[0, 0], [0.25, 0.7], [1.55, 0.7, "hold"], [1.9, 0]])
    ]));
    parts.push({ part: "tail", status: "completed", layerIds: tailLayers.map((layer) => layer.id), behaviorIds: ["action-tail-wag"], message: "已用真实尾巴图层建立根部抬起和左右摇摆动作。" });
  } else parts.push({ part: "tail", status: "not-present", layerIds: [], message: "项目没有尾巴图层，未伪造尾巴动作。" });

  for (const value of behaviors) pushIfChanged(operations, project, { op: "upsert-behavior", behavior: value });

  const previewBehaviorIds = ["action-wave-left", "action-step-in-place", "action-bow", "action-look-around", "action-double-blink", "action-short-talk", "action-ear-flick", "action-tail-wag"];
  const previews: AuthoringPreview[] = [
    ...expressions.map((value) => ({ id: value.id, label: value.name, expressions: { [value.id]: 1 } })),
    ...previewBehaviorIds.flatMap((id) => {
      const value = behaviors.find((candidate) => candidate.id === id);
      return value ? [{ id: value.id, label: value.name, behavior: { id: value.id, timeSeconds: value.duration * 0.55 } }] : [];
    })
  ];
  return {
    version: 1,
    project: project.name,
    baseRevision,
    changed: operations.length > 0,
    expressions: expressions.map(({ id, name }) => ({ id, name })),
    behaviors: behaviors.map(({ id, name, duration }) => ({ id, name, duration })),
    limbLayers,
    parts,
    warnings,
    ...(operations.length > 0 ? { patch: { version: 1, baseRevision, label: "建立标准表情、行为与肢体动作库", operations, previews } } : {})
  };
}
