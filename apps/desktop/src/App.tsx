import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { BuildReport, CharacterStateSelection, InspectionReport, PerformanceTakeSummary, PuppetLoomProject, RuntimeViewerDescriptor } from "@puppetloom/core";
import { neutralMotionState } from "@puppetloom/core/browser";
import { PuppetRenderer } from "@puppetloom/renderer";
import { Activity, Camera, CameraOff, ChevronRight, ClipboardCopy, ExternalLink, FileImage, FileJson2, FileUp, FolderKanban, FolderOpen, FolderOutput, Image as ImageIcon, Mic, MicOff, Minus, MousePointer2, MousePointerClick, Pause, Pin, Play, Plus, PointerOff, RadioTower, Repeat2, ScanSearch, Smile, Sparkles, Square, Video, WandSparkles, X } from "lucide-react";
import type { DesktopCreatePhase, DesktopCreateRequest, RecentProject, ViewerCapabilities, ViewerState } from "../electron/global.js";
import type { SpoutOutputStatus } from "../electron/spout-output-service.js";
import { WindowTitleBar } from "./WindowTitleBar.js";
import { startFaceInput, startMicrophoneInput, type InputAdapterStatus, type RuntimeInputAdapter } from "./runtime-input.js";
import { startPerformanceRecording, type PerformanceRecorder, type PerformanceRecordingInputSession, type PerformanceRecordingOptions } from "./performance-recorder.js";
import { ProductionCenter } from "./ProductionCenter.js";
import { LOCALE_DATE, useLocale, type AppLocale, type MessageKey, type Translate } from "./i18n/index.js";

const EditorWorkspace = lazy(() => import("./EditorWorkspace.js").then((module) => ({ default: module.EditorWorkspace })));

type ViewerAction = "pause" | "top" | "click-through" | "pointer-tracking" | "larger" | "smaller" | "close";

type RecordingBackgroundChoice = "transparent" | "black" | "white" | "green" | "custom";

interface ViewerRecordingSettings {
  background: RecordingBackgroundChoice;
  backgroundColor: string;
  width: number;
  height: number;
  fps: 24 | 30 | 60;
  durationSeconds: number;
  includeAudio: boolean;
  includeMotionData: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recentProjectTime(openedAt: string, locale: AppLocale, fallback: string): string {
  const date = new Date(openedAt);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(LOCALE_DATE[locale], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function rigLevelLabel(level: PuppetLoomProject["rigLevel"], t: Translate): string {
  return level === "semantic" ? t("rigSemantic") : level === "grouped" ? t("rigGrouped") : t("rigBasic");
}

const featureKeys: Record<string, MessageKey> = {
  headTurn: "featureHeadTurn", bodyFollow: "featureBodyFollow", gaze: "featureGaze", hairPhysics: "featureHairPhysics", blink: "featureBlink", mouthMotion: "featureMouthMotion"
};

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
}

const viewerInteractionSelector = "button, input, select, textarea, summary, video, a, .viewer-controls, .action-panel, .recording-panel, .recording-preview, .viewer-status-stack";

function isViewerMoveOrZoomSurface(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest(viewerInteractionSelector);
}

function Viewer({ projectDirectory, revision, output = false }: { projectDirectory: string; revision?: number; output?: boolean }): React.JSX.Element {
  const { t } = useLocale();
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<PuppetRenderer | undefined>(undefined);
  const [project, setProject] = useState<PuppetLoomProject>();
  const [sourceLabel, setSourceLabel] = useState("");
  const [capabilities, setCapabilities] = useState<ViewerCapabilities>({ hotkeys: {} });
  const [state, setState] = useState<ViewerState>({ paused: false, alwaysOnTop: true, clickThrough: false, mouseTracking: true, scale: 1 });
  const [error, setError] = useState("");
  const [cameraStatus, setCameraStatus] = useState<InputAdapterStatus>({ state: "stopped", message: "" });
  const [microphoneStatus, setMicrophoneStatus] = useState<InputAdapterStatus>({ state: "stopped", message: "" });
  const [recordingInput, setRecordingInput] = useState(false);
  const [recordingPerformance, setRecordingPerformance] = useState(false);
  const [recordingFinalizing, setRecordingFinalizing] = useState(false);
  const [replayingInput, setReplayingInput] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<{ text: string; path?: string }>();
  const [transientMessage, setTransientMessage] = useState("");
  const [recordingClock, setRecordingClock] = useState<{ kind: "video" | "input"; startedAt: number; targetDurationMs?: number }>();
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [runtimeDescriptor, setRuntimeDescriptor] = useState<RuntimeViewerDescriptor>();
  const [showActions, setShowActions] = useState(false);
  const [showRecordingSettings, setShowRecordingSettings] = useState(false);
  const [selectedCharacterState, setSelectedCharacterState] = useState<CharacterStateSelection>({});
  const [takes, setTakes] = useState<PerformanceTakeSummary[]>([]);
  const [takeEdit, setTakeEdit] = useState<{ id: string; startSeconds: number; endSeconds: number; speed: number; smoothWindow: number }>();
  const [spoutStatus, setSpoutStatus] = useState<SpoutOutputStatus>();
  const [recordingSettings, setRecordingSettings] = useState<ViewerRecordingSettings>({ background: "transparent", backgroundColor: "#00ff00", width: 1080, height: 1080, fps: 30, durationSeconds: 0, includeAudio: true, includeMotionData: false });
  const [recordingPreview, setRecordingPreview] = useState<{ url: string; output: string; note?: string }>();
  const cameraInput = useRef<RuntimeInputAdapter | undefined>(undefined);
  const microphoneInput = useRef<RuntimeInputAdapter | undefined>(undefined);
  const performanceRecorder = useRef<PerformanceRecorder | undefined>(undefined);
  const performanceOwnsInput = useRef(false);
  const performanceStopTimer = useRef<number | undefined>(undefined);
  const finishingPerformance = useRef(false);
  const viewerDragPointer = useRef<number | undefined>(undefined);
  const wheelDelta = useRef(0);
  const queuedWheelAction = useRef<"larger" | "smaller" | undefined>(undefined);
  const wheelActionRunning = useRef(false);
  const [draggingWindow, setDraggingWindow] = useState(false);

  useEffect(() => {
    if (!transientMessage) return;
    const timer = window.setTimeout(() => setTransientMessage(""), 2600);
    return () => window.clearTimeout(timer);
  }, [transientMessage]);

  useEffect(() => {
    if (!recordingClock) {
      setRecordingElapsedMs(0);
      return;
    }
    const update = () => setRecordingElapsedMs(Date.now() - recordingClock.startedAt);
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [recordingClock]);
  useEffect(() => { if (showRecordingSettings) void refreshTakes(); }, [showRecordingSettings]);
  useEffect(() => {
    if (output) return;
    let disposed = false;
    const refresh = () => void window.puppetloom.spoutOutput("status").then((status) => {
      if (disposed) return;
      setSpoutStatus((current) => current && JSON.stringify(current) === JSON.stringify(status) ? current : status);
    }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, spoutStatus?.active ? 1000 : 4000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [output, spoutStatus?.active]);

  useEffect(() => window.puppetloom.onViewerState((next) => {
    setState(next);
    renderer.current?.setPaused(next.paused);
  }), []);

  useEffect(() => window.puppetloom.onRuntimeControl((snapshot) => renderer.current?.setRuntimeControl(snapshot)), []);

  useEffect(() => {
    const apply = (payload: { project: PuppetLoomProject; sourceLabel: string }) => {
      setProject(payload.project);
      setSourceLabel(payload.sourceLabel);
      setError("");
    };
    void window.puppetloom.viewerProject().then(apply).catch((cause) => setError(messageOf(cause)));
    void window.puppetloom.viewerCapabilities().then(setCapabilities).catch(() => undefined);
    return window.puppetloom.onViewerProject(apply);
  }, []);

  useEffect(() => window.puppetloom.onInputReplayState((next) => {
    setReplayingInput(next.replaying);
    if (next.reason === "started") renderer.current?.restartMotion();
    if (next.reason === "finished") setTransientMessage(t("replayFinished"));
    if (next.reason === "stopped") setTransientMessage(t("replayStopped"));
  }), []);

  useEffect(() => () => {
    if (performanceStopTimer.current !== undefined) window.clearTimeout(performanceStopTimer.current);
    const activeRecorder = performanceRecorder.current;
    performanceRecorder.current = undefined;
    if (activeRecorder) void (async () => {
      let inputSession: PerformanceRecordingInputSession | undefined;
      if (performanceOwnsInput.current) {
        const result = await window.puppetloom.inputRecording("stop").catch(() => undefined);
        if (result?.output && result.durationMs !== undefined && result.events !== undefined) inputSession = { output: result.output, durationMs: result.durationMs, events: result.events };
      }
      await activeRecorder.stop(inputSession).catch(() => undefined);
    })();
    void cameraInput.current?.stop();
    void microphoneInput.current?.stop();
    void window.puppetloom.releaseRuntimeSource("camera");
    void window.puppetloom.releaseRuntimeSource("microphone");
    void window.puppetloom.releaseRuntimeSource("pointer");
  }, []);

  useEffect(() => () => {
    if (recordingPreview) void window.puppetloom.releaseProjectMedia(recordingPreview.url);
  }, [recordingPreview]);

  useEffect(() => {
    let disposed = false;
    let pointerTimer = 0;
    let pointerRequestActive = false;
    let pointerSourceActive = false;
    void (async () => {
      try {
        if (!project || disposed || !canvas.current) return;
        setRuntimeDescriptor(await window.puppetloom.runtimeDescriptor());
        renderer.current?.dispose();
        renderer.current = await PuppetRenderer.create(canvas.current, project, (layer) => window.puppetloom.readAsset(projectDirectory, layer));
        renderer.current.start();
        const updatePointer = async () => {
          if (output) return;
          if (disposed || pointerRequestActive || !renderer.current) return;
          pointerRequestActive = true;
          try {
            const target = await window.puppetloom.pointerTarget();
            if (target.strength > 0) {
              await window.puppetloom.setRuntimeSource({
                id: "pointer",
                priority: 20,
                blend: 1,
                ttlMs: 250,
                motion: { lookTargetX: target.x, lookTargetY: target.y, lookTargetStrength: target.strength }
              });
              pointerSourceActive = true;
            } else if (pointerSourceActive) {
              await window.puppetloom.releaseRuntimeSource("pointer");
              pointerSourceActive = false;
            }
          } catch {
            if (pointerSourceActive) await window.puppetloom.releaseRuntimeSource("pointer").catch(() => undefined);
            pointerSourceActive = false;
          } finally {
            pointerRequestActive = false;
          }
        };
        if (!output) void updatePointer();
        // The motion controller interpolates this target every rendered frame;
        // a 10 Hz screen-coordinate sample remains smooth while avoiding a
        // cross-process round trip on every third frame.
        if (!output) pointerTimer = window.setInterval(() => void updatePointer(), 1000 / 10);
        renderer.current.setRuntimeControl(await window.puppetloom.runtimeControl());
        window.puppetloomRenderTestPose = (override) => {
          if (!renderer.current) return false;
          renderer.current.setPaused(true);
          renderer.current.render({ ...neutralMotionState, ...override });
          return true;
        };
        window.puppetloomRenderCurrentFrame = () => {
          const current = renderer.current;
          if (!current?.motionState) return false;
          current.render(current.motionState);
          return true;
        };
      } catch (cause) {
        setError(messageOf(cause));
      }
    })();
    return () => {
      disposed = true;
      if (pointerTimer) window.clearInterval(pointerTimer);
      if (pointerSourceActive) void window.puppetloom.releaseRuntimeSource("pointer");
      delete window.puppetloomRenderTestPose;
      delete window.puppetloomRenderCurrentFrame;
      renderer.current?.dispose();
    };
  }, [projectDirectory, project, revision, output]);

  async function act(action: ViewerAction): Promise<void> {
    const next = await window.puppetloom.viewerAction(action);
    if (next) {
      setState(next);
      renderer.current?.setPaused(next.paused);
    }
  }

  async function flushWheelAction(): Promise<void> {
    if (wheelActionRunning.current) return;
    wheelActionRunning.current = true;
    try {
      while (queuedWheelAction.current) {
        const action = queuedWheelAction.current;
        queuedWheelAction.current = undefined;
        await act(action);
      }
    } finally {
      wheelActionRunning.current = false;
    }
  }

  function zoomViewerWithWheel(event: React.WheelEvent<HTMLElement>): void {
    if (state.clickThrough || !isViewerMoveOrZoomSurface(event.target) || event.deltaY === 0) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
    wheelDelta.current += event.deltaY * unit;
    if (Math.abs(wheelDelta.current) < 40) return;
    queuedWheelAction.current = wheelDelta.current < 0 ? "larger" : "smaller";
    wheelDelta.current = 0;
    void flushWheelAction();
  }

  function beginViewerDrag(event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0 || state.clickThrough || !isViewerMoveOrZoomSurface(event.target)) return;
    viewerDragPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    window.puppetloom.viewerDrag("start", { x: event.screenX, y: event.screenY });
    setDraggingWindow(true);
    event.preventDefault();
  }

  function moveViewerDrag(event: React.PointerEvent<HTMLElement>): void {
    if (viewerDragPointer.current !== event.pointerId) return;
    window.puppetloom.viewerDrag("move", { x: event.screenX, y: event.screenY });
  }

  function endViewerDrag(event: React.PointerEvent<HTMLElement>): void {
    if (viewerDragPointer.current !== event.pointerId) return;
    viewerDragPointer.current = undefined;
    window.puppetloom.viewerDrag("end");
    setDraggingWindow(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function toggleCamera(): Promise<void> {
    if (cameraInput.current) {
      const input = cameraInput.current;
      cameraInput.current = undefined;
      await input.stop();
      await window.puppetloom.releaseRuntimeSource("camera");
      return;
    }
    try {
      setCameraStatus({ state: "starting", message: t("cameraStarting") });
      const input = await startFaceInput(await window.puppetloom.runtimeAssets(), (motion) => {
        void window.puppetloom.setRuntimeSource({ id: "camera", priority: 55, blend: 1, ttlMs: 250, motion });
      }, setCameraStatus, {
        cameraStarting: t("cameraStartingModel"),
        cameraCalibrating: t("cameraCalibrating"),
        cameraCalibrated: t("cameraCalibrated"),
        cameraLost: t("cameraLost"),
        cameraStopped: t("cameraStopped"),
        microphoneStarting: t("microphoneStarting"),
        microphoneActive: t("microphoneActive"),
        microphoneStopped: t("microphoneStopped")
      });
      cameraInput.current = input;
    } catch (cause) {
      setCameraStatus({ state: "error", message: t("cameraStartFailed", { error: messageOf(cause) }) });
      await window.puppetloom.releaseRuntimeSource("camera");
    }
  }

  async function toggleMicrophone(): Promise<void> {
    if (microphoneInput.current) {
      const input = microphoneInput.current;
      microphoneInput.current = undefined;
      await input.stop();
      await window.puppetloom.releaseRuntimeSource("microphone");
      return;
    }
    try {
      setMicrophoneStatus({ state: "starting", message: t("microphoneStarting") });
      const input = await startMicrophoneInput((motion) => {
        void window.puppetloom.setRuntimeSource({ id: "microphone", priority: 65, blend: 1, ttlMs: 250, motion });
      }, setMicrophoneStatus, {
        cameraStarting: t("cameraStartingModel"),
        cameraCalibrating: t("cameraCalibrating"),
        cameraCalibrated: t("cameraCalibrated"),
        cameraLost: t("cameraLost"),
        cameraStopped: t("cameraStopped"),
        microphoneStarting: t("microphoneStarting"),
        microphoneActive: t("microphoneActive"),
        microphoneStopped: t("microphoneStopped")
      });
      microphoneInput.current = input;
    } catch (cause) {
      setMicrophoneStatus({ state: "error", message: t("microphoneStartFailed", { error: messageOf(cause) }) });
      await window.puppetloom.releaseRuntimeSource("microphone");
    }
  }

  async function toggleInputRecording(): Promise<void> {
    try {
      if (!recordingInput) {
        if (recordingPerformance || performanceRecorder.current) throw new Error(t("videoRecordingNow"));
        if (replayingInput) throw new Error(t("stopReplayFirst"));
        renderer.current?.restartMotion();
        await window.puppetloom.inputRecording("start");
        setRecordingInput(true);
        setSessionMessage(undefined);
        setRecordingClock({ kind: "input", startedAt: Date.now() });
      } else {
        const result = await window.puppetloom.inputRecording("stop");
        setRecordingInput(false);
        setRecordingClock(undefined);
        setSessionMessage({ text: t("motionSaved"), ...(result.output ? { path: result.output } : {}) });
      }
    } catch (cause) {
      setRecordingInput(false);
      setRecordingClock(undefined);
      setSessionMessage({ text: `모션 데이터 녹화에 실패함: ${messageOf(cause)}` });
    }
  }

  async function toggleInputReplay(): Promise<void> {
    try {
      if (replayingInput) {
        await window.puppetloom.inputReplay("stop");
        setReplayingInput(false);
        setTransientMessage(t("replayStopped"));
      } else {
        if (recordingInput) throw new Error(t("stopMotionRecordFirst"));
        const result = await window.puppetloom.inputReplay("start");
        if (result.canceled) return;
        setReplayingInput(true);
        setSessionMessage(undefined);
        setTransientMessage(t("replayingIsolated"));
      }
    } catch (cause) {
      setReplayingInput(false);
      setSessionMessage({ text: `모션 데이터 재생에 실패함: ${messageOf(cause)}` });
    }
  }

  function recordingOptions(): PerformanceRecordingOptions {
    const width = Math.round(recordingSettings.width);
    const height = Math.round(recordingSettings.height);
    if (!Number.isInteger(width) || width < 64 || width > 4096 || !Number.isInteger(height) || height < 64 || height > 4096) throw new Error(t("recordingSizeError"));
    if (!Number.isFinite(recordingSettings.durationSeconds) || recordingSettings.durationSeconds < 0 || recordingSettings.durationSeconds > 3600) throw new Error(t("recordingDurationError"));
    const solidColors: Record<Exclude<RecordingBackgroundChoice, "transparent" | "custom">, string> = { black: "#000000", white: "#ffffff", green: "#00ff00" };
    const background = recordingSettings.background === "transparent"
      ? { mode: "transparent" as const }
      : { mode: "solid" as const, color: recordingSettings.background === "custom" ? recordingSettings.backgroundColor : solidColors[recordingSettings.background] };
    return {
      fps: recordingSettings.fps,
      width,
      height,
      background,
      ...(recordingSettings.durationSeconds > 0 ? { targetDurationMs: Math.round(recordingSettings.durationSeconds * 1000) } : {})
    };
  }

  async function startConfiguredPerformanceRecording(): Promise<void> {
    try {
      if (performanceRecorder.current || finishingPerformance.current) throw new Error(t("performanceStillFinishing"));
      if (!canvas.current) throw new Error(t("canvasNotReady"));
      if (!renderer.current) throw new Error(t("rendererNotReady"));
      if (recordingInput) throw new Error(t("stopSoloMotionFirst"));
      if (replayingInput) throw new Error(t("stopReplayFirst"));
      const options = recordingOptions();
      setRecordingPreview(undefined);
      if (recordingSettings.includeMotionData) {
        renderer.current?.restartMotion();
        await window.puppetloom.inputRecording("start");
        performanceOwnsInput.current = true;
        setRecordingInput(true);
      } else performanceOwnsInput.current = false;
      try {
        performanceRecorder.current = await startPerformanceRecording(
          canvas.current,
          options,
          recordingSettings.includeAudio ? microphoneInput.current?.mediaStream : undefined,
          renderer.current
        );
      } catch (cause) {
        const input = performanceOwnsInput.current ? await window.puppetloom.inputRecording("stop").catch(() => undefined) : undefined;
        performanceOwnsInput.current = false;
        setRecordingInput(false);
        if (input?.output) setSessionMessage({ text: `영상을 시작하지 못함. 모션 데이터는 따로 저장됨: ${messageOf(cause)}`, path: input.output });
        throw cause;
      }
      setRecordingPerformance(true);
      setRecordingFinalizing(false);
      setRecordingClock({ kind: "video", startedAt: Date.now(), ...(options.targetDurationMs === undefined ? {} : { targetDurationMs: options.targetDurationMs }) });
      setShowRecordingSettings(false);
      setShowActions(false);
      setSessionMessage(undefined);
      if (options.targetDurationMs !== undefined) performanceStopTimer.current = window.setTimeout(() => void finishPerformanceRecording(), options.targetDurationMs);
    } catch (cause) {
      if (!performanceRecorder.current) {
        setRecordingPerformance(false);
        setRecordingClock(undefined);
        setSessionMessage((current) => current?.path ? current : { text: `영상 녹화에 실패함: ${messageOf(cause)}` });
      }
    }
  }

  async function finishPerformanceRecording(): Promise<void> {
    const activeRecorder = performanceRecorder.current;
    if (!activeRecorder || finishingPerformance.current) return;
    finishingPerformance.current = true;
    performanceRecorder.current = undefined;
    setRecordingPerformance(false);
    setRecordingFinalizing(true);
    setRecordingClock(undefined);
    if (performanceStopTimer.current !== undefined) window.clearTimeout(performanceStopTimer.current);
    performanceStopTimer.current = undefined;
    let inputSession: PerformanceRecordingInputSession | undefined;
    let inputError = "";
    try {
      if (performanceOwnsInput.current) {
        try {
          const input = await window.puppetloom.inputRecording("stop");
          if (!input.output || input.durationMs === undefined || input.events === undefined) throw new Error("입력 서비스가 완전한 세션 요약을 반환하지 않았습니다.");
          inputSession = { output: input.output, durationMs: input.durationMs, events: input.events };
        } catch (cause) {
          inputError = messageOf(cause);
        } finally {
          performanceOwnsInput.current = false;
          setRecordingInput(false);
        }
      }
      const result = await activeRecorder.stop(inputSession);
      let previewFailure = "";
      try {
        const url = await window.puppetloom.projectMediaUrl(projectDirectory, result.relativeOutput);
        setRecordingPreview({
          url,
          output: result.output,
          ...(inputError ? { note: "영상은 저장됨. 모션 데이터는 완전히 저장되지 않음: " + inputError } : inputSession ? { note: "영상과 모션 데이터가 모두 저장됨." } : {})
        });
        setSessionMessage(undefined);
      } catch (cause) {
        previewFailure = messageOf(cause);
        setSessionMessage({
          text: [inputError ? "영상은 저장됐지만 모션 데이터는 완전히 저장되지 않음: " + inputError : "영상이 저장됨", "미리보기를 읽지 못함: " + previewFailure].join(" · "),
          path: result.output
        });
      }
    } catch (cause) {
      setSessionMessage({ text: `영상 녹화에 실패함: ${messageOf(cause)}` });
    } finally {
      finishingPerformance.current = false;
      setRecordingFinalizing(false);
    }
  }

  async function togglePerformanceRecording(): Promise<void> {
    if (performanceRecorder.current) await finishPerformanceRecording();
    else if (!recordingFinalizing) {
      setShowActions(false);
      if (!showRecordingSettings) setRecordingPreview(undefined);
      setShowRecordingSettings(!showRecordingSettings);
    }
  }

  async function triggerTarget(target: { behaviorId?: string; expressionId?: string }): Promise<void> {
    try {
      await window.puppetloom.triggerRuntimeTarget(target);
      const selected = target.behaviorId
        ? runtimeDescriptor?.behaviors.find((value) => value.id === target.behaviorId)?.name
        : runtimeDescriptor?.expressions.find((value) => value.id === target.expressionId)?.name;
      setTransientMessage(`트리거됨: ${selected ?? target.behaviorId ?? target.expressionId}`);
    } catch (cause) {
      setSessionMessage({ text: `트리거에 실패함: ${messageOf(cause)}` });
    }
  }

  async function dismissInputStatus(kind: "camera" | "microphone"): Promise<void> {
    if (kind === "camera") {
      const input = cameraInput.current;
      cameraInput.current = undefined;
      await input?.stop().catch(() => undefined);
      await window.puppetloom.releaseRuntimeSource("camera").catch(() => undefined);
      setCameraStatus({ state: "stopped", message: t("cameraOffStatus") });
    } else {
      const input = microphoneInput.current;
      microphoneInput.current = undefined;
      await input?.stop().catch(() => undefined);
      await window.puppetloom.releaseRuntimeSource("microphone").catch(() => undefined);
      setMicrophoneStatus({ state: "stopped", message: t("micOffStatus") });
    }
  }

  async function toggleSpoutOutput(): Promise<void> {
    try {
      const status = spoutStatus?.active
        ? await window.puppetloom.spoutOutput("stop")
        : await window.puppetloom.spoutOutput("start", { name: project ? `${project.name} · PuppetLoom` : "PuppetLoom", width: Math.round(recordingSettings.width), height: Math.round(recordingSettings.height), fps: recordingSettings.fps });
      setSpoutStatus(status);
      setTransientMessage(status.message);
    } catch (cause) {
      setSessionMessage({ text: `Spout2 출력에 실패함: ${messageOf(cause)}` });
    }
  }

  async function selectCharacterState(next: CharacterStateSelection): Promise<void> {
    try {
      await window.puppetloom.setRuntimeSource({ id: "viewer-character-state", priority: 45, blend: 1, characterState: next });
      setSelectedCharacterState(next);
    } catch (cause) { setSessionMessage({ text: `상태 전환에 실패함: ${messageOf(cause)}` }); }
  }

  async function refreshTakes(): Promise<void> { try { setTakes(await window.puppetloom.listTakes()); } catch (cause) { setSessionMessage({ text: `Take 목록을 읽지 못함: ${messageOf(cause)}` }); } }
  async function importTake(): Promise<void> { try { const take = await window.puppetloom.importTake(); if (take) { await refreshTakes(); setTransientMessage(`Take를 가져옴: ${take.name}`); } } catch (cause) { setSessionMessage({ text: `Take 가져오기에 실패함: ${messageOf(cause)}` }); } }
  async function saveTakeEdit(): Promise<void> {
    if (!takeEdit) return;
    try {
      const edited = await window.puppetloom.editTake(takeEdit.id, { trim: { startMs: Math.round(takeEdit.startSeconds * 1000), endMs: Math.round(takeEdit.endSeconds * 1000) }, speed: takeEdit.speed, smoothWindow: takeEdit.smoothWindow });
      await refreshTakes(); setTakeEdit(undefined); setTransientMessage(`편집본을 만듦: ${edited.name}`);
    } catch (cause) { setSessionMessage({ text: `Take 편집에 실패함: ${messageOf(cause)}` }); }
  }

  return (
    <main
      className={`viewer ${output ? "is-output" : ""} ${draggingWindow ? "is-window-dragging" : ""}`}
      data-testid="viewer"
      aria-label={project?.name ?? t("viewerAria")}
      onWheel={zoomViewerWithWheel}
      onPointerDown={beginViewerDrag}
      onPointerMove={moveViewerDrag}
      onPointerUp={endViewerDrag}
      onPointerCancel={endViewerDrag}
      onLostPointerCapture={endViewerDrag}
    >
      <canvas ref={canvas} className="puppet-canvas" />
      <div className="drag-strip" title={t("dragHint", { source: sourceLabel || t("readingPreview") })}><span>{project?.name ?? t("loading")}</span><small>{sourceLabel || t("readingPreview")}</small></div>
      {showActions && runtimeDescriptor && <aside className="action-panel" aria-label={t("expressionsActions")}>
        <div className="action-group"><strong>{t("expressions")}</strong>{runtimeDescriptor.expressions.map((expression, index) => { const key = `CommandOrControl+Shift+${index + 1}`; return <button className="with-icon" key={expression.id} onClick={() => void triggerTarget({ expressionId: expression.id })} title={index < 4 ? capabilities.hotkeys[key] ? t("hotkey", { n: index + 1 }) : t("hotkeyUnavailable") : expression.id}><Smile aria-hidden="true" />{expression.name}</button>; })}</div>
        <div className="action-group"><strong>{t("actions")}</strong>{runtimeDescriptor.behaviors.map((behavior, index) => { const key = `CommandOrControl+Shift+${index + 5}`; return <button className="with-icon" key={behavior.id} onClick={() => void triggerTarget({ behaviorId: behavior.id })} title={index < 4 ? capabilities.hotkeys[key] ? t("hotkey", { n: index + 5 }) : t("hotkeyUnavailable") : behavior.id}><Activity aria-hidden="true" />{behavior.name}</button>; })}</div>
        {runtimeDescriptor.production && <><div className="action-group character-presets"><strong>{t("statePresets")}</strong>{runtimeDescriptor.production.presets.map((preset) => <button className={selectedCharacterState.presetId === preset.id ? "is-active" : ""} key={preset.id} onClick={() => void selectCharacterState({ presetId: preset.id })}>{preset.name}</button>)}</div><div className="action-group character-variants"><strong>{t("outfitsStyles")}</strong>{runtimeDescriptor.production.variants.map((group) => <label key={group.id}><span>{group.name}</span><select value={selectedCharacterState.variants?.[group.id] ?? group.defaultOptionId} onChange={(event) => void selectCharacterState({ variants: { ...(selectedCharacterState.variants ?? {}), [group.id]: event.target.value }, ...(selectedCharacterState.props ? { props: selectedCharacterState.props } : {}) })}>{group.options.map((option) => <option value={option.id} key={option.id}>{option.name}</option>)}</select></label>)}</div><div className="action-group character-props"><strong>{t("props")}</strong>{runtimeDescriptor.production.props.map((prop) => { const selected = selectedCharacterState.props?.includes(prop.id) ?? prop.defaultEnabled ?? false; return <label key={prop.id}><input type="checkbox" checked={selected} onChange={(event) => { const current = new Set(selectedCharacterState.props ?? runtimeDescriptor.production!.props.filter((value) => value.defaultEnabled).map((value) => value.id)); event.target.checked ? current.add(prop.id) : current.delete(prop.id); void selectCharacterState({ ...(selectedCharacterState.variants ? { variants: selectedCharacterState.variants } : {}), props: [...current] }); }} />{prop.name}</label>; })}</div></>}
        {Object.entries(capabilities.hotkeys).some(([key, available]) => key !== "CommandOrControl+Shift+P" && !available) && <p className="hotkey-warning">{t("hotkeyWarning")}</p>}
      </aside>}
      {showRecordingSettings && !recordingPerformance && <aside className="recording-panel" aria-label={t("recordingSettings")}>
        <div className="recording-panel-heading"><strong>{t("videoRecording")}</strong><button aria-label={t("closeRecordingSettings")} onClick={() => setShowRecordingSettings(false)}><X aria-hidden="true" /></button></div>
        <label><span>{t("background")}</span><select aria-label={t("recordingBackground")} value={recordingSettings.background} onChange={(event) => setRecordingSettings((current) => ({ ...current, background: event.target.value as RecordingBackgroundChoice }))}><option value="transparent">{t("transparent")}</option><option value="black">{t("black")}</option><option value="white">{t("white")}</option><option value="green">{t("greenScreen")}</option><option value="custom">{t("customSolid")}</option></select></label>
        {recordingSettings.background === "custom" && <label><span>배경색</span><input aria-label="사용자 지정 녹화 배경색" type="color" value={recordingSettings.backgroundColor} onChange={(event) => setRecordingSettings((current) => ({ ...current, backgroundColor: event.target.value }))} /></label>}
        <div className="recording-grid">
          <label><span>너비</span><input aria-label="녹화 너비" type="number" min="64" max="4096" step="1" value={recordingSettings.width} onChange={(event) => setRecordingSettings((current) => ({ ...current, width: Number(event.target.value) }))} /></label>
          <label><span>높이</span><input aria-label="녹화 높이" type="number" min="64" max="4096" step="1" value={recordingSettings.height} onChange={(event) => setRecordingSettings((current) => ({ ...current, height: Number(event.target.value) }))} /></label>
          <label><span>프레임레이트</span><select aria-label="녹화 프레임레이트" value={recordingSettings.fps} onChange={(event) => setRecordingSettings((current) => ({ ...current, fps: Number(event.target.value) as ViewerRecordingSettings["fps"] }))}><option value="24">24 FPS</option><option value="30">30 FPS</option><option value="60">60 FPS</option></select></label>
          <label><span>자동 정지</span><input aria-label="녹화 시간(초)" type="number" min="0" max="3600" step="1" value={recordingSettings.durationSeconds} onChange={(event) => setRecordingSettings((current) => ({ ...current, durationSeconds: Number(event.target.value) }))} /><small>초, 0은 수동</small></label>
        </div>
        <label className="recording-checkbox"><input type="checkbox" checked={recordingSettings.includeAudio} disabled={!microphoneInput.current?.mediaStream} onChange={(event) => setRecordingSettings((current) => ({ ...current, includeAudio: event.target.checked }))} /><span>{microphoneInput.current?.mediaStream ? "켜진 마이크 트랙을 녹음" : "마이크를 먼저 켜야 오디오를 녹음할 수 있음"}</span></label>
        <label className="recording-checkbox recording-data-option"><input type="checkbox" checked={recordingSettings.includeMotionData} onChange={(event) => setRecordingSettings((current) => ({ ...current, includeMotionData: event.target.checked }))} /><span><strong>모션 데이터도 함께 저장</strong><small>같은 프로젝트 버전에서 마우스 따라가기, 얼굴 추적, 립싱크, 표정, 동작, 외부 제어를 다시 재생합니다. 웹캠 원본이나 소리는 포함되지 않습니다.</small></span></label>
        <p>영상은 선택한 크기에 맞춰 비율을 유지한 채 가운데 정렬되어 WebM으로 저장되며, 캐릭터는 늘어나지 않습니다. 모션 데이터는 선택적인 별도 JSON이며, 일반 녹화에는 켜지 않아도 됩니다.</p>
        <button className="recording-start with-icon" disabled={recordingInput || replayingInput} onClick={() => void startConfiguredPerformanceRecording()}><Video aria-hidden="true" />영상 녹화 시작</button>
        <section className="spout-output"><strong>Spout2 공유 텍스처</strong><p>위의 너비·높이와 프레임레이트로 D3D11을 통해 투명 화면을 공유합니다. OBS, TouchDesigner 등에서 센더 이름이 보입니다.</p><button className={`with-icon ${spoutStatus?.active ? "is-active" : ""}`} disabled={spoutStatus?.supported === false} onClick={() => void toggleSpoutOutput()}><RadioTower aria-hidden="true" />{spoutStatus?.active ? "Spout2 출력 중지" : "Spout2 출력 시작"}</button>{spoutStatus?.active && <small>{spoutStatus.senderName} · {spoutStatus.width}×{spoutStatus.height} · {spoutStatus.fps} FPS · {spoutStatus.frames ?? 0}프레임 전송됨{spoutStatus.droppedFrames ? ` · ${spoutStatus.droppedFrames}프레임 드롭` : ""}</small>}{spoutStatus?.supported === false && <small>{spoutStatus.message}</small>}</section>
        <details className="recording-advanced">
          <summary><ChevronRight aria-hidden="true" />모션 데이터 도구</summary>
          <p>모션 데이터만 따로 기록하거나 재생합니다. 캐릭터를 수정한 뒤 같은 입력으로 비교하거나 문제를 찾을 때 유용합니다. 재생 중에는 실시간 소스가 잠시 격리됩니다.</p>
          <div>
            <button className={`with-icon ${recordingInput ? "is-recording" : ""}`} disabled={replayingInput} onClick={() => void toggleInputRecording()}>{recordingInput ? <Square aria-hidden="true" /> : <FileJson2 aria-hidden="true" />}{recordingInput ? "중지하고 모션 데이터 저장" : "모션 데이터만 녹화"}</button>
            <button className={`with-icon ${replayingInput ? "is-active" : ""}`} disabled={recordingInput} onClick={() => void toggleInputReplay()}><Repeat2 aria-hidden="true" />{replayingInput ? "모션 데이터 재생 중지" : "모션 데이터 재생"}</button>
          </div>
          <section className="take-library"><header><strong>Take 라이브러리</strong><span><button onClick={() => void importTake()}>가져오기</button><button onClick={() => void refreshTakes()}>새로고침</button></span></header>{takes.length === 0 ? <p>가져온 Take가 없습니다. 원본 모션 세션과 각 편집본은 따로 보관됩니다.</p> : takes.map((take) => <article key={take.id}><div><strong>{take.name}</strong><small>{formatDuration(take.durationMs)} · {take.events}개 이벤트{take.parentTakeId ? " · 편집본" : ""}</small></div><span><button onClick={() => { void window.puppetloom.replayTake(take.id).then(() => setReplayingInput(true)).catch((cause) => setSessionMessage({ text: messageOf(cause) })); }}>재생</button><button onClick={() => setTakeEdit({ id: take.id, startSeconds: 0, endSeconds: take.durationMs / 1000, speed: 1, smoothWindow: 1 })}>편집</button></span></article>)}{takeEdit && <div className="take-editor"><strong>비파괴 편집본 만들기</strong><label>시작(초)<input type="number" min="0" step="0.1" value={takeEdit.startSeconds} onChange={(event) => setTakeEdit({ ...takeEdit, startSeconds: Number(event.target.value) })} /></label><label>끝(초)<input type="number" min="0.1" step="0.1" value={takeEdit.endSeconds} onChange={(event) => setTakeEdit({ ...takeEdit, endSeconds: Number(event.target.value) })} /></label><label>속도<select value={takeEdit.speed} onChange={(event) => setTakeEdit({ ...takeEdit, speed: Number(event.target.value) })}><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><label>스무딩 윈도우<input type="number" min="1" max="120" step="1" value={takeEdit.smoothWindow} onChange={(event) => setTakeEdit({ ...takeEdit, smoothWindow: Number(event.target.value) })} /></label><span><button onClick={() => setTakeEdit(undefined)}>취소</button><button className="primary" onClick={() => void saveTakeEdit()}>새 버전 저장</button></span></div>}</section>
        </details>
      </aside>}
      {recordingPreview && <aside className="recording-preview" aria-label="영상 녹화 미리보기"><div><strong>방금 저장한 영상</strong><button aria-label="영상 녹화 미리보기 닫기" onClick={() => setRecordingPreview(undefined)}><X aria-hidden="true" /></button></div><video aria-label="영상 녹화 미리보기" controls src={recordingPreview.url} />{recordingPreview.note && <p>{recordingPreview.note}</p>}<button className="with-icon" onClick={() => void window.puppetloom.revealPath(recordingPreview.output)}><FolderOpen aria-hidden="true" />폴더에서 보기</button></aside>}
      <nav className="viewer-controls" aria-label={t("viewerControls")}>
        <button className="icon-only" aria-label={t("shrinkViewer")} onClick={() => act("smaller")} title={t("shrinkViewer")}><Minus aria-hidden="true" /></button>
        <button className="icon-only" aria-label={t("enlargeViewer")} onClick={() => act("larger")} title={t("enlargeViewer")}><Plus aria-hidden="true" /></button>
        <button className={`icon-only ${state.paused ? "is-active" : ""}`} aria-label={state.paused ? t("resumePlayback") : t("pause")} aria-pressed={state.paused} onClick={() => act("pause")} title={state.paused ? t("resumePlayback") : t("pause")}>{state.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</button>
        <button className={`icon-only ${state.alwaysOnTop ? "is-active" : ""}`} aria-label={state.alwaysOnTop ? t("unpin") : t("pinTop")} aria-pressed={state.alwaysOnTop} onClick={() => act("top")} title={state.alwaysOnTop ? t("unpin") : t("pinTop")}><Pin aria-hidden="true" /></button>
        <button className={`icon-only ${state.mouseTracking ? "is-active" : ""}`} aria-label={state.mouseTracking ? "자율 관찰로 전환" : "마우스 따라가기로 전환"} aria-pressed={state.mouseTracking} onClick={() => act("pointer-tracking")} title={state.mouseTracking ? "현재 마우스를 따라갑니다. 클릭하면 자율 관찰로 전환" : "현재 자율 관찰 중입니다. 클릭하면 마우스 따라가기로 전환"}>{state.mouseTracking ? <MousePointer2 aria-hidden="true" /> : <Sparkles aria-hidden="true" />}</button>
        <button className={`icon-only ${cameraInput.current ? "is-active" : ""}`} aria-label={cameraInput.current ? "웹캠 얼굴 추적 끄기" : "웹캠 얼굴 추적 켜기"} aria-pressed={Boolean(cameraInput.current)} onClick={() => void toggleCamera()} title={cameraStatus.message}>{cameraInput.current ? <Camera aria-hidden="true" /> : <CameraOff aria-hidden="true" />}</button>
        <button className={`icon-only ${microphoneInput.current ? "is-active" : ""}`} aria-label={microphoneInput.current ? "마이크 립싱크 끄기" : "마이크 립싱크 켜기"} aria-pressed={Boolean(microphoneInput.current)} onClick={() => void toggleMicrophone()} title={microphoneStatus.message}>{microphoneInput.current ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}</button>
        <button disabled={recordingFinalizing} className={`icon-only ${recordingPerformance || recordingInput ? "is-recording" : showRecordingSettings || replayingInput || recordingFinalizing ? "is-active" : ""}`} aria-label={recordingFinalizing ? "영상 파일을 마무리하는 중" : recordingPerformance ? "중지하고 영상 저장" : "영상 녹화"} aria-pressed={recordingPerformance} onClick={() => void togglePerformanceRecording()} title={recordingFinalizing ? "영상 파일을 마무리하는 중입니다. 잠시만 기다리세요" : recordingPerformance ? "현재 캐릭터 영상을 중지하고 저장" : recordingInput ? "모션 데이터를 녹화 중입니다. 클릭하면 녹화 패널이 열립니다" : replayingInput ? "모션 데이터를 재생 중입니다. 클릭하면 녹화 패널이 열립니다" : "배경, 해상도, 프레임레이트, 길이, 오디오와 선택적 모션 데이터 설정"}>{recordingPerformance ? <Square aria-hidden="true" /> : <Video aria-hidden="true" />}</button>
        <button className={`icon-only ${showActions ? "is-active" : ""}`} aria-label={showActions ? "표정·동작 패널 닫기" : "표정·동작 패널 열기"} aria-pressed={showActions} onClick={() => { setShowRecordingSettings(false); setShowActions((value) => !value); }} title={Object.entries(capabilities.hotkeys).some(([key, available]) => key !== "CommandOrControl+Shift+P" && !available) ? "표정과 동작. 단축키가 사용 중이면 패널 버튼을 클릭하세요" : "표정과 동작. Ctrl+Shift+1…8로 빠르게 트리거"}><WandSparkles aria-hidden="true" /></button>
        <button className={`icon-only ${state.clickThrough ? "is-active" : ""}`} disabled={!state.clickThrough && capabilities.hotkeys["CommandOrControl+Shift+P"] === false} aria-label={state.clickThrough ? "마우스 관통 끄기" : "마우스 관통 켜기"} aria-pressed={state.clickThrough} onClick={() => act("click-through")} title={state.clickThrough ? "마우스 관통 끄기" : capabilities.hotkeys["CommandOrControl+Shift+P"] ? "마우스 관통 켜기. Ctrl+Shift+P로 마우스를 되돌리세요" : "복원 단축키가 다른 프로그램에 사용 중이어서 마우스 관통이 비활성화됨"}>{state.clickThrough ? <PointerOff aria-hidden="true" /> : <MousePointerClick aria-hidden="true" />}</button>
        <button className="icon-only viewer-close" aria-label="캐릭터 창 닫기" onClick={() => act("close")} title="캐릭터 창 닫기"><X aria-hidden="true" /></button>
      </nav>
      {state.clickThrough && <div className="shortcut-hint">{capabilities.hotkeys["CommandOrControl+Shift+P"] ? "Ctrl+Shift+P로 마우스 복원" : "복원 단축키가 사용 중입니다. 만들기 페이지의 원격 제어에서 마우스 관통을 끄세요"}</div>}
      <div className="viewer-status-stack">
      {spoutStatus?.active && <div className="spout-operation" role="status"><RadioTower aria-hidden="true" /><strong>Spout2 출력 중</strong><small>{spoutStatus.senderName} · {spoutStatus.width}×{spoutStatus.height}@{spoutStatus.fps}</small></div>}
      {recordingClock && <div className="recording-operation" role="timer" aria-live="off"><span className="recording-dot" aria-hidden="true" /><strong>{recordingClock.kind === "video" ? "영상 녹화 중" : "모션 데이터 녹화 중"}</strong><time>{formatDuration(recordingElapsedMs)}</time>{recordingClock.targetDurationMs !== undefined && <small>남은 {formatDuration(Math.max(0, recordingClock.targetDurationMs - recordingElapsedMs))}</small>}</div>}
      {recordingFinalizing && <div className="recording-operation is-finalizing" role="status"><strong>영상 파일을 마무리하는 중…</strong><small>마지막 데이터를 쓰고 미리보기를 준비 중입니다. 창을 닫지 마세요.</small></div>}
      {replayingInput && <div className="replay-operation" role="status"><Repeat2 aria-hidden="true" /><strong>모션 데이터를 재생하는 중</strong><small>실시간 입력이 잠시 격리됨</small></div>}
      {(cameraStatus.state === "starting" || cameraStatus.state === "calibrating" || cameraStatus.state === "lost" || cameraStatus.state === "error") && <div className={`input-status ${cameraStatus.state === "error" || cameraStatus.state === "lost" ? "is-error" : ""}`}><span>{cameraStatus.message}</span>{(cameraStatus.state === "error" || cameraStatus.state === "lost") && <button className="icon-only" aria-label="웹캠 알림 닫기" title="웹캠 알림 닫기" onClick={() => void dismissInputStatus("camera")}><X aria-hidden="true" /></button>}</div>}
      {(microphoneStatus.state === "starting" || microphoneStatus.state === "error") && <div className={`input-status microphone-status ${microphoneStatus.state === "error" ? "is-error" : ""}`}><span>{microphoneStatus.message}</span>{microphoneStatus.state === "error" && <button className="icon-only" aria-label="마이크 알림 닫기" title="마이크 알림 닫기" onClick={() => void dismissInputStatus("microphone")}><X aria-hidden="true" /></button>}</div>}
      {transientMessage && <div className="viewer-toast" role="status">{transientMessage}</div>}
      {sessionMessage && <div className="session-status" role="status"><strong>{sessionMessage.text}</strong>{sessionMessage.path && <code title={sessionMessage.path}>{sessionMessage.path}</code>}<span>{sessionMessage.path && <><button className="with-icon" onClick={() => void window.puppetloom.revealPath(sessionMessage.path!)}><FolderOpen aria-hidden="true" />폴더에서 보기</button><button className="with-icon" onClick={() => void window.puppetloom.copyText(sessionMessage.path!)}><ClipboardCopy aria-hidden="true" />경로 복사</button></>}<button className="icon-only" aria-label="알림 닫기" title="알림 닫기" onClick={() => setSessionMessage(undefined)}><X aria-hidden="true" /></button></span></div>}
      </div>
      {error && <div className="viewer-error">{error}</div>}
    </main>
  );
}

function DropField({ label, value, accept, optional, icon, disabled, onPick, onDrop, onClear, onReject }: {
  label: string;
  value: string;
  accept: string;
  optional?: boolean;
  icon: React.ReactNode;
  disabled?: boolean;
  onPick: () => Promise<void>;
  onDrop: (path: string) => void;
  onClear?: () => void;
  onReject?: (message: string) => void;
}): React.JSX.Element {
  const { t } = useLocale();
  const [dragging, setDragging] = useState(false);
  return (
    <section
      className={`drop-field ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (disabled) return;
        const file = event.dataTransfer.files[0];
        if (!file) return;
        if (!file.name.toLowerCase().match(accept)) { onReject?.(t("unsupportedFile", { name: file.name })); return; }
        onDrop(window.puppetloom.pathForFile(file));
      }}
    >
      <div className="drop-field-identity"><span className="field-icon" aria-hidden="true">{icon}</span><span><strong>{label}</strong>{optional && <span className="optional">{t("optional")}</span>}<small>{value || t("dropOrChoose")}</small></span></div>
      <span className="drop-field-actions">{value && onClear && <button disabled={disabled} className="with-icon clear-file" onClick={onClear}><X aria-hidden="true" />{t("clearFile")}</button>}<button disabled={disabled} className="with-icon" onClick={() => void onPick()}><FileUp aria-hidden="true" />{t("chooseFile")}</button></span>
    </section>
  );
}

function Report({ report }: { report: BuildReport }): React.JSX.Element {
  const { t } = useLocale();
  const cleanupLabel = report.importPreflight.cleanupMode === "preserve-all" ? t("keepAllPixels") : report.importPreflight.cleanupMode === "remove-all-tiny" ? t("removeAllTiny") : t("removeConfirmedNoise");
  const featureName = (feature: string) => { const key = featureKeys[feature]; return key ? t(key) : feature; };
  return (
    <section className="report" data-testid="build-report">
      <div><span>{t("rigLevel")}</span><strong>{rigLevelLabel(report.rigLevel, t)}</strong></div>
      <div><span>{t("safetyScale")}</span><strong>{report.safetyScale.toFixed(2)}</strong></div>
      <div><span>{t("keptLayers")}</span><strong>{report.layerCount}</strong></div>
      <div><span>{t("assetRequests")}</span><strong>{report.assetRequestCount}</strong></div>
      <div><span>{t("alphaComponents")}</span><strong>{report.importPreflight.sourceComponentCount}</strong></div>
      <div><span>{t("alphaPolicyLabel")}</span><strong>{cleanupLabel}</strong></div>
      <div><span>{t("actualCleanup")}</span><strong>{report.importPreflight.cleanupApplied ? t("cleanupCount", { count: report.importPreflight.confirmedNoiseComponentCount, pixels: report.importPreflight.confirmedNoisePixelCount }) : t("noPixelRemoval")}</strong></div>
      <div><span>{t("keptDetail")}</span><strong>{t("detailCount", { count: report.importPreflight.suspectedDetailComponentCount, pixels: report.importPreflight.suspectedDetailPixelCount })}</strong></div>
      <div><span>{t("smartSplit")}</span><strong>{report.importPreflight.componentSplitCount}</strong></div>
      <p>{t("enabledFeatures", { features: report.enabledFeatures.map(featureName).join(", ") || t("safetyMotionOnly") })}</p>
      {report.disabledFeatures.length > 0 && <p>{t("disabledFeatures", { features: report.disabledFeatures.map(featureName).join(", ") })}</p>}
      {report.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
    </section>
  );
}

function Creator({ onEdit }: { onEdit: (projectDirectory: string) => void }): React.JSX.Element {
  const { t, locale } = useLocale();
  const [productionSection, setProductionSection] = useState<"library" | "source">();
  const [input, setInput] = useState("");
  const [reference, setReference] = useState("");
  const [output, setOutput] = useState("");
  const [name, setName] = useState("");
  const [alphaCleanup, setAlphaCleanup] = useState<NonNullable<DesktopCreateRequest["alphaCleanup"]>>("automatic");
  const [inspection, setInspection] = useState<InspectionReport>();
  const [inspecting, setInspecting] = useState(false);
  const [report, setReport] = useState<BuildReport>();
  const [projectDirectory, setProjectDirectory] = useState("");
  const [viewerId, setViewerId] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [busySeconds, setBusySeconds] = useState(0);
  const [createPhase, setCreatePhase] = useState<DesktopCreatePhase>();
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [creatorCapabilities, setCreatorCapabilities] = useState<ViewerCapabilities>({ hotkeys: {} });
  const [exportBusy, setExportBusy] = useState(false);
  const [cubismEditorVersion, setCubismEditorVersion] = useState<'5.3'|'5.4'>('5.3');
  const [cubismRuntimeVersion, setCubismRuntimeVersion] = useState<'4.2'|'5.0'|'5.3'>('5.0');
  const inspectionGeneration = useRef(0);
  const createOperationId = useRef<string | undefined>(undefined);

  useEffect(() => { void window.puppetloom.recentProjects().then(setRecent).catch(() => setRecent([])); }, []);
  useEffect(() => { void window.puppetloom.viewerCapabilities().then(setCreatorCapabilities).catch(() => undefined); }, []);

  useEffect(() => window.puppetloom.onCreateProgress((progress) => {
    if (progress.operationId === createOperationId.current) setCreatePhase(progress.phase);
  }), []);

  useEffect(() => {
    setReport(undefined);
    setProjectDirectory("");
    setViewerId(undefined);
    setError("");
  }, [input, reference, output, name, alphaCleanup]);

  useEffect(() => {
    const generation = ++inspectionGeneration.current;
    setInspection(undefined);
    setError("");
    if (!input) { setInspecting(false); return; }
    setInspecting(true);
    const timer = window.setTimeout(() => {
      void window.puppetloom.inspect(input, alphaCleanup).then((result) => {
        if (generation === inspectionGeneration.current) setInspection(result);
      }).catch((cause) => {
        if (generation === inspectionGeneration.current) setError(t("inspectFailed", { error: messageOf(cause) }));
      }).finally(() => {
        if (generation === inspectionGeneration.current) setInspecting(false);
      });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [input, alphaCleanup, t]);

  useEffect(() => {
    if (!busy) { setBusySeconds(0); return; }
    const started = Date.now();
    const timer = window.setInterval(() => setBusySeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const ready = useMemo(() => Boolean(input && output && !busy), [input, output, busy]);
  const readinessMessage = busy ? t("readyBusy") : !input ? t("readyNeedPsd") : !output ? t("readyNeedOutput") : t("readyOk");

  async function choose(kind: "psd" | "reference" | "output"): Promise<void> {
    const result = kind === "psd" ? await window.puppetloom.choosePsd() : kind === "reference" ? await window.puppetloom.chooseReference() : await window.puppetloom.chooseOutput();
    if (!result) return;
    if (kind === "psd") setInput(result);
    else if (kind === "reference") setReference(result);
    else setOutput(result);
  }

  async function create(): Promise<void> {
    if (!ready) return;
    const operationId = crypto.randomUUID();
    createOperationId.current = operationId;
    setCreatePhase("importing");
    setBusy(true); setError(""); setReport(undefined); setProjectDirectory(""); setViewerId(undefined);
    try {
      const result = await window.puppetloom.create({ operationId, input, output, ...(reference ? { reference } : {}), ...(name.trim() ? { name: name.trim() } : {}), alphaCleanup, seed: 42 });
      setReport(result.report);
      setProjectDirectory(result.outputDirectory);
      void window.puppetloom.recentProjects().then(setRecent).catch(() => undefined);
    } catch (cause) {
      const detail = messageOf(cause);
      setError(detail.includes(t("userStoppedCreateZh")) || detail.includes(t("userStoppedCreateKo")) ? t("createStoppedSafe") : detail);
    } finally {
      createOperationId.current = undefined;
      setCreatePhase(undefined);
      setBusy(false);
    }
  }

  async function cancelCreate(): Promise<void> {
    const operationId = createOperationId.current;
    if (!operationId) return;
    const requested = await window.puppetloom.cancelCreate(operationId);
    if (requested) setError(t("stoppingSafe"));
  }

  async function openExisting(): Promise<void> {
    const directory = await window.puppetloom.chooseProject();
    if (!directory) return;
    setProjectDirectory(directory);
    onEdit(directory);
  }

  async function exportProject(format: "portable" | "web" | "cubism"): Promise<void> {
    if (!projectDirectory) return;
    setExportBusy(true); setError("");
    try {
      const result = await window.puppetloom.exportProject(projectDirectory, format, {editorVersion:cubismEditorVersion,runtimeVersion:cubismRuntimeVersion});
      const target = result?.outputDirectory ?? result?.output;
      if (target) { await window.puppetloom.revealPath(target); }
    } catch (cause) { setError(t("exportFailed", { error: messageOf(cause) })); }
    finally { setExportBusy(false); }
  }

  function openRecent(directory: string): void {
    setError("");
    onEdit(directory);
  }

  async function launch(): Promise<void> {
    if (!projectDirectory) return;
    const launched = await window.puppetloom.launchViewer(projectDirectory);
    setViewerId(launched.id);
  }

  async function controlRemote(action: ViewerAction): Promise<void> {
    if (viewerId === undefined) return;
    const next = await window.puppetloom.controlViewer(viewerId, action);
    if (!next) {
      setViewerId(undefined);
      setError(t("viewerClosed"));
    }
  }

  return (
    <main className="app-shell" data-testid="creator">
      <header className="creator-header">
        <div className="creator-header-copy">
          <div className="mark" aria-hidden="true"><Sparkles /></div>
          <div><span className="creator-eyebrow">{t("creatorEyebrow")}</span><h1>{t("creatorTitle")}</h1><p>{t("creatorLead")}</p></div>
        </div>
        <div className="creator-header-actions"><button className="secondary with-icon" onClick={() => setProductionSection("source")}><FileImage aria-hidden="true" />{t("sourcePrep")}</button><button className="secondary with-icon" onClick={() => setProductionSection("library")}><FolderKanban aria-hidden="true" />{t("projectCheck")}</button><button className="secondary open-project with-icon" onClick={() => void openExisting()}><FolderOpen aria-hidden="true" />{t("openExisting")}</button></div>
      </header>
      {productionSection ? <ProductionCenter initialSection={productionSection} onClose={() => setProductionSection(undefined)} onEdit={onEdit} /> : <div className="workflow">
        <section className="inputs">
          <div className="section-title"><FileImage aria-hidden="true" /><div><h2>{t("characterAssets")}</h2><p>{t("characterAssetsHint")}</p></div></div>
          <DropField label={t("layeredPsd")} value={input} accept="\\.psd$" icon={<FileImage />} disabled={busy} onPick={() => choose("psd")} onDrop={setInput} onClear={() => setInput("")} onReject={() => setError(t("rejectPsd"))} />
          <DropField label={t("originalImage")} value={reference} accept="\\.(png|jpe?g|webp)$" icon={<ImageIcon />} optional disabled={busy} onPick={() => choose("reference")} onDrop={setReference} onClear={() => setReference("")} onReject={() => setError(t("rejectReference"))} />
          <label className="text-field"><span>{t("projectName")} <small>{t("optional")}</small></span><input disabled={busy} value={name} maxLength={80} placeholder={t("projectNamePlaceholder")} onChange={(event) => setName(event.target.value)} /></label>
          <section className="output-field">
            <div className="drop-field-identity"><span className="field-icon" aria-hidden="true"><FolderOutput /></span><span><strong>{t("outputFolder")}</strong><small>{output || t("outputFolderEmpty")}</small></span></div>
            <button disabled={busy} className="with-icon" onClick={() => void choose("output")}><FolderOutput aria-hidden="true" />{t("chooseFolder")}</button>
          </section>
          <fieldset disabled={busy} className="alpha-policy"><legend>{t("alphaPolicy")}</legend><div className="alpha-default"><strong>{t("alphaDefaultTitle")}</strong><small>{t("alphaDefaultHint")}</small></div><details><summary><ChevronRight aria-hidden="true" />{t("advancedOptions")}</summary><label><input type="checkbox" name="preserve-alpha-noise" checked={alphaCleanup === "preserve-all"} onChange={(event) => setAlphaCleanup(event.target.checked ? "preserve-all" : "automatic")} /><span><strong>{t("preserveNoiseTitle")}</strong><small>{t("preserveNoiseHint")}</small></span></label></details></fieldset>
          <button className="primary with-icon" disabled={!ready} onClick={() => void create()}><Sparkles aria-hidden="true" />{busy ? `${createPhase === "importing" ? t("creatingImporting") : createPhase === "rigging" ? t("creatingRigging") : createPhase === "writing" ? t("creatingWriting") : createPhase === "validating" ? t("creatingValidating") : t("creatingPublishing")}${busySeconds ? t("creatingSeconds", { seconds: busySeconds }) : ""}` : t("createProject")}</button>
          <p className={"creation-readiness" + (ready ? " is-ready" : "")} role="status">{readinessMessage}</p>
          {busy && <button className="cancel-create with-icon" onClick={() => void cancelCreate()}><Square aria-hidden="true" />{t("cancelCreate")}</button>}
          <p className="policy">{t("createPolicy")}</p>
        </section>
        <aside className="status-panel">
            <div className="section-title"><ScanSearch aria-hidden="true" /><div><h2>{t("autoInspect")}</h2><p>{t("autoInspectHint")}</p></div></div>
            {inspecting && <div className="empty-state" role="status">{t("inspectingPsd")}</div>}
            {!inspecting && !inspection && !report && <div className="empty-state"><strong>{t("waitingAssetsTitle")}</strong><span>{t("waitingAssetsBody")}</span></div>}
            {inspection && !report && <section className="inspection">
              <div><span>{t("canvas")}</span><strong>{inspection.canvas.width} × {inspection.canvas.height}</strong></div>
              <div><span>{t("visibleLayers")}</span><strong>{inspection.visibleLayerCount}</strong></div>
              <div><span>{t("recognizedLayers")}</span><strong>{inspection.recognizedLayerCount}</strong></div>
              <div><span>{t("suggestedRig")}</span><strong>{rigLevelLabel(inspection.suggestedRigLevel, t)}</strong></div>
              <div><span>{t("alphaComponents")}</span><strong>{inspection.preflight.sourceComponentCount}</strong></div>
              <div><span>{t("alphaPolicyLabel")}</span><strong>{inspection.preflight.cleanupMode === "preserve-all" ? t("keepAllPixels") : inspection.preflight.cleanupMode === "automatic" ? t("removeConfirmedNoise") : t("removeAllTiny")}</strong></div>
              <div><span>{t("expectedRemoval")}</span><strong>{inspection.preflight.cleanupApplied ? t("cleanupCount", { count: inspection.preflight.confirmedNoiseComponentCount, pixels: inspection.preflight.confirmedNoisePixelCount }) : t("noPixelRemoval")}</strong></div>
              <div><span>{t("keptDetail")}</span><strong>{t("detailCount", { count: inspection.preflight.suspectedDetailComponentCount, pixels: inspection.preflight.suspectedDetailPixelCount })}</strong></div>
              <div><span>{t("componentSplit")}</span><strong>{inspection.preflight.componentSplitCount}</strong></div>
              {inspection.preflight.fallbackSplitCount > 0 && <div><span>{t("fallbackSplit")}</span><strong>{inspection.preflight.fallbackSplitCount}</strong></div>}
              {inspection.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
            </section>}
            {report && <Report report={report} />}
            {projectDirectory && <section className="result-actions">
              <p>{t("projectSaved")}<br/><code>{projectDirectory}</code></p><div className="path-actions"><button className="with-icon" onClick={() => void window.puppetloom.revealPath(projectDirectory)}><FolderOpen aria-hidden="true" />{t("showInFolder")}</button><button className="with-icon" onClick={() => void window.puppetloom.copyText(projectDirectory)}><ClipboardCopy aria-hidden="true" />{t("copyPath")}</button></div>
              <button className="primary with-icon" onClick={() => onEdit(projectDirectory)}><ExternalLink aria-hidden="true" />{t("openEditor")}</button>
              <button className="primary with-icon" onClick={() => void launch()}><Play aria-hidden="true" />{t("openViewer")}</button>
              <details className="export-center"><summary><FolderOutput aria-hidden="true" />{t("exportCenter")}</summary><p>{t("exportCenterHint")}</p><div><button disabled={exportBusy} onClick={() => void exportProject("portable")}>{t("portableProject")}</button><button disabled={exportBusy} onClick={() => void exportProject("web")}>{t("webObs")}</button></div>
                <label>{t("cubismEditorVersion")} <select disabled={exportBusy} value={cubismEditorVersion} onChange={event=>setCubismEditorVersion(event.target.value as '5.3'|'5.4')}><option value="5.3">Cubism 5.3.01 이상</option><option value="5.4">Cubism 5.4</option></select></label>
                <label>{t("cubismRuntimeVersion")} <select disabled={exportBusy} value={cubismRuntimeVersion} onChange={event=>setCubismRuntimeVersion(event.target.value as '4.2'|'5.0'|'5.3')}><option value="4.2">SDK 4.2</option><option value="5.0">SDK 5.0</option><option value="5.3">SDK 5.3</option></select></label>
                <p>{t("cubismExportHint")}</p><button disabled={exportBusy} onClick={() => void exportProject("cubism")}>{exportBusy ? t("exporting") : t("exportCubism")}</button>
              </details>
              {viewerId !== undefined && <div className="remote-controls">
                <button className="with-icon" onClick={() => void controlRemote("pause")}><Pause aria-hidden="true" />{t("pauseResume")}</button>
                <button className="with-icon" disabled={creatorCapabilities.hotkeys["CommandOrControl+Shift+P"] === false} title={creatorCapabilities.hotkeys["CommandOrControl+Shift+P"] === false ? t("clickThroughDisabled") : t("clickThrough")} onClick={() => void controlRemote("click-through")}><PointerOff aria-hidden="true" />{t("clickThrough")}</button>
                <button className="with-icon" onClick={() => void controlRemote("pointer-tracking")}><MousePointer2 aria-hidden="true" />{t("followOrAuto")}</button>
                <button className="with-icon" onClick={() => void controlRemote("top")}><Pin aria-hidden="true" />{t("alwaysOnTopToggle")}</button>
              </div>}
            </section>}
            {error && <div className="error" role="alert">{error}</div>}
        </aside>
        <section className="recent-projects" data-testid="recent-projects">
            <div className="recent-projects-heading">
              <div className="section-title compact"><FolderKanban aria-hidden="true" /><div><h2>{t("recentProjects")}</h2></div></div>
              <span>{recent.length > 0 ? t("recentCount", { count: recent.length }) : t("noRecords")}</span>
            </div>
            {recent.length > 0 ? <div className="recent-project-list">
              {recent.map((entry) => <button key={entry.directory} title={entry.directory} onClick={() => void openRecent(entry.directory)}>
                <span className="recent-project-icon" aria-hidden="true"><FolderKanban /></span>
                <span className="recent-project-copy">
                  <strong>{entry.name}</strong>
                  <span>{entry.directory}</span>
                </span>
                <time dateTime={entry.openedAt}>{recentProjectTime(entry.openedAt, locale, t("recentOpened"))}</time>
              </button>)}
            </div> : <div className="recent-projects-empty">
              <strong>{t("noRecentTitle")}</strong>
              <span>{t("noRecentBody")}</span>
            </div>}
        </section>
      </div>}
    </main>
  );
}

export function App(): React.JSX.Element {
  const { t } = useLocale();
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project");
  const revisionValue = params.get("revision");
  const revision = revisionValue !== null && Number.isInteger(Number(revisionValue)) && Number(revisionValue) >= 0 ? Number(revisionValue) : undefined;
  const [editorProject, setEditorProject] = useState(params.get("editor") === "1" && project ? project : "");
  if (params.get("viewer") === "1" && project) return <Viewer projectDirectory={project} output={params.get("output") === "spout"} {...(revision !== undefined ? { revision } : {})} />;
  const editing = Boolean(editorProject);
  return (
    <div className={`desktop-window ${editing ? "is-editor" : "is-creator"}`}>
      <WindowTitleBar title={editing ? t("editorTitle") : "PuppetLoom"} />
      <div className="desktop-window-body">
        {editorProject
          ? <Suspense fallback={<main className="editor-loading"><p>{t("editorLoading")}</p></main>}><EditorWorkspace projectDirectory={editorProject} onBack={() => setEditorProject("")} /></Suspense>
          : <Creator onEdit={setEditorProject} />}
      </div>
    </div>
  );
}
