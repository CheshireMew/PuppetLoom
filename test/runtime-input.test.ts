import { describe, expect, it } from "vitest";
import { FaceInputMapper, MicrophoneInputMapper, type FacePoint } from "../apps/desktop/src/runtime-input.js";

function face(overrides: { noseX?: number; noseY?: number; roll?: number; gazeX?: number } = {}): FacePoint[] {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const roll = overrides.roll ?? 0;
  points[33] = { x: 0.4, y: 0.4 - roll };
  points[263] = { x: 0.6, y: 0.4 + roll };
  points[1] = { x: overrides.noseX ?? 0.5, y: overrides.noseY ?? 0.5 };
  points[10] = { x: 0.5, y: 0.2 };
  points[152] = { x: 0.5, y: 0.8 };
  for (let index = 468; index < 473; index += 1) points[index] = { x: 0.4 + (overrides.gazeX ?? 0), y: 0.4 };
  for (let index = 473; index < 478; index += 1) points[index] = { x: 0.6 + (overrides.gazeX ?? 0), y: 0.4 };
  return points;
}

describe("desktop runtime input mapping", () => {
  it("calibrates neutral face before producing stable pose, gaze, blink and mouth input", () => {
    const mapper = new FaceInputMapper(2);
    expect(mapper.sample({ landmarks: face() }, 0)?.headYaw).toBe(0);
    expect(mapper.sample({ landmarks: face() }, 33)?.headYaw).toBe(0);
    let motion;
    for (let index = 0; index < 8; index += 1) motion = mapper.sample({
      landmarks: face({ noseX: 0.54, noseY: 0.54, roll: 0.02, gazeX: 0.02 }),
      blendshapes: { eyeBlinkLeft: 1, eyeBlinkRight: 0.8, jawOpen: 0.7 }
    }, 66 + index * 33);
    expect(motion!.headYaw).toBeGreaterThan(0.6);
    expect(motion!.headPitch).toBeGreaterThan(0.25);
    expect(motion!.headRoll).toBeGreaterThan(0.3);
    expect(motion!.gazeX).toBeGreaterThan(0.6);
    expect(motion!.blink).toBeGreaterThan(0.85);
    expect(motion!.mouthOpen).toBeGreaterThan(0.65);
  });

  it("drops missing faces so TTL fallback can restore autonomous motion", () => {
    const mapper = new FaceInputMapper(1);
    expect(mapper.sample({ landmarks: face() }, 0)).toBeDefined();
    expect(mapper.sample(undefined, 33)).toBeUndefined();
  });

  it("gates room noise while following speech with fast attack and slower release", () => {
    const mapper = new MicrophoneInputMapper();
    const silent = new Float32Array(1024).fill(0.002);
    expect(mapper.sample(silent)).toBe(0);
    const loud = Float32Array.from({ length: 1024 }, (_, index) => index % 2 ? 0.12 : -0.12);
    const opened = Array.from({ length: 5 }, () => mapper.sample(loud)).at(-1)!;
    expect(opened).toBeGreaterThan(0.7);
    expect(mapper.sample(silent)).toBeGreaterThan(0.2);
  });
});
