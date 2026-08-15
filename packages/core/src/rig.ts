import { rectCenter, rectUnion, roundPoint, roundRect } from "./math.js";
import { suggestedRigLevel, type ImportedLayer, type ImportedPsd } from "./psd.js";
import type {
  AnchorGraph,
  LayerBinding,
  LayerWeights,
  MeshBinding,
  MotionEnvelope,
  CoherentPoseField,
  Point,
  PuppetLoomProject,
  Rect,
  RigLevel,
  RuntimeFeatures,
  SemanticRole
} from "./types.js";

const headRoles = new Set<SemanticRole>([
  "backHair",
  "frontHair",
  "sideHair",
  "face",
  "eyeWhite",
  "iris",
  "eyelash",
  "eyeClosed",
  "eyebrow",
  "nose",
  "mouth",
  "ear",
  "headwear"
]);

const fineRoles = new Set<SemanticRole>(["eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth", "ear"]);
const hairRoles = new Set<SemanticRole>(["backHair", "frontHair", "sideHair"]);
const eyeSocketRoles = new Set<SemanticRole>(["eyeWhite", "iris", "eyelash", "eyeClosed"]);

function normalizedRect(rect: Rect, width: number, height: number): Rect {
  return roundRect({ x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height });
}

function meshDensity(layer: ImportedLayer): { rows: number; cols: number } {
  if (fineRoles.has(layer.role)) return { rows: 4, cols: 4 };
  const cols = Math.max(4, Math.min(14, Math.ceil(layer.bounds.width / 72) + 2));
  const rows = Math.max(4, Math.min(14, Math.ceil(layer.bounds.height / 72) + 2));
  if (layer.role === "frontHair") return { rows: Math.max(rows, 12), cols: Math.max(cols, 10) };
  if (layer.role === "backHair" || layer.role === "sideHair") return { rows: Math.max(rows, 10), cols: Math.max(cols, 10) };
  if (layer.role === "headwear") return { rows: Math.max(rows, 8), cols: Math.max(cols, 10) };
  if (layer.role === "tail" || layer.role === "bottomWear") return { rows: Math.max(rows, 10), cols: Math.max(cols, 10) };
  if (layer.role === "face") return { rows: Math.max(rows, 8), cols: Math.max(cols, 8) };
  return { rows, cols };
}

export function makeGridMesh(bounds: Rect, rows: number, cols: number): MeshBinding {
  const points: Point[] = [];
  const uvs: Point[] = [];
  const triangles: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    const v = rows <= 1 ? 0 : row / (rows - 1);
    for (let col = 0; col < cols; col += 1) {
      const u = cols <= 1 ? 0 : col / (cols - 1);
      points.push(roundPoint({ x: bounds.x + bounds.width * u, y: bounds.y + bounds.height * v }));
      uvs.push({ x: u, y: v });
    }
  }
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const topLeft = row * cols + col;
      const topRight = topLeft + 1;
      const bottomLeft = (row + 1) * cols + col;
      const bottomRight = bottomLeft + 1;
      triangles.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }
  return { rows, cols, points, uvs, triangles };
}

function pivotFor(role: SemanticRole, bounds: Rect, side: LayerBinding["side"], anchors: AnchorGraph): Point {
  if (eyeSocketRoles.has(role) && side !== "center") {
    const eye = side === "left" ? anchors.eyeLeft : anchors.eyeRight;
    if (eye) return roundPoint(eye);
  }
  if (role === "frontHair") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.38 });
  if (role === "backHair" || role === "sideHair") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.15 });
  if (role === "tail") return roundPoint({ x: bounds.x + bounds.width * 0.03, y: bounds.y + bounds.height * 0.08 });
  if (role === "topWear") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.18 });
  if (role === "bottomWear") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.12 });
  if (role === "arm" || role === "hand") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.08 });
  if (role === "leg" || role === "foot") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.05 });
  return roundPoint(rectCenter(bounds));
}

function weightsFor(role: SemanticRole, level: RigLevel, insideHead: boolean): LayerWeights {
  if (level === "minimal") return { head: 0, body: 0, gaze: 0, physics: 0 };
  if (role === "iris") return { head: 1, body: 0, gaze: level === "semantic" ? 1 : 0, physics: 0 };
  if (hairRoles.has(role)) return { head: 1, body: 0, gaze: 0, physics: level === "semantic" ? (role === "backHair" ? 0.8 : 1) : 0.35 };
  if (role === "headwear" || role === "ear") return { head: 1, body: 0, gaze: 0, physics: level === "semantic" ? 0.55 : 0.2 };
  if (headRoles.has(role) || (role === "unknown" && insideHead)) return { head: 1, body: 0, gaze: 0, physics: 0 };
  if (role === "neck") return { head: level === "semantic" ? 1 : 0.78, body: 1, gaze: 0, physics: 0 };
  if (role === "tail") return { head: 0, body: 1, gaze: 0, physics: level === "semantic" ? 0.75 : 0.3 };
  if (role === "bottomWear") return { head: 0, body: 1, gaze: 0, physics: level === "semantic" ? 0.3 : 0.12 };
  if (role === "topWear") return { head: 0, body: 1, gaze: 0, physics: level === "semantic" ? 0.1 : 0.04 };
  if (role === "accessory") return { head: insideHead ? 0.75 : 0, body: insideHead ? 0.25 : 1, gaze: 0, physics: level === "semantic" ? 0.65 : 0.25 };
  return { head: 0, body: 1, gaze: 0, physics: 0 };
}

function findLayer(layers: ImportedLayer[], role: SemanticRole, side?: "left" | "right"): ImportedLayer | undefined {
  return layers.find((layer) => layer.role === role && (!side || layer.side === side));
}

function centerOfLayer(layer: ImportedLayer | undefined, canvas: { width: number; height: number }): Point | undefined {
  if (!layer) return undefined;
  const bounds = normalizedRect(layer.bounds, canvas.width, canvas.height);
  return roundPoint(rectCenter(bounds));
}

function deriveAnchors(imported: ImportedPsd): AnchorGraph {
  const { layers, canvas } = imported;
  const faceLayer = findLayer(layers, "face");
  const headLayers = layers.filter((layer) => headRoles.has(layer.role));
  const headRectPx = rectUnion(headLayers.map((layer) => layer.bounds));
  const face = faceLayer ? normalizedRect(faceLayer.bounds, canvas.width, canvas.height) : headRectPx ? normalizedRect(headRectPx, canvas.width, canvas.height) : undefined;
  const topWear = findLayer(layers, "topWear");
  const torso = topWear ? normalizedRect(topWear.bounds, canvas.width, canvas.height) : undefined;
  const neck = centerOfLayer(findLayer(layers, "neck"), canvas);
  if (!face) {
    const body = rectUnion(layers.map((layer) => normalizedRect(layer.bounds, canvas.width, canvas.height)));
    return body ? { bodyCenter: roundPoint(rectCenter(body)) } : {};
  }

  const faceCenter = rectCenter(face);
  const eyeLeft = centerOfLayer(findLayer(layers, "eyeWhite", "left") ?? findLayer(layers, "eyelash", "left"), canvas);
  const eyeRight = centerOfLayer(findLayer(layers, "eyeWhite", "right") ?? findLayer(layers, "eyelash", "right"), canvas);
  const headTopY = headRectPx ? headRectPx.y / canvas.height : face.y;
  const anchors: AnchorGraph = {
    headTop: roundPoint({ x: faceCenter.x, y: headTopY }),
    forehead: roundPoint({ x: faceCenter.x, y: face.y + face.height * 0.18 }),
    cheekLeft: roundPoint({ x: face.x + face.width * 0.82, y: face.y + face.height * 0.62 }),
    cheekRight: roundPoint({ x: face.x + face.width * 0.18, y: face.y + face.height * 0.62 }),
    nose: centerOfLayer(findLayer(layers, "nose"), canvas) ?? roundPoint({ x: faceCenter.x, y: face.y + face.height * 0.58 }),
    mouth: centerOfLayer(findLayer(layers, "mouth"), canvas) ?? roundPoint({ x: faceCenter.x, y: face.y + face.height * 0.74 }),
    chin: roundPoint({ x: faceCenter.x, y: face.y + face.height * 0.96 }),
    bodyCenter: torso ? roundPoint(rectCenter(torso)) : roundPoint({ x: faceCenter.x, y: face.y + face.height * 1.35 })
  };
  if (eyeLeft) anchors.eyeLeft = eyeLeft;
  if (eyeRight) anchors.eyeRight = eyeRight;
  if (neck) anchors.neck = neck;
  if (torso) {
    anchors.shoulderLeft = roundPoint({ x: torso.x + torso.width * 0.78, y: torso.y + torso.height * 0.14 });
    anchors.shoulderRight = roundPoint({ x: torso.x + torso.width * 0.22, y: torso.y + torso.height * 0.14 });
  }
  return anchors;
}

function envelopeFor(level: RigLevel): MotionEnvelope {
  if (level === "semantic") {
    return { headYaw: 0.84, headPitch: 0.64, headRollDegrees: 3.2, bodySway: 0.012, bodyRollDegrees: 2.2, gazeX: 0.16, gazeY: 0.1, breath: 0.004, globalScale: 1 };
  }
  if (level === "grouped") {
    return { headYaw: 0.36, headPitch: 0.25, headRollDegrees: 2, bodySway: 0.007, bodyRollDegrees: 0.9, gazeX: 0, gazeY: 0, breath: 0.003, globalScale: 1 };
  }
  return { headYaw: 0, headPitch: 0, headRollDegrees: 0.8, bodySway: 0.0045, bodyRollDegrees: 0.6, gazeX: 0, gazeY: 0, breath: 0.0025, globalScale: 1 };
}

function poseFieldFor(anchors: AnchorGraph, level: RigLevel): CoherentPoseField | undefined {
  if (level === "minimal" || !anchors.forehead || !anchors.chin || !anchors.cheekLeft || !anchors.cheekRight) return undefined;
  const faceWidth = Math.max(0.07, Math.abs(anchors.cheekLeft.x - anchors.cheekRight.x) / 0.64);
  const faceHeight = Math.max(0.09, Math.abs(anchors.chin.y - anchors.forehead.y) / 0.78);
  return {
    kind: "head-surfaces-v2",
    center: roundPoint({
      x: anchors.nose?.x ?? (anchors.cheekLeft.x + anchors.cheekRight.x) * 0.5,
      y: (anchors.forehead.y + anchors.chin.y) * 0.5
    }),
    radiusX: Number((faceWidth * 0.5).toFixed(6)),
    radiusY: Number((faceHeight * 0.5).toFixed(6)),
    skullCenter: roundPoint({
      x: anchors.nose?.x ?? (anchors.cheekLeft.x + anchors.cheekRight.x) * 0.5,
      y: ((anchors.headTop?.y ?? anchors.forehead.y) + anchors.chin.y) * 0.5
    }),
    skullRadiusX: Number((Math.max(faceWidth * 1.25, faceHeight * 0.72)).toFixed(6)),
    skullRadiusY: Number((Math.max(faceHeight * 0.72, (anchors.chin.y - (anchors.headTop?.y ?? anchors.forehead.y)) * 0.5)).toFixed(6)),
    maxYawRadians: level === "semantic" ? 0.3 : 0.14,
    maxPitchRadians: level === "semantic" ? 0.2 : 0.1,
    perspective: level === "semantic" ? 0.1 : 0.05
  };
}

function featuresFor(imported: ImportedPsd, level: RigLevel): RuntimeFeatures {
  const layers = imported.layers;
  const paired = (role: SemanticRole) => layers.some((layer) => layer.role === role && layer.side === "left") && layers.some((layer) => layer.role === role && layer.side === "right");
  return {
    headTurn: level !== "minimal",
    bodyFollow: layers.some((layer) => layer.role === "topWear" || layer.role === "neck"),
    gaze: level === "semantic" && paired("eyeWhite") && paired("iris"),
    hairPhysics: level !== "minimal" && layers.some((layer) => hairRoles.has(layer.role) || layer.role === "headwear" || layer.role === "ear" || layer.role === "tail" || layer.role === "topWear" || layer.role === "bottomWear" || layer.role === "accessory"),
    blink: paired("eyeClosed"),
    mouthMotion: false
  };
}

function disabledReasons(features: RuntimeFeatures, imported: ImportedPsd, level: RigLevel): string[] {
  const reasons: string[] = [];
  if (level !== "semantic") reasons.push("脸部语义不完整，已采用保守绑定。" );
  if (!features.gaze) reasons.push("缺少成对眼白或虹膜，已关闭视线移动。" );
  if (!features.hairPhysics) reasons.push("没有可用的头发、耳朵、衣摆、尾巴或饰品图层，已关闭次级运动。" );
  if (!features.blink) reasons.push("缺少闭眼图层，当前结果不启用眨眼。" );
  if (!features.mouthMotion) reasons.push("缺少闭合、微张和张开三态嘴形，当前结果不启用嘴部开合。" );
  if (!features.bodyFollow) reasons.push("没有识别到脖子或上身，已关闭身体跟随。" );
  if (imported.layers.some((layer) => layer.role === "unknown")) reasons.push("未识别图层保持原样，不参与专用变形。" );
  return reasons;
}

function clipLayerFor(layer: ImportedLayer, all: ImportedLayer[]): string | undefined {
  if (layer.role !== "iris" || layer.side === "center") return undefined;
  return all.find((candidate) => candidate.role === "eyeWhite" && candidate.side === layer.side)?.id;
}

export interface BuildRigInput {
  imported: ImportedPsd;
  name: string;
  seed: number;
  source: PuppetLoomProject["source"];
}

export function buildRig(input: BuildRigInput): PuppetLoomProject {
  const { imported } = input;
  const level = suggestedRigLevel(imported.layers);
  const anchors = deriveAnchors(imported);
  const headBoundsPx = rectUnion(imported.layers.filter((layer) => headRoles.has(layer.role)).map((layer) => layer.bounds));
  const headBounds = headBoundsPx ? normalizedRect(headBoundsPx, imported.canvas.width, imported.canvas.height) : undefined;
  const layers: LayerBinding[] = imported.layers.map((layer) => {
    const bounds = normalizedRect(layer.bounds, imported.canvas.width, imported.canvas.height);
    const center = rectCenter(bounds);
    const insideHead = headBounds ? center.x >= headBounds.x && center.x <= headBounds.x + headBounds.width && center.y >= headBounds.y && center.y <= headBounds.y + headBounds.height : false;
    const density = meshDensity(layer);
    const weights = weightsFor(layer.role, level, insideHead);
    const parentGroup: LayerBinding["parentGroup"] = weights.head >= 0.5 ? "head" : weights.body > 0 ? "body" : "root";
    const clipLayerId = clipLayerFor(layer, imported.layers);
    return {
      id: layer.id,
      sourceName: layer.sourceName,
      sourcePath: layer.sourcePath,
      role: layer.role,
      side: layer.side,
      order: layer.order,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      bounds,
      texture: `textures/${layer.id}.png`,
      pivot: pivotFor(layer.role, bounds, layer.side, anchors),
      mesh: makeGridMesh(bounds, density.rows, density.cols),
      weights,
      ...(clipLayerId ? { clipLayerId } : {}),
      ...(layer.role === "mouth" ? { mouthVariant: "closed" as const } : {}),
      parentGroup
    };
  });
  const features = featuresFor(imported, level);
  const poseField = poseFieldFor(anchors, level);
  return {
    version: 1,
    name: input.name,
    canvas: imported.canvas,
    source: input.source,
    rigLevel: level,
    layers,
    anchors,
    runtime: {
      seed: input.seed,
      profile: poseField ? "coherent-v2" : "calm-v1",
      envelope: envelopeFor(level),
      features,
      ...(poseField ? { poseField, motionTuning: { amplitude: 1, response: 0.72, stability: 0.42 } } : {})
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] },
    disabledReasons: disabledReasons(features, imported, level)
  };
}

export function isHeadRole(role: SemanticRole): boolean {
  return headRoles.has(role);
}

export function isHairRole(role: SemanticRole): boolean {
  return hairRoles.has(role);
}
