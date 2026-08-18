import { createHash } from "node:crypto";
import { deformedPoints, neutralMotionState } from "./deform.js";
import type { ModelAgentCheck, ModelAgentPart } from "./agent.js";
import type { LayerBinding, MotionState, Point, PuppetLoomProject, SemanticRole } from "./types.js";

export interface ModelAgentConstraint {
  id: string;
  label: string;
  parts: ModelAgentPart[];
  description: string;
}

const headParts: ModelAgentPart[] = ["headFace", "eyes", "mouth", "frontHair", "backHair", "ahoge", "ears", "headwear"];
const waistParts: ModelAgentPart[] = ["body", "topCloth", "skirt"];
const tailParts: ModelAgentPart[] = ["body", "skirt", "tail"];

function intersects(requested: Set<ModelAgentPart>, parts: ModelAgentPart[]): boolean {
  return parts.some((part) => requested.has(part));
}

/** Declares the whole-character relationships the deterministic executor will verify after all requested parts run. */
export function modelAgentConstraints(requestedParts: ModelAgentPart[]): ModelAgentConstraint[] {
  const requested = new Set(requestedParts);
  const constraints: ModelAgentConstraint[] = [];
  if (intersects(requested, headParts)) constraints.push({
    id: "head-chain-coherence",
    label: "头脸、眼睛、头发与头饰共同跟随转头",
    parts: headParts,
    description: "检查主要头部图层在左右转头时共享同一头部运动，不互相脱离。"
  });
  if (!requested.has("frontHair") && intersects(requested, headParts)) constraints.push({
    id: "accepted-front-hair-preserved",
    label: "保留已接受的前发制作结果",
    parts: ["headFace", "eyes", "frontHair", "headwear"],
    description: "未要求重做前发时，前发网格、关键形、滞后和物理绑定必须保持不变。"
  });
  if (intersects(requested, waistParts)) constraints.push({
    id: "waist-connection",
    label: "上衣与裙腰保持连接",
    parts: waistParts,
    description: "检查身体摆动时腰线两侧不会产生明显相对滑动或断开。"
  });
  if (intersects(requested, tailParts)) constraints.push({
    id: "tail-root-connection",
    label: "尾根跟随身体",
    parts: tailParts,
    description: "检查尾巴自由端运动时，最靠近身体的根部不会漂移脱离。"
  });
  return constraints;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function centroid(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function layerCentroid(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): Point {
  return centroid(deformedPoints(project, layer, state));
}

function roles(project: PuppetLoomProject, accepted: SemanticRole[]): LayerBinding[] {
  const selected = new Set<SemanticRole>(accepted);
  return project.layers.filter((layer) => selected.has(layer.role));
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function frontHairFingerprint(project: PuppetLoomProject): string {
  const layerIds = new Set(project.layers.filter((layer) => layer.role === "frontHair").map((layer) => layer.id));
  return hash({
    layers: project.layers.filter((layer) => layerIds.has(layer.id)).map((layer) => ({
      id: layer.id,
      mesh: layer.mesh,
      pivot: layer.pivot,
      secondaryAnchors: layer.secondaryAnchors,
      weights: layer.weights
    })),
    parameters: project.model.parameters.filter((parameter) => parameter.id.includes("front-hair")),
    bindings: project.model.bindings.filter((binding) => binding.id.includes("front-hair") || layerIds.has(binding.target.id)),
    physics: project.model.physics.filter((physics) => physics.id.includes("front-hair") || physics.inputParameterId.includes("front-hair") || physics.outputParameterId.includes("front-hair"))
  });
}

function headChainCheck(project: PuppetLoomProject): ModelAgentCheck {
  const face = project.layers.find((layer) => layer.role === "face");
  const coupled = roles(project, ["frontHair", "backHair", "sideHair", "headwear", "ear"]);
  if (!face || coupled.length === 0) return {
    id: "head-chain-coherence",
    label: "头部跨部位共同跟随",
    passed: true,
    details: { skipped: true, reason: "项目没有可比较的脸部与头部附属图层。" }
  };
  const neutral = { ...neutralMotionState };
  const samples: MotionState[] = [
    { ...neutralMotionState, headYaw: -0.82, headPitch: -0.35 },
    { ...neutralMotionState, headYaw: 0.82, headPitch: 0.35 }
  ];
  const faceNeutral = layerCentroid(project, face, neutral);
  let faceMotion = 0;
  let maximumRelativeDrift = 0;
  for (const sample of samples) {
    const faceMoved = layerCentroid(project, face, sample);
    const faceDelta = { x: faceMoved.x - faceNeutral.x, y: faceMoved.y - faceNeutral.y };
    faceMotion = Math.max(faceMotion, Math.hypot(faceDelta.x, faceDelta.y));
    for (const layer of coupled) {
      const before = layerCentroid(project, layer, neutral);
      const after = layerCentroid(project, layer, sample);
      const layerDelta = { x: after.x - before.x, y: after.y - before.y };
      maximumRelativeDrift = Math.max(maximumRelativeDrift, Math.hypot(layerDelta.x - faceDelta.x, layerDelta.y - faceDelta.y));
    }
  }
  return {
    id: "head-chain-coherence",
    label: "头部跨部位共同跟随",
    passed: faceMotion >= 0.002 && maximumRelativeDrift <= 0.075,
    details: { faceMotion: rounded(faceMotion), maximumRelativeDrift: rounded(maximumRelativeDrift), allowedRelativeDrift: 0.075, comparedLayers: coupled.length }
  };
}

function edgeAnchor(project: PuppetLoomProject, layer: LayerBinding, state: MotionState, edge: "top" | "bottom"): Point {
  const points = deformedPoints(project, layer, state);
  const ordered = [...points].sort((left, right) => edge === "top" ? left.y - right.y : right.y - left.y);
  return centroid(ordered.slice(0, Math.max(3, Math.ceil(ordered.length * 0.16))));
}

function waistCheck(project: PuppetLoomProject): ModelAgentCheck {
  const top = project.layers.find((layer) => layer.role === "topWear");
  const skirt = project.layers.find((layer) => layer.role === "bottomWear");
  if (!top || !skirt) return { id: "waist-connection", label: "上下装腰线连接", passed: true, details: { skipped: true, reason: "项目没有同时识别到上衣和裙装。" } };
  const neutral = { ...neutralMotionState };
  const baseTop = edgeAnchor(project, top, neutral, "bottom");
  const baseSkirt = edgeAnchor(project, skirt, neutral, "top");
  let maximumRelativeSlide = 0;
  for (const bodySway of [-0.55, 0.55]) {
    const sample = { ...neutralMotionState, bodySway, bodyRoll: bodySway * 0.5, clothX: -bodySway * 0.025 };
    const movedTop = edgeAnchor(project, top, sample, "bottom");
    const movedSkirt = edgeAnchor(project, skirt, sample, "top");
    const relativeX = (movedSkirt.x - movedTop.x) - (baseSkirt.x - baseTop.x);
    const relativeY = (movedSkirt.y - movedTop.y) - (baseSkirt.y - baseTop.y);
    maximumRelativeSlide = Math.max(maximumRelativeSlide, Math.hypot(relativeX, relativeY));
  }
  return { id: "waist-connection", label: "上下装腰线连接", passed: maximumRelativeSlide <= 0.035, details: { maximumRelativeSlide: rounded(maximumRelativeSlide), allowedRelativeSlide: 0.035 } };
}

function tailRootCheck(project: PuppetLoomProject): ModelAgentCheck {
  const tail = project.layers.find((layer) => layer.role === "tail");
  const skirt = project.layers.find((layer) => layer.role === "bottomWear");
  if (!tail || !skirt) return { id: "tail-root-connection", label: "尾根连接", passed: true, details: { skipped: true, reason: "项目没有同时识别到尾巴和身体下装。" } };
  const rootReference = project.anchors.bodyCenter ?? skirt.pivot;
  const rootIndex = tail.mesh.points.reduce((best, point, index) => {
    const distance = Math.hypot(point.x - rootReference.x, point.y - rootReference.y);
    return distance < best.distance ? { index, distance } : best;
  }, { index: 0, distance: Number.POSITIVE_INFINITY }).index;
  const neutral = { ...neutralMotionState };
  const tailNeutral = deformedPoints(project, tail, neutral)[rootIndex]!;
  const skirtNeutral = layerCentroid(project, skirt, neutral);
  let maximumRelativeDrift = 0;
  for (const direction of [-1, 1]) {
    const sample = { ...neutralMotionState, bodySway: direction * 0.5, clothX: direction * 0.018, tailX: -direction * 0.07, tailY: direction * 0.035 };
    const tailMoved = deformedPoints(project, tail, sample)[rootIndex]!;
    const skirtMoved = layerCentroid(project, skirt, sample);
    maximumRelativeDrift = Math.max(maximumRelativeDrift, Math.hypot(
      (tailMoved.x - tailNeutral.x) - (skirtMoved.x - skirtNeutral.x),
      (tailMoved.y - tailNeutral.y) - (skirtMoved.y - skirtNeutral.y)
    ));
  }
  return { id: "tail-root-connection", label: "尾根连接", passed: maximumRelativeDrift <= 0.045, details: { maximumRelativeDrift: rounded(maximumRelativeDrift), allowedRelativeDrift: 0.045, rootVertexIndex: rootIndex } };
}

/** Evaluates final, cross-part invariants after all requested revisions have been applied. */
export function evaluateModelAgentCoherence(before: PuppetLoomProject, after: PuppetLoomProject, requestedParts: ModelAgentPart[]): ModelAgentCheck[] {
  return modelAgentConstraints(requestedParts).map((constraint) => {
    if (constraint.id === "accepted-front-hair-preserved") {
      const beforeFingerprint = frontHairFingerprint(before);
      const afterFingerprint = frontHairFingerprint(after);
      return {
        id: constraint.id,
        label: constraint.label,
        passed: beforeFingerprint === afterFingerprint,
        details: { beforeFingerprint, afterFingerprint }
      };
    }
    if (constraint.id === "head-chain-coherence") return headChainCheck(after);
    if (constraint.id === "waist-connection") return waistCheck(after);
    return tailRootCheck(after);
  });
}
