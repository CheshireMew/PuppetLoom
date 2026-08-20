import { applyAuthoringOperations } from "./authoring.js";
import { makeAssetRequests } from "./assets.js";
import { applyCalibrationOverrides } from "./calibration.js";
import { deformedPoints, deformPoint, neutralMotionState } from "./deform.js";
import { PuppetLoomError } from "./errors.js";
import { clamp } from "./math.js";
import { commitModelAgentProposal, type ModelAgentCheck, type ModelAgentPart, type ModelAgentRepair } from "./agent.js";
import { authoredOpacityFor } from "./render-contract.js";
import { loadCalibration, loadCalibrationDraft, loadProject, saveCalibrationPatch, clearCalibrationDraft } from "./project.js";
import { safetyPoseState, validatePose, validateProjectPoses } from "./safety.js";
import { resolve } from "node:path";
import type {
  AssetRequest,
  AuthoringOperation,
  AuthoringPreview,
  CalibrationDraftDocument,
  CalibrationOverrides,
  LayerBinding,
  MotionState,
  PuppetLoomProject,
  SemanticRole
} from "./types.js";

export type PrimaryModelAgentPart = Extract<ModelAgentPart, "headFace" | "eyes" | "mouth" | "body">;

export interface PrimaryPartAgentOptions {
  part: PrimaryModelAgentPart;
  instruction: string;
  layerIds?: string[];
  intent?: PrimaryPartIntent;
}

export interface PrimaryPartIntent {
  amplitude: number;
  response: number;
  stability: number;
  yawDegrees?: number;
  pitchUpDegrees?: number;
  pitchDownDegrees?: number;
  contourStrength?: number;
  depthStrength?: number;
  farEyeOpacity?: number;
  farBrowOpacity?: number;
  farEarOpacity?: number;
  farSideHairOpacity?: number;
  occlusionFadeStart?: number;
  sideHairDepthSwap?: boolean;
  explanation: string[];
}

export interface PrimaryPartAgentPlan {
  version: 1;
  task: PrimaryModelAgentPart;
  project: string;
  projectDirectory: string;
  baseRevision: number;
  instruction: string;
  targetLayers: Array<{ id: string; sourceName: string; role: SemanticRole }>;
  intent: PrimaryPartIntent;
  operations: Array<{ op: AuthoringOperation["op"]; id: string }>;
  checks: ModelAgentCheck[];
  repairs: ModelAgentRepair[];
  assetRequests: AssetRequest[];
  draft: { found: boolean; compatible: boolean; blockers: string[] };
  canApply: boolean;
  blockers: string[];
}

export interface PrimaryPartAgentRunResult {
  ok: true;
  task: PrimaryModelAgentPart;
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

interface PreparedPrimaryProposal {
  project: PuppetLoomProject;
  layers: LayerBinding[];
  instruction: string;
  intent: PrimaryPartIntent;
  operations: AuthoringOperation[];
  previews: AuthoringPreview[];
  overrides: CalibrationOverrides;
  checks: ModelAgentCheck[];
  repairs: ModelAgentRepair[];
  assetRequests: AssetRequest[];
}

const roles: Record<PrimaryModelAgentPart, SemanticRole[]> = {
  headFace: ["face", "nose", "eyebrow", "eyeWhite", "iris", "eyelash", "eyeClosed", "mouth", "neck", "frontHair", "backHair", "sideHair", "headwear", "ear"],
  eyes: ["eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow"],
  mouth: ["mouth"],
  body: ["neck", "topWear", "bottomWear", "arm", "hand", "leg", "foot"]
};

const labels: Record<PrimaryModelAgentPart, string> = {
  headFace: "头部与脸部九向",
  eyes: "眼神与眨眼",
  mouth: "三态嘴型",
  body: "身体跟随与呼吸"
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rounded(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function intentFor(_instruction: string): PrimaryPartIntent {
  return {
    amplitude: 0.76,
    response: 0.72,
    stability: 0.66,
    yawDegrees: 12,
    pitchUpDegrees: 12,
    pitchDownDegrees: 14,
    contourStrength: 1,
    depthStrength: 1,
    farEyeOpacity: 1,
    farBrowOpacity: 1,
    farEarOpacity: 0.55,
    farSideHairOpacity: 0.72,
    occlusionFadeStart: 0.58,
    sideHairDepthSwap: true,
    explanation: ["旧调用兼容入口使用固定安全基线；自然语言意图应由外部 Agent 写入结构化规格。"]
  };
}

function targetLayers(project: PuppetLoomProject, part: PrimaryModelAgentPart, requested?: string[]): LayerBinding[] {
  const requestedSet = requested ? new Set(requested) : undefined;
  const selected = project.layers.filter((layer) => roles[part].includes(layer.role) && (!requestedSet || requestedSet.has(layer.id)));
  if (requested) {
    const missing = requested.filter((id) => !selected.some((layer) => layer.id === id));
    if (missing.length > 0) throw new PuppetLoomError("INVALID_INPUT", `${labels[part]} Agent 找不到目标图层：${missing.join("、")}`);
  }
  if (selected.length === 0) throw new PuppetLoomError("INVALID_INPUT", `项目中没有识别到${labels[part]}所需图层。`);
  return selected;
}

function layerOverrides(part: PrimaryModelAgentPart, project: PuppetLoomProject, layers: LayerBinding[], intent: PrimaryPartIntent): CalibrationOverrides {
  const amplitude = intent.amplitude;
  const patches: NonNullable<CalibrationOverrides["layers"]> = {};
  for (const layer of layers) {
    if (part === "eyes") {
      patches[layer.id] = { weights: { ...layer.weights, head: 1, gaze: layer.role === "iris" ? 1 : 0 } };
    } else if (part === "mouth" || part === "headFace") {
      patches[layer.id] = { weights: { ...layer.weights, head: 1 } };
    } else {
      const body = layer.role === "foot" ? 0 : layer.role === "leg" ? Math.max(0.45, layer.weights.body) : 1;
      patches[layer.id] = { weights: { ...layer.weights, body } };
    }
  }
  if (part === "headFace") {
    const degreesToRadians = (degrees: number): number => degrees * Math.PI / 180;
    const yawDegrees = clamp(intent.yawDegrees ?? 12, 10, 25);
    const pitchUpDegrees = clamp(intent.pitchUpDegrees ?? 12, 8, 20);
    const pitchDownDegrees = clamp(intent.pitchDownDegrees ?? 14, 8, 20);
    return {
      model: {
        // Head/face work is additive. It may update the shared pose field below,
        // but it must not silently erase any accepted front-hair pose, lag or
        // physics authoring from an earlier revision.
        ...clone(project.model)
      },
      layers: patches,
      runtime: {
        envelope: {
          // Semantic poses use normalized -1..1 input; the pose field below
          // is the single source of truth for the actual geometric angle.
          headYaw: 1,
          headPitch: 1,
          headRollDegrees: rounded(clamp(Math.max(project.runtime.envelope.headRollDegrees, 2.6) * amplitude, 1.8, 3.8))
        },
        ...(project.runtime.poseField ? {
          poseField: {
            maxYawRadians: rounded(degreesToRadians(yawDegrees)),
            maxPitchRadians: rounded(degreesToRadians(Math.max(pitchUpDegrees, pitchDownDegrees))),
            maxPitchUpRadians: rounded(degreesToRadians(pitchUpDegrees)),
            maxPitchDownRadians: rounded(degreesToRadians(pitchDownDegrees)),
            perspective: rounded(clamp(Math.max(project.runtime.poseField.perspective, 0.12), 0.1, 0.18)),
            contourStrength: rounded(clamp(intent.contourStrength ?? 1, 0.4, 1.6)),
            depthStrength: rounded(clamp(intent.depthStrength ?? 1, 0.4, 1.6))
          }
        } : {}),
        poseOcclusion: {
          fadeStart: rounded(clamp(intent.occlusionFadeStart ?? 0.58, 0, 0.95)),
          // Retain the serialized fields for project-format compatibility, but painted face
          // features must remain opaque. Perspective comes from geometry, never transparency.
          farEyeOpacity: 1,
          farBrowOpacity: 1,
          farEarOpacity: rounded(clamp(intent.farEarOpacity ?? 0.55, 0, 1)),
          farSideHairOpacity: rounded(clamp(intent.farSideHairOpacity ?? 0.72, 0, 1)),
          sideHairDepthSwap: intent.sideHairDepthSwap ?? true
        },
        motionTuning: { amplitude, response: intent.response, stability: intent.stability }
      }
    };
  }
  if (part === "eyes") {
    return {
      layers: patches,
      runtime: {
        envelope: {
          gazeX: rounded(clamp(Math.max(project.runtime.envelope.gazeX, 0.13) * amplitude, 0.08, 0.18)),
          gazeY: rounded(clamp(Math.max(project.runtime.envelope.gazeY, 0.085) * amplitude, 0.055, 0.12))
        }
      }
    };
  }
  if (part === "body") {
    return {
      layers: patches,
      runtime: {
        envelope: {
          bodySway: rounded(clamp(Math.max(project.runtime.envelope.bodySway, 0.009) * amplitude, 0.006, 0.018)),
          bodyRollDegrees: rounded(clamp(Math.max(project.runtime.envelope.bodyRollDegrees, 1.35) * amplitude, 0.8, 2.4)),
          breath: rounded(clamp(Math.max(project.runtime.envelope.breath, 0.0045) * amplitude, 0.003, 0.008))
        }
      }
    };
  }
  return { layers: patches };
}

function operationsFor(part: PrimaryModelAgentPart): AuthoringOperation[] {
  if (part === "eyes") return [{
    op: "upsert-expression",
    expression: { id: "agent-eyes-closed", name: "自然闭眼", parameters: { "param-blink": 1 } }
  }];
  if (part === "mouth") return [
    { op: "upsert-expression", expression: { id: "agent-mouth-neutral", name: "嘴型 · 闭合", parameters: { "param-mouth-open": 0 } } },
    { op: "upsert-expression", expression: { id: "agent-mouth-slight", name: "嘴型 · 微张", parameters: { "param-mouth-open": 0.42 } } },
    { op: "upsert-expression", expression: { id: "agent-mouth-open", name: "嘴型 · 张开", parameters: { "param-mouth-open": 1 } } }
  ];
  return [];
}

function previewsFor(part: PrimaryModelAgentPart): AuthoringPreview[] {
  if (part === "eyes") return [
    { id: "eyes-left", label: "眼神 · 左", parameters: { "param-gaze-x": -1 } },
    { id: "eyes-neutral", label: "眼神 · 中立", parameters: { "param-gaze-x": 0, "param-gaze-y": 0 } },
    { id: "eyes-right", label: "眼神 · 右", parameters: { "param-gaze-x": 1 } },
    { id: "eyes-blink", label: "眼睛 · 闭眼", parameters: { "param-blink": 1 } }
  ];
  if (part === "mouth") return [
    { id: "mouth-closed", label: "嘴型 · 闭合", parameters: { "param-mouth-open": 0 } },
    { id: "mouth-slight", label: "嘴型 · 微张", parameters: { "param-mouth-open": 0.42 } },
    { id: "mouth-open", label: "嘴型 · 张开", parameters: { "param-mouth-open": 1 } }
  ];
  if (part === "body") return [
    { id: "body-left", label: "身体 · 左跟随", parameters: { "param-body-sway": -0.8, "param-body-roll": -0.45 } },
    { id: "body-breath", label: "身体 · 呼吸", parameters: { "param-breath": 1 } },
    { id: "body-right", label: "身体 · 右跟随", parameters: { "param-body-sway": 0.8, "param-body-roll": 0.45 } }
  ];
  return [
    ["left-up", "头脸 · 左上", -0.8, -0.65], ["up", "头脸 · 上", 0, -0.8], ["right-up", "头脸 · 右上", 0.8, -0.65],
    ["left", "头脸 · 左", -1, 0], ["neutral", "头脸 · 中立", 0, 0], ["right", "头脸 · 右", 1, 0],
    ["left-down", "头脸 · 左下", -0.8, 0.65], ["down", "头脸 · 下", 0, 0.8], ["right-down", "头脸 · 右下", 0.8, 0.65]
  ].map(([id, label, yaw, pitch]) => ({ id: String(id), label: String(label), parameters: { "param-head-yaw": Number(yaw), "param-head-pitch": Number(pitch) } }));
}

function maximumDrift(before: PuppetLoomProject, after: PuppetLoomProject, ids: Set<string>, state: MotionState): number {
  let result = 0;
  for (const layer of after.layers.filter((candidate) => ids.has(candidate.id))) {
    const baseline = before.layers.find((candidate) => candidate.id === layer.id);
    if (!baseline) continue;
    const left = deformedPoints(before, baseline, state);
    const right = deformedPoints(after, layer, state);
    for (let index = 0; index < right.length; index += 1) result = Math.max(result, Math.hypot(right[index]!.x - left[index]!.x, right[index]!.y - left[index]!.y));
  }
  return result;
}

function stateMovement(project: PuppetLoomProject, layers: LayerBinding[], state: MotionState): number {
  let result = 0;
  for (const layer of layers) {
    const moved = deformedPoints(project, layer, state);
    moved.forEach((point, index) => { result = Math.max(result, Math.hypot(point.x - layer.mesh.points[index]!.x, point.y - layer.mesh.points[index]!.y)); });
  }
  return result;
}

function headPoseGeometry(project: PuppetLoomProject): {
  available: boolean;
  crownAvailable: boolean;
  mirrorError: number;
  nearFarEyeRatio: number;
  upLowerFaceRatio: number;
  downLowerFaceRatio: number;
  upCrownRatio: number;
  downCrownRatio: number;
} {
  const cage = project.runtime.semanticCage;
  const field = project.runtime.poseField;
  const face = project.layers.find((layer) => layer.role === "face");
  if (!cage || !field || !face) {
    return { available: false, crownAvailable: false, mirrorError: 0, nearFarEyeRatio: 1, upLowerFaceRatio: 1, downLowerFaceRatio: 1, upCrownRatio: 1, downCrownRatio: 1 };
  }
  const posePoint = (layer: LayerBinding, point: { x: number; y: number }, headYaw = 0, headPitch = 0) =>
    deformPoint(project, layer, point, { ...neutralMotionState, headYaw, headPitch });
  const nose = cage.points.nose.position;
  const noseRight = posePoint(face, nose, 1, 0);
  const noseLeft = posePoint(face, nose, -1, 0);
  const mirrorError = Math.abs((noseRight.x - nose.x) - (nose.x - noseLeft.x)) + Math.abs(noseRight.y - noseLeft.y);

  const eyes = project.layers.filter((layer) => layer.role === "eyeWhite");
  const eyeWidth = (layer: LayerBinding, yaw: number) => {
    const left = posePoint(layer, { x: layer.bounds.x, y: layer.pivot.y }, yaw, 0);
    const right = posePoint(layer, { x: layer.bounds.x + layer.bounds.width, y: layer.pivot.y }, yaw, 0);
    return Math.max(1e-6, right.x - left.x);
  };
  const screenLeft = eyes.find((layer) => layer.side === "right");
  const screenRight = eyes.find((layer) => layer.side === "left");
  const nearFarEyeRatio = screenLeft && screenRight ? eyeWidth(screenLeft, 1) / eyeWidth(screenRight, 1) : 1;

  const lowerHeight = (pitch: number) => {
    const mouth = posePoint(face, cage.points.mouth.position, 0, pitch);
    const chin = posePoint(face, cage.points.chin.position, 0, pitch);
    return Math.max(1e-6, chin.y - mouth.y);
  };
  const neutralLower = lowerHeight(0);

  const crown = project.layers.find((layer) => layer.role === "headwear");
  const crownHeight = (pitch: number) => {
    if (!crown) return 1;
    const x = crown.bounds.x + crown.bounds.width * 0.5;
    const top = posePoint(crown, { x, y: crown.bounds.y + crown.bounds.height * 0.08 }, 0, pitch);
    const band = posePoint(crown, { x, y: crown.bounds.y + crown.bounds.height * 0.46 }, 0, pitch);
    return Math.max(1e-6, band.y - top.y);
  };
  const neutralCrown = crownHeight(0);
  return {
    available: true,
    crownAvailable: Boolean(crown),
    mirrorError,
    nearFarEyeRatio,
    upLowerFaceRatio: lowerHeight(-1) / neutralLower,
    downLowerFaceRatio: lowerHeight(1) / neutralLower,
    upCrownRatio: crownHeight(-1) / neutralCrown,
    downCrownRatio: crownHeight(1) / neutralCrown
  };
}

function requestedAssets(project: PuppetLoomProject, part: PrimaryModelAgentPart): AssetRequest[] {
  const kind = part === "eyes" ? "closed-eye" : part === "mouth" ? "mouth-shape" : undefined;
  return kind ? makeAssetRequests(project).requests.filter((request) => request.kind === kind) : [];
}

function checksFor(part: PrimaryModelAgentPart, before: PuppetLoomProject, proposed: PuppetLoomProject, layers: LayerBinding[], assets: AssetRequest[]): ModelAgentCheck[] {
  const ids = new Set(layers.map((layer) => layer.id));
  const otherIds = new Set(proposed.layers.filter((layer) => !ids.has(layer.id)).map((layer) => layer.id));
  const checks: ModelAgentCheck[] = [
    { id: "neutral-preservation", label: "中立姿态保持原样", passed: maximumDrift(before, proposed, ids, neutralMotionState) <= 1e-8, details: { maximumDrift: rounded(maximumDrift(before, proposed, ids, neutralMotionState), 10) } },
    { id: "other-layers-preserved", label: "没有改变其他图层的中立结果", passed: maximumDrift(before, proposed, otherIds, neutralMotionState) <= 1e-8, details: { maximumOtherLayerDrift: rounded(maximumDrift(before, proposed, otherIds, neutralMotionState), 10) } },
    { id: "pose-safety", label: "联合姿态通过关系和网格安全检查", passed: validateProjectPoses(proposed).every((pose) => pose.passed), details: { passed: validateProjectPoses(proposed).filter((pose) => pose.passed).length, total: validateProjectPoses(proposed).length } }
  ];
  if (part === "headFace") {
    const movement = Math.max(stateMovement(proposed, layers, safetyPoseState(-1, 0, 0)), stateMovement(proposed, layers, safetyPoseState(1, 0, 0)));
    const geometry = headPoseGeometry(proposed);
    const faceLayerCount = before.layers.filter((layer) => layer.role === "face").length;
    const materialYawLimit = faceLayerCount <= 1 ? 12 : 20;
    const requestedYawDegrees = (proposed.runtime.poseField?.maxYawRadians ?? 0) * 180 / Math.PI;
    checks.push({
      id: "head-material-yaw-limit",
      label: "侧转幅度没有超过现有脸部素材能够支持的范围",
      // The stored radians are rounded for deterministic JSON. Converting the
      // 12° boundary back to degrees can therefore be a few ten-thousandths
      // above 12 even though the requested intent is exactly at the limit.
      passed: requestedYawDegrees <= materialYawLimit + 0.001,
      details: { faceLayerCount, requestedYawDegrees: rounded(requestedYawDegrees, 4), materialYawLimit }
    });
    checks.push({ id: "head-turn-visible", label: "头脸九向变化可见且不过量", passed: movement >= 0.002 && movement <= 0.085, details: { maximumMovement: rounded(movement, 8) } });
    checks.push({ id: "nine-pose", label: "九向头部检查全部通过", passed: previewsFor(part).every((preview) => validatePose(proposed, preview.id, {
      ...neutralMotionState,
      headYaw: preview.parameters?.["param-head-yaw"] ?? 0,
      headPitch: preview.parameters?.["param-head-pitch"] ?? 0
    }).passed), details: { poseCount: 9 } });
    if (geometry.available) {
      checks.push({
        id: "head-pose-mirror",
        label: "左右转头使用同一几何规则并保持镜像关系",
        passed: geometry.mirrorError <= proposed.runtime.poseField!.radiusX * 0.035,
        details: { mirrorError: rounded(geometry.mirrorError, 8), nearFarEyeRatio: rounded(geometry.nearFarEyeRatio, 6) }
      });
      checks.push({
        id: "head-yaw-perspective",
        label: "侧转时近眼大于远眼且差异克制",
        passed: geometry.nearFarEyeRatio >= 1.05 && geometry.nearFarEyeRatio <= 1.25,
        details: { nearFarEyeRatio: rounded(geometry.nearFarEyeRatio, 6) }
      });
      checks.push({
        id: "head-pitch-volume",
        label: "抬头展开下半脸并压缩头顶，低头执行相反透视",
        passed: geometry.upLowerFaceRatio >= 1.05
          && geometry.upLowerFaceRatio <= 1.25
          && geometry.downLowerFaceRatio >= 0.75
          && geometry.downLowerFaceRatio <= 0.95
          && (!geometry.crownAvailable || (geometry.upCrownRatio >= 0.86
            && geometry.upCrownRatio <= 0.97
            && geometry.downCrownRatio >= 1.04
            && geometry.downCrownRatio <= 1.16)),
        details: {
          upLowerFaceRatio: rounded(geometry.upLowerFaceRatio, 6),
          downLowerFaceRatio: rounded(geometry.downLowerFaceRatio, 6),
          upCrownRatio: rounded(geometry.upCrownRatio, 6),
          downCrownRatio: rounded(geometry.downCrownRatio, 6)
        }
      });
    }
  }
  if (part === "eyes") {
    const irises = layers.filter((layer) => layer.role === "iris");
    const left = stateMovement(proposed, irises, { ...neutralMotionState, gazeX: -1 });
    const right = stateMovement(proposed, irises, { ...neutralMotionState, gazeX: 1 });
    const openVisible = layers.filter((layer) => ["eyeWhite", "iris", "eyelash"].includes(layer.role)).every((layer) => authoredOpacityFor(proposed, layer, { ...neutralMotionState, blink: 0 }) > 0 && authoredOpacityFor(proposed, layer, { ...neutralMotionState, blink: 1 }) === 0);
    const closed = layers.filter((layer) => layer.role === "eyeClosed");
    const closedVisible = closed.length >= 2 && closed.every((layer) => authoredOpacityFor(proposed, layer, { ...neutralMotionState, blink: 0 }) === 0 && authoredOpacityFor(proposed, layer, { ...neutralMotionState, blink: 1 }) > 0);
    checks.push({ id: "eye-assets", label: "左右闭眼素材完整", passed: assets.length === 0 && proposed.runtime.features.blink, details: { missingAssetCount: assets.length, closedEyeLayerCount: closed.length } });
    checks.push({ id: "gaze", label: "双眼视线可跟随且范围克制", passed: irises.length >= 2 && left >= 0.0008 && right >= 0.0008 && Math.max(left, right) <= 0.012, details: { irisCount: irises.length, leftMovement: rounded(left, 8), rightMovement: rounded(right, 8) } });
    checks.push({ id: "blink-composite", label: "睁眼与闭眼图层正确切换", passed: openVisible && closedVisible, details: { openVisible, closedVisible } });
  }
  if (part === "mouth") {
    const variants = new Set(layers.filter((layer) => layer.opacity > 0).map((layer) => layer.mouthVariant ?? "closed"));
    const dominant = ([0, 0.42, 1] as const).map((value) => layers.filter((layer) => authoredOpacityFor(proposed, layer, { ...neutralMotionState, mouthOpen: value }) > 0.5).map((layer) => layer.mouthVariant ?? "closed"));
    checks.push({ id: "mouth-assets", label: "闭合、微张和张开嘴型素材完整", passed: assets.length === 0 && ["closed", "slight", "open"].every((variant) => variants.has(variant as "closed" | "slight" | "open")) && proposed.runtime.features.mouthMotion, details: { missingAssetCount: assets.length, variants: [...variants].join(",") } });
    checks.push({ id: "mouth-composite", label: "嘴型参数会依次切换三态素材", passed: dominant[0]!.includes("closed") && dominant[1]!.includes("slight") && dominant[2]!.includes("open"), details: { closed: dominant[0]!.join(","), slight: dominant[1]!.join(","), open: dominant[2]!.join(",") } });
  }
  if (part === "body") {
    const moving = stateMovement(proposed, layers.filter((layer) => !["leg", "foot"].includes(layer.role)), { ...neutralMotionState, bodySway: 1, bodyRoll: 0.5, breath: 1 });
    const feet = layers.filter((layer) => layer.role === "foot");
    const feetMovement = stateMovement(proposed, feet, { ...neutralMotionState, bodySway: 1, bodyRoll: 1, breath: 1 });
    checks.push({ id: "body-visible", label: "上身跟随和呼吸可见但不过量", passed: moving >= 0.001 && moving <= 0.055, details: { maximumMovement: rounded(moving, 8) } });
    checks.push({ id: "feet-stable", label: "身体运动时脚部保持稳定", passed: feetMovement <= 1e-8, details: { footCount: feet.length, maximumMovement: rounded(feetMovement, 10) } });
  }
  return checks;
}

/** Builds one primary-body/expression proposal without file-system side effects. */
export function createPrimaryPartAgentProposal(project: PuppetLoomProject, options: PrimaryPartAgentOptions): PreparedPrimaryProposal {
  const layers = targetLayers(project, options.part, options.layerIds);
  const intent = options.intent ? clone(options.intent) : intentFor(options.instruction);
  const operations = operationsFor(options.part);
  const overrides = layerOverrides(options.part, project, layers, intent);
  const proposed = applyCalibrationOverrides(applyAuthoringOperations(project, operations), overrides);
  const assetRequests = requestedAssets(project, options.part);
  return {
    project: proposed,
    layers,
    instruction: options.instruction.trim() || `自动完成${labels[options.part]}`,
    intent,
    operations,
    previews: previewsFor(options.part),
    overrides,
    checks: checksFor(options.part, project, proposed, layers, assetRequests),
    repairs: [],
    assetRequests
  };
}

function draftAssessment(draft: CalibrationDraftDocument | undefined, part: PrimaryModelAgentPart, layerIds: string[]): { found: boolean; compatible: boolean; blockers: string[] } {
  if (!draft) return { found: false, compatible: true, blockers: [] };
  const blockers: string[] = [];
  if (draft.overrides.model) blockers.push("草稿修改了 Authoring 模型");
  if (part !== "headFace" && (draft.overrides.anchors || draft.overrides.semanticPoints)) blockers.push("草稿修改了头脸定位");
  const otherLayers = Object.keys(draft.overrides.layers ?? {}).filter((id) => !layerIds.includes(id));
  if (otherLayers.length > 0) blockers.push(`草稿还包含其他图层：${otherLayers.join("、")}`);
  if (part !== "headFace" && part !== "body" && (draft.overrides.runtime?.envelope || draft.overrides.runtime?.motionTuning)) blockers.push("草稿修改了全局运动参数");
  if (draft.overrides.runtime?.secondaryMotionTuning) blockers.push("草稿修改了次级运动参数");
  return { found: true, compatible: blockers.length === 0, blockers };
}

function operationId(operation: AuthoringOperation): string {
  if (operation.op === "upsert-expression") return operation.expression.id;
  if (operation.op === "upsert-parameter") return operation.parameter.id;
  if (operation.op === "upsert-binding") return operation.binding.id;
  if (operation.op === "upsert-physics") return operation.physics.id;
  if (operation.op === "upsert-deformer") return operation.deformer.id;
  if (operation.op === "upsert-behavior") return operation.behavior.id;
  if (operation.op === "set-layer-deformer") return operation.layerId;
  return operation.id;
}

export async function planPrimaryPartAgent(projectDirectory: string, options: PrimaryPartAgentOptions): Promise<PrimaryPartAgentPlan> {
  const root = resolve(projectDirectory);
  const [project, calibration, draft] = await Promise.all([loadProject(root), loadCalibration(root), loadCalibrationDraft(root)]);
  const layers = targetLayers(project, options.part, options.layerIds);
  const draftState = draftAssessment(draft, options.part, layers.map((layer) => layer.id));
  const effective = draftState.compatible && draft ? applyCalibrationOverrides(project, clone(draft.overrides)) : project;
  const proposal = createPrimaryPartAgentProposal(effective, { ...options, layerIds: layers.map((layer) => layer.id) });
  const failed = proposal.checks.filter((check) => !check.passed).map((check) => `自检未通过：${check.label}`);
  const assetBlockers = proposal.assetRequests.length > 0 ? [`缺少 ${proposal.assetRequests.length} 项必要素材，已生成素材请求。`] : [];
  const blockers = [...draftState.blockers, ...assetBlockers, ...failed];
  return {
    version: 1,
    task: options.part,
    project: project.name,
    projectDirectory: root,
    baseRevision: calibration.revision,
    instruction: proposal.instruction,
    targetLayers: proposal.layers.map((layer) => ({ id: layer.id, sourceName: layer.sourceName, role: layer.role })),
    intent: proposal.intent,
    operations: proposal.operations.map((operation) => ({ op: operation.op, id: operationId(operation) })),
    checks: proposal.checks,
    repairs: proposal.repairs,
    assetRequests: proposal.assetRequests,
    draft: draftState,
    canApply: blockers.length === 0,
    blockers
  };
}

export async function runPrimaryPartAgent(projectDirectory: string, options: PrimaryPartAgentOptions): Promise<PrimaryPartAgentRunResult> {
  const root = resolve(projectDirectory);
  const plan = await planPrimaryPartAgent(root, options);
  if (!plan.canApply) throw new PuppetLoomError("INVALID_INPUT", `${labels[options.part]} Agent 计划未通过：${plan.blockers.join("；")}`);
  let revision = plan.baseRevision;
  let adoptedDraftRevision: number | undefined;
  const draft = await loadCalibrationDraft(root);
  if (draft && plan.draft.compatible && Object.keys(draft.overrides).length > 0) {
    const adoption = await saveCalibrationPatch(root, { baseRevision: revision, label: `Agent · 接管${labels[options.part]}草稿 · ${draft.label ?? "未命名草稿"}`, overrides: clone(draft.overrides) });
    revision = adoption.calibration.revision;
    adoptedDraftRevision = revision;
    await clearCalibrationDraft(root);
  }
  const project = await loadProject(root);
  const proposal = createPrimaryPartAgentProposal(project, options);
  const failed = proposal.checks.filter((check) => !check.passed);
  if (failed.length > 0) throw new PuppetLoomError("INVALID_INPUT", `${labels[options.part]}自检未通过：${failed.map((check) => check.label).join("；")}`);
  const committed = await commitModelAgentProposal(root, revision, {
    part: options.part,
    instruction: proposal.instruction,
    label: `Agent · ${labels[options.part]}`,
    targetLayerIds: proposal.layers.map((layer) => layer.id),
    operations: proposal.operations,
    previews: proposal.previews,
    overrides: proposal.overrides,
    checks: proposal.checks,
    repairs: proposal.repairs,
    reportDetails: { intent: proposal.intent, assetRequests: proposal.assetRequests, adoptedDraftRevision }
  });
  await clearCalibrationDraft(root);
  return {
    ok: true,
    task: options.part,
    project: committed.result.project.name,
    projectDirectory: root,
    fromRevision: plan.baseRevision,
    toRevision: committed.result.calibration.revision,
    targetLayerIds: proposal.layers.map((layer) => layer.id),
    ...(adoptedDraftRevision !== undefined ? { adoptedDraftRevision } : {}),
    checks: proposal.checks,
    repairs: proposal.repairs,
    reportPath: committed.reportPath,
    comparisonSheet: committed.result.evidence.comparisonSheet,
    differenceImage: committed.result.evidence.differenceImage
  };
}
