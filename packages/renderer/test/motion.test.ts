import type { PuppetLoomProject } from "@puppetloom/core/browser";
import { describe, expect, it } from "vitest";
import { CalmMotionController } from "../src/motion.js";
import { layersInRenderOrder, opacityFor } from "../src/renderer.js";

function fixtureProject(seed = 42, mouthMotion = false): PuppetLoomProject {
  return {
    runtime: {
      seed,
      profile: "calm-v1",
      features: { headTurn: true, bodyFollow: true, gaze: true, hairPhysics: true, blink: false, mouthMotion },
      envelope: { headYaw: 0.12, headPitch: 0.08, headRollDegrees: 4, bodySway: 0.02, bodyRollDegrees: 2, breath: 0.018, gazeX: 0.2, gazeY: 0.12, globalScale: 1 }
    }
  } as PuppetLoomProject;
}

describe("calm autonomous timeline", () => {
  it("is deterministic for one project seed", () => {
    const project = fixtureProject();
    const left = new CalmMotionController(project);
    const right = new CalmMotionController(project);
    const times = Array.from({ length: 360 }, (_, index) => index / 60);
    expect(times.map((time) => left.sample(time))).toEqual(times.map((time) => right.sample(time)));
  });

  it("keeps mouth motion disabled and uses correlated movement", () => {
    const project = fixtureProject();
    const controller = new CalmMotionController(project);
    const states = Array.from({ length: 1200 }, (_, index) => controller.sample(index / 60));
    expect(project.runtime.features.mouthMotion).toBe(false);
    expect(states.some((state) => Math.abs(state.headYaw) > 0.5)).toBe(true);
    expect(states.some((state) => Math.abs(state.bodySway) > 0.01)).toBe(true);
    expect(states.every((state) => Number.isFinite(state.hairX))).toBe(true);
    expect(states.every((state) => Number.isFinite(state.ahogeX) && Number.isFinite(state.backHairX) && Number.isFinite(state.headwearX) && Number.isFinite(state.earX))).toBe(true);
    expect(states.every((state) => Number.isFinite(state.clothX) && Number.isFinite(state.tailX) && Number.isFinite(state.accessoryX))).toBe(true);
    expect(states.some((state) => Math.abs(state.hairX - state.backHairX) > 0.001)).toBe(true);
    expect(states.some((state) => Math.abs(state.hairX - state.earX) > 0.001)).toBe(true);
    expect(states.some((state) => Math.abs(state.headwearX - state.earX) > 0.0001)).toBe(true);
    expect(states.some((state) => Math.abs(state.backHairX - state.accessoryX) > 0.001)).toBe(true);
    expect(states.some((state) => Math.abs(state.ahogeX - state.hairX) > 0.001)).toBe(true);
    expect(states.some((state) => Math.abs(state.tailX - state.clothX) > 0.001)).toBe(true);
    expect(states.every((state) => state.secondary?.frontHairLeft.x.length === 4)).toBe(true);
    expect(states.every((state) => state.secondary?.backHairLeft.x.length === 5)).toBe(true);
    expect(states.some((state) => state.secondary!.frontHairLeft.x.some((value, index) => Math.abs(value - state.secondary!.frontHairLeft.x[0]!) > 0.0001 && index > 0))).toBe(true);
    expect(states.some((state) => Math.abs(state.secondary!.frontHairLeft.x.at(-1)! - state.secondary!.frontHairRight.x.at(-1)!) > 0.0001)).toBe(true);
    expect(states.every((state) => Math.abs(state.headYaw) <= 1 && Math.abs(state.headPitch) <= 1)).toBe(true);
    expect(states.some((state) => state.headPitch > 0.12)).toBe(true);
    const frameSteps = states.slice(1).map((state, index) => Math.abs(state.headYaw - states[index]!.headYaw));
    expect(Math.max(...frameSteps)).toBeLessThan(0.04);
    const bodySteps = states.slice(1).map((state, index) => Math.abs(state.bodySway - states[index]!.bodySway));
    expect(Math.max(...bodySteps)).toBeLessThan(Math.max(...frameSteps));
    const peakTurn = states.reduce((peak, state) => Math.abs(state.headYaw) > Math.abs(peak.headYaw) ? state : peak, states[0]!);
    expect(Math.sign(peakTurn.gazeX)).toBe(Math.sign(peakTurn.headYaw));
    expect(Math.abs(peakTurn.gazeX)).toBeLessThan(0.8);
  });

  it("keeps secondary parts gently moving between deliberate head turns", () => {
    const controller = new CalmMotionController(fixtureProject());
    const states = Array.from({ length: 105 }, (_, index) => controller.sample(index / 60));
    expect(Math.max(...states.map((state) => Math.abs(state.hairX)))).toBeGreaterThan(0.003);
    expect(Math.max(...states.map((state) => Math.abs(state.backHairX)))).toBeGreaterThan(0.006);
    expect(Math.max(...states.map((state) => Math.abs(state.ahogeX)))).toBeGreaterThan(0.008);
    expect(Math.max(...states.map((state) => Math.abs(state.ahogeY)))).toBeGreaterThan(0.0004);
    expect(states.some((state) => Math.abs(state.clothX) > 0.001)).toBe(true);
    expect(states.some((state) => Math.abs(state.tailY) > 0.001)).toBe(true);
    expect(states.filter((state) => state.hairX * state.backHairX < 0)).toHaveLength(states.length);
    expect(Math.max(...states.map((state) => Math.abs(state.tailY)))).toBeLessThan(0.08);
  });

  it("does not drive every attached part with the same phase and direction", () => {
    const controller = new CalmMotionController(fixtureProject());
    const states = Array.from({ length: 900 }, (_, index) => controller.sample(index / 60));
    const differsInDirection = (left: keyof typeof states[number], right: keyof typeof states[number]) =>
      states.some((state) => Number(state[left]) * Number(state[right]) < -1e-7);
    expect(differsInDirection("hairX", "backHairX")).toBe(true);
    expect(differsInDirection("ahogeX", "headwearX")).toBe(true);
    expect(differsInDirection("earY", "clothY")).toBe(true);
    expect(differsInDirection("tailY", "clothX")).toBe(true);
  });

  it("keeps breeze and ahoge sway alive while primary motion is frozen, but triggers ears in occasional multi-flap bursts", () => {
    const controller = new CalmMotionController(fixtureProject());
    const states = Array.from({ length: 720 }, (_, index) => controller.sample(index / 60, { primaryMotion: false }));
    expect(states.every((state) => state.headYaw === 0 && state.headPitch === 0 && state.headRoll === 0)).toBe(true);
    expect(states.every((state) => state.bodySway === 0 && state.bodyRoll === 0)).toBe(true);
    expect(Math.max(...states.map((state) => Math.abs(state.hairX)))).toBeGreaterThan(0.004);
    expect(Math.max(...states.map((state) => Math.abs(state.backHairX)))).toBeGreaterThan(0.008);
    expect(Math.max(...states.map((state) => Math.abs(state.ahogeX)))).toBeGreaterThan(0.01);
    expect(Math.max(...states.map((state) => Math.abs(state.ahogeY)))).toBeGreaterThan(0.01);
    expect(states.filter((state) => Math.abs(state.ahogeY) > 0.01).length / states.length).toBeLessThan(0.35);
    expect(Math.max(...states.map((state) => Math.abs(state.earY)))).toBeGreaterThan(0.008);
    const activeEars = states.map((state) => Math.abs(state.earY) > 0.0001);
    expect(activeEars.filter(Boolean).length / states.length).toBeLessThan(0.3);
    expect(activeEars.some((active, index) => active && !activeEars[index - 1])).toBe(true);
    expect(states.some((state) => state.earY === 0 && state.earX === 0)).toBe(true);
    const strongEars = states.map((state) => Math.abs(state.earY) > 0.008);
    const strongFlapStarts = strongEars.filter((active, index) => active && !strongEars[index - 1]).length;
    expect(strongFlapStarts).toBeGreaterThanOrEqual(6);
  });

  it("moves the gaze before the head and lets the body follow later", () => {
    const controller = new CalmMotionController(fixtureProject());
    const first = controller.events[0]!;
    const gazeLead = controller.sample(first.start - 0.2);
    expect(Math.abs(gazeLead.gazeX)).toBeGreaterThan(0);
    expect(Math.abs(gazeLead.gazeX)).toBeGreaterThan(Math.abs(gazeLead.headYaw) * 2);

    controller.reset();
    const duringTurn = controller.sample(first.start + first.transition * 0.55);
    expect(Math.abs(duringTurn.headYaw)).toBeGreaterThan(Math.abs(duringTurn.bodySway));
  });

  it("follows a pointer with gaze first, head second, and body last", () => {
    const controller = new CalmMotionController(fixtureProject());
    const target = { x: 0.9, y: -0.7, strength: 1 };
    const states = Array.from({ length: 180 }, (_, index) => controller.sample(index / 60, { lookTarget: target }));
    expect(states[8]!.gazeX).toBeGreaterThan(states[8]!.headYaw * 0.35);
    expect(states.at(-1)!.headYaw).toBeGreaterThan(0.75);
    expect(states.at(-1)!.headPitch).toBeLessThan(-0.62);
    expect(states.at(-1)!.bodySway).toBeGreaterThan(0.3);
    expect(states.at(-1)!.bodyPitch).toBeLessThan(-0.2);
    expect(Math.abs(states.at(-1)!.bodySway)).toBeLessThan(Math.abs(states.at(-1)!.headYaw));
  });

  it("returns smoothly to autonomous motion when pointer tracking is disabled", () => {
    const controller = new CalmMotionController(fixtureProject());
    for (let index = 0; index < 120; index += 1) controller.sample(index / 60, { lookTarget: { x: -0.9, y: 0.4, strength: 1 } });
    const release = Array.from({ length: 180 }, (_, index) => controller.sample((120 + index) / 60));
    const steps = release.slice(1).map((state, index) => Math.abs(state.headYaw - release[index]!.headYaw));
    expect(Math.max(...steps)).toBeLessThan(0.05);
    expect(release.at(-1)!.headYaw).toBeGreaterThan(-0.7);
  });

  it("opens and closes the mouth occasionally instead of chattering continuously", () => {
    const controller = new CalmMotionController(fixtureProject(42, true));
    const states = Array.from({ length: 1200 }, (_, index) => controller.sample(index / 60));
    expect(states.some((state) => state.mouthOpen > 0.8)).toBe(true);
    expect(states.some((state) => state.mouthOpen === 0)).toBe(true);
    expect(states.filter((state) => state.mouthOpen > 0).length / states.length).toBeLessThan(0.3);
    const steps = states.slice(1).map((state, index) => Math.abs(state.mouthOpen - states[index]!.mouthOpen));
    expect(Math.max(...steps)).toBeLessThan(0.14);
  });
});

describe("eye rendering order", () => {
  it("always draws eye white, iris, then eyelash for both eyes", () => {
    const layer = (role: "eyeWhite" | "iris" | "eyelash", side: "left" | "right", order: number) => ({ role, side, order }) as PuppetLoomProject["layers"][number];
    const input = [
      layer("eyeWhite", "right", 15),
      layer("eyeWhite", "left", 16),
      layer("eyelash", "left", 17),
      layer("iris", "left", 18),
      layer("iris", "right", 19),
      layer("eyelash", "right", 20)
    ];
    expect(layersInRenderOrder(input).map(({ role, side }) => `${role}:${side}`)).toEqual([
      "eyeWhite:left", "eyeWhite:right",
      "iris:left", "iris:right",
      "eyelash:left", "eyelash:right"
    ]);
  });
});

describe("mouth shape crossfade", () => {
  const state = new CalmMotionController(fixtureProject()).sample(0);
  const mouth = (mouthVariant: "closed" | "slight" | "open") => ({ role: "mouth", mouthVariant, opacity: 1 }) as PuppetLoomProject["layers"][number];

  it("keeps the closed PSD mouth at rest", () => {
    expect(opacityFor(mouth("closed"), { ...state, mouthOpen: 0 })).toBe(1);
    expect(opacityFor(mouth("slight"), { ...state, mouthOpen: 0 })).toBe(0);
    expect(opacityFor(mouth("open"), { ...state, mouthOpen: 0 })).toBe(0);
  });

  it("crossfades through one slight shape into one open shape", () => {
    expect(opacityFor(mouth("slight"), { ...state, mouthOpen: 0.42 })).toBeGreaterThan(0.8);
    expect(opacityFor(mouth("closed"), { ...state, mouthOpen: 0.42 })).toBe(0);
    expect(opacityFor(mouth("open"), { ...state, mouthOpen: 1 })).toBe(1);
    expect(opacityFor(mouth("slight"), { ...state, mouthOpen: 1 })).toBe(0);
  });
});
