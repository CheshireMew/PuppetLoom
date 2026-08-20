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
  it("calibrates neutral face before producing stable head, body, gaze, blink and mouth input", () => {
    const mapper = new FaceInputMapper(2);
    expect(mapper.sample({ landmarks: face() }, 0)).toMatchObject({ headYaw: 0, bodySway: 0, bodyPitch: 0, bodyRoll: 0 });
    expect(mapper.sample({ landmarks: face() }, 33)).toMatchObject({ headYaw: 0, bodySway: 0, bodyPitch: 0, bodyRoll: 0 });
    let motion;
    for (let index = 0; index < 8; index += 1) motion = mapper.sample({
      landmarks: face({ noseX: 0.54, noseY: 0.54, roll: 0.02, gazeX: 0.02 }),
      blendshapes: { eyeBlinkLeft: 1, eyeBlinkRight: 0.8, jawOpen: 0.7 }
    }, 66 + index * 33);
    expect(motion!.headYaw).toBeGreaterThan(0.6);
    expect(motion!.headPitch).toBeGreaterThan(0.25);
    expect(motion!.headRoll).toBeGreaterThan(0.3);
    expect(motion!.bodySway).toBeGreaterThan(0.1);
    expect(motion!.bodyPitch).toBeGreaterThan(0.04);
    expect(motion!.bodyRoll).toBeGreaterThan(0.05);
    expect(motion!.bodySway).toBeLessThan(motion!.headYaw!);
    expect(motion!.bodyPitch).toBeLessThan(motion!.headPitch!);
    expect(motion!.bodyRoll).toBeLessThan(motion!.headRoll!);
    expect(motion!.gazeX).toBeGreaterThan(0.6);
    expect(motion!.blink).toBeGreaterThan(0.85);
    expect(motion!.mouthOpen).toBeGreaterThan(0.65);
  });

  it("keeps non-zero neutral blendshape scores from washing out the face", () => {
    const mapper = new FaceInputMapper(8);
    const neutralBlendshapes = {
      eyeBlinkLeft: 0.16,
      eyeBlinkRight: 0.12,
      jawOpen: 0.14,
      mouthFunnel: 0.1,
      mouthPucker: 0.08
    };
    let motion;
    for (let index = 0; index < 8; index += 1) {
      motion = mapper.sample({ landmarks: face(), blendshapes: neutralBlendshapes }, index * 33);
      expect(motion).toMatchObject({ blink: 0, mouthOpen: 0 });
    }
    for (let index = 0; index < 12; index += 1) {
      motion = mapper.sample({
        landmarks: face(),
        blendshapes: { eyeBlinkLeft: 0.19, eyeBlinkRight: 0.14, jawOpen: 0.17, mouthFunnel: 0.13, mouthPucker: 0.1 }
      }, 264 + index * 33);
    }
    expect(motion).toMatchObject({ blink: 0, mouthOpen: 0 });
  });

  it("ignores natural blinks during calibration but still reaches a full blink and open mouth", () => {
    const mapper = new FaceInputMapper(10);
    for (let index = 0; index < 10; index += 1) {
      const blink = index === 2 || index === 3 ? 0.95 : 0.13;
      const motion = mapper.sample({
        landmarks: face(),
        blendshapes: { eyeBlinkLeft: blink, eyeBlinkRight: blink, jawOpen: index === 4 ? 0.75 : 0.12 }
      }, index * 33);
      expect(motion).toMatchObject({ blink: 0, mouthOpen: 0 });
    }
    let motion;
    for (let index = 0; index < 8; index += 1) motion = mapper.sample({
      landmarks: face(),
      blendshapes: { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.82, jawOpen: 0.72 }
    }, 330 + index * 33);
    expect(motion!.blink).toBeGreaterThan(0.85);
    expect(motion!.mouthOpen).toBeGreaterThan(0.85);
  });

  it("requires agreement from both eyes so one-eye tracking noise does not fade the face", () => {
    const mapper = new FaceInputMapper(2);
    mapper.sample({ landmarks: face(), blendshapes: { eyeBlinkLeft: 0.12, eyeBlinkRight: 0.12 } }, 0);
    mapper.sample({ landmarks: face(), blendshapes: { eyeBlinkLeft: 0.12, eyeBlinkRight: 0.12 } }, 33);
    let motion;
    for (let index = 0; index < 8; index += 1) motion = mapper.sample({
      landmarks: face(),
      blendshapes: { eyeBlinkLeft: 0.95, eyeBlinkRight: 0.14 }
    }, 66 + index * 33);
    expect(motion!.blink).toBe(0);
  });

  it("drops missing faces so TTL fallback can restore autonomous motion", () => {
    const mapper = new FaceInputMapper(1);
    expect(mapper.sample({ landmarks: face() }, 0)).toBeDefined();
    expect(mapper.sample(undefined, 33)).toBeUndefined();
  });

  it("clears stale blink and mouth output before calibrating a face again", () => {
    const mapper = new FaceInputMapper(2);
    mapper.sample({ landmarks: face(), blendshapes: { eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1, jawOpen: 0.1 } }, 0);
    mapper.sample({ landmarks: face(), blendshapes: { eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1, jawOpen: 0.1 } }, 33);
    let motion;
    for (let index = 0; index < 6; index += 1) motion = mapper.sample({
      landmarks: face(),
      blendshapes: { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9, jawOpen: 0.75 }
    }, 66 + index * 33);
    expect(motion!.blink).toBeGreaterThan(0.8);
    expect(motion!.mouthOpen).toBeGreaterThan(0.8);
    for (let index = 0; index < 31; index += 1) mapper.sample(undefined, 300 + index * 33);
    expect(mapper.calibrated).toBe(false);
    expect(mapper.sample({
      landmarks: face(),
      blendshapes: { eyeBlinkLeft: 0.14, eyeBlinkRight: 0.12, jawOpen: 0.13 }
    }, 1400)).toMatchObject({ blink: 0, mouthOpen: 0 });
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
