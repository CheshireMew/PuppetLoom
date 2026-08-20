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

interface FaceAxes {
  yaw: number;
  pitch: number;
  roll: number;
  gazeX: number;
  gazeY: number;
}

const faceShapeNames = ["eyeBlinkLeft", "eyeBlinkRight", "jawOpen", "mouthFunnel", "mouthPucker"] as const;
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
  return { eyeBlinkLeft: 0, eyeBlinkRight: 0, jawOpen: 0, mouthFunnel: 0, mouthPucker: 0 };
}

function emptyShapeSamples(): Record<FaceShapeName, number[]> {
  return { eyeBlinkLeft: [], eyeBlinkRight: [], jawOpen: [], mouthFunnel: [], mouthPucker: [] };
}

function neutralFaceOutput(): Required<Pick<RuntimeMotionInput, "headYaw" | "headPitch" | "headRoll" | "bodySway" | "bodyPitch" | "bodyRoll" | "gazeX" | "gazeY" | "blink" | "mouthOpen">> {
  return { headYaw: 0, headPitch: 0, headRoll: 0, bodySway: 0, bodyPitch: 0, bodyRoll: 0, gazeX: 0, gazeY: 0, blink: 0, mouthOpen: 0 };
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
    // PuppetLoom currently has one symmetric blink channel. Geometric agreement
    // requires both eye scores to rise, so a one-eye tracking spike cannot fade
    // both rendered eyes and create a washed-out face.
    const blink = Math.sqrt(normalizedShapes.eyeBlinkLeft * normalizedShapes.eyeBlinkRight);
    const mouthOpen = Math.max(
      normalizedShapes.jawOpen,
      normalizedShapes.mouthFunnel * 0.55,
      normalizedShapes.mouthPucker * 0.45
    );
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
      mouthOpen
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
      mouthOpen: smooth(this.output.mouthOpen, target.mouthOpen, deltaMs, target.mouthOpen > this.output.mouthOpen ? 42 : 105)
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

function blendshapes(result: { faceBlendshapes?: Array<{ categories: Array<{ categoryName?: string; score: number }> }> }): Record<string, number> {
  return Object.fromEntries((result.faceBlendshapes?.[0]?.categories ?? []).flatMap((category) => category.categoryName ? [[category.categoryName, category.score] as const] : []));
}

export async function startFaceInput(
  assets: { wasmBaseUrl: string; faceLandmarkerModelUrl: string },
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
  try {
    await video.play();
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
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
  } catch (cause) {
    landmarker?.close();
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    throw cause;
  }
  const mapper = new FaceInputMapper();
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
        onMotion(motion);
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
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      onStatus({ state: "stopped", message: "摄像头面捕已关闭" });
    }
  };
}

export async function startMicrophoneInput(
  onMouthOpen: (mouthOpen: number) => void,
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
  const mapper = new MicrophoneInputMapper();
  let active = true;
  let frame = 0;
  let previous = performance.now();
  const tick = (now: number) => {
    if (!active) return;
    analyser!.getFloatTimeDomainData(samples);
    onMouthOpen(mapper.sample(samples, now - previous));
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
