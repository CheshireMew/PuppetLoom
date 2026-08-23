import { resolve } from "node:path";
import { prepareAgentMeshes } from "./agent-mesh.js";
import { commitModelAgentProposal, type ModelAgentCheck, type ModelAgentPart, type ModelAgentRepair } from "./agent.js";
import { applyAuthoringOperations } from "./authoring.js";
import { applyCalibrationOverrides } from "./calibration.js";
import { deformedPoints, neutralMotionState } from "./deform.js";
import { PuppetLoomError } from "./errors.js";
import { ahogeHingeWeight, rotationDelta } from "./front-hair-geometry.js";
import {
  clothingPhysicsMask,
  clothingSecondaryRelease,
  skirtElasticRelease,
  skirtStructuralRelease,
  skirtSupportPivot
} from "./clothing-geometry.js";
import { ModelPhysicsController } from "./model.js";
import { clearCalibrationDraft, loadCalibration, loadCalibrationDraft, loadProject, saveCalibrationPatch } from "./project.js";
import { validatePose, validateProjectPoses } from "./safety.js";
import type {
  AuthoringOperation,
  AuthoringPreview,
  CalibrationDraftDocument,
  CalibrationOverrides,
  LayerBinding,
  ModelBinding,
  ModelKeyform,
  MotionTuning,
  Point,
  PuppetLoomProject,
  SecondaryMotionPart,
  SemanticRole
} from "./types.js";

export type SecondaryModelAgentPart = Exclude<ModelAgentPart, "headFace" | "eyes" | "mouth" | "frontHair" | "body">;

export interface SecondaryPartAgentOptions {
  part: SecondaryModelAgentPart;
  instruction?: string;
  layerIds?: string[];
  intent?: SecondaryPartIntent;
}

export interface SecondaryPartIntent {
  amplitude: number;
  response: number;
  stability: number;
  lagResponse: number;
  lagDamping: number;
  deformationScale: number;
  garmentStructure?: "soft" | "supported";
  garmentFlexibility?: number;
  explanation: string[];
}

export interface SecondaryPartAgentPlan {
  version: 1;
  task: SecondaryModelAgentPart;
  project: string;
  projectDirectory: string;
  baseRevision: number;
  instruction: string;
  targetLayers: Array<{ id: string; sourceName: string; role: SemanticRole; pointCount: number; triangleCount: number }>;
  intent: SecondaryPartIntent;
  operations: Array<{ op: AuthoringOperation["op"]; id: string }>;
  checks: ModelAgentCheck[];
  repairs: ModelAgentRepair[];
  draft: { found: boolean; compatible: boolean; blockers: string[] };
  canApply: boolean;
  blockers: string[];
}

export interface SecondaryPartAgentRunResult {
  ok: true;
  task: SecondaryModelAgentPart;
  project: string;
  projectDirectory: string;
  fromRevision: number;
  toRevision: number;
  targetLayerIds: string[];
  adoptedDraftRevision?: number;
  checks: ModelAgentCheck[];
  repairs: ModelAgentRepair[];
  reportPath: string;
  comparisonSheet: string;
  differenceImage: string;
}

interface PartPolicy {
  label: string;
  roles: SemanticRole[];
  tuningPart: SecondaryMotionPart;
  driver: "param-head-yaw" | "param-body-sway";
  defaultAmplitude: number;
  baseScale: number;
}

interface PreparedSecondaryProposal {
  project: PuppetLoomProject;
  layers: LayerBinding[];
  instruction: string;
  intent: SecondaryPartIntent;
  operations: AuthoringOperation[];
  previews: AuthoringPreview[];
  overrides: CalibrationOverrides;
  checks: ModelAgentCheck[];
  repairs: ModelAgentRepair[];
}

const policies: Record<SecondaryModelAgentPart, PartPolicy> = {
  backHair: { label: "后发与侧发", roles: ["backHair", "sideHair"], tuningPart: "backHair", driver: "param-head-yaw", defaultAmplitude: 0.82, baseScale: 0.012 },
  ahoge: { label: "呆毛", roles: ["frontHair"], tuningPart: "ahoge", driver: "param-head-yaw", defaultAmplitude: 0.9, baseScale: 0.015 },
  ears: { label: "耳朵", roles: ["ear"], tuningPart: "ears", driver: "param-head-yaw", defaultAmplitude: 0.68, baseScale: 0.01 },
  headwear: { label: "头饰", roles: ["headwear"], tuningPart: "headwear", driver: "param-head-yaw", defaultAmplitude: 0.62, baseScale: 0.009 },
  topCloth: { label: "上衣与袖子", roles: ["topWear", "arm"], tuningPart: "topCloth", driver: "param-body-sway", defaultAmplitude: 0.46, baseScale: 0.007 },
  skirt: { label: "裙摆与下装", roles: ["bottomWear"], tuningPart: "skirt", driver: "param-body-sway", defaultAmplitude: 0.5, baseScale: 0.0085 },
  tail: { label: "尾巴", roles: ["tail"], tuningPart: "tail", driver: "param-body-sway", defaultAmplitude: 0.9, baseScale: 0.017 },
  accessory: { label: "配饰", roles: ["accessory"], tuningPart: "accessory", driver: "param-body-sway", defaultAmplitude: 0.72, baseScale: 0.013 }
};

function rounded(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(value: number): number {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function intentFor(part: SecondaryModelAgentPart, rawInstruction?: string): { instruction: string; intent: SecondaryPartIntent } {
  const policy = policies[part];
  const instruction = rawInstruction?.trim() || `让${policy.label}自然跟随，并增加轻微滞后和回弹`;
  return {
    instruction,
    intent: {
      amplitude: rounded(clamp(policy.defaultAmplitude * 0.86, 0.1, 1.4), 4),
      response: 0.46,
      stability: 0.5,
      lagResponse: 7.4,
      lagDamping: 0.82,
      deformationScale: 0.88,
      explanation: ["旧调用兼容入口使用固定安全基线；自然语言意图应由外部 Agent 写入结构化规格。"]
    }
  };
}

function targetLayers(project: PuppetLoomProject, part: SecondaryModelAgentPart, requested?: string[]): LayerBinding[] {
  const requestedSet = requested ? new Set(requested) : undefined;
  const layers = requestedSet
    ? project.layers.filter((layer) => requestedSet.has(layer.id))
    : project.layers.filter((layer) => policies[part].roles.includes(layer.role));
  if (requestedSet) {
    const missing = (requested ?? []).filter((id) => !layers.some((layer) => layer.id === id));
    if (missing.length > 0) throw new PuppetLoomError("INVALID_INPUT", `${policies[part].label} Agent 找不到目标图层：${missing.join("、")}`);
    const incompatible = layers.filter((layer) => !policies[part].roles.includes(layer.role) && !(part === "accessory" && layer.role === "unknown"));
    if (incompatible.length > 0) {
      throw new PuppetLoomError("INVALID_INPUT", `${policies[part].label} Agent 不能接管这些语义不兼容的图层：${incompatible.map((layer) => layer.id).join("、")}`);
    }
  }
  if (layers.length === 0) throw new PuppetLoomError("INVALID_INPUT", `项目中没有识别到${policies[part].label}图层。`);
  if (part === "ahoge" && !layers.some((layer) => layer.secondaryAnchors?.ahogeRoot)) throw new PuppetLoomError("INVALID_INPUT", "前发图层没有识别到呆毛根部，无法安全制作呆毛运动。" );
  return layers;
}

function vertexRelease(part: SecondaryModelAgentPart, layer: LayerBinding, point: Point): number {
  const width = Math.max(1e-6, layer.bounds.width);
  const height = Math.max(1e-6, layer.bounds.height);
  const u = clamp((point.x - layer.bounds.x) / width);
  const v = clamp((point.y - layer.bounds.y) / height);
  if (part === "ahoge") {
    return ahogeHingeWeight(layer, point);
  }
  if ((part === "topCloth" && (layer.role === "topWear" || layer.role === "arm")) || (part === "skirt" && layer.role === "bottomWear")) {
    return clothingSecondaryRelease(layer, point);
  }
  if (["ears", "headwear", "tail", "accessory"].includes(part)) {
    const diagonal = Math.max(1e-6, Math.hypot(width, height));
    return smoothstep(Math.hypot(point.x - layer.pivot.x, point.y - layer.pivot.y) / (diagonal * 0.72));
  }
  const rootV = clamp((layer.pivot.y - layer.bounds.y) / height, 0.02, 0.7);
  return smoothstep((v - rootV) / Math.max(0.12, 1 - rootV));
}

function ids(part: SecondaryModelAgentPart): { output: string; physics: string } {
  return { output: `param-agent-${part}-follow`, physics: `agent-${part}-physics` };
}

function layerBinding(part: SecondaryModelAgentPart, layer: LayerBinding, parameterId: string, scale: number, direction: 1 | -1, suffix: string): ModelBinding {
  const policy = policies[part];
  const keyform = (value: -1 | 0 | 1): ModelKeyform => {
    if (value === 0) return { values: [value] };
    const deltas = Object.fromEntries(layer.mesh.points.flatMap((point, index) => {
      const release = vertexRelease(part, layer, point);
      if (release <= 1e-5) return [];
      if (part === "ahoge") {
        const pivot = layer.secondaryAnchors?.ahogeRoot ?? layer.pivot;
        const angle = -value * direction * scale * policy.baseScale * 3.2;
        const delta = rotationDelta(point, pivot, angle);
        return [[String(index), { x: rounded(delta.x * release, 8), y: rounded(delta.y * release, 8) }]];
      }
      if (part === "ears") {
        const angle = value * direction * scale * policy.baseScale * 1.6;
        const delta = rotationDelta(point, layer.pivot, angle);
        return [[String(index), { x: rounded(delta.x, 8), y: rounded(delta.y, 8) }]];
      }
      if (part === "skirt" && layer.garmentStructure === "supported") {
        const angle = value * direction * scale * policy.baseScale;
        const flexibility = clamp(layer.garmentFlexibility ?? 0, 0, 0.5);
        const elasticAngle = angle * (1 + flexibility * 1.6 * skirtElasticRelease(layer, point));
        const delta = rotationDelta(point, skirtSupportPivot(layer), elasticAngle);
        return [[String(index), { x: rounded(delta.x * release, 8), y: rounded(delta.y * release, 8) }]];
      }
      const side = (point.x - layer.pivot.x) / Math.max(1e-6, layer.bounds.width);
      const amount = value * direction * release * scale;
      const delta = {
        x: -amount * layer.bounds.width * policy.baseScale,
        y: amount * side * layer.bounds.height * policy.baseScale * 0.48
      };
      return [[String(index), { x: rounded(delta.x, 8), y: rounded(delta.y, 8) }]];
    }));
    return { values: [value], meshPointDeltas: deltas };
  };
  return {
    id: `agent-${part}-${suffix}-${layer.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
    parameterIds: [parameterId],
    target: { kind: "layer", id: layer.id },
    keyforms: ([-1, 0, 1] as const).map(keyform)
  };
}

function proposalOperations(part: SecondaryModelAgentPart, layers: LayerBinding[], intent: SecondaryPartIntent, scale: number): AuthoringOperation[] {
  const policy = policies[part];
  const partIds = ids(part);
  return [
    {
      op: "upsert-parameter",
      parameter: { id: partIds.output, name: `${policy.label} Follow`, group: `Agent / ${policy.label}`, kind: "continuous", min: -1, default: 0, max: 1 }
    },
    ...layers.flatMap((layer) => [
      { op: "upsert-binding", binding: layerBinding(part, layer, policy.driver, scale, 1, "direct") } as AuthoringOperation,
      { op: "upsert-binding", binding: layerBinding(part, layer, partIds.output, scale, -1, "follow") } as AuthoringOperation
    ]),
    {
      op: "upsert-physics",
      physics: {
        id: partIds.physics,
        name: `${policy.label} Lag and Rebound`,
        inputParameterId: policy.driver,
        outputParameterId: partIds.output,
        inputScale: 1,
        outputScale: 1,
        response: intent.lagResponse,
        damping: intent.lagDamping
      }
    }
  ];
}

function operationsPreviews(part: SecondaryModelAgentPart): AuthoringPreview[] {
  const policy = policies[part];
  return [
    { id: `agent-${part}-negative`, label: `${policy.label} · 反向`, parameters: { [policy.driver]: -0.8 }, settleSeconds: 1.2 },
    { id: `agent-${part}-neutral`, label: `${policy.label} · 中立`, parameters: { [policy.driver]: 0 }, settleSeconds: 1.2 },
    { id: `agent-${part}-positive`, label: `${policy.label} · 正向`, parameters: { [policy.driver]: 0.8 }, settleSeconds: 1.2 }
  ];
}

function overlapsSkirtWaist(skirt: LayerBinding, limb: LayerBinding): boolean {
  const waistBottom = skirt.bounds.y + skirt.bounds.height * 0.3;
  const horizontalOverlap = Math.min(skirt.bounds.x + skirt.bounds.width, limb.bounds.x + limb.bounds.width) - Math.max(skirt.bounds.x, limb.bounds.x);
  const verticalOverlap = Math.min(waistBottom, limb.bounds.y + limb.bounds.height) - Math.max(skirt.bounds.y, limb.bounds.y);
  return horizontalOverlap > 0 && verticalOverlap > 0;
}

function skirtOrderBehindArms(project: PuppetLoomProject, skirt: LayerBinding): number | undefined {
  const frontArms = project.layers.filter((layer) => (layer.role === "arm" || layer.role === "hand") && overlapsSkirtWaist(skirt, layer));
  if (frontArms.length === 0) return undefined;
  return Math.min(skirt.order, Math.min(...frontArms.map((layer) => layer.order)) - 1);
}

function layerOverrides(part: SecondaryModelAgentPart, project: PuppetLoomProject, layers: LayerBinding[], intent: SecondaryPartIntent): CalibrationOverrides {
  const policy = policies[part];
  const layerPatches = Object.fromEntries(layers.map((layer) => {
    if (part === "ahoge") return [layer.id, {}];
    const authoredClothing = part === "topCloth" || part === "skirt";
    const physics = Object.fromEntries(layer.mesh.points.map((point, index) => [
      String(index),
      authoredClothing
        ? clothingPhysicsMask(layer, point)
        : rounded(Math.max(layer.mesh.influences?.physics?.[index] ?? 0, vertexRelease(part, layer, point)), 6)
    ]));
    const weights = policy.driver === "param-head-yaw"
      ? { ...layer.weights, head: 1, physics: part === "ears" ? 0 : 1 }
      : { ...layer.weights, body: 1, physics: 1 };
    const order = part === "skirt" ? skirtOrderBehindArms(project, layer) : undefined;
    return [layer.id, {
      weights,
      vertexInfluences: { physics },
      ...(part === "skirt" && intent.garmentStructure ? { garmentStructure: intent.garmentStructure } : {}),
      ...(part === "skirt" && intent.garmentFlexibility !== undefined ? { garmentFlexibility: intent.garmentFlexibility } : {}),
      ...(order !== undefined ? { order } : {})
    }];
  }));
  const tuning: MotionTuning = { amplitude: intent.amplitude, response: intent.response, stability: intent.stability };
  return {
    layers: layerPatches,
    runtime: { secondaryMotionTuning: { [policy.tuningPart]: tuning } }
  };
}

function maximumBindingDelta(operations: AuthoringOperation[], layerId: string): number {
  return Math.max(0, ...operations.flatMap((operation) => operation.op === "upsert-binding" && operation.binding.target.kind === "layer" && operation.binding.target.id === layerId
    ? operation.binding.keyforms.flatMap((keyform) => Object.values(keyform.meshPointDeltas ?? {}).map((delta) => Math.hypot(delta.x, delta.y)))
    : []));
}

function ahogeRigidityMetrics(layers: LayerBinding[], operations: AuthoringOperation[]): {
  memberVertices: number;
  maximumRadialError: number;
  maximumAngularSpread: number;
} {
  let memberVertices = 0;
  let maximumRadialError = 0;
  let maximumAngularSpread = 0;
  for (const layer of layers) {
    const root = layer.secondaryAnchors?.ahogeRoot;
    if (!root) continue;
    const indices = layer.mesh.points.flatMap((point, index) => ahogeHingeWeight(layer, point) >= 0.999 ? [index] : []);
    memberVertices += indices.length;
    for (const operation of operations) {
      if (operation.op !== "upsert-binding" || operation.binding.target.kind !== "layer" || operation.binding.target.id !== layer.id) continue;
      for (const keyform of operation.binding.keyforms) {
        if ((keyform.values[0] ?? 0) === 0) continue;
        const angles: number[] = [];
        for (const index of indices) {
          const base = layer.mesh.points[index]!;
          const delta = keyform.meshPointDeltas?.[String(index)] ?? { x: 0, y: 0 };
          const moved = { x: base.x + delta.x, y: base.y + delta.y };
          const beforeRadius = Math.hypot(base.x - root.x, base.y - root.y);
          const afterRadius = Math.hypot(moved.x - root.x, moved.y - root.y);
          maximumRadialError = Math.max(maximumRadialError, Math.abs(afterRadius - beforeRadius));
          if (beforeRadius > Math.max(layer.bounds.width, layer.bounds.height) * 0.015) {
            let angle = Math.atan2(moved.y - root.y, moved.x - root.x) - Math.atan2(base.y - root.y, base.x - root.x);
            while (angle > Math.PI) angle -= Math.PI * 2;
            while (angle < -Math.PI) angle += Math.PI * 2;
            angles.push(angle);
          }
        }
        if (angles.length > 1) maximumAngularSpread = Math.max(maximumAngularSpread, Math.max(...angles) - Math.min(...angles));
      }
    }
  }
  return { memberVertices, maximumRadialError, maximumAngularSpread };
}

function supportedSkirtRigidityMetrics(layers: LayerBinding[], operations: AuthoringOperation[]): {
  memberVertices: number;
  maximumRadialError: number;
  maximumAngularSpread: number;
} {
  let memberVertices = 0;
  let maximumRadialError = 0;
  let maximumAngularSpread = 0;
  for (const layer of layers.filter((candidate) => candidate.role === "bottomWear" && candidate.garmentStructure === "supported")) {
    const pivot = skirtSupportPivot(layer);
    const indices = layer.mesh.points.flatMap((point, index) => skirtStructuralRelease(layer, point) >= 0.999 ? [index] : []);
    memberVertices += indices.length;
    for (const operation of operations) {
      if (operation.op !== "upsert-binding" || operation.binding.target.kind !== "layer" || operation.binding.target.id !== layer.id) continue;
      for (const keyform of operation.binding.keyforms) {
        if ((keyform.values[0] ?? 0) === 0) continue;
        const angles: number[] = [];
        for (const index of indices) {
          const base = layer.mesh.points[index]!;
          const delta = keyform.meshPointDeltas?.[String(index)] ?? { x: 0, y: 0 };
          const moved = { x: base.x + delta.x, y: base.y + delta.y };
          const beforeRadius = Math.hypot(base.x - pivot.x, base.y - pivot.y);
          const afterRadius = Math.hypot(moved.x - pivot.x, moved.y - pivot.y);
          maximumRadialError = Math.max(maximumRadialError, Math.abs(afterRadius - beforeRadius));
          if (beforeRadius > Math.max(layer.bounds.width, layer.bounds.height) * 0.015) {
            let angle = Math.atan2(moved.y - pivot.y, moved.x - pivot.x) - Math.atan2(base.y - pivot.y, base.x - pivot.x);
            while (angle > Math.PI) angle -= Math.PI * 2;
            while (angle < -Math.PI) angle += Math.PI * 2;
            angles.push(angle);
          }
        }
        if (angles.length > 1) maximumAngularSpread = Math.max(maximumAngularSpread, Math.max(...angles) - Math.min(...angles));
      }
    }
  }
  return { memberVertices, maximumRadialError, maximumAngularSpread };
}

function checksFor(part: SecondaryModelAgentPart, before: PuppetLoomProject, proposed: PuppetLoomProject, layers: LayerBinding[], operations: AuthoringOperation[]): ModelAgentCheck[] {
  const targetIds = new Set(layers.map((layer) => layer.id));
  const poses = validateProjectPoses(proposed);
  let targetNeutralDrift = 0;
  let otherNeutralDrift = 0;
  let maximumRootDelta = 0;
  let maximumWaistDelta = 0;
  let maximumRelativeDelta = 0;
  for (const layer of proposed.layers) {
    const beforeLayer = before.layers.find((candidate) => candidate.id === layer.id);
    if (!beforeLayer) continue;
    const points = deformedPoints(proposed, layer, neutralMotionState);
    const baseline = deformedPoints(before, beforeLayer, neutralMotionState);
    const drift = Math.max(0, ...points.map((point, index) => Math.hypot(point.x - baseline[index]!.x, point.y - baseline[index]!.y)));
    if (targetIds.has(layer.id)) targetNeutralDrift = Math.max(targetNeutralDrift, drift);
    else otherNeutralDrift = Math.max(otherNeutralDrift, drift);
    if (!targetIds.has(layer.id)) continue;
    const delta = maximumBindingDelta(operations, layer.id);
    maximumRelativeDelta = Math.max(maximumRelativeDelta, delta / Math.max(layer.bounds.width, layer.bounds.height, 1e-6));
    const rootIndices = layer.mesh.points.flatMap((point, index) => vertexRelease(part, layer, point) <= 0.14 ? [index] : []);
    for (const index of rootIndices) {
      const value = operations.flatMap((operation) => operation.op === "upsert-binding" && operation.binding.target.kind === "layer" && operation.binding.target.id === layer.id
        ? operation.binding.keyforms.flatMap((keyform) => {
            const point = keyform.meshPointDeltas?.[String(index)];
            return point ? [Math.hypot(point.x, point.y)] : [];
          })
        : []);
      maximumRootDelta = Math.max(maximumRootDelta, ...value, 0);
    }
    if ((part === "topCloth" && layer.role === "topWear") || (part === "skirt" && layer.role === "bottomWear")) {
      const seamIndices = layer.mesh.points.flatMap((point, index) => {
        const v = clamp((point.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height));
        return (layer.role === "topWear" ? v >= 0.82 : v <= 0.2) ? [index] : [];
      });
      for (const index of seamIndices) {
        const values = operations.flatMap((operation) => operation.op === "upsert-binding" && operation.binding.target.kind === "layer" && operation.binding.target.id === layer.id
          ? operation.binding.keyforms.flatMap((keyform) => {
              const delta = keyform.meshPointDeltas?.[String(index)];
              return delta ? [Math.hypot(delta.x, delta.y)] : [];
            })
          : []);
        maximumWaistDelta = Math.max(maximumWaistDelta, ...values, 0);
      }
    }
  }

  const policy = policies[part];
  const partIds = ids(part);
  const controller = new ModelPhysicsController(proposed);
  let reboundPeak = 0;
  let settledError = 1;
  let dynamicFailures = 0;
  const visibleMinimum = part === "topCloth" && layers.every((layer) => layer.role === "topWear") ? 0 : 0.0015;
  for (let frame = 0; frame <= 210; frame += 1) {
    const timeSeconds = frame / 60;
    const input = timeSeconds < 0.4 ? 0 : timeSeconds < 1.65 ? 0.78 : 0;
    const state = controller.sample({ ...neutralMotionState, [policy.driver === "param-head-yaw" ? "headYaw" : "bodySway"]: input, timeSeconds }, timeSeconds);
    const output = state.parameters?.[partIds.output] ?? 0;
    if (timeSeconds > 1.65) reboundPeak = Math.min(reboundPeak, output);
    if (frame === 210) settledError = Math.abs(output);
    if (frame % 15 === 0 && !validatePose(proposed, `${part}-dynamic-${frame}`, state).passed) dynamicFailures += 1;
  }
  const checks: ModelAgentCheck[] = [
    {
      id: "neutral-preservation",
      label: "目标部位在中立姿态不漂移",
      passed: targetNeutralDrift <= 1e-8,
      details: { maximumNormalizedDrift: rounded(targetNeutralDrift, 10) }
    },
    {
      id: "other-layers-preserved",
      label: "没有改变其他图层的中立结果",
      passed: otherNeutralDrift <= 1e-8,
      details: { maximumOtherLayerDrift: rounded(otherNeutralDrift, 10) }
    },
    {
      id: "visible-deformation",
      label: "变形可见但保持克制",
      passed: maximumRelativeDelta >= visibleMinimum && maximumRelativeDelta <= 0.04,
      details: { maximumRelativeDelta: rounded(maximumRelativeDelta, 8), minimumRequired: visibleMinimum }
    },
    {
      id: "root-continuity",
      label: "根部保持连接",
      passed: maximumRootDelta <= 0.0015,
      details: { maximumRootDelta: rounded(maximumRootDelta, 8) }
    },
    ...((part === "topCloth" || part === "skirt") ? [{
      id: "waist-seam-lock",
      label: "腰线两侧不参与独立布料变形",
      passed: maximumWaistDelta <= 1e-6,
      details: { maximumWaistDelta: rounded(maximumWaistDelta, 10) }
    }] : []),
    {
      id: "lag-rebound",
      label: "滞后会回弹并最终收敛",
      passed: reboundPeak < -0.001 && settledError <= 0.03,
      details: { reboundPeak: rounded(reboundPeak, 8), settledError: rounded(settledError, 8) }
    },
    {
      id: "pose-safety",
      label: "静态姿态与连续运动通过关系和网格安全检查",
      passed: poses.every((pose) => pose.passed) && dynamicFailures === 0,
      details: { staticPassed: poses.filter((pose) => pose.passed).length, staticTotal: poses.length, dynamicFailures }
    }
  ];
  if (part === "skirt") {
    const skirtLayers = proposed.layers.filter((layer) => targetIds.has(layer.id) && layer.role === "bottomWear");
    const comparisons = skirtLayers.flatMap((skirt) => proposed.layers
      .filter((layer) => (layer.role === "arm" || layer.role === "hand") && overlapsSkirtWaist(skirt, layer))
      .map((limb) => ({ skirt: skirt.id, skirtOrder: skirt.order, limb: limb.id, limbOrder: limb.order, passed: skirt.order < limb.order })));
    checks.splice(-1, 0, {
      id: "waist-bow-behind-arms",
      label: "后腰蝴蝶结与下装位于手臂图层之后",
      passed: comparisons.every((comparison) => comparison.passed),
      details: {
        comparisonCount: comparisons.length,
        skirtOrders: comparisons.map((comparison) => comparison.skirtOrder),
        armOrders: comparisons.map((comparison) => comparison.limbOrder),
        violations: comparisons.filter((comparison) => !comparison.passed).length
      }
    });
    const supportedLayers = layers.filter((layer) => layer.role === "bottomWear" && layer.garmentStructure === "supported");
    if (supportedLayers.length > 0) {
      const rigidity = supportedSkirtRigidityMetrics(supportedLayers, operations);
      const scale = Math.max(...supportedLayers.map((layer) => Math.max(layer.bounds.width, layer.bounds.height)), 1e-6);
      const maximumFlexibility = Math.max(...supportedLayers.map((layer) => clamp(layer.garmentFlexibility ?? 0, 0, 0.5)), 0);
      const maximumAllowedAngularSpread = 1e-5 + maximumFlexibility * 0.03;
      checks.splice(-1, 0, {
        id: "supported-skirt-volume",
        label: "裙撑区域保持体积，并只在下半段产生受控弹性",
        passed: rigidity.memberVertices >= 2
          && rigidity.maximumRadialError <= scale * 1e-6
          && rigidity.maximumAngularSpread <= maximumAllowedAngularSpread,
        details: {
          memberVertices: rigidity.memberVertices,
          maximumRadialError: rounded(rigidity.maximumRadialError, 10),
          maximumAngularSpread: rounded(rigidity.maximumAngularSpread, 10),
          maximumFlexibility: rounded(maximumFlexibility, 4),
          maximumAllowedAngularSpread: rounded(maximumAllowedAngularSpread, 10)
        }
      });
    }
  }
  if (part === "ahoge") {
    const rigidity = ahogeRigidityMetrics(layers, operations);
    const scale = Math.max(...layers.map((layer) => Math.max(layer.bounds.width, layer.bounds.height)), 1e-6);
    checks.splice(4, 0, {
      id: "rigid-root-hinge",
      label: "呆毛以发根为轴刚性转动，不拉伸也不分段漂浮",
      passed: rigidity.memberVertices >= 2 && rigidity.maximumRadialError <= scale * 1e-6 && rigidity.maximumAngularSpread <= 1e-5,
      details: {
        memberVertices: rigidity.memberVertices,
        maximumRadialError: rounded(rigidity.maximumRadialError, 10),
        maximumAngularSpread: rounded(rigidity.maximumAngularSpread, 10)
      }
    });
  }
  return checks;
}

function operationId(operation: AuthoringOperation): string {
  if (operation.op === "upsert-parameter") return operation.parameter.id;
  if (operation.op === "upsert-binding") return operation.binding.id;
  if (operation.op === "upsert-physics") return operation.physics.id;
  if (operation.op === "upsert-deformer") return operation.deformer.id;
  if (operation.op === "upsert-expression") return operation.expression.id;
  if (operation.op === "upsert-behavior") return operation.behavior.id;
  if (operation.op === "set-layer-deformer") return operation.layerId;
  if (operation.op === "move-layer") return operation.layerId;
  return operation.id;
}

function draftAssessment(draft: CalibrationDraftDocument | undefined, part: SecondaryModelAgentPart, layerIds: string[]): { found: boolean; compatible: boolean; blockers: string[] } {
  if (!draft) return { found: false, compatible: true, blockers: [] };
  const blockers: string[] = [];
  if (draft.overrides.model) blockers.push("草稿修改了 Authoring 模型");
  if (draft.overrides.anchors) blockers.push("草稿修改了身体锚点");
  if (draft.overrides.semanticPoints) blockers.push("草稿修改了脸部语义点");
  if (draft.overrides.runtime?.envelope || draft.overrides.runtime?.motionTuning) blockers.push("草稿修改了全局运动参数");
  const otherLayers = Object.keys(draft.overrides.layers ?? {}).filter((id) => !layerIds.includes(id));
  if (otherLayers.length > 0) blockers.push(`草稿还包含其他图层：${otherLayers.join("、")}`);
  const allowedTuning = policies[part].tuningPart;
  const otherTuning = Object.keys(draft.overrides.runtime?.secondaryMotionTuning ?? {}).filter((key) => key !== allowedTuning);
  if (otherTuning.length > 0) blockers.push(`草稿还包含其他部位参数：${otherTuning.join("、")}`);
  return { found: true, compatible: blockers.length === 0, blockers };
}

function effectiveDraftOverrides(draft: CalibrationDraftDocument | undefined): CalibrationOverrides {
  return draft ? clone(draft.overrides) : {};
}

/** Builds and repairs one secondary-part proposal without reading or writing project files. */
export function createSecondaryPartAgentProposal(project: PuppetLoomProject, options: SecondaryPartAgentOptions): PreparedSecondaryProposal {
  const preparedLayers = targetLayers(project, options.part, options.layerIds);
  const resolved = intentFor(options.part, options.instruction);
  const instruction = resolved.instruction;
  const intent = options.intent ? clone(options.intent) : resolved.intent;
  const configuredLayers = preparedLayers.map((layer) => options.part === "skirt"
    ? {
        ...layer,
        ...(intent.garmentStructure ? { garmentStructure: intent.garmentStructure } : {}),
        ...(intent.garmentFlexibility !== undefined ? { garmentFlexibility: intent.garmentFlexibility } : {})
      }
    : layer);
  let last: PreparedSecondaryProposal | undefined;
  const repairs: ModelAgentRepair[] = [];
  for (const multiplier of [1, 0.82, 0.66, 0.5, 0.38, 0.28]) {
    if (multiplier < 1) repairs.push({
      pass: repairs.length + 1,
      action: `把${policies[options.part].label}变形收敛到原计划的 ${(multiplier * 100).toFixed(0)}%`,
      reason: "上一轮联合姿态或连续运动检查未通过。",
      targetLayerIds: preparedLayers.map((layer) => layer.id)
    });
    const operations = proposalOperations(options.part, configuredLayers, intent, intent.deformationScale * multiplier);
    const overrides = layerOverrides(options.part, project, configuredLayers, intent);
    const authored = applyAuthoringOperations(project, operations);
    const proposed = applyCalibrationOverrides(authored, overrides);
    const checks = checksFor(options.part, project, proposed, configuredLayers, operations);
    last = { project: proposed, layers: configuredLayers, instruction, intent, operations, previews: operationsPreviews(options.part), overrides, checks, repairs: clone(repairs) };
    if (checks.every((check) => check.passed)) return last;
  }
  return last!;
}

async function preparedProposal(root: string, project: PuppetLoomProject, options: SecondaryPartAgentOptions): Promise<PreparedSecondaryProposal> {
  const selected = targetLayers(project, options.part, options.layerIds);
  const meshPreparation = await prepareAgentMeshes(root, project, selected.map((layer) => layer.id));
  if (meshPreparation.blockers.length > 0) throw new PuppetLoomError("INVALID_INPUT", `${policies[options.part].label}网格无法自动修复：${meshPreparation.blockers.join("；")}`);
  const proposal = createSecondaryPartAgentProposal(meshPreparation.project, { ...options, layerIds: selected.map((layer) => layer.id) });
  for (const [id, mesh] of Object.entries(meshPreparation.replacements)) {
    proposal.overrides.layers ??= {};
    proposal.overrides.layers[id] = { ...proposal.overrides.layers[id], mesh };
  }
  if (Object.keys(meshPreparation.replacements).length > 0) proposal.overrides.model = proposal.project.model;
  proposal.repairs = [...meshPreparation.repairs, ...proposal.repairs].map((repair, index) => ({ ...repair, pass: index + 1 }));
  return proposal;
}

export async function planSecondaryPartAgent(projectDirectory: string, options: SecondaryPartAgentOptions): Promise<SecondaryPartAgentPlan> {
  const root = resolve(projectDirectory);
  const [committed, calibration, draft] = await Promise.all([loadProject(root), loadCalibration(root), loadCalibrationDraft(root)]);
  const selected = targetLayers(committed, options.part, options.layerIds);
  const draftState = draftAssessment(draft, options.part, selected.map((layer) => layer.id));
  const effective = draftState.compatible && draft ? applyCalibrationOverrides(committed, effectiveDraftOverrides(draft)) : committed;
  const proposal = await preparedProposal(root, effective, options);
  const failed = proposal.checks.filter((check) => !check.passed).map((check) => `自检未通过：${check.label}`);
  const blockers = [...draftState.blockers, ...failed];
  return {
    version: 1,
    task: options.part,
    project: committed.name,
    projectDirectory: root,
    baseRevision: calibration.revision,
    instruction: proposal.instruction,
    targetLayers: proposal.layers.map((layer) => ({ id: layer.id, sourceName: layer.sourceName, role: layer.role, pointCount: layer.mesh.points.length, triangleCount: Math.floor(layer.mesh.triangles.length / 3) })),
    intent: proposal.intent,
    operations: proposal.operations.map((operation) => ({ op: operation.op, id: operationId(operation) })),
    checks: proposal.checks,
    repairs: proposal.repairs,
    draft: draftState,
    canApply: blockers.length === 0,
    blockers
  };
}

export async function runSecondaryPartAgent(projectDirectory: string, options: SecondaryPartAgentOptions): Promise<SecondaryPartAgentRunResult> {
  const root = resolve(projectDirectory);
  const plan = await planSecondaryPartAgent(root, options);
  if (!plan.canApply) throw new PuppetLoomError("INVALID_INPUT", `${policies[options.part].label} Agent 计划未通过：${plan.blockers.join("；")}`);
  let revision = plan.baseRevision;
  let adoptedDraftRevision: number | undefined;
  const draft = await loadCalibrationDraft(root);
  if (draft && plan.draft.compatible && Object.keys(draft.overrides).length > 0) {
    const adoption = await saveCalibrationPatch(root, {
      baseRevision: revision,
      label: `Agent · 接管${policies[options.part].label}草稿 · ${draft.label ?? "未命名草稿"}`,
      overrides: clone(draft.overrides)
    });
    revision = adoption.calibration.revision;
    adoptedDraftRevision = revision;
    await clearCalibrationDraft(root);
  }
  const committed = await loadProject(root);
  const proposal = await preparedProposal(root, committed, options);
  const failed = proposal.checks.filter((check) => !check.passed);
  if (failed.length > 0) throw new PuppetLoomError("INVALID_INPUT", `${policies[options.part].label}自检未通过：${failed.map((check) => check.label).join("；")}`);
  const committedProposal = await commitModelAgentProposal(root, revision, {
    part: options.part,
    instruction: proposal.instruction,
    label: `Agent · ${policies[options.part].label}自然运动`,
    targetLayerIds: proposal.layers.map((layer) => layer.id),
    operations: proposal.operations,
    previews: proposal.previews,
    overrides: proposal.overrides,
    checks: proposal.checks,
    repairs: proposal.repairs,
    reportDetails: { intent: proposal.intent, adoptedDraftRevision }
  });
  await clearCalibrationDraft(root);
  const result = committedProposal.result;
  return {
    ok: true,
    task: options.part,
    project: result.project.name,
    projectDirectory: root,
    fromRevision: plan.baseRevision,
    toRevision: result.calibration.revision,
    targetLayerIds: proposal.layers.map((layer) => layer.id),
    ...(adoptedDraftRevision !== undefined ? { adoptedDraftRevision } : {}),
    checks: proposal.checks,
    repairs: proposal.repairs,
    reportPath: committedProposal.reportPath,
    comparisonSheet: result.evidence.comparisonSheet,
    differenceImage: result.evidence.differenceImage
  };
}
