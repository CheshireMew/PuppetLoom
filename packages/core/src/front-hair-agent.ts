import { resolve } from "node:path";
import { commitModelAgentProposal, type ModelAgentCheck, type ModelAgentRepair } from "./agent.js";
import { assessAgentMesh, prepareAgentMeshes } from "./agent-mesh.js";
import { applyAuthoringOperations } from "./authoring.js";
import { applyCalibrationOverrides } from "./calibration.js";
import { deformedPoints, neutralMotionState } from "./deform.js";
import { PuppetLoomError } from "./errors.js";
import { ahogeHingeWeight, ahogeMembership, frontHairSideGeometry, rotationDelta } from "./front-hair-geometry.js";
import { ModelPhysicsController } from "./model.js";
import { applyCoherentPoseField } from "./pose-field.js";
import {
  clearCalibrationDraft,
  loadCalibration,
  loadCalibrationDraft,
  loadProject,
  saveCalibrationPatch
} from "./project.js";
import { safetyPoses, safetyPoseState, validatePose, validateProjectPoses } from "./safety.js";
import type {
  AuthoringOperation,
  AuthoringPreview,
  CalibrationDraftDocument,
  CalibrationOverrides,
  LayerCalibrationOverride,
  CalibrationSaveResult,
  LayerBinding,
  ModelBinding,
  ModelKeyform,
  MotionTuning,
  Point,
  PuppetLoomProject
} from "./types.js";

const DEFAULT_INSTRUCTION = "让前发随头部转向自然变形，并增加轻微滞后和回弹";

export interface FrontHairAgentOptions {
  instruction?: string;
  layerId?: string;
  intent?: FrontHairIntentProfile;
}

export interface FrontHairIntentProfile {
  amplitude: number;
  response: number;
  stability: number;
  ahogeAmplitude: number;
  ahogeResponse: number;
  ahogeStability: number;
  lagResponse: number;
  lagDamping: number;
  deformationScale: number;
  crownOutset?: number;
  bangLagDegrees?: number;
  explanation: string[];
}

export interface FrontHairTopologySummary {
  pointCount: number;
  triangleCount: number;
  connectedComponents: number;
  expectedComponents: number;
  orphanVertexIndices: number[];
}

export type FrontHairAgentCheck = ModelAgentCheck;

export interface FrontHairAgentPlan {
  version: 1;
  task: "front-hair";
  project: string;
  projectDirectory: string;
  baseRevision: number;
  instruction: string;
  layer: {
    id: string;
    sourceName: string;
    topology: LayerBinding["mesh"]["topology"];
    pointCount: number;
    triangleCount: number;
  };
  draft: {
    found: boolean;
    requiresAdoption: boolean;
    label?: string;
    pointCount?: number;
  };
  intent: FrontHairIntentProfile;
  topology: FrontHairTopologySummary;
  operations: Array<{ op: AuthoringOperation["op"]; id: string }>;
  checks: FrontHairAgentCheck[];
  requiresChanges: boolean;
  canApply: boolean;
  blockers: string[];
}

export interface FrontHairAgentRunResult {
  ok: true;
  changed: boolean;
  task: "front-hair";
  project: string;
  projectDirectory: string;
  instruction: string;
  layerId: string;
  fromRevision: number;
  toRevision: number;
  adoptedDraftRevision?: number;
  sessions: Array<{
    kind: "draft-adoption" | "front-hair-authoring";
    id: string;
    fromRevision: number;
    toRevision: number;
    evidenceDirectory?: string;
  }>;
  checks: FrontHairAgentCheck[];
  reportPath?: string;
  comparisonSheet?: string;
  differenceImage?: string;
}

interface PreparedFrontHairProposal {
  layer: LayerBinding;
  intent: FrontHairIntentProfile;
  topology: FrontHairTopologySummary;
  operations: AuthoringOperation[];
  previews: AuthoringPreview[];
  overrides: CalibrationOverrides;
  project: PuppetLoomProject;
  checks: FrontHairAgentCheck[];
  repairs: ModelAgentRepair[];
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(value: number): number {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function rounded(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function instructionProfile(rawInstruction?: string, explicitIntent?: FrontHairIntentProfile): { instruction: string; profile: FrontHairIntentProfile } {
  const instruction = rawInstruction?.trim() || DEFAULT_INSTRUCTION;
  if (explicitIntent) return { instruction, profile: clone(explicitIntent) };
  return {
    instruction,
    profile: {
      amplitude: 0.74,
      response: 0.42,
      stability: 0.46,
      ahogeAmplitude: 0.7992,
      ahogeResponse: 0.36,
      ahogeStability: 0.38,
      lagResponse: 8.2,
      lagDamping: 0.78,
      deformationScale: 0.88,
      crownOutset: 0,
      bangLagDegrees: 3.2,
      explanation: ["旧调用兼容入口使用固定安全基线；自然语言意图应由外部 Agent 写入结构化规格。"]
    }
  };
}

function selectFrontHairLayer(project: PuppetLoomProject, requestedId?: string): LayerBinding {
  if (requestedId) {
    const selected = project.layers.find((layer) => layer.id === requestedId);
    if (!selected) throw new PuppetLoomError("INVALID_INPUT", `找不到图层：${requestedId}`);
    if (selected.role !== "frontHair") throw new PuppetLoomError("INVALID_INPUT", `${selected.sourceName} 不是前发图层。`);
    return selected;
  }
  const candidates = project.layers.filter((layer) => layer.role === "frontHair");
  if (candidates.length === 0) throw new PuppetLoomError("INVALID_INPUT", "项目中没有识别到前发图层。" );
  if (candidates.length === 1) return candidates[0]!;
  return [...candidates].sort((left, right) => right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height)[0]!;
}

function topologySummary(layer: LayerBinding): FrontHairTopologySummary {
  const referenced = new Set(layer.mesh.triangles);
  const adjacency = Array.from({ length: layer.mesh.points.length }, () => new Set<number>());
  for (let index = 0; index < layer.mesh.triangles.length; index += 3) {
    const triangle = layer.mesh.triangles.slice(index, index + 3);
    if (triangle.length !== 3) continue;
    for (const from of triangle) for (const to of triangle) if (from !== to) adjacency[from]?.add(to);
  }
  const visited = new Set<number>();
  let components = 0;
  for (let index = 0; index < adjacency.length; index += 1) {
    if (!referenced.has(index) || visited.has(index)) continue;
    components += 1;
    const queue = [index];
    visited.add(index);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency[current] ?? []) if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return {
    pointCount: layer.mesh.points.length,
    triangleCount: Math.floor(layer.mesh.triangles.length / 3),
    connectedComponents: components,
    expectedComponents: Math.max(1, layer.mesh.art?.regions.length ?? 1),
    orphanVertexIndices: layer.mesh.points.flatMap((_point, index) => referenced.has(index) ? [] : [index])
  };
}

interface VertexRelease {
  u: number;
  v: number;
  strand: number;
  ahoge: number;
  total: number;
}

function vertexRelease(layer: LayerBinding, point: Point): VertexRelease {
  const width = Math.max(1e-6, layer.bounds.width);
  const height = Math.max(1e-6, layer.bounds.height);
  const u = clamp((point.x - layer.bounds.x) / width);
  const v = clamp((point.y - layer.bounds.y) / height);
  const strand = frontHairSideGeometry(layer, point).totalRelease;

  const ahoge = ahogeHingeWeight(layer, point);
  return { u, v, strand, ahoge, total: Math.max(strand, ahoge) };
}

function sparseDeltas(layer: LayerBinding, calculate: (point: Point, release: VertexRelease, index: number) => Point): Record<string, Point> {
  return Object.fromEntries(layer.mesh.points.flatMap((point, index) => {
    const delta = calculate(point, vertexRelease(layer, point), index);
    const value = { x: rounded(delta.x), y: rounded(delta.y) };
    return Math.hypot(value.x, value.y) <= 1e-9 ? [] : [[String(index), value]];
  }));
}

function poseKeyform(
  layer: LayerBinding,
  yaw: -1 | 0 | 1,
  pitch: -1 | 0 | 1,
  profile: FrontHairIntentProfile,
  protectedVertices: ReadonlySet<number>
): ModelKeyform {
  if (yaw === 0 && pitch === 0) return { values: [yaw, pitch] };
  const deltas = sparseDeltas(layer, (point, release, index) => {
    if (protectedVertices.has(index)) return { x: 0, y: 0 };
    // The ahoge has its own root-hinge authoring and must not inherit the
    // flexible front-hair keyform as a second deformation.
    if (ahogeMembership(layer, point)) return { x: 0, y: 0 };
    const strand = frontHairSideGeometry(layer, point);
    const flex = 0.38 + release.total * 0.62;
    const yawShift = yaw * layer.bounds.width * (0.0025 + 0.0028 * flex) * profile.deformationScale;
    const near = Math.max(0, -yaw * strand.screenSide);
    const far = Math.max(0, yaw * strand.screenSide);
    const centerX = layer.bounds.x + layer.bounds.width * 0.5;
    // Keep only a mild authored depth cue. The runtime contour plane owns the
    // visible silhouette and prevents this keyform from over-compressing it.
    const halfPlaneWeight = smoothstep((Math.abs(release.u - 0.5) - 0.04) / 0.16);
    const perspectiveX = (point.x - centerX) * (near * 0.045 - far * 0.05) * halfPlaneWeight * profile.deformationScale;
    const pitchShift = pitch * layer.bounds.height * (0.0038 + 0.0062 * flex) * profile.deformationScale;
    const pitchSpread = -pitch * (release.u - 0.5) * layer.bounds.width * 0.0028 * flex * profile.deformationScale;
    return { x: yawShift + perspectiveX + pitchSpread, y: pitchShift };
  });
  return { values: [yaw, pitch], ...(Object.keys(deltas).length > 0 ? { meshPointDeltas: deltas } : {}) };
}

function lagKeyform(
  layer: LayerBinding,
  value: -1 | 0 | 1,
  profile: FrontHairIntentProfile,
  direction: 1 | -1,
  protectedVertices: ReadonlySet<number>,
  angleLimit = 0.026
): ModelKeyform {
  if (value === 0) return { values: [value] };
  const deltas = sparseDeltas(layer, (point, _release, index) => {
    if (protectedVertices.has(index)) return { x: 0, y: 0 };
    if (ahogeMembership(layer, point)) return { x: 0, y: 0 };
    const strand = frontHairSideGeometry(layer, point);
    if (strand.totalRelease <= 1e-6) return { x: 0, y: 0 };
    const sign = -value * direction * profile.deformationScale;
    const sideDelta = rotationDelta(point, strand.root, sign * strand.sideRelease * angleLimit);
    // A short bang has much less lever length than a long side lock. Reusing
    // the side-lock angle left its tip below one pixel even at full lag. Give
    // the central fringe its own restrained 3.2° hinge range.
    const bangAngle = (profile.bangLagDegrees ?? 3.2) * Math.PI / 180;
    const bangDelta = rotationDelta(point, strand.bangRoot, sign * strand.bangRelease * bangAngle);
    return { x: sideDelta.x + bangDelta.x, y: sideDelta.y + bangDelta.y };
  });
  return { values: [value], ...(Object.keys(deltas).length > 0 ? { meshPointDeltas: deltas } : {}) };
}

function crownOutsetWeight(uv: Point): number {
  const side = smoothstep((Math.abs(uv.x - 0.5) - 0.12) / 0.38);
  const enters = smoothstep((uv.y - 0.12) / 0.24);
  const leaves = 1 - smoothstep((uv.y - 0.58) / 0.22);
  return side * enters * leaves;
}

function crownOutsetOverride(layer: LayerBinding, outset: number): LayerCalibrationOverride | undefined {
  if (outset <= 1e-9) return undefined;
  const width = Math.max(1e-6, layer.bounds.width);
  const height = Math.max(1e-6, layer.bounds.height);
  const meshPointDeltas = Object.fromEntries(layer.mesh.points.flatMap((point, index) => {
    const uv = layer.mesh.uvs[index];
    if (!uv) return [];
    const side = uv.x < 0.5 ? -1 : uv.x > 0.5 ? 1 : 0;
    const weight = crownOutsetWeight(uv);
    if (side === 0 || weight <= 1e-6) return [];
    // Calibration deltas are stored relative to the UV-aligned ArtMesh. Keep
    // any existing authored neutral correction, then add the requested crown
    // fullness so a later revision does not silently erase earlier work.
    const uvBase = {
      x: layer.bounds.x + width * uv.x,
      y: layer.bounds.y + height * uv.y
    };
    return [[String(index), {
      x: rounded(point.x - uvBase.x + side * width * outset * weight),
      y: rounded(point.y - uvBase.y)
    }]];
  }));
  const secondaryAnchors = Object.fromEntries([
    ["frontHairRootLeft", layer.secondaryAnchors?.frontHairRootLeft],
    ["frontHairRootRight", layer.secondaryAnchors?.frontHairRootRight]
  ].flatMap(([name, rawAnchor]) => {
    const anchor = rawAnchor as Point | undefined;
    if (!anchor) return [];
    const uv = {
      x: clamp((anchor.x - layer.bounds.x) / width),
      y: clamp((anchor.y - layer.bounds.y) / height)
    };
    const side = uv.x < 0.5 ? -1 : 1;
    return [[name, { x: rounded(anchor.x + side * width * outset * crownOutsetWeight(uv)), y: anchor.y }]];
  })) as LayerCalibrationOverride["secondaryAnchors"];
  const anchorPatch = secondaryAnchors ?? {};
  return {
    meshPointDeltas,
    ...(Object.keys(anchorPatch).length > 0 ? { secondaryAnchors: anchorPatch } : {})
  };
}

function idsFor(layer: LayerBinding): {
  outputParameter: string;
  poseBinding: string;
  directLagBinding: string;
  followLagBinding: string;
  physics: string;
} {
  const suffix = layer.id.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return {
    outputParameter: `param-agent-front-hair-follow-${suffix}`,
    poseBinding: `agent-front-hair-pose-${suffix}`,
    directLagBinding: `agent-front-hair-lag-direct-${suffix}`,
    followLagBinding: `agent-front-hair-lag-follow-${suffix}`,
    physics: `agent-front-hair-physics-${suffix}`
  };
}

function frontHairOperations(
  layer: LayerBinding,
  profile: FrontHairIntentProfile,
  protectedVertices: ReadonlySet<number>,
  unifiedPose: boolean
): AuthoringOperation[] {
  const ids = idsFor(layer);
  const poseBinding: ModelBinding = {
    id: ids.poseBinding,
    parameterIds: ["param-head-yaw", "param-head-pitch"],
    target: { kind: "layer", id: layer.id },
    keyforms: ([-1, 0, 1] as const).flatMap((yaw) => ([-1, 0, 1] as const).map((pitch) => poseKeyform(layer, yaw, pitch, profile, protectedVertices)))
  };
  const directLag: ModelBinding = {
    id: ids.directLagBinding,
    parameterIds: ["param-head-yaw"],
    target: { kind: "layer", id: layer.id },
    keyforms: ([-1, 0, 1] as const).map((value) => lagKeyform(layer, value, profile, 1, protectedVertices, unifiedPose ? 0.012 : 0.026))
  };
  const followLag: ModelBinding = {
    id: ids.followLagBinding,
    parameterIds: [ids.outputParameter],
    target: { kind: "layer", id: layer.id },
    keyforms: ([-1, 0, 1] as const).map((value) => lagKeyform(layer, value, profile, -1, protectedVertices, unifiedPose ? 0.012 : 0.026))
  };
  return [
    {
      op: "upsert-parameter",
      parameter: {
        id: ids.outputParameter,
        name: "Front Hair Follow",
        group: "Agent / Front Hair",
        kind: "continuous",
        min: -1,
        default: 0,
        max: 1
      }
    },
    ...(!unifiedPose ? [{ op: "upsert-binding", binding: poseBinding } as AuthoringOperation] : []),
    { op: "upsert-binding", binding: directLag },
    { op: "upsert-binding", binding: followLag },
    {
      op: "upsert-physics",
      physics: {
        id: ids.physics,
        name: "Front Hair Lag and Rebound",
        inputParameterId: "param-head-yaw",
        outputParameterId: ids.outputParameter,
        inputScale: 1,
        outputScale: 1,
        response: profile.lagResponse,
        damping: profile.lagDamping
      }
    }
  ];
}

function frontHairPreviews(): AuthoringPreview[] {
  return [
    ["left-up", "左转 + 抬头", -1, -1], ["up", "抬头", 0, -1], ["right-up", "右转 + 抬头", 1, -1],
    ["left", "左转", -1, 0], ["neutral", "中立", 0, 0], ["right", "右转", 1, 0],
    ["left-down", "左转 + 低头", -1, 1], ["down", "低头", 0, 1], ["right-down", "右转 + 低头", 1, 1]
  ].map(([id, label, yaw, pitch]) => ({
    id: `agent-front-hair-${String(id)}`,
    label: `前发 · ${String(label)}`,
    parameters: { "param-head-yaw": Number(yaw), "param-head-pitch": Number(pitch) }
  }));
}

function physicsInfluencePatch(layer: LayerBinding): Record<string, number> {
  return Object.fromEntries(layer.mesh.points.map((point, index) => {
    const release = Math.max(ahogeHingeWeight(layer, point), vertexRelease(layer, point).strand);
    return [String(index), rounded(release <= 1e-4 ? 0 : 0.52 + release * 0.48, 6)];
  }));
}

function signedArea(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function unstableFrontHairVertices(project: PuppetLoomProject, layer: LayerBinding): Set<number> {
  const unstable = new Set<number>();
  for (const pose of safetyPoses) {
    const current = deformedPoints(project, layer, safetyPoseState(pose.yaw, pose.pitch, pose.roll));
    for (let triangleIndex = 0; triangleIndex < layer.mesh.triangles.length; triangleIndex += 3) {
      const ia = layer.mesh.triangles[triangleIndex];
      const ib = layer.mesh.triangles[triangleIndex + 1];
      const ic = layer.mesh.triangles[triangleIndex + 2];
      if (ia === undefined || ib === undefined || ic === undefined) continue;
      const a0 = layer.mesh.points[ia];
      const b0 = layer.mesh.points[ib];
      const c0 = layer.mesh.points[ic];
      const a1 = current[ia];
      const b1 = current[ib];
      const c1 = current[ic];
      if (!a0 || !b0 || !c0 || !a1 || !b1 || !c1) continue;
      const baseArea = signedArea(a0, b0, c0);
      const currentArea = signedArea(a1, b1, c1);
      const ratio = Math.abs(currentArea) / Math.max(1e-12, Math.abs(baseArea));
      if (baseArea * currentArea <= 0 || ratio < 0.1) {
        unstable.add(ia);
        unstable.add(ib);
        unstable.add(ic);
      }
    }
  }
  return unstable;
}

function maxBindingDelta(operations: AuthoringOperation[], bindingId: string): number {
  const binding = operations.find((operation): operation is Extract<AuthoringOperation, { op: "upsert-binding" }> => operation.op === "upsert-binding" && operation.binding.id === bindingId)?.binding;
  return Math.max(0, ...(binding?.keyforms.flatMap((keyform) => Object.values(keyform.meshPointDeltas ?? {}).map((delta) => Math.hypot(delta.x, delta.y))) ?? []));
}

function maxBindingDeltaForVertices(operations: AuthoringOperation[], bindingId: string, vertexIndices: readonly number[]): number {
  const binding = operations.find((operation): operation is Extract<AuthoringOperation, { op: "upsert-binding" }> => operation.op === "upsert-binding" && operation.binding.id === bindingId)?.binding;
  const wanted = new Set(vertexIndices.map(String));
  return Math.max(0, ...(binding?.keyforms.flatMap((keyform) => Object.entries(keyform.meshPointDeltas ?? {}).flatMap(([index, delta]) => (
    wanted.has(index) ? [Math.hypot(delta.x, delta.y)] : []
  ))) ?? []));
}

function neutralDrift(project: PuppetLoomProject, layer: LayerBinding): number {
  const points = deformedPoints(project, layer, neutralMotionState);
  return Math.max(0, ...points.map((point, index) => Math.hypot(point.x - layer.mesh.points[index]!.x, point.y - layer.mesh.points[index]!.y)));
}

function nearestVertexIndex(layer: LayerBinding, target: Point): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < layer.mesh.points.length; index += 1) {
    const point = layer.mesh.points[index]!;
    const distance = Math.hypot(point.x - target.x, point.y - target.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function frontHairGeometryChecks(project: PuppetLoomProject, layer: LayerBinding): {
  perspectivePassed: boolean;
  hangingPassed: boolean;
  details: Record<string, number>;
} {
  const leftRoot = layer.secondaryAnchors?.frontHairRootLeft;
  const rightRoot = layer.secondaryAnchors?.frontHairRootRight;
  const leftTip = layer.secondaryAnchors?.frontHairTipLeft;
  const rightTip = layer.secondaryAnchors?.frontHairTipRight;
  if (!leftRoot || !rightRoot || !leftTip || !rightTip) {
    return { perspectivePassed: false, hangingPassed: false, details: { missingSideAnchors: 1 } };
  }
  const midpoint = (root: Point, tip: Point): Point => ({
    x: root.x + (tip.x - root.x) * 0.56,
    y: root.y + (tip.y - root.y) * 0.56
  });
  const leftMid = midpoint(leftRoot, leftTip);
  const rightMid = midpoint(rightRoot, rightTip);
  const sampleY = (leftMid.y + rightMid.y) * 0.5;
  const center = { x: layer.bounds.x + layer.bounds.width * 0.5, y: sampleY };
  const unifiedPose = project.runtime.poseField && project.runtime.semanticCage;
  const samples = [leftRoot, rightRoot, leftMid, rightMid, center];
  const indices = unifiedPose
    ? { leftRoot: 0, rightRoot: 1, leftMid: 2, rightMid: 3, center: 4 }
    : {
        leftRoot: nearestVertexIndex(layer, leftRoot),
        rightRoot: nearestVertexIndex(layer, rightRoot),
        leftMid: nearestVertexIndex(layer, leftMid),
        rightMid: nearestVertexIndex(layer, rightMid),
        center: nearestVertexIndex(layer, center)
      };
  const coherentSamples = (yaw: number): Point[] => samples.map((point) => applyCoherentPoseField(
    project.runtime.poseField!,
    layer,
    point,
    yaw * project.runtime.envelope.headYaw,
    0,
    project.runtime.semanticCage
  ));
  const poses = unifiedPose
    ? { neutral: samples, noseRight: coherentSamples(0.82), noseLeft: coherentSamples(-0.82) }
    : {
        neutral: deformedPoints(project, layer, neutralMotionState),
        noseRight: deformedPoints(project, layer, { ...neutralMotionState, headYaw: 0.82 }),
        noseLeft: deformedPoints(project, layer, { ...neutralMotionState, headYaw: -0.82 })
      };
  const spanScales = (points: Point[]): { left: number; right: number } => {
    const neutral = poses.neutral;
    const neutralLeft = Math.max(1e-6, neutral[indices.center]!.x - neutral[indices.leftMid]!.x);
    const neutralRight = Math.max(1e-6, neutral[indices.rightMid]!.x - neutral[indices.center]!.x);
    return {
      left: (points[indices.center]!.x - points[indices.leftMid]!.x) / neutralLeft,
      right: (points[indices.rightMid]!.x - points[indices.center]!.x) / neutralRight
    };
  };
  const noseRightScale = spanScales(poses.noseRight);
  const noseLeftScale = spanScales(poses.noseLeft);
  const inwardChange = (points: Point[], rootIndex: number, midIndex: number, screenSide: -1 | 1): number => {
    const neutralLean = poses.neutral[midIndex]!.x - poses.neutral[rootIndex]!.x;
    const posedLean = points[midIndex]!.x - points[rootIndex]!.x;
    return (posedLean - neutralLean) * -screenSide;
  };
  const maximumInwardPull = Math.max(
    0,
    inwardChange(poses.noseRight, indices.leftRoot, indices.leftMid, -1),
    inwardChange(poses.noseRight, indices.rightRoot, indices.rightMid, 1),
    inwardChange(poses.noseLeft, indices.leftRoot, indices.leftMid, -1),
    inwardChange(poses.noseLeft, indices.rightRoot, indices.rightMid, 1)
  );
  const rightDifference = noseRightScale.left - noseRightScale.right;
  const leftDifference = noseLeftScale.right - noseLeftScale.left;
  return {
    perspectivePassed: rightDifference >= 0.012
      && leftDifference >= 0.012
      && noseRightScale.left <= 1.12
      && noseLeftScale.right <= 1.12
      && noseRightScale.right >= 0.92
      && noseLeftScale.left >= 0.92,
    hangingPassed: maximumInwardPull <= layer.bounds.width * 0.035,
    details: {
      noseRightNearScale: rounded(noseRightScale.left, 6),
      noseRightFarScale: rounded(noseRightScale.right, 6),
      noseLeftNearScale: rounded(noseLeftScale.right, 6),
      noseLeftFarScale: rounded(noseLeftScale.left, 6),
      maximumInwardPull: rounded(maximumInwardPull, 8),
      maximumAllowedInwardPull: rounded(layer.bounds.width * 0.035, 8)
    }
  };
}

function lagSimulation(project: PuppetLoomProject, layer: LayerBinding): {
  peakError: number;
  settledTurnError: number;
  settledNeutralError: number;
  reboundPeak: number;
  reboundObserved: boolean;
  dynamicPoseFailures: number;
} {
  const ids = idsFor(layer);
  const controller = new ModelPhysicsController(project);
  let peakError = 0;
  let settledTurnError = 1;
  let settledNeutralError = 1;
  let reboundPeak = 0;
  let dynamicPoseFailures = 0;
  for (let frame = 0; frame <= 240; frame += 1) {
    const timeSeconds = frame / 60;
    const input = timeSeconds < 0.5 ? 0 : timeSeconds < 1.75 ? 0.78 : 0;
    const sampled = controller.sample({ ...neutralMotionState, headYaw: input, timeSeconds }, timeSeconds);
    const output = sampled.parameters?.[ids.outputParameter] ?? 0;
    const error = input - output;
    peakError = Math.max(peakError, Math.abs(error));
    if (Math.abs(timeSeconds - 1.7) < 1 / 120) settledTurnError = Math.abs(error);
    if (timeSeconds > 1.75) reboundPeak = Math.min(reboundPeak, output);
    if (frame === 240) settledNeutralError = Math.abs(output);
    if (frame % 20 === 0 && !validatePose(project, `front-hair-dynamic-${frame}`, sampled).passed) dynamicPoseFailures += 1;
  }
  return {
    peakError: rounded(peakError, 6),
    settledTurnError: rounded(settledTurnError, 6),
    settledNeutralError: rounded(settledNeutralError, 6),
    reboundPeak: rounded(reboundPeak, 6),
    reboundObserved: reboundPeak < -0.001,
    dynamicPoseFailures
  };
}

function qualityChecks(
  project: PuppetLoomProject,
  layer: LayerBinding,
  operations: AuthoringOperation[],
  topology: FrontHairTopologySummary,
  unifiedPose: boolean,
  profile: FrontHairIntentProfile
): FrontHairAgentCheck[] {
  const ids = idsFor(layer);
  const poses = validateProjectPoses(project);
  const lag = lagSimulation(project, layer);
  const neutralPoints = deformedPoints(project, layer, neutralMotionState);
  const coherentPoseDelta = Math.max(
    ...[-1, 1].flatMap((yaw) => deformedPoints(project, layer, safetyPoseState(yaw, 0, 0)).map((point, index) => {
      const neutral = neutralPoints[index]!;
      return Math.hypot(point.x - neutral.x, point.y - neutral.y);
    }))
  );
  const poseDelta = unifiedPose ? coherentPoseDelta : maxBindingDelta(operations, ids.poseBinding);
  const lagDelta = maxBindingDelta(operations, ids.directLagBinding);
  const drift = neutralDrift(project, layer);
  const geometry = frontHairGeometryChecks(project, layer);
  const meshAssessment = assessAgentMesh(layer);
  const scale = Math.max(layer.bounds.width, layer.bounds.height);
  const expectedCrownOutset = layer.bounds.width * (profile.crownOutset ?? 0);
  const crownOutsets = layer.mesh.points.flatMap((point, index) => {
    const uv = layer.mesh.uvs[index];
    if (!uv || crownOutsetWeight(uv) < 0.65 || Math.abs(uv.x - 0.5) < 1e-6) return [];
    const uvX = layer.bounds.x + layer.bounds.width * uv.x;
    return [{ side: uv.x < 0.5 ? -1 : 1, outset: (point.x - uvX) * (uv.x < 0.5 ? -1 : 1) }];
  });
  const leftCrownOutset = Math.max(0, ...crownOutsets.filter(({ side }) => side < 0).map(({ outset }) => outset));
  const rightCrownOutset = Math.max(0, ...crownOutsets.filter(({ side }) => side > 0).map(({ outset }) => outset));
  const canvasScale = Math.min(project.canvas.width, project.canvas.height);
  const bangGeometry = layer.mesh.points.map((point, index) => ({ index, geometry: frontHairSideGeometry(layer, point) }));
  const bangCandidates = bangGeometry.filter(({ geometry: strand }) => (
    strand.bangMask >= 0.6 && strand.bangProgress >= 0.3
  ));
  const releasedBangVertices = bangCandidates.filter(({ geometry: strand }) => strand.bangRelease >= 0.5);
  const maximumBangRelease = Math.max(0, ...bangCandidates.map(({ geometry: strand }) => strand.bangRelease));
  const maximumBangLagDelta = maxBindingDeltaForVertices(
    operations,
    ids.directLagBinding,
    bangCandidates.map(({ index }) => index)
  );
  const maximumBangLagPixels = maximumBangLagDelta * Math.min(project.canvas.width, project.canvas.height);
  const minimumVisibleBangDelta = Math.max(1.8 / Math.min(project.canvas.width, project.canvas.height), scale * 0.006);
  const rootIndices = layer.mesh.points.flatMap((point, index) => vertexRelease(layer, point).total <= 0.08 ? [index] : []);
  const rootLag = Math.max(0, ...rootIndices.map((index) => {
    const binding = operations.find((operation): operation is Extract<AuthoringOperation, { op: "upsert-binding" }> => operation.op === "upsert-binding" && operation.binding.id === ids.directLagBinding)?.binding;
    return Math.max(0, ...(binding?.keyforms.map((keyform) => {
      const delta = keyform.meshPointDeltas?.[String(index)];
      return delta ? Math.hypot(delta.x, delta.y) : 0;
    }) ?? []));
  }));
  return [
    {
      id: "topology",
      label: "网格没有孤立点，连通块与 Alpha 区域一致",
      passed: topology.orphanVertexIndices.length === 0 && topology.connectedComponents <= topology.expectedComponents,
      details: {
        pointCount: topology.pointCount,
        triangleCount: topology.triangleCount,
        connectedComponents: topology.connectedComponents,
        expectedComponents: topology.expectedComponents,
        orphanVertexIndices: topology.orphanVertexIndices
      }
    },
    {
      id: "silhouette-resolution",
      label: "头发外轮廓有足够控制点保持圆润体积，不被过长直边压瘪",
      passed: layer.mesh.art === undefined
        || meshAssessment.maximumBoundaryEdgePixels <= layer.mesh.art.detail * 2.2,
      details: {
        applicable: layer.mesh.art !== undefined,
        maximumBoundaryEdgePixels: rounded(meshAssessment.maximumBoundaryEdgePixels, 3),
        maximumAllowedPixels: rounded((layer.mesh.art?.detail ?? 0) * 2.2, 3),
        pointCount: layer.mesh.points.length
      }
    },
    {
      id: "crown-volume",
      label: "左右头顶到鬓角保留对称、可见的外凸弧度",
      passed: expectedCrownOutset <= 1e-9 || (
        leftCrownOutset >= expectedCrownOutset * 0.72
        && rightCrownOutset >= expectedCrownOutset * 0.72
        && leftCrownOutset <= expectedCrownOutset * 1.35
        && rightCrownOutset <= expectedCrownOutset * 1.35
      ),
      details: {
        requestedOutsetPixels: rounded(expectedCrownOutset * canvasScale, 3),
        leftOutsetPixels: rounded(leftCrownOutset * canvasScale, 3),
        rightOutsetPixels: rounded(rightCrownOutset * canvasScale, 3),
        inspectedVertices: crownOutsets.length
      }
    },
    {
      id: "neutral-preservation",
      label: "中立姿态保持原图，不引入静态漂移",
      passed: drift <= 1e-8,
      details: { maximumNormalizedDrift: rounded(drift, 10) }
    },
    {
      id: "pose-deformation",
      label: "九向关键形有可见但克制的变形范围",
      passed: poseDelta >= scale * 0.002 && poseDelta <= scale * (unifiedPose ? 0.18 : 0.035),
      details: { maximumNormalizedDelta: rounded(poseDelta, 8), relativeToLayer: rounded(poseDelta / Math.max(1e-9, scale), 6) }
    },
    {
      id: "root-continuity",
      label: "前发根部不会被滞后补偿拉离头部",
      passed: rootIndices.length > 0 && rootLag <= scale * 0.001,
      details: { inspectedRootVertices: rootIndices.length, maximumRootLagDelta: rounded(rootLag, 8), maximumLagDelta: rounded(lagDelta, 8) }
    },
    {
      id: "central-bang-motion",
      label: "中央刘海拥有独立根部、渐变权重和可见的发梢运动",
      passed: bangCandidates.length >= 2
        && releasedBangVertices.length >= 2
        && maximumBangRelease >= 0.65
        && maximumBangLagDelta >= minimumVisibleBangDelta
        && maximumBangLagDelta <= scale * 0.08,
      details: {
        candidateVertices: bangCandidates.length,
        releasedVertices: releasedBangVertices.length,
        maximumRelease: rounded(maximumBangRelease, 6),
        maximumLagDelta: rounded(maximumBangLagDelta, 8),
        maximumLagPixels: rounded(maximumBangLagPixels, 3),
        minimumVisibleLagDelta: rounded(minimumVisibleBangDelta, 8),
        relativeLagDelta: rounded(maximumBangLagDelta / Math.max(1e-9, scale), 6)
      }
    },
    {
      id: "side-perspective",
      label: "左右转头都保持近侧更大、远侧更小",
      passed: geometry.perspectivePassed,
      details: geometry.details
    },
    {
      id: "side-hang",
      label: "脸侧头发从各自发根自然下垂，不被拉向脸内",
      passed: geometry.hangingPassed,
      details: geometry.details
    },
    {
      id: "lag-rebound",
      label: "转头时产生短暂滞后，随后收敛并保留轻微回弹",
      passed: lag.peakError >= 0.08 && lag.settledTurnError <= 0.08 && lag.settledNeutralError <= 0.03 && lag.reboundObserved,
      details: lag
    },
    {
      id: "pose-safety",
      label: "13 个静态姿态和连续滞后采样都通过网格安全检查",
      passed: poses.every((pose) => pose.passed) && lag.dynamicPoseFailures === 0,
      details: {
        staticPassed: poses.filter((pose) => pose.passed).length,
        staticTotal: poses.length,
        dynamicPoseFailures: lag.dynamicPoseFailures,
        minimumPoseScore: rounded(Math.min(...poses.map((pose) => pose.score)), 4)
      }
    }
  ];
}

/** Builds the deterministic front-hair proposal without writing project files. */
export function createFrontHairAgentProposal(project: PuppetLoomProject, rawInstruction?: string, requestedLayerId?: string, explicitIntent?: FrontHairIntentProfile): PreparedFrontHairProposal {
  const { profile: requestedProfile, instruction: _instruction } = instructionProfile(rawInstruction, explicitIntent);
  const selectedLayer = selectFrontHairLayer(project, requestedLayerId);
  const neutralShape = crownOutsetOverride(selectedLayer, requestedProfile.crownOutset ?? 0);
  const workingProject = neutralShape
    ? applyCalibrationOverrides(project, { layers: { [selectedLayer.id]: neutralShape } })
    : project;
  const layer = selectFrontHairLayer(workingProject, selectedLayer.id);
  if (!workingProject.runtime.features.hairPhysics) throw new PuppetLoomError("INVALID_INPUT", "当前项目关闭了头发物理，无法建立完整的前发动态闭环。" );
  const topology = topologySummary(layer);
  const unifiedPose = Boolean(workingProject.runtime.poseField && workingProject.runtime.semanticCage);
  let lastProposal: PreparedFrontHairProposal | undefined;
  const protectedVertices = new Set<number>();
  const repairs: ModelAgentRepair[] = [];
  for (const safetyMultiplier of [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.25, 0.2, 0.15]) {
    if (safetyMultiplier < 1) repairs.push({
      pass: repairs.length + 1,
      action: `把关键形整体幅度收敛到原计划的 ${(safetyMultiplier * 100).toFixed(0)}%`,
      reason: "上一轮仍有极限姿态安全风险。",
      targetLayerIds: [layer.id]
    });
    for (let repairPass = 0; repairPass < 4; repairPass += 1) {
      const adjusted = rounded(requestedProfile.deformationScale * safetyMultiplier, 4);
      const explanation = [
        ...requestedProfile.explanation,
        ...(protectedVertices.size > 0 ? [`Agent 只保护 ${protectedVertices.size} 个极限姿态风险顶点，其余区域保留计划幅度。`] : []),
        ...(safetyMultiplier === 1 ? [] : [`局部保护后仍有安全余量不足，关键形整体收敛到原计划的 ${(safetyMultiplier * 100).toFixed(0)}%。`])
      ];
      const profile: FrontHairIntentProfile = { ...requestedProfile, deformationScale: adjusted, explanation };
      const operations = frontHairOperations(layer, profile, protectedVertices, unifiedPose);
      let authored: PuppetLoomProject;
      try {
        authored = applyAuthoringOperations(workingProject, operations);
      } catch (error) {
        throw new PuppetLoomError("INVALID_INPUT", "Agent 生成的前发参数、关键形或物理图无法形成有效模型。", { cause: error });
      }
      const frontHairTuning: MotionTuning = { amplitude: profile.amplitude, response: profile.response, stability: profile.stability };
      const ahogeTuning: MotionTuning = { amplitude: profile.ahogeAmplitude, response: profile.ahogeResponse, stability: profile.ahogeStability };
      const overrides: CalibrationOverrides = {
        model: authored.model,
        layers: {
          [layer.id]: {
            ...(neutralShape ?? {}),
            weights: { head: 1, body: 0, gaze: 0, physics: 1 },
            vertexInfluences: { physics: physicsInfluencePatch(layer), pin: Object.fromEntries(layer.mesh.points.map((_point, index) => [String(index), 0])) }
          }
        },
        runtime: { secondaryMotionTuning: { frontHair: frontHairTuning, ahoge: ahogeTuning } }
      };
      // `workingProject` already contains the neutral crown adjustment used
      // to author and validate these operations. Keep it in the persisted
      // patch, but do not apply the same point/anchor delta a second time to
      // the in-memory proposal.
      const effectiveLayerOverride = { ...overrides.layers![layer.id]! };
      delete effectiveLayerOverride.meshPointDeltas;
      delete effectiveLayerOverride.secondaryAnchors;
      const proposed = applyCalibrationOverrides(authored, {
        ...overrides,
        layers: { [layer.id]: effectiveLayerOverride }
      });
      const proposedLayer = proposed.layers.find((candidate) => candidate.id === layer.id)!;
      const checks = qualityChecks(proposed, proposedLayer, operations, topology, unifiedPose, profile);
      lastProposal = { layer: proposedLayer, intent: profile, topology, operations, previews: frontHairPreviews(), overrides, project: proposed, checks, repairs: clone(repairs) };
      if (checks.every((check) => check.passed)) return lastProposal;
      const unsafePose = checks.find((check) => check.id === "pose-safety" && !check.passed);
      if (!unsafePose) break;
      const unstable = unstableFrontHairVertices(proposed, proposedLayer);
      const before = protectedVertices.size;
      for (const index of unstable) protectedVertices.add(index);
      if (protectedVertices.size === before) break;
      repairs.push({
        pass: repairs.length + 1,
        action: `固定 ${protectedVertices.size - before} 个极限姿态风险顶点`,
        reason: "连续姿态检查发现三角形可能翻转或退化。",
        targetLayerIds: [layer.id],
        affectedVertexIndices: [...unstable].sort((left, right) => left - right)
      });
    }
  }
  return lastProposal!;
}

async function prepareFrontHairAgentProposal(root: string, project: PuppetLoomProject, instruction?: string, requestedLayerId?: string, explicitIntent?: FrontHairIntentProfile): Promise<PreparedFrontHairProposal> {
  const selected = selectFrontHairLayer(project, requestedLayerId);
  const meshes = await prepareAgentMeshes(root, project, [selected.id]);
  if (meshes.blockers.length > 0) throw new PuppetLoomError("INVALID_INPUT", `前发网格无法自动修复：${meshes.blockers.join("；")}`);
  const proposal = createFrontHairAgentProposal(meshes.project, instruction, selected.id, explicitIntent);
  const replacement = meshes.replacements[selected.id];
  if (replacement) {
    proposal.overrides.layers ??= {};
    proposal.overrides.layers[selected.id] = { ...proposal.overrides.layers[selected.id], mesh: replacement };
  }
  proposal.repairs = [...meshes.repairs, ...proposal.repairs].map((repair, index) => ({ ...repair, pass: index + 1 }));
  return proposal;
}

function draftBlockers(draft: CalibrationDraftDocument | undefined, targetLayerId: string): string[] {
  if (!draft) return [];
  const blockers: string[] = [];
  if (draft.overrides.model) blockers.push("草稿同时修改了 Authoring 模型");
  if (draft.overrides.anchors) blockers.push("草稿同时修改了项目锚点");
  if (draft.overrides.semanticPoints) blockers.push("草稿同时修改了语义控制点");
  if (draft.overrides.runtime) blockers.push("草稿同时修改了运行时参数");
  const otherLayers = Object.keys(draft.overrides.layers ?? {}).filter((id) => id !== targetLayerId);
  if (otherLayers.length > 0) blockers.push(`草稿还包含其他图层：${otherLayers.join("、")}`);
  return blockers;
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

/** Inspects the current revision and any compatible editor draft without writing. */
export async function planFrontHairAgent(projectDirectory: string, options: FrontHairAgentOptions = {}): Promise<FrontHairAgentPlan> {
  const root = resolve(projectDirectory);
  const [committed, calibration, draft] = await Promise.all([loadProject(root), loadCalibration(root), loadCalibrationDraft(root)]);
  const committedLayer = selectFrontHairLayer(committed, options.layerId);
  const blockers = draftBlockers(draft, committedLayer.id);
  const targetDraft = draft?.overrides.layers?.[committedLayer.id];
  const effective = targetDraft ? applyCalibrationOverrides(committed, { layers: { [committedLayer.id]: targetDraft } }) : committed;
  const proposal = await prepareFrontHairAgentProposal(root, effective, options.instruction, committedLayer.id, options.intent);
  const { instruction } = instructionProfile(options.instruction, options.intent);
  const checks = proposal.checks;
  const failedChecks = checks.filter((check) => !check.passed);
  blockers.push(...failedChecks.map((check) => `自检未通过：${check.label}`));
  const requiresChanges = Boolean(targetDraft) || JSON.stringify(proposal.project) !== JSON.stringify(committed);
  return {
    version: 1,
    task: "front-hair",
    project: committed.name,
    projectDirectory: root,
    baseRevision: calibration.revision,
    instruction,
    layer: {
      id: proposal.layer.id,
      sourceName: proposal.layer.sourceName,
      topology: proposal.layer.mesh.topology,
      pointCount: proposal.layer.mesh.points.length,
      triangleCount: Math.floor(proposal.layer.mesh.triangles.length / 3)
    },
    draft: {
      found: Boolean(draft),
      requiresAdoption: Boolean(targetDraft),
      ...(draft?.label ? { label: draft.label } : {}),
      ...(targetDraft?.mesh ? { pointCount: targetDraft.mesh.points.length } : {})
    },
    intent: proposal.intent,
    topology: proposal.topology,
    operations: proposal.operations.map((operation) => ({ op: operation.op, id: operationId(operation) })),
    checks,
    requiresChanges,
    canApply: blockers.length === 0,
    blockers
  };
}

function sessionSummary(kind: "draft-adoption" | "front-hair-authoring", result: CalibrationSaveResult): FrontHairAgentRunResult["sessions"][number] {
  return {
    kind,
    id: result.session.id,
    fromRevision: result.session.fromRevision,
    toRevision: result.session.toRevision,
    ...(result.session.evidenceDirectory ? { evidenceDirectory: result.session.evidenceDirectory } : {})
  };
}

/** Executes draft adoption, authored deformation, physics tuning and evidence as reversible calibration revisions. */
export async function runFrontHairAgent(projectDirectory: string, options: FrontHairAgentOptions = {}): Promise<FrontHairAgentRunResult> {
  const root = resolve(projectDirectory);
  const initialPlan = await planFrontHairAgent(root, options);
  if (!initialPlan.canApply) throw new PuppetLoomError("INVALID_INPUT", `前发 Agent 计划未通过：${initialPlan.blockers.join("；")}`);
  if (!initialPlan.requiresChanges) return {
    ok: true,
    changed: false,
    task: "front-hair",
    project: initialPlan.project,
    projectDirectory: root,
    instruction: initialPlan.instruction,
    layerId: initialPlan.layer.id,
    fromRevision: initialPlan.baseRevision,
    toRevision: initialPlan.baseRevision,
    sessions: [],
    checks: initialPlan.checks
  };
  const sessions: FrontHairAgentRunResult["sessions"] = [];
  let revision = initialPlan.baseRevision;
  let adoptedDraftRevision: number | undefined;
  const draft = await loadCalibrationDraft(root);
  const targetDraft = draft?.overrides.layers?.[initialPlan.layer.id];
  if (targetDraft) {
    const adoption = await saveCalibrationPatch(root, {
      baseRevision: revision,
      label: `Agent · 接管前发草稿 · ${draft?.label ?? initialPlan.layer.sourceName}`,
      overrides: { layers: { [initialPlan.layer.id]: clone(targetDraft) } }
    });
    sessions.push(sessionSummary("draft-adoption", adoption));
    revision = adoption.calibration.revision;
    adoptedDraftRevision = revision;
    await clearCalibrationDraft(root);
  }

  const [committed, calibration] = await Promise.all([loadProject(root), loadCalibration(root)]);
  if (calibration.revision !== revision) throw new PuppetLoomError("REVISION_CONFLICT", "前发草稿接管后项目修订发生变化，Agent 没有继续写入。" );
  const proposal = await prepareFrontHairAgentProposal(root, committed, initialPlan.instruction, initialPlan.layer.id, options.intent);
  const failedChecks = proposal.checks.filter((check) => !check.passed);
  if (failedChecks.length > 0) throw new PuppetLoomError("INVALID_INPUT", `前发自检未通过：${failedChecks.map((check) => check.label).join("；")}`);
  const label = "Agent · 前发自然转向、滞后与回弹";
  const committedProposal = await commitModelAgentProposal(root, revision, {
    part: "frontHair",
    instruction: initialPlan.instruction,
    label,
    targetLayerIds: [initialPlan.layer.id],
    operations: proposal.operations,
    previews: proposal.previews,
    overrides: proposal.overrides,
    checks: proposal.checks,
    repairs: proposal.repairs,
    reportDetails: {
      intent: proposal.intent,
      topology: proposal.topology,
      adoptedDraftRevision,
      priorSessions: sessions
    }
  });
  const result = committedProposal.result;
  sessions.push(sessionSummary("front-hair-authoring", result));
  await clearCalibrationDraft(root);
  return {
    ok: true,
    changed: true,
    task: "front-hair",
    project: result.project.name,
    projectDirectory: root,
    instruction: initialPlan.instruction,
    layerId: initialPlan.layer.id,
    fromRevision: initialPlan.baseRevision,
    toRevision: result.calibration.revision,
    ...(adoptedDraftRevision !== undefined ? { adoptedDraftRevision } : {}),
    sessions,
    checks: proposal.checks,
    reportPath: committedProposal.reportPath,
    comparisonSheet: result.evidence.comparisonSheet,
    differenceImage: result.evidence.differenceImage
  };
}
