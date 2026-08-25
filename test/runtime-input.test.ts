import { describe, expect, it } from "vitest";
import { FaceInputMapper, MicrophoneInputMapper, MicrophoneVisemeMapper, UpperBodyInputMapper, type FacePoint } from "../apps/desktop/src/runtime-input.js";

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
    expect(motion!.blinkLeft).toBeGreaterThan(0.9);
    expect(motion!.blinkRight).toBeLessThan(0.05);
  });

  it("maps brows, smile, cheeks and vowel groups without discarding legacy mouth-open", () => {
    const mapper = new FaceInputMapper(1);
    mapper.sample({ landmarks: face(), blendshapes: {} }, 0);
    let motion;
    for (let index = 0; index < 8; index += 1) motion = mapper.sample({
      landmarks: face(),
      blendshapes: { browInnerUp: 0.8, browDownLeft: 0.1, browDownRight: 0.25, mouthSmileLeft: 0.7, mouthSmileRight: 0.8, cheekPuff: 0.6, jawOpen: 0.55, mouthFunnel: 0.7, mouthPucker: 0.65 }
    }, 33 + index * 33);
    expect(motion!.browLeft).toBeGreaterThan(0.4);
    expect(motion!.browRight).toBeGreaterThan(0.25);
    expect(motion!.smile).toBeGreaterThan(0.65);
    expect(motion!.cheekPuff).toBeGreaterThan(0.5);
    expect(motion!.mouthOpen).toBeGreaterThan(0.45);
    expect(motion!.mouthU).toBeGreaterThan(0.5);
    expect(motion!.mouthO).toBeGreaterThan(0.4);
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

  it("extracts deterministic local viseme weights from microphone spectrum", () => {
    const mapper = new MicrophoneVisemeMapper();
    const loud = Float32Array.from({ length: 1024 }, (_, index) => index % 2 ? 0.12 : -0.12);
    const spectrum = new Float32Array(512).fill(-100);
    spectrum.fill(-12, 5, 30);
    let motion;
    for (let index = 0; index < 6; index += 1) motion = mapper.sample(loud, spectrum, 48_000);
    expect(motion!.mouthOpen).toBeGreaterThan(0.7);
    expect(motion!.mouthU).toBeGreaterThan(0.5);
    expect(motion!.mouthO).toBeGreaterThan(0.4);
  });

  it("maps pose and hand landmarks to calibrated upper-body channels", () => {
    const mapper = new UpperBodyInputMapper(1);
    const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
    pose[11] = { x: 0.4, y: 0.45 };
    pose[12] = { x: 0.6, y: 0.45 };
    pose[15] = { x: 0.3, y: 0.25 };
    pose[16] = { x: 0.7, y: 0.3 };
    const openHand = Array.from({ length: 21 }, () => ({ x: 0.3, y: 0.15 }));
    openHand[0] = { x: 0.3, y: 0.25 };
    openHand[9] = { x: 0.3, y: 0.2 };
    for (const [index, x] of [[4, 0.15], [8, 0.22], [12, 0.3], [16, 0.38], [20, 0.45]] as const) openHand[index] = { x, y: 0.02 };
    mapper.sample({ poseLandmarks: pose });
    let motion;
    for (let index = 0; index < 8; index += 1) motion = mapper.sample({ poseLandmarks: pose, hands: [{ side: "left", landmarks: openHand }] });
    expect(motion!.armLeft).toBeGreaterThan(0.8);
    expect(motion!.armRight).toBeGreaterThan(0.6);
    expect(motion!.handLeftOpen).toBeGreaterThan(0.2);
  });
});
