import type { RuntimeMotionInput } from "@puppetloom/core/browser";

export interface FacePoint {
  x: number;
  y: number;
  z?: number;
}

export interface FaceTrackingSample {
  landmarks: FacePoint[];
  blendshapes?: Record<string, number>;
}

export interface UpperBodyTrackingSample {
  poseLandmarks?: FacePoint[];
  hands?: Array<{ side: "left" | "right"; landmarks: FacePoint[] }>;
}

interface FaceAxes {
  yaw: number;
  pitch: number;
  roll: number;
  gazeX: number;
  gazeY: number;
}

const faceShapeNames = [
  "eyeBlinkLeft", "eyeBlinkRight", "jawOpen", "mouthFunnel", "mouthPucker",
  "mouthSmileLeft", "mouthSmileRight", "browInnerUp", "browDownLeft", "browDownRight", "cheekPuff"
] as const;
type FaceShapeName = typeof faceShapeNames[number];
type FaceShapeBaseline = Record<FaceShapeName, number>;

interface FaceShapeResponse {
  deadZone: number;
  activeRange: number;
}

const faceShapeResponses: Record<FaceShapeName, FaceShapeResponse> = {
  eyeBlinkLeft: { deadZone: 0.06, activeRange: 0.55 },
  eyeBlinkRight: { deadZone: 0.06, activeRange: 0.55 },
  jawOpen: { deadZone: 0.045, activeRange: 0.42 },
  mouthFunnel: { deadZone: 0.08, activeRange: 0.5 },
  mouthPucker: { deadZone: 0.08, activeRange: 0.5 }
  , mouthSmileLeft: { deadZone: 0.06, activeRange: 0.5 }
  , mouthSmileRight: { deadZone: 0.06, activeRange: 0.5 }
  , browInnerUp: { deadZone: 0.05, activeRange: 0.45 }
  , browDownLeft: { deadZone: 0.05, activeRange: 0.45 }
  , browDownRight: { deadZone: 0.05, activeRange: 0.45 }
  , cheekPuff: { deadZone: 0.08, activeRange: 0.5 }
};

export interface InputAdapterStatus {
  state: "starting" | "calibrating" | "active" | "lost" | "error" | "stopped";
  message: string;
}

export interface RuntimeInputAdapter {
  mediaStream?: MediaStream;
  stop(): Promise<void>;
}

function clamp(value: number, minimum = -1, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function average(points: FacePoint[]): FacePoint {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function smooth(current: number, target: number, deltaMs: number, responseMs: number): number {
  return current + (target - current) * (1 - Math.exp(-Math.max(1, deltaMs) / responseMs));
}

function emptyFaceAxes(): FaceAxes {
  return { yaw: 0, pitch: 0, roll: 0, gazeX: 0, gazeY: 0 };
}

function emptyShapeBaseline(): FaceShapeBaseline {
  return { eyeBlinkLeft: 0, eyeBlinkRight: 0, jawOpen: 0, mouthFunnel: 0, mouthPucker: 0, mouthSmileLeft: 0, mouthSmileRight: 0, browInnerUp: 0, browDownLeft: 0, browDownRight: 0, cheekPuff: 0 };
}

function emptyShapeSamples(): Record<FaceShapeName, number[]> {
  return { eyeBlinkLeft: [], eyeBlinkRight: [], jawOpen: [], mouthFunnel: [], mouthPucker: [], mouthSmileLeft: [], mouthSmileRight: [], browInnerUp: [], browDownLeft: [], browDownRight: [], cheekPuff: [] };
}

function neutralFaceOutput(): Required<Pick<RuntimeMotionInput,
  "headYaw" | "headPitch" | "headRoll" | "bodySway" | "bodyPitch" | "bodyRoll" | "gazeX" | "gazeY" |
  "blink" | "blinkLeft" | "blinkRight" | "browLeft" | "browRight" | "smile" | "cheekPuff" |
  "mouthOpen" | "mouthA" | "mouthI" | "mouthU" | "mouthE" | "mouthO">> {
  return {
    headYaw: 0, headPitch: 0, headRoll: 0, bodySway: 0, bodyPitch: 0, bodyRoll: 0, gazeX: 0, gazeY: 0,
    blink: 0, blinkLeft: 0, blinkRight: 0, browLeft: 0, browRight: 0, smile: 0, cheekPuff: 0,
    mouthOpen: 0, mouthA: 0, mouthI: 0, mouthU: 0, mouthE: 0, mouthO: 0
  };
}

function shapeValue(shape: Record<string, number>, name: FaceShapeName): number {
  const value = shape[name];
  return Number.isFinite(value) ? clamp(value!, 0, 1) : 0;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.round(clamp(fraction, 0, 1) * (sorted.length - 1))]!;
}

function smoothstep01(value: number): number {
  const normalized = clamp(value, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function calibratedShape(value: number, baseline: number, response: FaceShapeResponse): number {
  return smoothstep01((value - baseline - response.deadZone) / response.activeRange);
}

function axesFromLandmarks(landmarks: FacePoint[]): FaceAxes | undefined {
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const nose = landmarks[1];
  const forehead = landmarks[10];
  const chin = landmarks[152];
  if (!leftEye || !rightEye || !nose || !forehead || !chin || landmarks.length < 478) return undefined;
  const eyeMid = average([leftEye, rightEye]);
  const eyeDistance = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  const faceHeight = Math.hypot(chin.x - forehead.x, chin.y - forehead.y);
  if (eyeDistance < 0.01 || faceHeight < 0.02) return undefined;
  const leftIris = average(landmarks.slice(468, 473));
  const rightIris = average(landmarks.slice(473, 478));
  const irisMid = average([leftIris, rightIris]);
  return {
    yaw: (nose.x - eyeMid.x) / eyeDistance,
    pitch: (nose.y - eyeMid.y) / faceHeight,
    roll: Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x),
    gazeX: (irisMid.x - eyeMid.x) / eyeDistance,
    gazeY: (irisMid.y - eyeMid.y) / eyeDistance
  };
}

/** Calibrates a neutral face, then emits smoothed PuppetLoom semantic motion. */
export class FaceInputMapper {
  private baseline: FaceAxes = emptyFaceAxes();
  private shapeBaseline: FaceShapeBaseline = emptyShapeBaseline();
  private shapeSamples = emptyShapeSamples();
  private output = neutralFaceOutput();
  private calibratedFrames = 0;
  private lastTimeMs: number | undefined;
  private lostFrames = 0;

  constructor(private readonly requiredCalibrationFrames = 24) {}

  sample(sample: FaceTrackingSample | undefined, nowMs: number): RuntimeMotionInput | undefined {
    const axes = sample ? axesFromLandmarks(sample.landmarks) : undefined;
    if (!axes) {
      this.lostFrames += 1;
      if (this.lostFrames > 30) this.resetCalibration();
      return undefined;
    }
    this.lostFrames = 0;
    const deltaMs = this.lastTimeMs === undefined ? 33 : Math.max(1, Math.min(100, nowMs - this.lastTimeMs));
    this.lastTimeMs = nowMs;
    const shape = sample?.blendshapes ?? {};
    if (this.calibratedFrames < this.requiredCalibrationFrames) {
      const count = this.calibratedFrames + 1;
      for (const key of Object.keys(this.baseline) as Array<keyof FaceAxes>) this.baseline[key] += (axes[key] - this.baseline[key]) / count;
      for (const name of faceShapeNames) this.shapeSamples[name].push(shapeValue(shape, name));
      this.calibratedFrames = count;
      if (this.calibratedFrames >= this.requiredCalibrationFrames) {
        // A low percentile represents the user's open-eye, closed-mouth state even
        // when one or two natural blinks happen during the calibration window.
        for (const name of faceShapeNames) this.shapeBaseline[name] = percentile(this.shapeSamples[name], 0.2);
      }
    }
    const calibrated = this.calibratedFrames >= this.requiredCalibrationFrames;
    const headYaw = calibrated ? clamp((axes.yaw - this.baseline.yaw) * 3.6) : 0;
    const headPitch = calibrated ? clamp((axes.pitch - this.baseline.pitch) * 5.2) : 0;
    const headRoll = calibrated ? clamp((axes.roll - this.baseline.roll) / 0.42) : 0;
    const normalizedShapes = Object.fromEntries(faceShapeNames.map((name) => {
      const value = shapeValue(shape, name);
      const response = faceShapeResponses[name];
      if (calibrated && value <= this.shapeBaseline[name] + response.deadZone * 0.75) {
        // Follow slow camera/model drift only while the channel still looks neutral.
        // An actual blink or mouth movement must never be learned away.
        this.shapeBaseline[name] = smooth(this.shapeBaseline[name], value, deltaMs, 4500);
      }
      return [name, calibrated ? calibratedShape(value, this.shapeBaseline[name], response) : 0];
    })) as FaceShapeBaseline;
    // The legacy symmetric channel still requires agreement from both eyes. New
    // projects can consume the separate channels for intentional winks.
    const blinkLeft = normalizedShapes.eyeBlinkLeft;
    const blinkRight = normalizedShapes.eyeBlinkRight;
    const blink = Math.sqrt(normalizedShapes.eyeBlinkLeft * normalizedShapes.eyeBlinkRight);
    const mouthOpen = Math.max(
      normalizedShapes.jawOpen,
      normalizedShapes.mouthFunnel * 0.55,
      normalizedShapes.mouthPucker * 0.45
    );
    const smile = (normalizedShapes.mouthSmileLeft + normalizedShapes.mouthSmileRight) * 0.5;
    const browLeft = clamp(normalizedShapes.browInnerUp - normalizedShapes.browDownLeft, -1, 1);
    const browRight = clamp(normalizedShapes.browInnerUp - normalizedShapes.browDownRight, -1, 1);
    const rounded = Math.max(normalizedShapes.mouthFunnel, normalizedShapes.mouthPucker);
    const wide = Math.max(smile, normalizedShapes.jawOpen * 0.35);
    const rawVisemes = {
      mouthA: normalizedShapes.jawOpen * (1 - rounded * 0.45),
      mouthI: wide * (1 - normalizedShapes.jawOpen * 0.45),
      mouthU: normalizedShapes.mouthPucker * (1 - normalizedShapes.jawOpen * 0.35),
      mouthE: wide * Math.max(0.2, normalizedShapes.jawOpen),
      mouthO: normalizedShapes.mouthFunnel * Math.max(0.35, normalizedShapes.jawOpen)
    };
    const visemeMaximum = Math.max(1, ...Object.values(rawVisemes));
    const target = {
      headYaw,
      headPitch,
      headRoll,
      bodySway: headYaw * 0.62,
      bodyPitch: headPitch * 0.46,
      bodyRoll: clamp(headRoll * 0.52 + headYaw * 0.16),
      gazeX: calibrated ? clamp((axes.gazeX - this.baseline.gazeX) * 7.5) : 0,
      gazeY: calibrated ? clamp((axes.gazeY - this.baseline.gazeY) * 7.5) : 0,
      blink,
      blinkLeft,
      blinkRight,
      browLeft,
      browRight,
      smile,
      cheekPuff: normalizedShapes.cheekPuff,
      mouthOpen,
      mouthA: rawVisemes.mouthA / visemeMaximum,
      mouthI: rawVisemes.mouthI / visemeMaximum,
      mouthU: rawVisemes.mouthU / visemeMaximum,
      mouthE: rawVisemes.mouthE / visemeMaximum,
      mouthO: rawVisemes.mouthO / visemeMaximum
    };
    this.output = {
      headYaw: smooth(this.output.headYaw, target.headYaw, deltaMs, 85),
      headPitch: smooth(this.output.headPitch, target.headPitch, deltaMs, 95),
      headRoll: smooth(this.output.headRoll, target.headRoll, deltaMs, 90),
      bodySway: smooth(this.output.bodySway, target.bodySway, deltaMs, 105),
      bodyPitch: smooth(this.output.bodyPitch, target.bodyPitch, deltaMs, 115),
      bodyRoll: smooth(this.output.bodyRoll, target.bodyRoll, deltaMs, 110),
      gazeX: smooth(this.output.gazeX, target.gazeX, deltaMs, 55),
      gazeY: smooth(this.output.gazeY, target.gazeY, deltaMs, 55),
      blink: smooth(this.output.blink, target.blink, deltaMs, target.blink > this.output.blink ? 28 : 65),
      blinkLeft: smooth(this.output.blinkLeft, target.blinkLeft, deltaMs, target.blinkLeft > this.output.blinkLeft ? 28 : 65),
      blinkRight: smooth(this.output.blinkRight, target.blinkRight, deltaMs, target.blinkRight > this.output.blinkRight ? 28 : 65),
      browLeft: smooth(this.output.browLeft, target.browLeft, deltaMs, 90),
      browRight: smooth(this.output.browRight, target.browRight, deltaMs, 90),
      smile: smooth(this.output.smile, target.smile, deltaMs, 95),
      cheekPuff: smooth(this.output.cheekPuff, target.cheekPuff, deltaMs, 110),
      mouthOpen: smooth(this.output.mouthOpen, target.mouthOpen, deltaMs, target.mouthOpen > this.output.mouthOpen ? 42 : 105),
      mouthA: smooth(this.output.mouthA, target.mouthA, deltaMs, 72),
      mouthI: smooth(this.output.mouthI, target.mouthI, deltaMs, 72),
      mouthU: smooth(this.output.mouthU, target.mouthU, deltaMs, 72),
      mouthE: smooth(this.output.mouthE, target.mouthE, deltaMs, 72),
      mouthO: smooth(this.output.mouthO, target.mouthO, deltaMs, 72)
    };
    return { ...this.output };
  }

  resetCalibration(): void {
    this.calibratedFrames = 0;
    this.baseline = emptyFaceAxes();
    this.shapeBaseline = emptyShapeBaseline();
    this.shapeSamples = emptyShapeSamples();
    this.output = neutralFaceOutput();
    this.lastTimeMs = undefined;
    this.lostFrames = 0;
  }

  get calibrated(): boolean {
    return this.calibratedFrames >= this.requiredCalibrationFrames;
  }
}

function handOpenness(points: FacePoint[]): number {
  const wrist = points[0];
  const palm = points[9];
  if (!wrist || !palm) return 0;
  const palmSize = Math.max(0.005, Math.hypot(palm.x - wrist.x, palm.y - wrist.y));
  const tips = [4, 8, 12, 16, 20].map((index) => points[index]).filter((point): point is FacePoint => Boolean(point));
  if (tips.length < 4) return 0;
  const spread = tips.reduce((sum, point) => sum + Math.hypot(point.x - wrist.x, point.y - wrist.y), 0) / tips.length / palmSize;
  return clamp((spread - 1.45) / 1.65, 0, 1);
}

/** Maps pose wrists and optional hand landmarks into authored upper-body semantic channels. */
export class UpperBodyInputMapper {
  private baselineCenter = { x: 0.5, y: 0.5 };
  private baselineWidth = 0.2;
  private calibratedFrames = 0;
  private output: Required<Pick<RuntimeMotionInput, "armLeft" | "armRight" | "handLeftX" | "handLeftY" | "handRightX" | "handRightY" | "handLeftOpen" | "handRightOpen">> = {
    armLeft: 0, armRight: 0, handLeftX: 0, handLeftY: 0, handRightX: 0, handRightY: 0, handLeftOpen: 0, handRightOpen: 0
  };

  constructor(private readonly requiredCalibrationFrames = 18) {}

  sample(sample: UpperBodyTrackingSample | undefined, deltaMs = 33): RuntimeMotionInput | undefined {
    const pose = sample?.poseLandmarks;
    const leftShoulder = pose?.[11]; const rightShoulder = pose?.[12];
    const leftWrist = pose?.[15]; const rightWrist = pose?.[16];
    if (!leftShoulder || !rightShoulder || !leftWrist || !rightWrist) return undefined;
    const center = average([leftShoulder, rightShoulder]);
    const width = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y);
    if (width < 0.02) return undefined;
    if (this.calibratedFrames < this.requiredCalibrationFrames) {
      const count = this.calibratedFrames + 1;
      this.baselineCenter.x += (center.x - this.baselineCenter.x) / count;
      this.baselineCenter.y += (center.y - this.baselineCenter.y) / count;
      this.baselineWidth += (width - this.baselineWidth) / count;
      this.calibratedFrames = count;
    }
    const calibrated = this.calibratedFrames >= this.requiredCalibrationFrames;
    const scale = Math.max(0.02, this.baselineWidth);
    const hand = (side: "left" | "right") => sample?.hands?.find((candidate) => candidate.side === side)?.landmarks;
    const target = {
      armLeft: calibrated ? clamp((leftShoulder.y - leftWrist.y) / scale + 0.15, 0, 1) : 0,
      armRight: calibrated ? clamp((rightShoulder.y - rightWrist.y) / scale + 0.15, 0, 1) : 0,
      handLeftX: calibrated ? clamp((leftWrist.x - this.baselineCenter.x) / scale, -1, 1) : 0,
      handLeftY: calibrated ? clamp((leftWrist.y - this.baselineCenter.y) / scale, -1, 1) : 0,
      handRightX: calibrated ? clamp((rightWrist.x - this.baselineCenter.x) / scale, -1, 1) : 0,
      handRightY: calibrated ? clamp((rightWrist.y - this.baselineCenter.y) / scale, -1, 1) : 0,
      handLeftOpen: calibrated ? handOpenness(hand("left") ?? []) : 0,
      handRightOpen: calibrated ? handOpenness(hand("right") ?? []) : 0
    };
    for (const key of Object.keys(this.output) as Array<keyof typeof this.output>) this.output[key] = smooth(this.output[key], target[key], deltaMs, 95);
    return { ...this.output };
  }
}

export class MicrophoneInputMapper {
  private noiseFloor = 0.008;
  private envelope = 0;

  sample(samples: Float32Array, deltaMs = 33): number {
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / Math.max(1, samples.length));
    if (rms < this.noiseFloor * 1.8) this.noiseFloor = smooth(this.noiseFloor, Math.max(0.002, rms), deltaMs, 1800);
    const gate = this.noiseFloor * 1.35;
    const target = clamp(Math.sqrt(Math.max(0, rms - gate) / Math.max(0.025, this.noiseFloor * 7)), 0, 1);
    this.envelope = smooth(this.envelope, target, deltaMs, target > this.envelope ? 38 : 145);
    return this.envelope < 0.025 ? 0 : this.envelope;
  }
}

/** Lightweight local spectral mapper. It emits useful vowel groups without storing audio or requiring speech recognition. */
export class MicrophoneVisemeMapper {
  private readonly loudness = new MicrophoneInputMapper();
  private output = { mouthA: 0, mouthI: 0, mouthU: 0, mouthE: 0, mouthO: 0 };

  sample(timeSamples: Float32Array, frequencyDb: Float32Array, sampleRate: number, deltaMs = 33): RuntimeMotionInput {
    const mouthOpen = this.loudness.sample(timeSamples, deltaMs);
    if (mouthOpen <= 0 || frequencyDb.length === 0) {
      for (const key of Object.keys(this.output) as Array<keyof typeof this.output>) this.output[key] = smooth(this.output[key], 0, deltaMs, 110);
      return { mouthOpen, ...this.output };
    }
    const nyquist = sampleRate * 0.5;
    const energy = (minimum: number, maximum: number): number => {
      const start = Math.max(0, Math.floor(minimum / nyquist * frequencyDb.length));
      const end = Math.min(frequencyDb.length, Math.ceil(maximum / nyquist * frequencyDb.length));
      let sum = 0;
      for (let index = start; index < end; index += 1) sum += 10 ** ((frequencyDb[index] ?? -120) / 20);
      return sum / Math.max(1, end - start);
    };
    const low = energy(100, 500);
    const mid = energy(500, 1_200);
    const highMid = energy(1_200, 2_500);
    const high = energy(2_500, 4_500);
    const total = Math.max(1e-9, low + mid + highMid + high);
    const target = {
      mouthA: mouthOpen * clamp((low + mid * 0.7) / total * 2.2, 0, 1),
      mouthI: mouthOpen * clamp((highMid + high * 0.45) / total * 2.3, 0, 1),
      mouthU: mouthOpen * clamp(low / total * 2.8, 0, 1),
      mouthE: mouthOpen * clamp((mid + highMid) / total * 1.65, 0, 1),
      mouthO: mouthOpen * clamp((low + mid) / total * 1.7, 0, 1)
    };
    for (const key of Object.keys(this.output) as Array<keyof typeof this.output>) this.output[key] = smooth(this.output[key], target[key], deltaMs, target[key] > this.output[key] ? 48 : 105);
    return { mouthOpen, ...this.output };
  }
}

function blendshapes(result: { faceBlendshapes?: Array<{ categories: Array<{ categoryName?: string; score: number }> }> }): Record<string, number> {
  return Object.fromEntries((result.faceBlendshapes?.[0]?.categories ?? []).flatMap((category) => category.categoryName ? [[category.categoryName, category.score] as const] : []));
}

export async function startFaceInput(
  assets: { wasmBaseUrl: string; faceLandmarkerModelUrl: string; poseLandmarkerModelUrl?: string; handLandmarkerModelUrl?: string },
  onMotion: (motion: RuntimeMotionInput) => void,
  onStatus: (status: InputAdapterStatus) => void
): Promise<RuntimeInputAdapter> {
  onStatus({ state: "starting", message: "正在启动摄像头并加载面捕模型…" });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  let landmarker: { detectForVideo: (video: HTMLVideoElement, now: number) => { faceLandmarks: FacePoint[][]; faceBlendshapes?: Array<{ categories: Array<{ categoryName?: string; score: number }> }> }; close: () => void } | undefined;
  let poseLandmarker: { detectForVideo: (video: HTMLVideoElement, now: number) => { landmarks?: FacePoint[][] }; close: () => void } | undefined;
  let handLandmarker: { detectForVideo: (video: HTMLVideoElement, now: number) => { landmarks?: FacePoint[][]; handedness?: Array<Array<{ categoryName?: string }>> }; close: () => void } | undefined;
  try {
    await video.play();
    const { FaceLandmarker, FilesetResolver, PoseLandmarker, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(assets.wasmBaseUrl);
  const options = {
    baseOptions: { modelAssetPath: assets.faceLandmarkerModelUrl, delegate: "GPU" as const },
    runningMode: "VIDEO" as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.55,
    minFacePresenceConfidence: 0.55,
    minTrackingConfidence: 0.5
  };
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, options);
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: "CPU" } });
    }
    if (assets.poseLandmarkerModelUrl) {
      const poseOptions = { baseOptions: { modelAssetPath: assets.poseLandmarkerModelUrl, delegate: "GPU" as const }, runningMode: "VIDEO" as const, numPoses: 1, minPoseDetectionConfidence: 0.55, minPosePresenceConfidence: 0.55, minTrackingConfidence: 0.5 };
      try { poseLandmarker = await PoseLandmarker.createFromOptions(fileset, poseOptions); }
      catch { poseLandmarker = await PoseLandmarker.createFromOptions(fileset, { ...poseOptions, baseOptions: { ...poseOptions.baseOptions, delegate: "CPU" } }); }
    }
    if (assets.handLandmarkerModelUrl) {
      const handOptions = { baseOptions: { modelAssetPath: assets.handLandmarkerModelUrl, delegate: "GPU" as const }, runningMode: "VIDEO" as const, numHands: 2, minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.55, minTrackingConfidence: 0.5 };
      try { handLandmarker = await HandLandmarker.createFromOptions(fileset, handOptions); }
      catch { handLandmarker = await HandLandmarker.createFromOptions(fileset, { ...handOptions, baseOptions: { ...handOptions.baseOptions, delegate: "CPU" } }); }
    }
  } catch (cause) {
    landmarker?.close();
    poseLandmarker?.close();
    handLandmarker?.close();
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    throw cause;
  }
  const mapper = new FaceInputMapper();
  const upperBodyMapper = new UpperBodyInputMapper();
  let active = true;
  let frame = 0;
  let lastVideoTime = -1;
  let hadFace = false;
  const tick = () => {
    if (!active) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = landmarker!.detectForVideo(video, performance.now());
      const landmarks = result.faceLandmarks[0];
      const motion = mapper.sample(landmarks ? { landmarks, blendshapes: blendshapes(result) } : undefined, performance.now());
      if (motion) {
        const pose = poseLandmarker?.detectForVideo(video, performance.now()).landmarks?.[0];
        const handResult = handLandmarker?.detectForVideo(video, performance.now());
        const hands = (handResult?.landmarks ?? []).flatMap((points, index) => {
          const category = handResult?.handedness?.[index]?.[0]?.categoryName?.toLowerCase();
          return category === "left" || category === "right" ? [{ side: category, landmarks: points } as const] : [];
        });
        const upperBody = upperBodyMapper.sample(pose ? { poseLandmarks: pose, hands } : undefined);
        onMotion({ ...motion, ...(upperBody ?? {}) });
        if (!hadFace || mapper.calibrated) onStatus({ state: mapper.calibrated ? "active" : "calibrating", message: mapper.calibrated ? "摄像头面捕已校准" : "请自然睁眼、闭口看向摄像头，正在校准…" });
        hadFace = true;
      } else if (hadFace) {
        onStatus({ state: "lost", message: "暂时没有检测到面部，角色已回到自主动作" });
        hadFace = false;
      }
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return {
    mediaStream: stream,
    async stop() {
      active = false;
      cancelAnimationFrame(frame);
      landmarker?.close();
      poseLandmarker?.close();
      handLandmarker?.close();
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      onStatus({ state: "stopped", message: "摄像头面捕已关闭" });
    }
  };
}

export async function startMicrophoneInput(
  onMotion: (motion: RuntimeMotionInput) => void,
  onStatus: (status: InputAdapterStatus) => void
): Promise<RuntimeInputAdapter> {
  onStatus({ state: "starting", message: "正在启动麦克风…" });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true }, video: false });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  try {
    context = new AudioContext({ latencyHint: "interactive" });
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
  } catch (cause) {
    stream.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => undefined);
    throw cause;
  }
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const frequencies = new Float32Array(analyser.frequencyBinCount);
  const mapper = new MicrophoneVisemeMapper();
  let active = true;
  let frame = 0;
  let previous = performance.now();
  const tick = (now: number) => {
    if (!active) return;
    analyser!.getFloatTimeDomainData(samples);
    analyser!.getFloatFrequencyData(frequencies);
    onMotion(mapper.sample(samples, frequencies, context!.sampleRate, now - previous));
    previous = now;
    frame = requestAnimationFrame(tick);
  };
  onStatus({ state: "active", message: "麦克风口型已启用" });
  frame = requestAnimationFrame(tick);
  return {
    mediaStream: stream,
    async stop() {
      active = false;
      cancelAnimationFrame(frame);
      source?.disconnect();
      analyser?.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context?.close();
      onStatus({ state: "stopped", message: "麦克风口型已关闭" });
    }
  };
}
