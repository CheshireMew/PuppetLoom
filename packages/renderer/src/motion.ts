import type { MotionState, PuppetLoomProject } from "@puppetloom/core/browser";

interface MotionEvent {
  start: number;
  transition: number;
  hold: number;
  returnDuration: number;
  yaw: number;
  pitch: number;
  roll: number;
}

interface SpringState {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

interface TrackingAxis {
  value: number;
  velocity: number;
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
  let cursor = 1.8 + random() * 0.8;
  let index = 0;
  while (cursor < seconds) {
    const direction = random() < 0.5 ? -1 : 1;
    const magnitude = 0.55 + random() * 0.23;
    const isVertical = index > 0 && index % 3 === 2;
    const looksUp = isVertical && index % 6 === 5;
    events.push({
      start: cursor,
      transition: 0.9 + random() * 0.3,
      hold: 1.05 + random() * 0.45,
      returnDuration: 1.25 + random() * 0.35,
      yaw: direction * (isVertical ? 0.16 + random() * 0.12 : magnitude),
      pitch: isVertical ? (looksUp ? -(0.14 + random() * 0.08) : 0.24 + random() * 0.14) : (random() - 0.5) * 0.16,
      roll: direction * (isVertical ? 0.04 + random() * 0.04 : 0.1 + random() * 0.12)
    });
    cursor += 5.4 + random() * 1.8;
    index += 1;
  }
  return events;
}

function advanceSpring(
  spring: SpringState,
  inputVelocityX: number,
  inputVelocityY: number,
  delta: number,
  stiffness: number,
  damping: number,
  coupling: number
): void {
  const accelerationX = -stiffness * spring.x - damping * spring.velocityX - inputVelocityX * coupling;
  const accelerationY = -stiffness * spring.y - damping * spring.velocityY - inputVelocityY * coupling;
  spring.velocityX += accelerationX * delta;
  spring.velocityY += accelerationY * delta;
  spring.x += spring.velocityX * delta;
  spring.y += spring.velocityY * delta;
}

function advanceTracking(axis: TrackingAxis, target: number, delta: number, response: number, stability: number): void {
  const angularFrequency = 5 + Math.max(0, Math.min(1, response)) * 8;
  const dampingRatio = 0.72 + Math.max(0, Math.min(1, stability)) * 0.38;
  const acceleration = (target - axis.value) * angularFrequency * angularFrequency
    - 2 * dampingRatio * angularFrequency * axis.velocity;
  axis.velocity += acceleration * delta;
  axis.value += axis.velocity * delta;
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
  let cursor = 2.2 + random() * 1.2;
  while (cursor <= time) {
    const duration = 1.2 + random() * 0.3;
    const peak = 0.94 + random() * 0.06;
    if (time <= cursor + duration) {
      const phase = (time - cursor) / duration;
      if (phase < 0.3) return peak * smoothstep(phase / 0.3);
      if (phase < 0.5) return peak;
      return peak * (1 - smoothstep((phase - 0.5) / 0.5));
    }
    cursor += 5.8 + random() * 3;
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
  private readonly trackedYaw: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedPitch: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedRoll: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedBody: TrackingAxis = { value: 0, velocity: 0 };
  private readonly trackedBodyRoll: TrackingAxis = { value: 0, velocity: 0 };
  private readonly frontHair: SpringState = { x: 0, y: 0, velocityX: 0, velocityY: 0 };
  private readonly backHair: SpringState = { x: 0, y: 0, velocityX: 0, velocityY: 0 };
  private readonly ear: SpringState = { x: 0, y: 0, velocityX: 0, velocityY: 0 };
  private readonly accessory: SpringState = { x: 0, y: 0, velocityX: 0, velocityY: 0 };

  constructor(project: PuppetLoomProject) {
    this.project = project;
    this.events = makeEvents(project.runtime.seed);
  }

  reset(): void {
    this.lastTime = 0;
    this.previousHead = 0;
    this.previousPitch = 0;
    this.previousRoll = 0;
    for (const axis of [this.trackedYaw, this.trackedPitch, this.trackedRoll, this.trackedBody, this.trackedBodyRoll]) {
      axis.value = 0;
      axis.velocity = 0;
    }
    for (const spring of [this.frontHair, this.backHair, this.ear, this.accessory]) {
      spring.x = 0;
      spring.y = 0;
      spring.velocityX = 0;
      spring.velocityY = 0;
    }
  }

  sample(timeSeconds: number): MotionState {
    const active = this.events.find((event) => timeSeconds >= event.start - 0.42 && timeSeconds <= event.start + event.transition + event.hold + event.returnDuration);
    const phase = (this.project.runtime.seed % 97) / 97 * Math.PI * 2;
    const microYaw = Math.sin(timeSeconds * 0.55 + phase) * 0.018 + Math.sin(timeSeconds * 0.19 + phase * 0.7) * 0.012;
    const microPitch = Math.sin(timeSeconds * 0.37 + phase * 1.3) * 0.01;
    const microRoll = Math.sin(timeSeconds * 0.29 + phase * 0.45) * 0.008;
    const tuning = this.project.runtime.motionTuning ?? { amplitude: 1, response: 0.72, stability: 0.42 };
    const desiredYaw = Math.max(-1, Math.min(1, ((active ? eventValue(active, timeSeconds, "yaw") : 0) + microYaw) * tuning.amplitude));
    const desiredPitch = Math.max(-1, Math.min(1, ((active ? eventValue(active, timeSeconds, "pitch") : 0) + microPitch) * tuning.amplitude));
    const desiredRoll = Math.max(-1, Math.min(1, ((active ? eventValue(active, timeSeconds, "roll") : 0) + microRoll) * tuning.amplitude));
    const gazeTargetX = ((active ? eventValue(active, timeSeconds, "yaw", 0.38) * 1.25 : 0) + microYaw * 0.7) * tuning.amplitude;
    const gazeTargetY = ((active ? eventValue(active, timeSeconds, "pitch", 0.32) * 1.05 : 0) + microPitch * 0.55) * tuning.amplitude;
    const delta = this.lastTime === 0 ? 1 / 60 : Math.max(1 / 240, Math.min(0.05, timeSeconds - this.lastTime));
    this.lastTime = timeSeconds;

    advanceTracking(this.trackedYaw, desiredYaw, delta, tuning.response, tuning.stability);
    advanceTracking(this.trackedPitch, desiredPitch, delta, tuning.response, tuning.stability);
    advanceTracking(this.trackedRoll, desiredRoll, delta, tuning.response, tuning.stability);
    const yaw = Math.max(-1, Math.min(1, this.trackedYaw.value));
    const pitch = Math.max(-1, Math.min(1, this.trackedPitch.value));
    const roll = Math.max(-1, Math.min(1, this.trackedRoll.value));
    const gazeX = gazeTargetX - yaw * 0.55;
    const gazeY = gazeTargetY - pitch * 0.42;

    advanceTracking(this.trackedBody, yaw * 0.38, delta, 0, Math.min(1, tuning.stability + 0.35));
    advanceTracking(this.trackedBodyRoll, roll * 0.4, delta, 0, Math.min(1, tuning.stability + 0.35));

    const headVelocity = Math.max(-2.5, Math.min(2.5, (yaw - this.previousHead) / delta));
    const pitchVelocity = Math.max(-2.5, Math.min(2.5, (pitch - this.previousPitch) / delta));
    const rollVelocity = Math.max(-2.5, Math.min(2.5, (roll - this.previousRoll) / delta));
    this.previousHead = yaw;
    this.previousPitch = pitch;
    this.previousRoll = roll;
    const lateralVelocity = headVelocity + rollVelocity * 0.18;
    advanceSpring(this.frontHair, lateralVelocity, pitchVelocity, delta, 28, 9.5, 0.3);
    advanceSpring(this.backHair, lateralVelocity, pitchVelocity, delta, 16, 6.7, 0.48);
    advanceSpring(this.ear, lateralVelocity, pitchVelocity, delta, 22, 7.8, 0.4);
    advanceSpring(this.accessory, lateralVelocity, pitchVelocity, delta, 8.5, 4.6, 0.68);

    const breathPeriod = 5.1 + ((this.project.runtime.seed % 17) / 17) * 0.7;
    const breath = Math.sin((timeSeconds / breathPeriod) * Math.PI * 2 - Math.PI * 0.5);

    return {
      headYaw: yaw,
      headPitch: pitch,
      headRoll: roll,
      bodySway: this.trackedBody.value,
      bodyRoll: this.trackedBodyRoll.value,
      gazeX: this.project.runtime.features.gaze ? gazeX : 0,
      gazeY: this.project.runtime.features.gaze ? gazeY : 0,
      breath,
      hairX: this.project.runtime.features.hairPhysics ? this.frontHair.x : 0,
      hairY: this.project.runtime.features.hairPhysics ? this.frontHair.y : 0,
      backHairX: this.project.runtime.features.hairPhysics ? this.backHair.x : 0,
      backHairY: this.project.runtime.features.hairPhysics ? this.backHair.y : 0,
      earX: this.project.runtime.features.hairPhysics ? this.ear.x : 0,
      earY: this.project.runtime.features.hairPhysics ? this.ear.y : 0,
      accessoryX: this.project.runtime.features.hairPhysics ? this.accessory.x : 0,
      accessoryY: this.project.runtime.features.hairPhysics ? this.accessory.y : 0,
      blink: this.project.runtime.features.blink ? blinkValue(timeSeconds, this.project.runtime.seed) : 0,
      mouthOpen: this.project.runtime.features.mouthMotion ? mouthValue(timeSeconds, this.project.runtime.seed) : 0
    };
  }
}
