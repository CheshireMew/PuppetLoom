import { rectCenter, rectUnion, roundPoint, roundRect } from "./math.js";
import { suggestedRigLevel, type ImportedLayer, type ImportedPsd } from "./psd.js";
import { buildSemanticControlCage } from "./semantic-cage.js";
import { makeAdaptiveMesh } from "./art-mesh.js";
import { makeGridMesh } from "./mesh.js";
import { PUPPETLOOM_PROJECT_VERSION } from "./types.js";
import { createDefaultAuthoringModel } from "./model.js";
import { frontHairPhysicsMask } from "./front-hair-geometry.js";
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
  SemanticRole,
  LayerSecondaryAnchors
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

export { makeGridMesh } from "./mesh.js";

function normalizedRect(rect: Rect, width: number, height: number): Rect {
  return roundRect({ x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height });
}

function meshDensity(layer: ImportedLayer): { rows: number; cols: number } {
  if (fineRoles.has(layer.role)) return { rows: 4, cols: 4 };
  const cols = Math.max(4, Math.min(14, Math.ceil(layer.bounds.width / 72) + 2));
  const rows = Math.max(4, Math.min(14, Math.ceil(layer.bounds.height / 72) + 2));
  if (layer.role === "frontHair") return { rows: Math.max(rows, 18), cols: Math.max(cols, 12) };
  if (layer.role === "backHair" || layer.role === "sideHair") return { rows: Math.max(rows, 10), cols: Math.max(cols, 10) };
  if (layer.role === "headwear") return { rows: Math.max(rows, 8), cols: Math.max(cols, 10) };
  if (layer.role === "tail" || layer.role === "bottomWear") return { rows: Math.max(rows, 10), cols: Math.max(cols, 10) };
  if (layer.role === "face") return { rows: Math.max(rows, 8), cols: Math.max(cols, 8) };
  return { rows, cols };
}

export function artMeshDetailForRole(role: SemanticRole): number {
  if (fineRoles.has(role)) return 8;
  // Long hair contours need fewer, better-shaped triangles than tiny facial
  // features. A denser outline creates narrow boundary slivers that can fold
  // under full head yaw even when the visible deformation remains smooth.
  if (role === "frontHair" || role === "backHair" || role === "sideHair") return 12;
  if (role === "face") return 12;
  if (role === "ear" || role === "headwear") return 12;
  if (role === "tail" || role === "bottomWear") return 14;
  if (role === "topWear" || role === "arm" || role === "leg") return 18;
  return 20;
}

function meshDetail(layer: ImportedLayer): number {
  return artMeshDetailForRole(layer.role);
}

function pivotFor(role: SemanticRole, bounds: Rect, side: LayerBinding["side"], anchors: AnchorGraph, secondaryAnchors?: LayerSecondaryAnchors): Point {
  if (eyeSocketRoles.has(role) && side !== "center") {
    const eye = side === "left" ? anchors.eyeLeft : anchors.eyeRight;
    if (eye) return roundPoint(eye);
  }
  if (role === "frontHair") return secondaryAnchors?.frontHairRoot ?? roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.52 });
  if (role === "backHair" || role === "sideHair") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.15 });
  if (role === "ear") {
    const x = side === "left" ? bounds.x : side === "right" ? bounds.x + bounds.width : bounds.x + bounds.width * 0.5;
    return roundPoint({ x, y: bounds.y + bounds.height * 0.42 });
  }
  if (role === "tail") return roundPoint({ x: bounds.x + bounds.width * 0.03, y: bounds.y + bounds.height * 0.08 });
  if (role === "topWear") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.18 });
  if (role === "bottomWear") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.12 });
  if (role === "arm" || role === "hand") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.08 });
  if (role === "leg" || role === "foot") return roundPoint({ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.05 });
  return roundPoint(rectCenter(bounds));
}

function countOpaqueWingPixels(layer: ImportedLayer, hingeX: number, hingeY: number, direction: -1 | 1, faceWidth: number, faceHeight: number): number {
  let count = 0;
  const { width, height, data } = layer.pixels;
  for (let y = 0; y < height; y += 1) {
    const globalY = layer.bounds.y + y;
    if (globalY < hingeY - faceHeight * 0.12) continue;
    for (let x = 0; x < width; x += 1) {
      const globalX = layer.bounds.x + x;
      if ((globalX - hingeX) * direction < faceWidth * 0.04) continue;
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 8) count += 1;
    }
  }
  return count;
}

function nearestOpaquePoint(
  layer: ImportedLayer,
  target: Point,
  side: -1 | 1,
  preferTip = false
): Point | undefined {
  const centerX = layer.bounds.x + layer.bounds.width * 0.5;
  let best: Point | undefined;
  let bestScore = preferTip ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (let y = 0; y < layer.pixels.height; y += 1) {
    for (let x = 0; x < layer.pixels.width; x += 1) {
      if ((layer.pixels.data[(y * layer.pixels.width + x) * 4 + 3] ?? 0) <= 8) continue;
      const global = { x: layer.bounds.x + x, y: layer.bounds.y + y };
      if ((global.x - centerX) * side < layer.bounds.width * 0.12) continue;
      if (preferTip) {
        if (global.y < target.y) continue;
        const score = (global.y - target.y) / Math.max(1, layer.bounds.height)
          - Math.abs(global.x - target.x) / Math.max(1, layer.bounds.width) * 0.12;
        if (score > bestScore) {
          best = global;
          bestScore = score;
        }
      } else {
        const dx = (global.x - target.x) / Math.max(1, layer.bounds.width);
        const dy = (global.y - target.y) / Math.max(1, layer.bounds.height);
        const score = dx * dx + dy * dy;
        if (score < bestScore) {
          best = global;
          bestScore = score;
        }
      }
    }
  }
  return best;
}

function frontHairAnchorsFor(layer: ImportedLayer, faceLayer: ImportedLayer | undefined, canvas: ImportedPsd["canvas"]): LayerSecondaryAnchors {
  const { width, height, data } = layer.pixels;
  const rows = Array.from({ length: height }, (_, y) => {
    let opaque = 0;
    let minimumX = width;
    let maximumX = -1;
    let runs = 0;
    let previousOpaque = false;
    for (let x = 0; x < width; x += 1) {
      const currentOpaque = (data[(y * width + x) * 4 + 3] ?? 0) > 8;
      if (currentOpaque) {
        opaque += 1;
        minimumX = Math.min(minimumX, x);
        maximumX = Math.max(maximumX, x);
        if (!previousOpaque) runs += 1;
      }
      previousOpaque = currentOpaque;
    }
    const span = maximumX >= minimumX ? maximumX - minimumX + 1 : 0;
    return {
      y,
      runs,
      spanRatio: span / Math.max(1, width),
      fillRatio: span > 0 ? opaque / span : 0
    };
  });
  const crown = rows.find((row) => row.spanRatio >= 0.35 && row.fillRatio >= 0.8);
  const crownY = crown?.y ?? Math.round(height * 0.24);
  const bangSearchY = crownY + Math.round(height * 0.18);
  const bang = rows.find((row) => row.y >= bangSearchY && row.spanRatio >= 0.65 && (row.runs >= 3 || row.fillRatio <= 0.96));
  const bangY = Math.max(crownY + Math.round(height * 0.18), Math.min(Math.round(height * 0.72), bang?.y ?? Math.round(height * 0.54)));
  const centerX = (layer.bounds.x + layer.bounds.width * 0.5) / canvas.width;
  const rootY = faceLayer
    ? faceLayer.bounds.y + faceLayer.bounds.height * 0.36
    : layer.bounds.y + layer.bounds.height * 0.52;
  const leftTarget = {
    x: faceLayer ? faceLayer.bounds.x + faceLayer.bounds.width * 0.04 : layer.bounds.x + layer.bounds.width * 0.18,
    y: rootY
  };
  const rightTarget = {
    x: faceLayer ? faceLayer.bounds.x + faceLayer.bounds.width * 0.96 : layer.bounds.x + layer.bounds.width * 0.82,
    y: rootY
  };
  const leftRootPx = nearestOpaquePoint(layer, leftTarget, -1) ?? leftTarget;
  const rightRootPx = nearestOpaquePoint(layer, rightTarget, 1) ?? rightTarget;
  const leftTipPx = nearestOpaquePoint(layer, leftRootPx, -1, true) ?? { x: leftRootPx.x, y: layer.bounds.y + layer.bounds.height };
  const rightTipPx = nearestOpaquePoint(layer, rightRootPx, 1, true) ?? { x: rightRootPx.x, y: layer.bounds.y + layer.bounds.height };
  const normalized = (point: Point): Point => roundPoint({ x: point.x / canvas.width, y: point.y / canvas.height });
  return {
    ahogeRoot: roundPoint({ x: centerX, y: (layer.bounds.y + crownY) / canvas.height }),
    frontHairRoot: roundPoint({ x: centerX, y: (layer.bounds.y + bangY) / canvas.height }),
    frontHairRootLeft: normalized(leftRootPx),
    frontHairRootRight: normalized(rightRootPx),
    frontHairTipLeft: normalized(leftTipPx),
    frontHairTipRight: normalized(rightTipPx)
  };
}

function secondaryAnchorsFor(layer: ImportedLayer, faceLayer: ImportedLayer | undefined, canvas: ImportedPsd["canvas"]): LayerSecondaryAnchors | undefined {
  if (layer.role === "frontHair") return frontHairAnchorsFor(layer, faceLayer, canvas);
  if (layer.role !== "headwear" || !faceLayer) return undefined;
  const hingeLeftX = faceLayer.bounds.x + faceLayer.bounds.width * 0.03;
  const hingeRightX = faceLayer.bounds.x + faceLayer.bounds.width * 0.97;
  const hingeY = faceLayer.bounds.y + faceLayer.bounds.height * 0.5;
  const leftPixels = countOpaqueWingPixels(layer, hingeLeftX, hingeY, -1, faceLayer.bounds.width, faceLayer.bounds.height);
  const rightPixels = countOpaqueWingPixels(layer, hingeRightX, hingeY, 1, faceLayer.bounds.width, faceLayer.bounds.height);
  const threshold = Math.max(24, Math.round(layer.opaquePixels * 0.006));
  if (leftPixels < threshold || rightPixels < threshold) return undefined;
  return {
    earHingeLeft: roundPoint({ x: hingeLeftX / canvas.width, y: hingeY / canvas.height }),
    earHingeRight: roundPoint({ x: hingeRightX / canvas.width, y: hingeY / canvas.height })
  };
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
    maxPitchRadians: level === "semantic" ? 0.32 : 0.14,
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
  const faceLayer = findLayer(imported.layers, "face");
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
    const secondaryAnchors = secondaryAnchorsFor(layer, faceLayer, imported.canvas);
    const binding: LayerBinding = {
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
      pivot: pivotFor(layer.role, bounds, layer.side, anchors, secondaryAnchors),
      ...(secondaryAnchors ? { secondaryAnchors } : {}),
      mesh: makeAdaptiveMesh({
        bounds,
        pixels: layer.pixels,
        detail: meshDetail(layer),
        fallbackRows: density.rows,
        fallbackCols: density.cols
      }),
      weights,
      ...(clipLayerId ? { clipLayerId } : {}),
      ...(layer.role === "mouth" ? { mouthVariant: "closed" as const } : {}),
      parentGroup
    };
    if (binding.role === "frontHair" && binding.mesh.influences) {
      binding.mesh.influences.physics = binding.mesh.points.map((point) => frontHairPhysicsMask(binding, point));
    }
    return binding;
  });
  const features = featuresFor(imported, level);
  const poseField = poseFieldFor(anchors, level);
  const semanticCage = level === "semantic" ? buildSemanticControlCage(imported) : undefined;
  return {
    version: PUPPETLOOM_PROJECT_VERSION,
    name: input.name,
    canvas: imported.canvas,
    source: input.source,
    rigLevel: level,
    layers,
    model: createDefaultAuthoringModel(),
    anchors,
    runtime: {
      seed: input.seed,
      profile: semanticCage && poseField ? "coherent-v3" : poseField ? "coherent-v2" : "calm-v1",
      envelope: envelopeFor(level),
      features,
      ...(poseField ? { poseField, motionTuning: { amplitude: 1, response: 0.72, stability: 0.42 } } : {}),
      ...(semanticCage ? { semanticCage } : {})
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
