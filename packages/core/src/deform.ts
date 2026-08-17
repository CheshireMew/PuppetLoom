import { clamp } from "./math.js";
import { evaluateLayerAuthoring, resolveMotionState } from "./model.js";
import { applyCoherentPoseField } from "./pose-field.js";
import type { LayerBinding, MotionChainState, MotionState, Point, PuppetLoomProject } from "./types.js";

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
  if (layer.role === "bottomWear") return 0.62;
  if (layer.role === "tail" || layer.role === "accessory") return 0.7;
  if (layer.role === "leg") return 0.16;
  if (layer.role === "foot") return 0;
  if (layer.role === "unknown") return 0.45;
  return 0.75;
}

function frontHairSecondaryRelease(layer: LayerBinding, base: Point): number {
  const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
  const centerX = layer.bounds.x + layer.bounds.width * 0.5;
  const screenLeft = base.x < centerX;
  const commonRootY = layer.secondaryAnchors?.frontHairRoot?.y ?? layer.bounds.y + layer.bounds.height * 0.52;
  const root = screenLeft
    ? layer.secondaryAnchors?.frontHairRootLeft ?? { x: layer.bounds.x + layer.bounds.width * 0.18, y: commonRootY }
    : layer.secondaryAnchors?.frontHairRootRight ?? { x: layer.bounds.x + layer.bounds.width * 0.82, y: commonRootY };
  const tip = screenLeft
    ? layer.secondaryAnchors?.frontHairTipLeft ?? { x: layer.bounds.x + layer.bounds.width * 0.1, y: layer.bounds.y + layer.bounds.height }
    : layer.secondaryAnchors?.frontHairTipRight ?? { x: layer.bounds.x + layer.bounds.width * 0.9, y: layer.bounds.y + layer.bounds.height };
  const length = Math.max(layer.bounds.height * 0.28, tip.y - root.y);
  const progress = clamp((base.y - root.y) / length, 0, 1);
  const expectedX = root.x + (tip.x - root.x) * progress;
  const distanceFromStrand = Math.abs(base.x - expectedX) / Math.max(1e-6, layer.bounds.width * 0.3);
  const strandProximity = 1 - smoothstep01((distanceFromStrand - 0.2) / 0.8);
  const outerBand = smoothstep01((Math.abs(u - 0.5) - 0.18) / 0.27);
  const strandMask = Math.max(outerBand, strandProximity * 0.9);
  const sideRelease = smoothstep01(progress) ** 1.3 * strandMask;

  const rootV = clamp((commonRootY - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0.35, 0.78);
  const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
  const bangRelease = smoothstep01((v - rootV) / Math.max(0.08, 1 - rootV)) ** 1.35 * (1 - outerBand) * 0.22;
  return Math.max(sideRelease, bangRelease);
}

function secondaryFree(layer: LayerBinding, base: Point): number {
  const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
  const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
  if (layer.role === "frontHair") {
    return frontHairSecondaryRelease(layer, base);
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
  if (layer.role === "topWear") return smoothstep01((v - 0.52) / 0.48) ** 2;
  if (layer.role === "bottomWear") return smoothstep01((v - 0.12) / 0.88) ** 2;
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

function ahogeFree(layer: LayerBinding, base: Point): number {
  if (layer.role !== "frontHair") return 0;
  const u = clamp((base.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1);
  const v = clamp((base.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0, 1);
  const root = layer.secondaryAnchors?.ahogeRoot;
  const rootU = root ? clamp((root.x - layer.bounds.x) / Math.max(1e-6, layer.bounds.width), 0, 1) : 0.5;
  const rootV = root ? clamp((root.y - layer.bounds.y) / Math.max(1e-6, layer.bounds.height), 0.12, 0.42) : 0.24;
  const center = 1 - smoothstep01((Math.abs(u - rootU) - 0.045) / 0.24);
  const aboveRoot = smoothstep01((rootV - v) / Math.max(0.08, rootV));
  return center * aboveRoot;
}

function hasSidePerspective(layer: LayerBinding): boolean {
  return layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash" || layer.role === "eyeClosed" || layer.role === "eyebrow" || layer.role === "ear";
}

function vertexInfluence(layer: LayerBinding, channel: "face" | "skull" | "head" | "body" | "gaze" | "physics" | "pin", index: number | undefined, fallback: number): number {
  if (index === undefined) return fallback;
  return clamp(layer.mesh.influences?.[channel]?.[index] ?? fallback, 0, 1);
}

export function deformPoint(project: PuppetLoomProject, layer: LayerBinding, base: Point, state: MotionState, vertexIndex?: number): Point {
  state = resolveMotionState(project, state);
  const envelope = project.runtime.envelope;
  const faceWidth = Math.max(0.08, Math.abs((project.anchors.cheekLeft?.x ?? 0.6) - (project.anchors.cheekRight?.x ?? 0.4)) / 0.64);
  const faceHeight = Math.max(0.1, Math.abs((project.anchors.chin?.y ?? 0.5) - (project.anchors.forehead?.y ?? 0.25)) / 0.78);
  const headPivot = project.anchors.neck ?? project.anchors.chin ?? { x: 0.5, y: 0.42 };
  const bodyPivot = project.anchors.bodyCenter ?? { x: 0.5, y: 0.65 };
  const yaw = clamp(state.headYaw, -1, 1) * envelope.headYaw;
  const pitch = clamp(state.headPitch, -1, 1) * envelope.headPitch;
  const headRoll = (clamp(state.headRoll, -1, 1) * envelope.headRollDegrees * Math.PI) / 180;
  const bodyRoll = (clamp(state.bodyRoll, -1, 1) * envelope.bodyRollDegrees * Math.PI) / 180;
  const release = 1 - vertexInfluence(layer, "pin", vertexIndex, 0);
  const bodyLayerWeight = layer.weights.body * vertexInfluence(layer, "body", vertexIndex, 1) * release;
  const headLayerWeight = layer.weights.head * vertexInfluence(layer, "head", vertexIndex, 1) * release;
  const gazeLayerWeight = layer.weights.gaze * vertexInfluence(layer, "gaze", vertexIndex, 1) * release;
  const physicsLayerWeight = layer.weights.physics * vertexInfluence(layer, "physics", vertexIndex, 1) * release;
  let point = { ...base };

  if ((layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash") && state.blink > 0) {
    const closing = smoothstep01(state.blink);
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
    const upperFollow = layer.role === "neck" ? 1 : 1 - smoothstep01((localV - 0.08) / 0.92);
    if (layer.role === "neck" || layer.role === "topWear" || layer.role === "arm" || layer.role === "hand" || layer.role === "bottomWear") {
      point.x += bodyTurn * faceWidth * 0.012 * bodyWeight * upperFollow;
      point.y += bodyTurn * (localU - 0.5) * faceHeight * 0.018 * bodyWeight * upperFollow;
      point.y += bodyPitch * faceHeight * 0.018 * bodyWeight * upperFollow;
      const pitchScale = 1 - bodyPitch * 0.012 * bodyWeight * upperFollow;
      point.x = bodyPivot.x + (point.x - bodyPivot.x) * pitchScale;
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
      const posed = applyCoherentPoseField(project.runtime.poseField, layer, point, yaw, pitch, project.runtime.semanticCage, {
        face: vertexInfluence(layer, "face", vertexIndex, 1),
        skull: vertexInfluence(layer, "skull", vertexIndex, 1)
      });
      point = { x: point.x + (posed.x - point.x) * headWeight, y: point.y + (posed.y - point.y) * headWeight };
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
      if (state.secondary) {
        const bend = pairedChainValue(state.secondary.frontHairLeft, state.secondary.frontHairRight, "x", u, free);
        const lift = pairedChainValue(state.secondary.frontHairLeft, state.secondary.frontHairRight, "y", u, free);
        addLocalBend(point, base, layer.pivot, bend * 3.1 * weight, 1);
        point.y += lift * faceHeight * 0.72 * weight;
        point.x += lift * (u - 0.5) * faceWidth * 1.1 * weight;
      } else {
        addLocalBend(point, base, layer.pivot, state.hairX * 2.1 * weight, free);
        point.y += state.hairY * faceHeight * 0.42 * weight * free;
        point.x += state.hairY * (u - 0.5) * faceWidth * 1.35 * weight * free;
      }
    } else if (layer.role === "backHair" || layer.role === "sideHair") {
      if (state.secondary) {
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
      } else {
        point.y += state.earY * faceHeight * 2.8 * weight * free;
        addLocalBend(point, base, layer.pivot, state.earX * 0.72 * weight, free);
      }
    } else if (layer.role === "ear") {
      const hinge = earHingeFor(layer, base);
      if (hinge) addLocalBend(point, base, hinge.pivot, (state.earY * hinge.mirror * 20 + state.earX * 6) * weight, free);
    } else if (layer.role === "topWear" || layer.role === "bottomWear") {
      const clothScale = layer.role === "bottomWear" ? 5.2 : 2.1;
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
      const ahoge = ahogeFree(layer, base);
      const ahogeX = state.secondary ? chainValue(state.secondary.ahoge, "x", ahoge) : state.ahogeX * ahoge;
      const ahogeY = state.secondary ? chainValue(state.secondary.ahoge, "y", ahoge) : state.ahogeY * ahoge;
      const ahogePivot = layer.secondaryAnchors?.ahogeRoot ?? layer.pivot;
      addLocalBend(point, base, ahogePivot, ahogeX * 6.4 * weight, 1);
      point.y += ahogeY * faceHeight * 2.2 * weight;
      point.y += ahogeX * (u - 0.5) * faceHeight * 0.2 * weight;
    }
  }

  return point;
}

export function deformedPoints(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): Point[] {
  const resolvedState = resolveMotionState(project, state);
  const authored = evaluateLayerAuthoring(project, layer, resolvedState);
  return authored.points.map((point, index) => deformPoint(project, layer, point, resolvedState, index));
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
