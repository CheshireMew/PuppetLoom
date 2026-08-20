import type { PuppetLoomProject, RuntimeControlSnapshot } from "@puppetloom/core/browser";
import { describe, expect, it } from "vitest";
import { CalmMotionController } from "../src/motion.js";
import { controlledMotionValue, resolveRuntimeControl, runtimeAuthoredState } from "../src/runtime-control.js";

function snapshot(sources: RuntimeControlSnapshot["sources"]): RuntimeControlSnapshot {
  return { version: 1, viewerId: 1, capturedAtMs: 1000, sources };
}

function project(): PuppetLoomProject {
  return {
    model: {
      parameters: [{ id: "smile", name: "Smile", group: "Expression", kind: "continuous", min: 0, default: 0, max: 1 }],
      deformers: [], bindings: [], expressions: [{ id: "happy", name: "Happy", parameters: { smile: 1 } }], physics: [], behaviors: []
    },
    runtime: {
      seed: 42, profile: "calm-v1",
      features: { headTurn: true, bodyFollow: true, gaze: true, hairPhysics: true, blink: true, mouthMotion: true },
      envelope: { headYaw: 0.12, headPitch: 0.08, headRollDegrees: 4, bodySway: 0.02, bodyRollDegrees: 2, breath: 0.018, gazeX: 0.2, gazeY: 0.12, globalScale: 1 }
    }
  } as PuppetLoomProject;
}

describe("runtime control blending", () => {
  it("applies higher priority sources last and ignores expired sources", () => {
    const control = resolveRuntimeControl(snapshot([
      { id: "low", priority: 10, blend: 1, updatedAtMs: 900, motion: { headYaw: -0.8 } },
      { id: "high", priority: 90, blend: 0.5, updatedAtMs: 950, motion: { headYaw: 0.8 } },
      { id: "expired", priority: 100, blend: 1, updatedAtMs: 800, expiresAtMs: 999, motion: { headYaw: 1 } }
    ]), 1000);
    expect(controlledMotionValue(0.2, "headYaw", control)).toBeCloseTo(0);
  });

  it("blends authored parameters from defaults and expressions from zero", () => {
    const control = resolveRuntimeControl(snapshot([
      { id: "agent", priority: 50, blend: 0.5, updatedAtMs: 900, parameters: { smile: 0.8 }, expressions: { happy: 1 } }
    ]), 1000);
    expect(runtimeAuthoredState(project(), control)).toEqual({ parameters: { smile: 0.4 }, expressions: { happy: 0.5 } });
  });

  it("drives primary and mouth motion while preserving smooth secondary response", () => {
    const controller = new CalmMotionController(project());
    const runtimeControl = snapshot([{ id: "camera", priority: 50, blend: 1, updatedAtMs: 1000, motion: { headYaw: 0.9, headPitch: -0.6, mouthOpen: 0.75 } }]);
    const states = Array.from({ length: 120 }, (_, index) => controller.sample(index / 60, { runtimeControl, nowMs: 1000 + index * 16 }));
    expect(states.at(-1)!.headYaw).toBeGreaterThan(0.85);
    expect(states.at(-1)!.headPitch).toBeLessThan(-0.55);
    expect(states.at(-1)!.mouthOpen).toBe(0.75);
    expect(states.some((state) => Math.abs(state.hairX) > 0.001)).toBe(true);
  });
});
