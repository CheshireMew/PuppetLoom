import type { PuppetLoomProject } from "@puppetloom/core/browser";
import { describe, expect, it } from "vitest";
import { CalmMotionController } from "../src/motion.js";
import { layersInRenderOrder } from "../src/renderer.js";

function fixtureProject(seed = 42): PuppetLoomProject {
  return {
    runtime: {
      seed,
      profile: "calm-v1",
      features: { headTurn: true, bodyFollow: true, gaze: true, hairPhysics: true, blink: false, mouthMotion: false },
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
    const states = Array.from({ length: 720 }, (_, index) => controller.sample(index / 60));
    expect(project.runtime.features.mouthMotion).toBe(false);
    expect(states.some((state) => Math.abs(state.headYaw) > 0.5)).toBe(true);
    expect(states.some((state) => Math.abs(state.bodySway) > 0.01)).toBe(true);
    expect(states.every((state) => Number.isFinite(state.hairX))).toBe(true);
    expect(states.every((state) => Number.isFinite(state.backHairX) && Number.isFinite(state.earX) && Number.isFinite(state.accessoryX))).toBe(true);
    expect(states.some((state) => Math.abs(state.hairX - state.backHairX) > 0.001)).toBe(true);
    expect(states.some((state) => Math.abs(state.hairX - state.earX) > 0.001)).toBe(true);
    expect(states.some((state) => Math.abs(state.backHairX - state.accessoryX) > 0.001)).toBe(true);
    expect(states.every((state) => Math.abs(state.headYaw) <= 1 && Math.abs(state.headPitch) <= 1)).toBe(true);
    const frameSteps = states.slice(1).map((state, index) => Math.abs(state.headYaw - states[index]!.headYaw));
    expect(Math.max(...frameSteps)).toBeLessThan(0.04);
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
