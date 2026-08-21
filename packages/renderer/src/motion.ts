import { ModelPhysicsController, type MotionState, type MotionTuning, type PuppetLoomProject, type RuntimeControlSnapshot, type SecondaryMotionPart, type SemanticRole } from "@puppetloom/core/browser";
import type { PointerLookTarget } from "./pointer.js";
import { controlledMotionValue, resolveRuntimeControl, runtimeAuthoredState } from "./runtime-control.js";
import { SegmentedSpringChain } from "./secondary-motion.js";

interface MotionEvent {
  start: number;
  transition: number;
  hold: number;
  returnDuration: number;
  yaw: number;
  pitch: number;
  roll: number;
}

interface TrackingAxis {
  value: number;
  velocity: number;
}

interface RuntimeHairStrand {
  chain: SegmentedSpringChain;
  role: Extract<SemanticRole, "frontHair" | "backHair" | "sideHair">;
  phase: number;
  order: number;
}

export interface MotionSampleOptions {
  primaryMotion?: boolean;
  lookTarget?: PointerLookTarget;
  runtimeControl?: RuntimeControlSnapshot;
  nowMs?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function stablePhase(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296 * Math.PI * 2;
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function eventValue(event: MotionEvent, time: number, key: "yaw" | "pitch" | "roll", lead = 0): number {
  const local = time - event.start + lead;
  const target = event[key];
  if (local <= 0) return 0;
  if (local < event.transition) return target * smoothstep(local / event.transition);
  if (local < event.transition + event.hold) return target;
  const returning = (local - event.transition - event.hold) / event.returnDuration;
  if (returning < 1) return target * (1 - smoothstep(returning));
  return 0;
}

function makeEvents(seed: number, seconds = 900): MotionEvent[] {
  const random = mulberry32(seed);
  const events: MotionEvent[] = [];
  let cursor = 1.15 + random() * 0.55;
  let index = 0;
  const firstDirection = random() < 0.5 ? -1 : 1;
  while (cursor < seconds) {
    const phraseStep = index % 4;
    const isVertical = phraseStep >= 2;
    const looksUp = phraseStep === 2;
    const direction = phraseStep === 0 ? firstDirection : phraseStep === 1 ? -firstDirection : (random() < 0.5 ? -1 : 1);
    const magnitude = 0.62 + random() * 0.16;
    events.push({
      start: cursor,
      transition: 0.68 + random() * 0.22,
      hold: 0.55 + random() * 0.28,
      returnDuration: 0.88 + random() * 0.24,
      yaw: direction * (isVertical ? 0.08 + random() * 0.08 : magnitude),
      pitch: isVertical ? (looksUp ? -(0.26 + random() * 0.1) : 0.3 + random() * 0.12) : (random() - 0.5) * 0.1,
      roll: direction * (isVertical ? 0.03 + random() * 0.035 : 0.12 + random() * 0.08)
    });
    cursor += 3.6 + random() * 0.65;
    index += 1;
  }
  return events;
}

function advanceTracking(axis: TrackingAxis, target: number, delta: number, response: number, stability: number): void {
  const angularFrequency = 5 + Math.max(0, Math.min(1, response)) * 8;
  const dampingRatio = 0.72 + Math.max(0, Math.min(1, stability)) * 0.38;
  const acceleration = (target - axis.value) * angularFrequency * angularFrequency
    - 2 * dampingRatio * angularFrequency * axis.velocity;
  axis.velocity += acceleration * delta;
  axis.value += axis.velocity * delta;
}

function advanceRateLimited(axis: TrackingAxis, target: number, delta: number, maximumSpeed: number): void {
  const maximumStep = Math.max(0, maximumSpeed) * delta;
  const step = Math.max(-maximumStep, Math.min(maximumStep, target - axis.value));
  axis.velocity = step / delta;
  axis.value += step;
}

function secondaryTuning(project: PuppetLoomProject, part: SecondaryMotionPart): MotionTuning {
  return { amplitude: 1, response: 0.5, stability: 0.5, ...(project.runtime.secondaryMotionTuning?.[part] ?? {}) };
}

function advanceChain(
  chain: SegmentedSpringChain,
  targetX: number,
  targetY: number,
  delta: number,
  tuning: MotionTuning
): void {
  chain.advance(targetX * tuning.amplitude, targetY * tuning.amplitude, delta, tuning);
}

function blinkValue(time: number, seed: number): number {
  const random = mulberry32(seed ^ 0x9e3779b9);
  let cursor = 2 + random() * 2.5;
  while (cursor < time + 0.25) {
    const duration = 0.12 + random() * 0.06;
    if (time >= cursor && time <= cursor + duration) {
      const phase = (time - cursor) / duration;
      return phase < 0.45 ? smoothstep(phase / 0.45) : 1 - smoothstep((phase - 0.45) / 0.55);
    }
    cursor += 3.5 + random() * 3.5;
  }
  return 0;
}

function mouthValue(time: number, seed: number): number {
  const random = mulberry32(seed ^ 0x6a09e667);
  let cursor = 1.45 + random() * 0.85;
  while (cursor <= time + 0.4) {
    const syllableCount = 4 + Math.floor(random() * 4);
    let syllableStart = 0;
    for (let index = 0; index < syllableCount; index += 1) {
      const duration = 0.3 + random() * 0.12;
      const gap = 0.045 + random() * 0.065;
      const peak = 0.48 + random() * 0.52;
      const local = time - cursor - syllableStart;
      if (local >= 0 && local <= duration) {
        const phase = local / duration;
        return peak * (phase < 0.46 ? smoothstep(phase / 0.46) : 1 - smoothstep((phase - 0.46) / 0.54));
      }
      syllableStart += duration + gap;
    }
    cursor += syllableStart + 3.2 + random() * 2.4;
  }
  return 0;
}

function perkEnvelope(phase: number): number {
  if (phase <= 0 || phase >= 1) return 0;
  if (phase < 0.2) return smoothstep(phase / 0.2);
  if (phase < 0.38) return 1;
  return 1 - smoothstep((phase - 0.38) / 0.62);
}

function earTwitchValue(time: number, seed: number): { x: number; y: number } {
  const random = mulberry32(seed ^ 0x3c6ef372);
  let cursor = 1.35 + random() * 1.55;
  while (cursor < time + 0.8) {
    const flapDuration = 0.22 + random() * 0.055;
    const flapCount = 3 + Math.floor(random() * 2);
    const amplitude = 0.016 + random() * 0.004;
    const asymmetry = (random() < 0.5 ? -1 : 1) * (0.0014 + random() * 0.0011);
    const local = time - cursor;
    const eventDuration = flapDuration * flapCount;
    if (local >= 0 && local <= eventDuration) {
      const flapIndex = Math.min(flapCount - 1, Math.floor(local / flapDuration));
      const flapPhase = (local - flapIndex * flapDuration) / flapDuration;
      const lift = perkEnvelope(flapPhase) * (1 - flapIndex * 0.055);
      return { x: asymmetry * lift, y: -amplitude * lift };
    }
    cursor += eventDuration + 4.8 + random() * 4.2;
  }
  return { x: 0, y: 0 };
}

function ahogePerkValue(time: number, seed: number): number {
  const random = mulberry32(seed ^ 0xbb67ae85);
  let cursor = 2.2 + random() * 2.1;
  while (cursor < time + 0.9) {
    const duration = 0.46 + random() * 0.14;
    const amplitude = 0.95 + random() * 0.35;
    const local = time - cursor;
    if (local >= 0 && local <= duration) return perkEnvelope(local / duration) * amplitude;
    cursor += 5.6 + random() * 4.6;
  }
  return 0;
}

export class CalmMotionController {
  readonly project: PuppetLoomProject;
  readonly events: MotionEvent[];
  private lastTime = 0;
  private previousHead = 0;
  private previousPitch = 0;
  private previousRoll = 0;
  private previousBody = 0;
  private readonly trackedYaw: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedPitch: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedRoll: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedBody: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedBodyPitch: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedBodyRoll: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedLookX: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedLookY: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedLookStrength: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedEarX: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedEarY: TrackingAxis = { value: 0, velocity: 0 };
  private readonly frontHairLeft = new SegmentedSpringChain({ segments: 4, stiffness: 31, damping: 10.2, propagation: 1.08, maxDisplacement: 0.075 });
  private readonly frontHairRight = new SegmentedSpringChain({ segments: 4, stiffness: 28, damping: 9.4, propagation: 1.1, maxDisplacement: 0.075 });
  private readonly backHairLeft = new SegmentedSpringChain({ segments: 5, stiffness: 23, damping: 7.4, propagation: 1.09, maxDisplacement: 0.105 });
  private readonly backHairRight = new SegmentedSpringChain({ segments: 5, stiffness: 21, damping: 6.9, propagation: 1.11, maxDisplacement: 0.105 });
  private readonly ahoge = new SegmentedSpringChain({ segments: 5, stiffness: 19, damping: 5.6, propagation: 1.12, maxDisplacement: 0.14 });
  private readonly headwear = new SegmentedSpringChain({ segments: 3, stiffness: 36, damping: 11.4, propagation: 1.04, maxDisplacement: 0.045 });
  private readonly topCloth = new SegmentedSpringChain({ segments: 3, stiffness: 24, damping: 8.6, propagation: 1.06, maxDisplacement: 0.055 });
  private readonly skirt = new SegmentedSpringChain({ segments: 4, stiffness: 18, damping: 7, propagation: 1.09, maxDisplacement: 0.09 });
  private readonly tail = new SegmentedSpringChain({ segments: 5, stiffness: 18, damping: 6.8, propagation: 1.09, maxDisplacement: 0.11 });
  private readonly accessory = new SegmentedSpringChain({ segments: 4, stiffness: 11, damping: 4.9, propagation: 1.1, maxDisplacement: 0.09 });
  private readonly hairStrandChains = new Map<string, RuntimeHairStrand>();
  private readonly modelPhysics: ModelPhysicsController;

  constructor(project: PuppetLoomProject) {
    this.project = project;
    this.events = makeEvents(project.runtime.seed);
    this.modelPhysics = new ModelPhysicsController(project);
    for (const layer of project.layers ?? []) {
      if (layer.role !== "frontHair" && layer.role !== "backHair" && layer.role !== "sideHair") continue;
      for (const [order, strand] of (layer.hairStrands ?? []).entries()) {
        this.hairStrandChains.set(strand.id, {
          chain: new SegmentedSpringChain({
            segments: strand.physics.segments,
            stiffness: strand.physics.stiffness,
            damping: strand.physics.damping,
            propagation: layer.role === "frontHair" ? 1.08 : 1.11,
            maxDisplacement: strand.physics.maxDisplacement
          }),
          role: layer.role,
          phase: stablePhase(strand.id),
          order
        });
      }
    }
  }

  reset(): void {
    this.lastTime = 0;
    this.previousHead = 0;
    this.previousPitch = 0;
    this.previousRoll = 0;
    this.previousBody = 0;
    for (const axis of [this.trackedYaw, this.trackedPitch, this.trackedRoll, this.trackedBody, this.trackedBodyPitch, this.trackedBodyRoll, this.trackedLookX, this.trackedLookY, this.trackedLookStrength, this.trackedEarX, this.trackedEarY]) {
      axis.value = 0;
      axis.velocity = 0;
    }
    for (const chain of [this.frontHairLeft, this.frontHairRight, this.backHairLeft, this.backHairRight, this.ahoge, this.headwear, this.topCloth, this.skirt, this.tail, this.accessory]) chain.reset();
    for (const strand of this.hairStrandChains.values()) strand.chain.reset();
    this.modelPhysics.reset();
  }

  sample(timeSeconds: number, options: MotionSampleOptions = {}): MotionState {
    const primaryMotion = options.primaryMotion ?? true;
    const active = primaryMotion ? this.events.find((event) => timeSeconds >= event.start - 0.42 && timeSeconds <= event.start + event.transition + event.hold + event.returnDuration) : undefined;
    const phase = (this.project.runtime.seed % 97) / 97 * Math.PI * 2;
    const microYaw = primaryMotion ? Math.sin(timeSeconds * 0.55 + phase) * 0.018 + Math.sin(timeSeconds * 0.19 + phase * 0.7) * 0.012 : 0;
    const microPitch = primaryMotion ? Math.sin(timeSeconds * 0.37 + phase * 1.3) * 0.01 : 0;
    const microRoll = primaryMotion ? Math.sin(timeSeconds * 0.29 + phase * 0.45) * 0.008 : 0;
    const tuning = this.project.runtime.motionTuning ?? { amplitude: 1, response: 0.72, stability: 0.42 };
    const delta = this.lastTime === 0 ? 1 / 60 : Math.max(1 / 240, Math.min(0.05, timeSeconds - this.lastTime));
    this.lastTime = timeSeconds;
    const runtimeControl = resolveRuntimeControl(options.runtimeControl, options.nowMs ?? Date.now());
    const controlled = (key: Parameters<typeof controlledMotionValue>[1], base: number): number => controlledMotionValue(base, key, runtimeControl);

    const recordedLookTarget = runtimeControl.motion.lookTargetStrength === undefined
      ? undefined
      : {
          x: runtimeControl.motion.lookTargetX ?? 0,
          y: runtimeControl.motion.lookTargetY ?? 0,
          strength: runtimeControl.motion.lookTargetStrength
        };
    const lookTarget = primaryMotion ? recordedLookTarget ?? options.lookTarget : undefined;
    advanceTracking(this.trackedLookX, Math.max(-1, Math.min(1, lookTarget?.x ?? 0)), delta, 1, 0.72);
    advanceTracking(this.trackedLookY, Math.max(-1, Math.min(1, lookTarget?.y ?? 0)), delta, 1, 0.72);
    advanceTracking(this.trackedLookStrength, Math.max(0, Math.min(1, lookTarget?.strength ?? 0)), delta, 1, 0.82);
    const lookStrength = Math.max(0, Math.min(1, this.trackedLookStrength.value));
    const autonomousYaw = ((active ? eventValue(active, timeSeconds, "yaw") : 0) + microYaw) * tuning.amplitude;
    const autonomousPitch = ((active ? eventValue(active, timeSeconds, "pitch") : 0) + microPitch) * tuning.amplitude;
    const autonomousRoll = ((active ? eventValue(active, timeSeconds, "roll") : 0) + microRoll) * tuning.amplitude;
    const pointerYaw = this.trackedLookX.value * 0.92 * tuning.amplitude;
    const pointerPitch = this.trackedLookY.value * 0.96 * tuning.amplitude;
    const pointerRoll = this.trackedLookX.value * 0.1 * tuning.amplitude;
    // Pointer tracking is an interactive layer, not a replacement for the
    // character's idle performance. Keeping part of the autonomous pose alive
    // prevents a stationary cursor from freezing the entire head.
    const pointerDistance = Math.max(Math.abs(this.trackedLookX.value), Math.abs(this.trackedLookY.value));
    const autonomousRetention = 1 - lookStrength * Math.min(1, 0.65 + pointerDistance * 0.35);
    const desiredYaw = controlled("headYaw", Math.max(-1, Math.min(1, autonomousYaw * autonomousRetention + (pointerYaw + microYaw * 0.2) * lookStrength)));
    const desiredPitch = controlled("headPitch", Math.max(-1, Math.min(1, autonomousPitch * autonomousRetention + (pointerPitch + microPitch * 0.18) * lookStrength)));
    const desiredRoll = controlled("headRoll", Math.max(-1, Math.min(1, autonomousRoll * autonomousRetention + (pointerRoll + microRoll * 0.24) * lookStrength)));
    const autonomousGazeX = ((active ? eventValue(active, timeSeconds, "yaw", 0.38) * 1.25 : 0) + microYaw * 0.7) * tuning.amplitude;
    const autonomousGazeY = ((active ? eventValue(active, timeSeconds, "pitch", 0.32) * 1.05 : 0) + microPitch * 0.55) * tuning.amplitude;
    const gazeTargetX = controlled("gazeX", autonomousGazeX * autonomousRetention + this.trackedLookX.value * 1.1 * tuning.amplitude * lookStrength);
    const gazeTargetY = controlled("gazeY", autonomousGazeY * autonomousRetention + this.trackedLookY.value * 0.92 * tuning.amplitude * lookStrength);

    advanceTracking(this.trackedYaw, desiredYaw, delta, tuning.response, tuning.stability);
    advanceTracking(this.trackedPitch, desiredPitch, delta, tuning.response, tuning.stability);
    advanceTracking(this.trackedRoll, desiredRoll, delta, tuning.response, tuning.stability);
    const yaw = Math.max(-1, Math.min(1, this.trackedYaw.value));
    const pitch = Math.max(-1, Math.min(1, this.trackedPitch.value));
    const roll = Math.max(-1, Math.min(1, this.trackedRoll.value));
    const gazeX = gazeTargetX - yaw * 0.55;
    const gazeY = gazeTargetY - pitch * 0.42;

    for (const [axis, target] of [
      [this.trackedBody, controlled("bodySway", yaw * 0.62)],
      [this.trackedBodyPitch, controlled("bodyPitch", pitch * 0.46)],
      [this.trackedBodyRoll, controlled("bodyRoll", roll * 0.52 + yaw * 0.16)]
    ] as const) {
      advanceRateLimited(axis, target, delta, 3);
    }

    const headVelocity = Math.max(-2.5, Math.min(2.5, (yaw - this.previousHead) / delta));
    const pitchVelocity = Math.max(-2.5, Math.min(2.5, (pitch - this.previousPitch) / delta));
    const rollVelocity = Math.max(-2.5, Math.min(2.5, (roll - this.previousRoll) / delta));
    const bodyVelocity = Math.max(-1.2, Math.min(1.2, (this.trackedBody.value - this.previousBody) / delta));
    this.previousHead = yaw;
    this.previousPitch = pitch;
    this.previousRoll = roll;
    this.previousBody = this.trackedBody.value;
    const lateralVelocity = headVelocity + rollVelocity * 0.18;
    const frontHairWind = Math.sin(timeSeconds * 0.81 + phase * 0.63) * 0.34 + Math.sin(timeSeconds * 0.29 + phase * 1.17) * 0.14;
    const frontHairLift = Math.sin(timeSeconds * 0.67 + phase * 1.46) * 0.15 + Math.sin(timeSeconds * 0.24 + phase * 0.55) * 0.06;
    const ahogeWind = Math.sin(timeSeconds * 1.07 + phase * 1.41) * 0.34 + Math.sin(timeSeconds * 0.43 + phase * 0.38) * 0.16;
    const ahogePerk = ahogePerkValue(timeSeconds, this.project.runtime.seed);
    const backHairWind = Math.sin(timeSeconds * 0.68 + phase * 0.92 + Math.PI) * 0.29 + Math.sin(timeSeconds * 0.33 + phase * 1.58) * 0.13;
    const backHairLift = Math.sin(timeSeconds * 0.56 + phase * 0.27) * 0.11;
    const headwearWobble = Math.sin(timeSeconds * 0.39 + phase * 1.73) * 0.055;
    const earTwitch = earTwitchValue(timeSeconds, this.project.runtime.seed);
    const clothWind = Math.sin(timeSeconds * 0.36 + phase * 1.09) * 0.19;
    const tailWind = Math.sin(timeSeconds * 0.27 + phase * 1.87) * 0.14 + Math.sin(timeSeconds * 0.62 + phase * 0.52) * 0.05;
    const accessoryWind = Math.sin(timeSeconds * 0.66 + phase * 1.31) * 0.09;
    const hairLateral = headVelocity * 0.6 + bodyVelocity * 0.4 + rollVelocity * 0.18;
    const hairVertical = pitchVelocity * 0.6 + this.trackedBodyPitch.velocity * 0.4;
    const frontTargetX = -hairLateral * 0.02 + frontHairWind * 0.027;
    const frontTargetY = -hairVertical * 0.013 + frontHairLift * 0.019;
    const frontTuning = secondaryTuning(this.project, "frontHair");
    advanceChain(this.frontHairLeft, frontTargetX + Math.sin(timeSeconds * 0.53 + phase * 1.91) * 0.0045, frontTargetY, delta, frontTuning);
    advanceChain(this.frontHairRight, frontTargetX + Math.sin(timeSeconds * 0.61 + phase * 0.31) * 0.004, frontTargetY * 0.92, delta, frontTuning);

    const backTargetX = -hairLateral * 0.034 + backHairWind * 0.072;
    const backTargetY = -hairVertical * 0.023 + backHairLift * 0.028;
    const backTuning = secondaryTuning(this.project, "backHair");
    advanceChain(this.backHairLeft, backTargetX + Math.sin(timeSeconds * 0.33 + phase * 0.43) * 0.008, backTargetY, delta, backTuning);
    advanceChain(this.backHairRight, backTargetX + Math.sin(timeSeconds * 0.41 + phase * 1.37) * 0.0075, backTargetY * 1.06, delta, backTuning);

    for (const strand of this.hairStrandChains.values()) {
      const front = strand.role === "frontHair";
      const baseX = front ? frontTargetX : backTargetX;
      const baseY = front ? frontTargetY : backTargetY;
      const independentWind = Math.sin(timeSeconds * (0.47 + strand.order * 0.037) + strand.phase) * (front ? 0.006 : 0.012)
        + Math.sin(timeSeconds * 0.23 + strand.phase * 0.61) * (front ? 0.0025 : 0.005);
      const independentLift = Math.sin(timeSeconds * (0.39 + strand.order * 0.021) + strand.phase * 1.19) * (front ? 0.0024 : 0.0045);
      advanceChain(
        strand.chain,
        baseX + independentWind,
        baseY + independentLift,
        delta,
        secondaryTuning(this.project, front ? "frontHair" : "backHair")
      );
    }

    advanceChain(this.ahoge,
      -hairLateral * 0.026 + ahogeWind * 0.1,
      -hairVertical * 0.011 + frontHairLift * 0.016 - ahogePerk * 0.08,
      delta,
      secondaryTuning(this.project, "ahoge")
    );
    advanceChain(this.headwear,
      -(headVelocity * 0.4 + bodyVelocity * 0.6 + rollVelocity * 0.28) * 0.01 + headwearWobble * 0.016,
      -(pitchVelocity * 0.4 + this.trackedBodyPitch.velocity * 0.6) * 0.006,
      delta,
      secondaryTuning(this.project, "headwear")
    );
    const bodyLateral = bodyVelocity + this.trackedBodyRoll.velocity * 0.35;
    const bodyVertical = this.trackedBodyPitch.velocity;
    advanceChain(this.topCloth, -bodyLateral * 0.021 + clothWind * 0.032, -bodyVertical * 0.008, delta, secondaryTuning(this.project, "topCloth"));
    const skirtSway = Math.sin(timeSeconds * 0.95 + phase * 0.74) * 0.25 + Math.sin(timeSeconds * 1.65 + phase * 0.29) * 0.07;
    const supportedSkirt = this.project.layers?.some((layer) => layer.role === "bottomWear" && layer.garmentStructure === "supported") ?? false;
    advanceChain(
      this.skirt,
      -bodyLateral * (supportedSkirt ? 0.032 : 0.031) + skirtSway * (supportedSkirt ? 0.085 : 0.115),
      -bodyVertical * (supportedSkirt ? 0.007 : 0.008),
      delta,
      secondaryTuning(this.project, "skirt")
    );
    const tailSwing = Math.sin(timeSeconds * 1.35 + phase * 0.76) * 0.056 + Math.sin(timeSeconds * 0.63 + phase * 1.32) * 0.012;
    advanceChain(this.tail, -bodyLateral * 0.01 + tailWind * 0.008, -bodyVertical * 0.015 + tailSwing, delta, secondaryTuning(this.project, "tail"));
    advanceChain(this.accessory, -hairLateral * 0.023 + accessoryWind * 0.028, -hairVertical * 0.014 + Math.sin(timeSeconds * 0.51 + phase * 1.61) * 0.008, delta, secondaryTuning(this.project, "accessory"));
    const configuredEarTuning = this.project.runtime.secondaryMotionTuning?.ears;
    if (configuredEarTuning) {
      const earTuning = secondaryTuning(this.project, "ears");
      advanceTracking(this.trackedEarX, earTwitch.x * earTuning.amplitude, delta, earTuning.response, earTuning.stability);
      advanceTracking(this.trackedEarY, earTwitch.y * earTuning.amplitude, delta, earTuning.response, earTuning.stability);
    } else {
      this.trackedEarX.value = earTwitch.x;
      this.trackedEarY.value = earTwitch.y;
      this.trackedEarX.velocity = 0;
      this.trackedEarY.velocity = 0;
    }

    const secondary = {
      frontHairLeft: this.frontHairLeft.sample(),
      frontHairRight: this.frontHairRight.sample(),
      backHairLeft: this.backHairLeft.sample(),
      backHairRight: this.backHairRight.sample(),
      ahoge: this.ahoge.sample(),
      headwear: this.headwear.sample(),
      topCloth: this.topCloth.sample(),
      skirt: this.skirt.sample(),
      tail: this.tail.sample(),
      accessory: this.accessory.sample(),
      hairStrands: Object.fromEntries([...this.hairStrandChains].map(([id, strand]) => [id, strand.chain.sample()]))
    };
    const tip = (values: number[]): number => values.at(-1) ?? 0;
    const pairTip = (left: number[], right: number[]): number => (tip(left) + tip(right)) * 0.5;

    const breathPeriod = 5.1 + ((this.project.runtime.seed % 17) / 17) * 0.7;
    const breathPhase = (timeSeconds / breathPeriod) * Math.PI * 2 - Math.PI * 0.5;
    const breath = controlled("breath", Math.max(-1, Math.min(1, Math.sin(breathPhase) * 0.86 + Math.sin(breathPhase * 0.5 + phase) * 0.1)));

    return this.modelPhysics.sample({
      headYaw: yaw,
      headPitch: pitch,
      headRoll: roll,
      bodySway: this.trackedBody.value,
      bodyPitch: this.trackedBodyPitch.value,
      bodyRoll: this.trackedBodyRoll.value,
      gazeX: this.project.runtime.features.gaze ? gazeX : 0,
      gazeY: this.project.runtime.features.gaze ? gazeY : 0,
      breath,
      hairX: this.project.runtime.features.hairPhysics ? pairTip(secondary.frontHairLeft.x, secondary.frontHairRight.x) : 0,
      hairY: this.project.runtime.features.hairPhysics ? pairTip(secondary.frontHairLeft.y, secondary.frontHairRight.y) : 0,
      ahogeX: this.project.runtime.features.hairPhysics ? tip(secondary.ahoge.x) : 0,
      ahogeY: this.project.runtime.features.hairPhysics ? tip(secondary.ahoge.y) : 0,
      backHairX: this.project.runtime.features.hairPhysics ? pairTip(secondary.backHairLeft.x, secondary.backHairRight.x) : 0,
      backHairY: this.project.runtime.features.hairPhysics ? pairTip(secondary.backHairLeft.y, secondary.backHairRight.y) : 0,
      headwearX: this.project.runtime.features.hairPhysics ? tip(secondary.headwear.x) : 0,
      headwearY: this.project.runtime.features.hairPhysics ? tip(secondary.headwear.y) : 0,
      earX: this.project.runtime.features.hairPhysics ? this.trackedEarX.value : 0,
      earY: this.project.runtime.features.hairPhysics ? this.trackedEarY.value : 0,
      clothX: this.project.runtime.features.hairPhysics ? tip(secondary.skirt.x) : 0,
      clothY: this.project.runtime.features.hairPhysics ? tip(secondary.skirt.y) : 0,
      tailX: this.project.runtime.features.hairPhysics ? tip(secondary.tail.x) : 0,
      tailY: this.project.runtime.features.hairPhysics ? tip(secondary.tail.y) : 0,
      accessoryX: this.project.runtime.features.hairPhysics ? tip(secondary.accessory.x) : 0,
      accessoryY: this.project.runtime.features.hairPhysics ? tip(secondary.accessory.y) : 0,
      ...(this.project.runtime.features.hairPhysics ? { secondary } : {}),
      blink: controlled("blink", this.project.runtime.features.blink ? blinkValue(timeSeconds, this.project.runtime.seed) : 0),
      mouthOpen: controlled("mouthOpen", this.project.runtime.features.mouthMotion ? mouthValue(timeSeconds, this.project.runtime.seed) : 0),
      ...runtimeAuthoredState(this.project, runtimeControl),
      timeSeconds
    }, timeSeconds);
  }
}
