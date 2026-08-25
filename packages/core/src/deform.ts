import { clamp } from "./math.js";
import { applyLayerCollisionConstraints } from "./collision-constraints.js";
import { characterMotionState } from "./character-state.js";
import { constrainMotionState } from "./collision-constraints.js";
import { evaluateLayerAuthoring, resolveMotionState } from "./model.js";
import { applyCoherentPoseField } from "./pose-field.js";
import { ahogeHingeWeight, frontHairSideGeometry } from "./front-hair-geometry.js";
import {
  clothingBodyFollow,
  clothingSecondaryRelease,
  skirtElasticRelease,
  skirtHemFlutterRelease,
  skirtSupportPivot
} from "./clothing-geometry.js";
import type { HairStrandSpec, LayerBinding, MeshBinding, MeshInfluenceChannel, MotionChainState, MotionState, Point, PuppetLoomProject, TorsoVolumeProfile } from "./types.js";

function rotate(point: Point, pivot: Point, radians: number): Point {
  if (Math.abs(radians) < 1e-8) return point;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x = point.x - pivot.x;
  const y = point.y - pivot.y;
  return { x: pivot.x + x * cos - y * sin, y: pivot.y + x * sin + y * cos };
}

function featureParallax(layer: LayerBinding): number {
  if (layer.role === "nose") return 1;
  if (layer.role === "mouth") return 0.78;
  if (layer.role === "iris" || layer.role === "eyeWhite" || layer.role === "eyelash" || layer.role === "eyeClosed") return 0.62;
  if (layer.role === "eyebrow") return 0.55;
  if (layer.role === "frontHair" || layer.role === "headwear") return 0.18;
  if (layer.role === "backHair") return -0.16;
  return 0;
}

function pitchParallax(layer: LayerBinding): number {
  if (layer.role === "nose") return 1;
  if (layer.role === "mouth") return 0.78;
  if (layer.role === "iris" || layer.role === "eyeWhite" || layer.role === "eyelash" || layer.role === "eyeClosed" || layer.role === "eyebrow") return 0.55;
  if (layer.role === "frontHair" || layer.role === "headwear") return 0.18;
  if (layer.role === "backHair") return -0.12;
  return 0;
}

function smoothstep01(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export function torsoVolumeAt(profile: TorsoVolumeProfile, normalizedTorsoY: number): number {
  const y = clamp(normalizedTorsoY, 0, 1);
  const points = profile.points;
  if (y <= points[0]!.position) return points[0]!.depth;
  if (y >= points.at(-1)!.position) return points.at(-1)!.depth;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!;
    const left = points[index - 1]!;
    if (y > right.position) continue;
    const amount = smoothstep01((y - left.position) / Math.max(1e-9, right.position - left.position));
    return left.depth + (right.depth - left.depth) * amount;
  }
  return 0;
}

const torsoVolumeDepthCaches = new WeakMap<PuppetLoomProject, WeakMap<Point, number>>();

function cachedTorsoVolumeDepth(project: PuppetLoomProject, base: Point, bodyPivot: Point, faceHeight: number): number {
  const profile = project.runtime.torsoVolumeProfile;
  if (!profile) return 0;
  let values = torsoVolumeDepthCaches.get(project);
  if (!values) {
    values = new WeakMap();
    torsoVolumeDepthCaches.set(project, values);
  }
  const cached = values.get(base);
  if (cached !== undefined) return cached;
  const shoulderY = project.anchors.shoulderLeft && project.anchors.shoulderRight
    ? (project.anchors.shoulderLeft.y + project.anchors.shoulderRight.y) * 0.5
    : project.anchors.neck?.y ?? bodyPivot.y - faceHeight * 0.55;
  const hipY = Math.max(shoulderY + faceHeight * 0.9, bodyPivot.y + faceHeight * 0.72);
  const torsoY = clamp((base.y - shoulderY) / Math.max(1e-6, hipY - shoulderY), 0, 1);
  const depth = torsoVolumeAt(profile, torsoY) * profile.strength;
  values.set(base, depth);
  return depth;
}

function chainValue(chain: MotionChainState | undefined, axis: "x" | "y", free: number): number {
  const values = chain?.[axis];
  if (!values?.length || free <= 0) return 0;
  const scaled = clamp(free, 0, 1) * values.length;
  if (scaled >= values.length) return values.at(-1) ?? 0;
  if (scaled <= 1) return (values[0] ?? 0) * smoothstep01(scaled);
  const upperIndex = Math.min(values.length - 1, Math.floor(scaled));
  const lowerIndex = Math.max(0, upperIndex - 1);
  const blend = smoothstep01(scaled - Math.floor(scaled));
  return (values[lowerIndex] ?? 0) * (1 - blend) + (values[upperIndex] ?? 0) * blend;
}

function pairedChainValue(
  left: MotionChainState | undefined,
  right: MotionChainState | undefined,
  axis: "x" | "y",
  u: number,
  free: number
): number {
  const blend = smoothstep01((u - 0.34) / 0.32);
  return chainValue(left, axis, free) * (1 - blend) + chainValue(right, axis, free) * blend;
}

function breathInfluence(layer: LayerBinding): number {
  if (layer.role === "topWear") return 1;
  if (layer.role === "neck") return 0.2;
  if (layer.role === "arm") return 0.18;
  if (layer.role === "bottomWear") return 0.08;
  if (layer.role === "unknown") return 0.12;
  return 0;
}

function bodyMotionInfluence(layer: LayerBinding, base: Point): number {
  if (layer.role === "neck") {
    const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
    return smoothstep01((v - 0.04) / 0.92);
  }
  if (layer.role === "topWear") return 1;
  if (layer.role === "arm" || layer.role === "hand") return 0.9;
  if (layer.role === "bottomWear") return clothingBodyFollow(layer, base);
  if (layer.role === "tail" || layer.role === "accessory") return 0.7;
  if (layer.role === "leg") return 0.16;
  if (layer.role === "foot") return 0;
  if (layer.role === "unknown") return 0.45;
  return 0.75;
}

function secondaryFree(layer: LayerBinding, base: Point): number {
  const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
  const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
  if (layer.role === "frontHair") {
    return frontHairSideGeometry(layer, base).totalRelease;
  }
  if (layer.role === "headwear") {
    const hinge = base.x < layer.bounds.x + layer.bounds.width * 0.5
      ? layer.secondaryAnchors?.earHingeLeft
      : layer.secondaryAnchors?.earHingeRight;
    if (hinge) {
      const distance = Math.hypot(
        (base.x - hinge.x) / Math.max(1e-6, layer.bounds.width * 0.32),
        (base.y - hinge.y) / Math.max(1e-6, layer.bounds.height * 0.35)
      );
      const radialRelease = smoothstep01((distance - 0.12) / 0.88);
      const outer = smoothstep01((Math.abs(u - 0.5) - 0.08) / 0.24);
      const belowBand = smoothstep01((v - 0.42) / 0.22);
      return radialRelease * outer * belowBand;
    }
    const outer = smoothstep01((Math.abs(u - 0.5) - 0.18) / 0.32);
    const belowBand = smoothstep01((v - 0.18) / 0.72);
    return outer * belowBand;
  }
  if (layer.role === "ear") return smoothstep01(v) ** 2;
  if (layer.role === "tail") {
    const distanceFromRoot = Math.hypot((u - 0.03) * 0.9, (v - 0.08) * 0.74);
    return smoothstep01((distanceFromRoot - 0.05) / 0.38);
  }
  if (layer.role === "topWear" || layer.role === "bottomWear" || layer.role === "arm") {
    return clothingSecondaryRelease(layer, base);
  }
  return v * v;
}

function addLocalBend(point: Point, base: Point, pivot: Point, radians: number, free: number): void {
  if (Math.abs(radians) < 1e-8 || free <= 0) return;
  const x = base.x - pivot.x;
  const y = base.y - pivot.y;
  point.x += -y * radians * free;
  point.y += x * radians * free;
}

function addLocalRotation(point: Point, base: Point, pivot: Point, radians: number, free: number): void {
  if (Math.abs(radians) < 1e-8 || free <= 0) return;
  const rotated = rotate(base, pivot, radians * free);
  point.x += rotated.x - base.x;
  point.y += rotated.y - base.y;
}

function addLocalStretch(point: Point, base: Point, pivot: Point, amount: number, free: number): void {
  if (Math.abs(amount) < 1e-8 || free <= 0) return;
  point.x += (base.x - pivot.x) * amount * free;
  point.y += (base.y - pivot.y) * amount * free;
}

function earHingeFor(layer: LayerBinding, base: Point): { pivot: Point; mirror: -1 | 1 } | undefined {
  if (layer.role === "headwear") {
    if (base.x < layer.bounds.x + layer.bounds.width * 0.5 && layer.secondaryAnchors?.earHingeLeft) {
      return { pivot: layer.secondaryAnchors.earHingeLeft, mirror: -1 };
    }
    if (layer.secondaryAnchors?.earHingeRight) return { pivot: layer.secondaryAnchors.earHingeRight, mirror: 1 };
    return undefined;
  }
  if (layer.role === "ear") {
    const mirror = layer.side === "right" || (layer.side === "center" && base.x < layer.bounds.x + layer.bounds.width * 0.5) ? -1 : 1;
    return { pivot: layer.pivot, mirror };
  }
  return undefined;
}

function hasSidePerspective(layer: LayerBinding): boolean {
  return layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash" || layer.role === "eyeClosed" || layer.role === "eyebrow" || layer.role === "ear";
}

function vertexInfluence(layer: LayerBinding, channel: MeshInfluenceChannel, index: number | undefined, fallback: number): number {
  if (index === undefined) return fallback;
  return clamp(layer.mesh.influences?.[channel]?.[index] ?? fallback, 0, 1);
}

interface HairVertexBinding {
  strandIndex: number;
  strand: HairStrandSpec;
  ownership: number;
  release: number;
}

interface PreparedHairLayerMotion {
  active: boolean;
  chains: Array<MotionChainState | undefined>;
  rotationScale: number;
  liftScale: number;
}

const hairVertexBindings = new WeakMap<LayerBinding, HairVertexBinding[][]>();

function vertexHairBindings(layer: LayerBinding): HairVertexBinding[][] {
  const cached = hairVertexBindings.get(layer);
  if (cached) return cached;
  const bindings = Array.from({ length: layer.mesh.points.length }, (): HairVertexBinding[] => []);
  for (const [strandIndex, strand] of (layer.hairStrands ?? []).entries()) {
    for (let vertexIndex = 0; vertexIndex < bindings.length; vertexIndex += 1) {
      const ownership = clamp(strand.weights[vertexIndex] ?? 0, 0, 1);
      const release = clamp(strand.release[vertexIndex] ?? 0, 0, 1);
      if (ownership <= 1e-6 || release <= 1e-6) continue;
      bindings[vertexIndex]!.push({ strandIndex, strand, ownership, release });
    }
  }
  hairVertexBindings.set(layer, bindings);
  return bindings;
}

function preparedHairLayerMotion(frame: DeformationFrameContext, layer: LayerBinding): PreparedHairLayerMotion | undefined {
  const cached = frame.hairLayerMotion.get(layer);
  if (cached !== undefined) return cached ?? undefined;
  const states = frame.state.secondary?.hairStrands;
  if (!layer.hairStrands?.length || !states) {
    frame.hairLayerMotion.set(layer, null);
    return undefined;
  }
  const chains = layer.hairStrands.map((strand) => states[strand.id]);
  const prepared = {
    active: chains.some(Boolean),
    chains,
    rotationScale: layer.role === "frontHair" ? 2.45 : layer.role === "sideHair" ? 3.15 : 3.65,
    liftScale: layer.role === "frontHair" ? 0.24 : layer.role === "sideHair" ? 0.64 : 0.84
  };
  frame.hairLayerMotion.set(layer, prepared);
  return prepared;
}

function applyAuthoredHairStrands(
  point: Point,
  base: Point,
  layer: LayerBinding,
  frame: DeformationFrameContext,
  vertexIndex: number | undefined,
  faceHeight: number,
  layerWeight: number
): boolean {
  if (vertexIndex === undefined) return false;
  const motion = preparedHairLayerMotion(frame, layer);
  if (!motion?.active) return false;
  for (const binding of vertexHairBindings(layer)[vertexIndex] ?? []) {
    const chain = motion.chains[binding.strandIndex];
    if (!chain) continue;
    const strandWeight = layerWeight * binding.ownership;
    const bend = chainValue(chain, "x", binding.release);
    const lift = chainValue(chain, "y", binding.release);
    addLocalRotation(point, base, binding.strand.root, bend * motion.rotationScale * strandWeight, 1);
    point.y += lift * faceHeight * motion.liftScale * strandWeight * binding.release;
  }
  // The authored strand system owns the whole layer, including pinned roots.
  // Returning true here prevents the legacy left/right chain from being
  // applied a second time to vertices whose release is intentionally zero.
  return true;
}

export interface DeformationFrameContext {
  state: MotionState;
  envelope: PuppetLoomProject["runtime"]["envelope"];
  faceWidth: number;
  faceHeight: number;
  headPivot: Point;
  bodyPivot: Point;
  yaw: number;
  pitch: number;
  headRoll: number;
  bodyRoll: number;
  hasSeparateEarLayers: boolean;
  hairLayerMotion: WeakMap<LayerBinding, PreparedHairLayerMotion | null>;
}

/** Precomputes values shared by every vertex in one rendered frame. */
export function createDeformationFrameContext(project: PuppetLoomProject, resolvedState: MotionState): DeformationFrameContext {
  const envelope = project.runtime.envelope;
  return {
    state: resolvedState,
    envelope,
    faceWidth: Math.max(0.08, Math.abs((project.anchors.cheekLeft?.x ?? 0.6) - (project.anchors.cheekRight?.x ?? 0.4)) / 0.64),
    faceHeight: Math.max(0.1, Math.abs((project.anchors.chin?.y ?? 0.5) - (project.anchors.forehead?.y ?? 0.25)) / 0.78),
    headPivot: project.anchors.neck ?? project.anchors.chin ?? { x: 0.5, y: 0.42 },
    bodyPivot: project.anchors.bodyCenter ?? { x: 0.5, y: 0.65 },
    yaw: clamp(resolvedState.headYaw, -1, 1) * envelope.headYaw,
    pitch: clamp(resolvedState.headPitch, -1, 1) * envelope.headPitch,
    headRoll: (clamp(resolvedState.headRoll, -1, 1) * envelope.headRollDegrees * Math.PI) / 180,
    bodyRoll: (clamp(resolvedState.bodyRoll, -1, 1) * envelope.bodyRollDegrees * Math.PI) / 180,
    hasSeparateEarLayers: project.layers?.some((layer) => layer.visible !== false && layer.role === "ear") ?? false,
    hairLayerMotion: new WeakMap()
  };
}

export function deformResolvedPoint(project: PuppetLoomProject, layer: LayerBinding, base: Point, frame: DeformationFrameContext, vertexIndex?: number): Point {
  const { state, envelope, faceWidth, faceHeight, headPivot, bodyPivot, yaw, pitch, headRoll, bodyRoll } = frame;
  const release = 1 - vertexInfluence(layer, "pin", vertexIndex, 0);
  const bodyLayerWeight = layer.weights.body * vertexInfluence(layer, "body", vertexIndex, 1) * release;
  const headLayerWeight = layer.weights.head * vertexInfluence(layer, "head", vertexIndex, 1) * release;
  const gazeLayerWeight = layer.weights.gaze * vertexInfluence(layer, "gaze", vertexIndex, 1) * release;
  const physicsLayerWeight = layer.weights.physics * vertexInfluence(layer, "physics", vertexIndex, 1) * release;
  let point = { ...base };

  const eyeBlink = layer.side === "left" ? state.blinkLeft ?? state.blink : layer.side === "right" ? state.blinkRight ?? state.blink : state.blink;
  if ((layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash") && eyeBlink > 0) {
    const closing = smoothstep01(eyeBlink);
    point.y = layer.pivot.y + (point.y - layer.pivot.y) * (1 - closing * 0.72);
  }

  if (bodyLayerWeight > 0) {
    const bodyWeight = bodyLayerWeight * bodyMotionInfluence(layer, base);
    const breath = clamp(state.breath, -1, 1);
    const bodyPitch = clamp(state.bodyPitch, -1, 1);
    const breathWeight = breathInfluence(layer) * bodyLayerWeight;
    if (breathWeight > 0) {
      const scaleX = 1 + breath * envelope.breath * breathWeight;
      const scaleY = 1 + breath * envelope.breath * 0.28 * breathWeight;
      point.x = bodyPivot.x + (point.x - bodyPivot.x) * scaleX;
      point.y = bodyPivot.y + (point.y - bodyPivot.y) * scaleY - Math.max(0, breath) * envelope.breath * 0.05 * breathWeight;
    }
    point.x += state.bodySway * envelope.bodySway * bodyWeight;
    const bodyTurn = clamp(state.bodySway * 2.1, -1, 1);
    const compression = 1 - Math.abs(bodyTurn) * 0.022 * bodyWeight;
    point.x = bodyPivot.x + (point.x - bodyPivot.x) * compression;
    const localU = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
    const localV = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
    const isConnectedGarment = layer.role === "topWear" || layer.role === "arm" || layer.role === "hand" || layer.role === "bottomWear";
    const garmentTop = project.anchors.neck?.y ?? bodyPivot.y - faceHeight * 0.45;
    const garmentFollow = 1 - smoothstep01((base.y - garmentTop) / Math.max(0.08, bodyPivot.y - garmentTop));
    const upperFollow = layer.role === "neck" ? 1 : isConnectedGarment ? garmentFollow : 1 - smoothstep01((localV - 0.08) / 0.92);
    if (layer.role === "neck" || layer.role === "topWear" || layer.role === "arm" || layer.role === "hand" || layer.role === "bottomWear") {
      point.x += bodyTurn * faceWidth * 0.012 * bodyWeight * upperFollow;
      point.y += bodyTurn * (localU - 0.5) * faceHeight * 0.018 * bodyWeight * upperFollow;
      point.y += bodyPitch * faceHeight * 0.018 * bodyWeight * upperFollow;
      const pitchScale = 1 - bodyPitch * 0.012 * bodyWeight * upperFollow;
      point.x = bodyPivot.x + (point.x - bodyPivot.x) * pitchScale;
    }
    if (project.runtime.torsoVolumeProfile && (layer.role === "topWear" || layer.role === "bottomWear")) {
      const depth = cachedTorsoVolumeDepth(project, base, bodyPivot, faceHeight);
      point.x += bodyTurn * faceWidth * depth * 0.24 * bodyLayerWeight;
    }
    if (layer.side !== "center") {
      const side = layer.side === "left" ? 1 : -1;
      point.x += bodyTurn * side * faceWidth * 0.006 * bodyWeight;
    }
    const rotated = rotate(point, bodyPivot, bodyRoll * bodyWeight);
    point = rotated;
  }

  if (headLayerWeight > 0) {
    const neckV = layer.role === "neck" ? clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1) : 0;
    const headWeight = headLayerWeight * (layer.role === "neck" ? 1 - smoothstep01(neckV) : 1);
    if (project.runtime.poseField) {
      const blinkModified = (layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash") && eyeBlink > 0;
      // Static head-only vertices retain their project object identity here so
      // the semantic-cage lookup can reuse topology weights across frames.
      const poseInput = bodyLayerWeight === 0 && !blinkModified ? base : point;
      const attachment = vertexIndex === undefined ? undefined : layer.mesh.influences?.headAttachment?.[vertexIndex];
      const posed = applyCoherentPoseField(project.runtime.poseField, layer, poseInput, yaw, pitch, project.runtime.semanticCage, {
        face: vertexInfluence(layer, "face", vertexIndex, 1),
        skull: vertexInfluence(layer, "skull", vertexIndex, 1),
        ...(attachment === undefined ? {} : { attachment: clamp(attachment, 0, 1) })
      });
      point = { x: point.x + (posed.x - poseInput.x) * headWeight, y: point.y + (posed.y - poseInput.y) * headWeight };
    }
    else {
      if (layer.side !== "center" && hasSidePerspective(layer)) {
        // Layer side is anatomical, so character-left is screen-right.
        const screenSide = layer.side === "left" ? 1 : -1;
        const perspectiveScale = 1 - yaw * screenSide * 0.045 * headWeight;
        point.x = layer.pivot.x + (point.x - layer.pivot.x) * perspectiveScale;
      }
      const horizontalCompression = 1 - Math.abs(yaw) * 0.055 * headWeight;
      point.x = headPivot.x + (point.x - headPivot.x) * horizontalCompression;
      const upperHeadLever = clamp((headPivot.y - base.y) / Math.max(0.1, faceHeight * 1.35), 0, 1);
      point.x += yaw * faceWidth * (0.028 + featureParallax(layer) * 0.07 + upperHeadLever * 0.012) * headWeight;
      if (layer.role === "face") {
        const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
        const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
        const center = 1 - Math.abs(u * 2 - 1);
        const cheekAndChin = smoothstep01((v - 0.12) / 0.78);
        point.x += yaw * faceWidth * (0.012 + center * cheekAndChin * 0.014) * headWeight;
        point.y += pitch * faceHeight * smoothstep01((v - 0.36) / 0.64) * 0.01 * headWeight;
      }
      point.y += pitch * faceHeight * (0.012 + upperHeadLever * 0.009 + pitchParallax(layer) * 0.011) * headWeight;
    }
    point = rotate(point, headPivot, headRoll * headWeight);
  }

  if (gazeLayerWeight > 0) {
    const eyeWidth = layer.bounds.width;
    const eyeHeight = layer.bounds.height;
    point.x += clamp(state.gazeX, -1, 1) * envelope.gazeX * eyeWidth * gazeLayerWeight;
    point.y += clamp(state.gazeY, -1, 1) * envelope.gazeY * eyeHeight * gazeLayerWeight;
  }

  if (physicsLayerWeight > 0) {
    const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
    const free = secondaryFree(layer, base);
    const weight = physicsLayerWeight;
    if (layer.role === "frontHair") {
      if (!applyAuthoredHairStrands(point, base, layer, frame, vertexIndex, faceHeight, weight)) {
        const strand = frontHairSideGeometry(layer, base);
        const strandChain = strand.screenSide < 0 ? state.secondary?.frontHairLeft : state.secondary?.frontHairRight;
        const bangRelease = strand.bangRelease;
        if (state.secondary) {
          const sideBend = chainValue(strandChain, "x", strand.sideRelease);
          const sideLift = chainValue(strandChain, "y", strand.sideRelease);
          const bangBend = pairedChainValue(state.secondary.frontHairLeft, state.secondary.frontHairRight, "x", u, bangRelease);
          const bangLift = pairedChainValue(state.secondary.frontHairLeft, state.secondary.frontHairRight, "y", u, bangRelease);
          addLocalRotation(point, base, strand.root, sideBend * 2.45 * weight, 1);
          addLocalRotation(point, base, strand.bangRoot, bangBend * 1.35 * weight, 1);
          point.y += sideLift * faceHeight * 0.22 * weight * strand.sideRelease;
          point.y += bangLift * faceHeight * 0.16 * weight * bangRelease;
        } else {
          addLocalRotation(point, base, strand.root, state.hairX * 1.7 * weight * strand.sideRelease, 1);
          addLocalRotation(point, base, strand.bangRoot, state.hairX * 0.9 * weight * bangRelease, 1);
          point.y += state.hairY * faceHeight * 0.2 * weight * free;
        }
      }
    } else if (layer.role === "backHair" || layer.role === "sideHair") {
      if (applyAuthoredHairStrands(point, base, layer, frame, vertexIndex, faceHeight, weight)) {
        // Every vertex is owned by one or more persisted strands.
      } else if (state.secondary) {
        const bend = pairedChainValue(state.secondary.backHairLeft, state.secondary.backHairRight, "x", u, free);
        const lift = pairedChainValue(state.secondary.backHairLeft, state.secondary.backHairRight, "y", u, free);
        addLocalBend(point, base, layer.pivot, bend * 3.5 * weight, 1);
        point.y += lift * faceHeight * 0.82 * weight;
      } else {
        addLocalBend(point, base, layer.pivot, state.backHairX * 2.5 * weight, free);
        point.y += state.backHairY * faceHeight * 0.5 * weight * free;
      }
    } else if (layer.role === "headwear") {
      const headwearX = state.secondary ? chainValue(state.secondary.headwear, "x", Math.max(0.35, free)) : state.headwearX;
      const headwearY = state.secondary ? chainValue(state.secondary.headwear, "y", Math.max(0.35, free)) : state.headwearY;
      addLocalBend(point, base, layer.pivot, headwearX * 1.8 * weight, 1);
      addLocalStretch(point, base, layer.pivot, headwearY * 0.32 * weight, 1);
      const hinge = earHingeFor(layer, base);
      if (hinge) {
        const flap = state.earY * hinge.mirror * 20 + state.earX * 6;
        addLocalBend(point, base, hinge.pivot, flap * weight, free);
      } else if (!frame.hasSeparateEarLayers) {
        point.y += state.earY * faceHeight * 2.8 * weight * free;
        addLocalBend(point, base, layer.pivot, state.earX * 0.72 * weight, free);
      }
    } else if (layer.role === "ear") {
      const hinge = earHingeFor(layer, base);
      if (hinge) addLocalBend(point, base, hinge.pivot, (state.earY * hinge.mirror * 20 + state.earX * 6) * weight, free);
    } else if (layer.role === "bottomWear" && layer.garmentStructure === "supported") {
      const clothChain = state.secondary?.skirt;
      const shellX = clothChain ? chainValue(clothChain, "x", 0.82) : state.clothX;
      const shellY = clothChain ? chainValue(clothChain, "y", 0.82) : state.clothY;
      const tipX = clothChain ? chainValue(clothChain, "x", 1) : shellX;
      const tipY = clothChain ? chainValue(clothChain, "y", 1) : shellY;
      const hemFlutter = skirtHemFlutterRelease(layer, base);
      const elasticRelease = skirtElasticRelease(layer, base);
      const flexibility = clamp(layer.garmentFlexibility ?? 0, 0, 0.5);
      const sectionX = clothChain
        ? chainValue(clothChain, "x", 0.46 + elasticRelease * 0.54)
        : shellX * (0.65 + elasticRelease * 0.35);
      const shellAngle = shellX * 2.9 + (tipX - shellX) * 0.48 * hemFlutter;
      const elasticAngle = ((sectionX - shellX) * 1.6 + shellX * 1.6) * flexibility;
      addLocalRotation(point, base, skirtSupportPivot(layer), (shellAngle + elasticAngle * elasticRelease) * weight, free);
      point.y += shellY * faceHeight * 0.22 * weight * free;
      point.y += (tipY - shellY) * faceHeight * 0.06 * weight * hemFlutter;
    } else if (layer.role === "topWear" || layer.role === "bottomWear") {
      const clothScale = layer.role === "bottomWear" ? 3.4 : 1.5;
      const clothChain = layer.role === "bottomWear" ? state.secondary?.skirt : state.secondary?.topCloth;
      const clothX = clothChain ? chainValue(clothChain, "x", free) : state.clothX * free;
      const clothY = clothChain ? chainValue(clothChain, "y", free) : state.clothY * free;
      addLocalBend(point, base, layer.pivot, clothX * clothScale * weight, 1);
      point.y += clothY * faceHeight * 0.56 * weight;
      point.y += clothX * (u - 0.5) * faceHeight * 0.16 * weight;
    } else if (layer.role === "tail") {
      const tailChain = state.secondary?.tail;
      const rootX = tailChain?.x[0] ?? state.tailX;
      const rootY = tailChain?.y[0] ?? state.tailY;
      const sectionX = tailChain ? chainValue(tailChain, "x", free) : state.tailX;
      const sectionY = tailChain ? chainValue(tailChain, "y", free) : state.tailY;
      const horizontal = rootX * 0.8 + sectionX * 0.2;
      const vertical = rootY * 0.72 + sectionY * 0.28;
      addLocalRotation(point, base, layer.pivot, (vertical * 5.6 + horizontal * 0.72) * weight, free);
    } else if (layer.role === "accessory") {
      const accessoryX = state.secondary ? chainValue(state.secondary.accessory, "x", free) : state.accessoryX * free;
      const accessoryY = state.secondary ? chainValue(state.secondary.accessory, "y", free) : state.accessoryY * free;
      addLocalBend(point, base, layer.pivot, accessoryX * 2.7 * weight, 1);
      point.y += accessoryY * faceHeight * 0.68 * weight;
    }
    if (layer.role === "frontHair") {
      const ahoge = ahogeHingeWeight(layer, base);
      const ahogeX = state.secondary ? chainValue(state.secondary.ahoge, "x", 1) : state.ahogeX;
      const ahogeY = state.secondary ? chainValue(state.secondary.ahoge, "y", 1) : state.ahogeY;
      const ahogePivot = layer.secondaryAnchors?.ahogeRoot ?? layer.pivot;
      const hingeWeight = layer.weights.physics * release;
      addLocalRotation(point, base, ahogePivot, (ahogeX * 5.4 + ahogeY * 1.5) * hingeWeight, ahoge);
    }
  }

  return point;
}

export function deformPoint(project: PuppetLoomProject, layer: LayerBinding, base: Point, state: MotionState, vertexIndex?: number): Point {
  const resolvedState = resolveMotionState(project, state);
  return deformResolvedPoint(project, layer, base, createDeformationFrameContext(project, resolvedState), vertexIndex);
}

/**
 * Finds the authored mesh point that produces a requested on-canvas point after
 * procedural pose and physics deformation. Editors use this to avoid a vertex
 * jumping when a visible posed mesh is dragged.
 */
export function invertDeformedPoint(
  project: PuppetLoomProject,
  layer: LayerBinding,
  target: Point,
  state: MotionState,
  vertexIndex: number,
  initial: Point
): Point {
  const resolvedState = resolveMotionState(project, state);
  const frame = createDeformationFrameContext(project, resolvedState);
  let current = { ...initial };
  const epsilon = 1e-5;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const value = deformResolvedPoint(project, layer, current, frame, vertexIndex);
    const error = { x: target.x - value.x, y: target.y - value.y };
    if (Math.hypot(error.x, error.y) < 1e-8) break;
    const dx = deformResolvedPoint(project, layer, { x: current.x + epsilon, y: current.y }, frame, vertexIndex);
    const dy = deformResolvedPoint(project, layer, { x: current.x, y: current.y + epsilon }, frame, vertexIndex);
    const j00 = (dx.x - value.x) / epsilon;
    const j10 = (dx.y - value.y) / epsilon;
    const j01 = (dy.x - value.x) / epsilon;
    const j11 = (dy.y - value.y) / epsilon;
    const determinant = j00 * j11 - j01 * j10;
    let step = Math.abs(determinant) > 1e-10
      ? {
          x: (error.x * j11 - error.y * j01) / determinant,
          y: (j00 * error.y - j10 * error.x) / determinant
        }
      : error;
    const length = Math.hypot(step.x, step.y);
    if (length > 0.05) step = { x: step.x * 0.05 / length, y: step.y * 0.05 / length };
    current = { x: current.x + step.x, y: current.y + step.y };
  }
  return current;
}

export function deformedPoints(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): Point[] {
  const resolvedState = resolveMotionState(project, constrainMotionState(project, characterMotionState(project, state)));
  const authored = evaluateLayerAuthoring(project, layer, resolvedState);
  const frame = createDeformationFrameContext(project, resolvedState);
  return applyLayerCollisionConstraints(project, layer, authored.points.map((point, index) => deformResolvedPoint(project, layer, point, frame, index)));
}

interface DeformedPointCacheEntry {
  project: PuppetLoomProject;
  layer: LayerBinding;
  authoredPoints: Point[];
  points: Point[];
  hasSeparateEarLayers: boolean;
}

const previewDeformedPointCache = new WeakMap<MotionState, Map<string, DeformedPointCacheEntry>>();
const resolvedDeformedPointCache = new WeakMap<MotionState, Map<string, DeformedPointCacheEntry>>();

/** Incremental deformation for a stable editor pose and immutable layer drafts. */
export function deformedPointsForPreview(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): Point[] {
  const resolvedState = resolveMotionState(project, constrainMotionState(project, characterMotionState(project, state)));
  const authored = evaluateLayerAuthoring(project, layer, resolvedState);
  const frame = createDeformationFrameContext(project, resolvedState);
  return applyLayerCollisionConstraints(project, layer, deformedPointsWithCache(project, layer, authored.points, resolvedState, frame, state, previewDeformedPointCache));
}

function sameInfluenceArrays(left: MeshBinding["influences"], right: MeshBinding["influences"]): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as MeshInfluenceChannel[]);
  return [...keys].every((key) => left[key] === right[key]);
}

function sameLayerDeformationInputs(left: LayerBinding, right: LayerBinding): boolean {
  return left.id === right.id
    && left.role === right.role
    && left.side === right.side
    && left.bounds === right.bounds
    && left.pivot === right.pivot
    && left.weights === right.weights
    && left.parentGroup === right.parentGroup
    && left.parentLayerId === right.parentLayerId
    && left.deformerId === right.deformerId
    && left.garmentStructure === right.garmentStructure
    && left.garmentFlexibility === right.garmentFlexibility
    && left.secondaryAnchors === right.secondaryAnchors
    && left.hairStrands === right.hairStrands
    && left.mesh.points.length === right.mesh.points.length
    && sameInfluenceArrays(left.mesh.influences, right.mesh.influences);
}

function deformedPointsWithCache(
  project: PuppetLoomProject,
  layer: LayerBinding,
  authoredPoints: Point[],
  resolvedState: MotionState,
  frame: DeformationFrameContext,
  cacheState: MotionState,
  cache: WeakMap<MotionState, Map<string, DeformedPointCacheEntry>>
): Point[] {
  let byLayer = cache.get(cacheState);
  if (!byLayer) {
    byLayer = new Map();
    cache.set(cacheState, byLayer);
  }
  const previous = byLayer.get(layer.id);
  const hasSeparateEarLayers = project.layers.some((candidate) => candidate.visible !== false && candidate.role === "ear");
  const reusable = previous
    && previous.project.runtime === project.runtime
    && previous.project.anchors === project.anchors
    && previous.hasSeparateEarLayers === hasSeparateEarLayers
    && sameLayerDeformationInputs(previous.layer, layer)
    && previous.authoredPoints.length === authoredPoints.length;
  let points: Point[];
  if (reusable) {
    points = [...previous.points];
    for (let index = 0; index < authoredPoints.length; index += 1) {
      const current = authoredPoints[index]!;
      const before = previous.authoredPoints[index]!;
      if (current.x !== before.x || current.y !== before.y) points[index] = deformResolvedPoint(project, layer, current, frame, index);
    }
  } else {
    points = authoredPoints.map((point, index) => deformResolvedPoint(project, layer, point, frame, index));
  }
  byLayer.set(layer.id, { project, layer, authoredPoints, points, hasSeparateEarLayers });
  return points;
}

/** Deforms one cached authoring result with a state already returned by resolveMotionState. */
export function deformedAuthoredPoints(project: PuppetLoomProject, layer: LayerBinding, authoredPoints: Point[], resolvedState: MotionState, frame = createDeformationFrameContext(project, resolvedState)): Point[] {
  return applyLayerCollisionConstraints(project, layer, authoredPoints.map((point, index) => deformResolvedPoint(project, layer, point, frame, index)));
}

/** Incremental authored deformation used by paused editor renderers. */
export function deformedAuthoredPointsForPreview(project: PuppetLoomProject, layer: LayerBinding, authoredPoints: Point[], resolvedState: MotionState, frame = createDeformationFrameContext(project, resolvedState)): Point[] {
  return applyLayerCollisionConstraints(project, layer, deformedPointsWithCache(project, layer, authoredPoints, resolvedState, frame, resolvedState, resolvedDeformedPointCache));
}

export const neutralMotionState: MotionState = {
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  bodySway: 0,
  bodyPitch: 0,
  bodyRoll: 0,
  gazeX: 0,
  gazeY: 0,
  breath: 0,
  hairX: 0,
  hairY: 0,
  ahogeX: 0,
  ahogeY: 0,
  backHairX: 0,
  backHairY: 0,
  headwearX: 0,
  headwearY: 0,
  earX: 0,
  earY: 0,
  clothX: 0,
  clothY: 0,
  tailX: 0,
  tailY: 0,
  accessoryX: 0,
  accessoryY: 0,
  blink: 0,
  mouthOpen: 0
};
