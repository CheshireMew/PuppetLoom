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

function recentProjectTime(openedAt: string): string {
  const date = new Date(openedAt);
  if (Number.isNaN(date.getTime())) return "최근 열림";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function rigLevelLabel(level: PuppetLoomProject["rigLevel"]): string {
  return level === "semantic" ? "전체 시맨틱 바인딩" : level === "grouped" ? "그룹 바인딩" : "기본 바인딩";
}

const featureLabels: Record<string, string> = {
  headTurn: "머리 회전", bodyFollow: "몸 따라가기", gaze: "시선 따라가기", hairPhysics: "머리카락 물리", blink: "깜빡임", mouthMotion: "립싱크"
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
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<PuppetRenderer | undefined>(undefined);
  const [project, setProject] = useState<PuppetLoomProject>();
  const [sourceLabel, setSourceLabel] = useState("미리보기 소스를 읽는 중");
  const [capabilities, setCapabilities] = useState<ViewerCapabilities>({ hotkeys: {} });
  const [state, setState] = useState<ViewerState>({ paused: false, alwaysOnTop: true, clickThrough: false, mouseTracking: true, scale: 1 });
  const [error, setError] = useState("");
  const [cameraStatus, setCameraStatus] = useState<InputAdapterStatus>({ state: "stopped", message: "웹캠 얼굴 추적이 꺼져 있음" });
  const [microphoneStatus, setMicrophoneStatus] = useState<InputAdapterStatus>({ state: "stopped", message: "마이크 립싱크가 꺼져 있음" });
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
    if (next.reason === "finished") setTransientMessage("모션 데이터 재생이 완료됨");
    if (next.reason === "stopped") setTransientMessage("모션 데이터 재생이 중지됨");
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
      setCameraStatus({ state: "starting", message: "웹캠을 시작하는 중…" });
      const input = await startFaceInput(await window.puppetloom.runtimeAssets(), (motion) => {
        void window.puppetloom.setRuntimeSource({ id: "camera", priority: 55, blend: 1, ttlMs: 250, motion });
      }, setCameraStatus);
      cameraInput.current = input;
    } catch (cause) {
      setCameraStatus({ state: "error", message: `웹캠 얼굴 추적을 시작할 수 없음: ${messageOf(cause)}` });
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
      setMicrophoneStatus({ state: "starting", message: "마이크를 시작하는 중…" });
      const input = await startMicrophoneInput((motion) => {
        void window.puppetloom.setRuntimeSource({ id: "microphone", priority: 65, blend: 1, ttlMs: 250, motion });
      }, setMicrophoneStatus);
      microphoneInput.current = input;
    } catch (cause) {
      setMicrophoneStatus({ state: "error", message: `마이크 립싱크를 시작할 수 없음: ${messageOf(cause)}` });
      await window.puppetloom.releaseRuntimeSource("microphone");
    }
  }

  async function toggleInputRecording(): Promise<void> {
    try {
      if (!recordingInput) {
        if (recordingPerformance || performanceRecorder.current) throw new Error("영상이 녹화 중입니다. 먼저 영상 녹화를 종료하세요.");
        if (replayingInput) throw new Error("먼저 모션 데이터 재생을 중지하세요.");
        renderer.current?.restartMotion();
        await window.puppetloom.inputRecording("start");
        setRecordingInput(true);
        setSessionMessage(undefined);
        setRecordingClock({ kind: "input", startedAt: Date.now() });
      } else {
        const result = await window.puppetloom.inputRecording("stop");
        setRecordingInput(false);
        setRecordingClock(undefined);
        setSessionMessage({ text: "모션 데이터가 저장됨", ...(result.output ? { path: result.output } : {}) });
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
        setTransientMessage("모션 데이터 재생이 중지됨");
      } else {
        if (recordingInput) throw new Error("먼저 모션 데이터 녹화를 중지하세요.");
        const result = await window.puppetloom.inputReplay("start");
        if (result.canceled) return;
        setReplayingInput(true);
        setSessionMessage(undefined);
        setTransientMessage("모션 데이터를 재생하는 중. 실시간 입력은 잠시 격리됨");
      }
    } catch (cause) {
      setReplayingInput(false);
      setSessionMessage({ text: `모션 데이터 재생에 실패함: ${messageOf(cause)}` });
    }
  }

  function recordingOptions(): PerformanceRecordingOptions {
    const width = Math.round(recordingSettings.width);
    const height = Math.round(recordingSettings.height);
    if (!Number.isInteger(width) || width < 64 || width > 4096 || !Number.isInteger(height) || height < 64 || height > 4096) throw new Error("녹화 너비와 높이는 64~4096 사이의 정수여야 합니다.");
    if (!Number.isFinite(recordingSettings.durationSeconds) || recordingSettings.durationSeconds < 0 || recordingSettings.durationSeconds > 3600) throw new Error("자동 정지 시간은 0~3600초여야 합니다. 0은 수동 정지를 의미합니다.");
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
      if (performanceRecorder.current || finishingPerformance.current) throw new Error("현재 퍼포먼스 녹화가 아직 끝나지 않았습니다.");
      if (!canvas.current) throw new Error("캐릭터 캔버스가 아직 준비되지 않았습니다.");
      if (!renderer.current) throw new Error("캐릭터 렌더러가 아직 준비되지 않았습니다.");
      if (recordingInput) throw new Error("먼저 단독 모션 데이터 녹화를 종료하세요.");
      if (replayingInput) throw new Error("먼저 모션 데이터 재생을 중지하세요.");
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
      setCameraStatus({ state: "stopped", message: "웹캠 얼굴 추적이 꺼져 있음" });
    } else {
      const input = microphoneInput.current;
      microphoneInput.current = undefined;
      await input?.stop().catch(() => undefined);
      await window.puppetloom.releaseRuntimeSource("microphone").catch(() => undefined);
      setMicrophoneStatus({ state: "stopped", message: "마이크 립싱크가 꺼져 있음" });
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
      aria-label={project?.name ?? "PuppetLoom 뷰어"}
      onWheel={zoomViewerWithWheel}
      onPointerDown={beginViewerDrag}
      onPointerMove={moveViewerDrag}
      onPointerUp={endViewerDrag}
      onPointerCancel={endViewerDrag}
      onLostPointerCapture={endViewerDrag}
    >
      <canvas ref={canvas} className="puppet-canvas" />
      <div className="drag-strip" title={`눌러서 캐릭터 창을 드래그 · 휠로 확대/축소 · ${sourceLabel}`}><span>{project?.name ?? "불러오는 중"}</span><small>{sourceLabel}</small></div>
      {showActions && runtimeDescriptor && <aside className="action-panel" aria-label="표정과 동작">
        <div className="action-group"><strong>표정</strong>{runtimeDescriptor.expressions.map((expression, index) => { const key = `CommandOrControl+Shift+${index + 1}`; return <button className="with-icon" key={expression.id} onClick={() => void triggerTarget({ expressionId: expression.id })} title={index < 4 ? capabilities.hotkeys[key] ? `단축키 Ctrl+Shift+${index + 1}` : "시스템 단축키를 사용할 수 없습니다. 클릭해서 트리거하세요" : expression.id}><Smile aria-hidden="true" />{expression.name}</button>; })}</div>
        <div className="action-group"><strong>동작</strong>{runtimeDescriptor.behaviors.map((behavior, index) => { const key = `CommandOrControl+Shift+${index + 5}`; return <button className="with-icon" key={behavior.id} onClick={() => void triggerTarget({ behaviorId: behavior.id })} title={index < 4 ? capabilities.hotkeys[key] ? `단축키 Ctrl+Shift+${index + 5}` : "시스템 단축키를 사용할 수 없습니다. 클릭해서 트리거하세요" : behavior.id}><Activity aria-hidden="true" />{behavior.name}</button>; })}</div>
        {runtimeDescriptor.production && <><div className="action-group character-presets"><strong>상태 프리셋</strong>{runtimeDescriptor.production.presets.map((preset) => <button className={selectedCharacterState.presetId === preset.id ? "is-active" : ""} key={preset.id} onClick={() => void selectCharacterState({ presetId: preset.id })}>{preset.name}</button>)}</div><div className="action-group character-variants"><strong>의상과 스타일</strong>{runtimeDescriptor.production.variants.map((group) => <label key={group.id}><span>{group.name}</span><select value={selectedCharacterState.variants?.[group.id] ?? group.defaultOptionId} onChange={(event) => void selectCharacterState({ variants: { ...(selectedCharacterState.variants ?? {}), [group.id]: event.target.value }, ...(selectedCharacterState.props ? { props: selectedCharacterState.props } : {}) })}>{group.options.map((option) => <option value={option.id} key={option.id}>{option.name}</option>)}</select></label>)}</div><div className="action-group character-props"><strong>소품</strong>{runtimeDescriptor.production.props.map((prop) => { const selected = selectedCharacterState.props?.includes(prop.id) ?? prop.defaultEnabled ?? false; return <label key={prop.id}><input type="checkbox" checked={selected} onChange={(event) => { const current = new Set(selectedCharacterState.props ?? runtimeDescriptor.production!.props.filter((value) => value.defaultEnabled).map((value) => value.id)); event.target.checked ? current.add(prop.id) : current.delete(prop.id); void selectCharacterState({ ...(selectedCharacterState.variants ? { variants: selectedCharacterState.variants } : {}), props: [...current] }); }} />{prop.name}</label>; })}</div></>}
        {Object.entries(capabilities.hotkeys).some(([key, available]) => key !== "CommandOrControl+Shift+P" && !available) && <p className="hotkey-warning">일부 시스템 단축키가 다른 프로그램에 사용 중입니다. 패널 버튼은 그대로 사용할 수 있습니다.</p>}
      </aside>}
      {showRecordingSettings && !recordingPerformance && <aside className="recording-panel" aria-label="영상 녹화 설정">
        <div className="recording-panel-heading"><strong>영상 녹화</strong><button aria-label="영상 녹화 설정 닫기" onClick={() => setShowRecordingSettings(false)}><X aria-hidden="true" /></button></div>
        <label><span>배경</span><select aria-label="녹화 배경" value={recordingSettings.background} onChange={(event) => setRecordingSettings((current) => ({ ...current, background: event.target.value as RecordingBackgroundChoice }))}><option value="transparent">투명</option><option value="black">검정</option><option value="white">흰색</option><option value="green">그린 스크린</option><option value="custom">사용자 지정 단색</option></select></label>
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
      <nav className="viewer-controls" aria-label="캐릭터 창 제어">
        <button className="icon-only" aria-label="캐릭터 창 축소" onClick={() => act("smaller")} title="캐릭터 창 축소"><Minus aria-hidden="true" /></button>
        <button className="icon-only" aria-label="캐릭터 창 확대" onClick={() => act("larger")} title="캐릭터 창 확대"><Plus aria-hidden="true" /></button>
        <button className={`icon-only ${state.paused ? "is-active" : ""}`} aria-label={state.paused ? "재생 계속" : "일시정지"} aria-pressed={state.paused} onClick={() => act("pause")} title={state.paused ? "재생 계속" : "일시정지"}>{state.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</button>
        <button className={`icon-only ${state.alwaysOnTop ? "is-active" : ""}`} aria-label={state.alwaysOnTop ? "항상 위 해제" : "창을 항상 위"} aria-pressed={state.alwaysOnTop} onClick={() => act("top")} title={state.alwaysOnTop ? "항상 위 해제" : "창을 항상 위"}><Pin aria-hidden="true" /></button>
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
        if (!file.name.toLowerCase().match(accept)) { onReject?.(`${file.name}은(는) 지원되지 않습니다.`); return; }
        onDrop(window.puppetloom.pathForFile(file));
      }}
    >
      <div className="drop-field-identity"><span className="field-icon" aria-hidden="true">{icon}</span><span><strong>{label}</strong>{optional && <span className="optional">선택</span>}<small>{value || "여기로 끌어오거나 이 컴퓨터에서 선택"}</small></span></div>
      <span className="drop-field-actions">{value && onClear && <button disabled={disabled} className="with-icon clear-file" onClick={onClear}><X aria-hidden="true" />지우기</button>}<button disabled={disabled} className="with-icon" onClick={() => void onPick()}><FileUp aria-hidden="true" />파일 선택</button></span>
    </section>
  );
}

function Report({ report }: { report: BuildReport }): React.JSX.Element {
  const cleanupLabel = report.importPreflight.cleanupMode === "preserve-all" ? "모든 픽셀 유지" : report.importPreflight.cleanupMode === "remove-all-tiny" ? "모든 미세 연결 영역 제거" : "확인된 노이즈만 제거";
  return (
    <section className="report" data-testid="build-report">
      <div><span>바인딩 등급</span><strong>{rigLevelLabel(report.rigLevel)}</strong></div>
      <div><span>안전 스케일</span><strong>{report.safetyScale.toFixed(2)}</strong></div>
      <div><span>유지된 레이어</span><strong>{report.layerCount}</strong></div>
      <div><span>소재 요청</span><strong>{report.assetRequestCount}</strong></div>
      <div><span>Alpha 연결 영역</span><strong>{report.importPreflight.sourceComponentCount}</strong></div>
      <div><span>투명 픽셀 정책</span><strong>{cleanupLabel}</strong></div>
      <div><span>실제 정리</span><strong>{report.importPreflight.cleanupApplied ? `${report.importPreflight.confirmedNoiseComponentCount}곳 / ${report.importPreflight.confirmedNoisePixelCount}px` : "픽셀을 제거하지 않음"}</strong></div>
      <div><span>그림 디테일 유지</span><strong>{report.importPreflight.suspectedDetailComponentCount} / {report.importPreflight.suspectedDetailPixelCount}px</strong></div>
      <div><span>스마트 분할</span><strong>{report.importPreflight.componentSplitCount}</strong></div>
      <p>사용 중: {report.enabledFeatures.map((feature) => featureLabels[feature] ?? feature).join(", ") || "안전 전체 움직임만"}</p>
      {report.disabledFeatures.length > 0 && <p>소재가 부족해 사용하지 않음: {report.disabledFeatures.map((feature) => featureLabels[feature] ?? feature).join(", ")}</p>}
      {report.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
    </section>
  );
}

function Creator({ onEdit }: { onEdit: (projectDirectory: string) => void }): React.JSX.Element {
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
        if (generation === inspectionGeneration.current) setError(`PSD 검사에 실패함: ${messageOf(cause)}`);
      }).finally(() => {
        if (generation === inspectionGeneration.current) setInspecting(false);
      });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [input, alphaCleanup]);

  useEffect(() => {
    if (!busy) { setBusySeconds(0); return; }
    const started = Date.now();
    const timer = window.setInterval(() => setBusySeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const ready = useMemo(() => Boolean(input && output && !busy), [input, output, busy]);
  const readinessMessage = busy ? "만드는 중입니다. 현재 작업이 끝날 때까지 기다리세요." : !input ? "레이어 PSD를 선택하세요." : !output ? "프로젝트 출력 폴더를 선택하세요." : "소재와 출력 폴더가 준비됨.";

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
      setError(detail.includes("用户已停止创建") || detail.includes("만들기를 중지함") ? "만들기가 안전하게 중지됨. 최종 프로젝트 폴더는 게시되지 않았습니다. 임시 작업 증거는 남아 있어 확인하거나 복구할 수 있습니다." : detail);
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
    if (requested) setError("안전하게 중지하는 중: 이미 쓴 임시 작업 증거는 남고, 최종 프로젝트 폴더는 게시되지 않습니다.");
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
    } catch (cause) { setError(`내보내기에 실패함: ${messageOf(cause)}`); }
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
      setError("캐릭터 창이 이미 닫혔습니다. 다시 여세요.");
    }
  }

  return (
    <main className="app-shell" data-testid="creator">
      <header className="creator-header">
        <div className="creator-header-copy">
          <div className="mark" aria-hidden="true"><Sparkles /></div>
          <div><span className="creator-eyebrow">캐릭터 작업대</span><h1>캐릭터 프로젝트 만들기</h1><p>레이어 소재를 준비하면 PuppetLoom이 사전 검사, 바인딩, 프로젝트 초기화를 완료합니다.</p></div>
        </div>
        <div className="creator-header-actions"><button className="secondary with-icon" onClick={() => setProductionSection("source")}><FileImage aria-hidden="true" />소재 준비</button><button className="secondary with-icon" onClick={() => setProductionSection("library")}><FolderKanban aria-hidden="true" />프로젝트 점검</button><button className="secondary open-project with-icon" onClick={() => void openExisting()}><FolderOpen aria-hidden="true" />기존 프로젝트 열기</button></div>
      </header>
      {productionSection ? <ProductionCenter initialSection={productionSection} onClose={() => setProductionSection(undefined)} onEdit={onEdit} /> : <div className="workflow">
        <section className="inputs">
          <div className="section-title"><FileImage aria-hidden="true" /><div><h2>캐릭터 소재</h2><p>소스 파일을 고르고 프로젝트 위치를 지정</p></div></div>
          <DropField label="레이어 PSD" value={input} accept="\\.psd$" icon={<FileImage />} disabled={busy} onPick={() => choose("psd")} onDrop={setInput} onClear={() => setInput("")} onReject={() => setError(".psd 파일만 넣을 수 있습니다.")} />
          <DropField label="원본 캐릭터 이미지" value={reference} accept="\\.(png|jpe?g|webp)$" icon={<ImageIcon />} optional disabled={busy} onPick={() => choose("reference")} onDrop={setReference} onClear={() => setReference("")} onReject={() => setError("참고 이미지는 PNG, JPG, WebP만 지원합니다.")} />
          <label className="text-field"><span>프로젝트 이름 <small>선택</small></span><input disabled={busy} value={name} maxLength={80} placeholder="비워 두면 PSD 파일 이름을 사용" onChange={(event) => setName(event.target.value)} /></label>
          <section className="output-field">
            <div className="drop-field-identity"><span className="field-icon" aria-hidden="true"><FolderOutput /></span><span><strong>프로젝트 출력 폴더</strong><small>{output || "새 폴더 또는 빈 폴더를 선택하세요"}</small></span></div>
            <button disabled={busy} className="with-icon" onClick={() => void choose("output")}><FolderOutput aria-hidden="true" />폴더 선택</button>
          </section>
          <fieldset disabled={busy} className="alpha-policy"><legend>투명 픽셀 처리</legend><div className="alpha-default"><strong>확인된 노이즈 자동 정리</strong><small>Alpha는 항상 분석합니다. 기본값은 아주 작고 옅으며 고립된 고신뢰 노이즈만 제거하고, 하이라이트·잔머리·장식으로 보이는 부분은 유지합니다.</small></div><details><summary><ChevronRight aria-hidden="true" />고급 옵션</summary><label><input type="checkbox" name="preserve-alpha-noise" checked={alphaCleanup === "preserve-all"} onChange={(event) => setAlphaCleanup(event.target.checked ? "preserve-all" : "automatic")} /><span><strong>고신뢰 노이즈 모두 유지</strong><small>오탐 확인용입니다. 이 옵션과 관계없이 원본 PSD는 수정되지 않습니다.</small></span></label></details></fieldset>
          <button className="primary with-icon" disabled={!ready} onClick={() => void create()}><Sparkles aria-hidden="true" />{busy ? `${createPhase === "importing" ? "PSD를 읽는 중" : createPhase === "rigging" ? "바인딩을 만드는 중" : createPhase === "writing" ? "텍스처와 프로젝트를 쓰는 중" : createPhase === "validating" ? "전체 출력을 검증하는 중" : "최종 프로젝트를 게시하는 중"}${busySeconds ? ` · ${busySeconds}초` : ""}` : "캐릭터 프로젝트 만들기"}</button>
          <p className={"creation-readiness" + (ready ? " is-ready" : "")} role="status">{readinessMessage}</p>
          {busy && <button className="cancel-create with-icon" onClick={() => void cancelCreate()}><Square aria-hidden="true" />안전하게 만들기 중지</button>}
          <p className="policy">3단계 입 모양이 없으면 입은 움직이지 않습니다. 연결된 뒤에는 가끔 한 번만 천천히 열고 닫으며, 소리 없이 계속 말하지는 않습니다. 눈 감기 소재가 없어도 만들기는 막히지 않습니다.</p>
        </section>
        <aside className="status-panel">
            <div className="section-title"><ScanSearch aria-hidden="true" /><div><h2>자동 검사</h2><p>인식 결과와 능력 사전 검사</p></div></div>
            {inspecting && <div className="empty-state" role="status">PSD 레이어와 투명 픽셀을 읽는 중…</div>}
            {!inspecting && !inspection && !report && <div className="empty-state"><strong>캐릭터 소재 대기</strong><span>레이어 PSD를 선택하면 레이어 인식, 권장 바인딩, 능력 제한이 여기에 표시됩니다.</span></div>}
            {inspection && !report && <section className="inspection">
              <div><span>캔버스</span><strong>{inspection.canvas.width} × {inspection.canvas.height}</strong></div>
              <div><span>보이는 레이어</span><strong>{inspection.visibleLayerCount}</strong></div>
              <div><span>인식된 레이어</span><strong>{inspection.recognizedLayerCount}</strong></div>
              <div><span>권장 바인딩</span><strong>{rigLevelLabel(inspection.suggestedRigLevel)}</strong></div>
              <div><span>Alpha 연결 영역</span><strong>{inspection.preflight.sourceComponentCount}</strong></div>
              <div><span>투명 픽셀 정책</span><strong>{inspection.preflight.cleanupMode === "preserve-all" ? "모든 픽셀 유지" : inspection.preflight.cleanupMode === "automatic" ? "확인된 노이즈만 제거" : "모든 미세 연결 영역 제거"}</strong></div>
              <div><span>예상 제거</span><strong>{inspection.preflight.cleanupApplied ? `${inspection.preflight.confirmedNoiseComponentCount}곳 / ${inspection.preflight.confirmedNoisePixelCount}px` : "픽셀을 제거하지 않음"}</strong></div>
              <div><span>그림 디테일 유지</span><strong>{inspection.preflight.suspectedDetailComponentCount} / {inspection.preflight.suspectedDetailPixelCount}px</strong></div>
              <div><span>연결 영역 분할</span><strong>{inspection.preflight.componentSplitCount}</strong></div>
              {inspection.preflight.fallbackSplitCount > 0 && <div><span>중심 폴백 분할</span><strong>{inspection.preflight.fallbackSplitCount}</strong></div>}
              {inspection.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
            </section>}
            {report && <Report report={report} />}
            {projectDirectory && <section className="result-actions">
              <p>프로젝트가 저장됨:<br/><code>{projectDirectory}</code></p><div className="path-actions"><button className="with-icon" onClick={() => void window.puppetloom.revealPath(projectDirectory)}><FolderOpen aria-hidden="true" />폴더에서 보기</button><button className="with-icon" onClick={() => void window.puppetloom.copyText(projectDirectory)}><ClipboardCopy aria-hidden="true" />경로 복사</button></div>
              <button className="primary with-icon" onClick={() => onEdit(projectDirectory)}><ExternalLink aria-hidden="true" />바인딩·캘리브레이션 에디터 열기</button>
              <button className="primary with-icon" onClick={() => void launch()}><Play aria-hidden="true" />투명 캐릭터 창 열기</button>
              <details className="export-center"><summary><FolderOutput aria-hidden="true" />내보내기 센터</summary><p>내보내기는 기존 폴더를 덮어쓰지 않습니다. 영상과 Take는 캐릭터 창에서 관리합니다.</p><div><button disabled={exportBusy} onClick={() => void exportProject("portable")}>이식 가능 프로젝트</button><button disabled={exportBusy} onClick={() => void exportProject("web")}>Web / OBS</button></div>
                <label>CMO3 에디터 버전 <select disabled={exportBusy} value={cubismEditorVersion} onChange={event=>setCubismEditorVersion(event.target.value as '5.3'|'5.4')}><option value="5.3">Cubism 5.3.01 이상</option><option value="5.4">Cubism 5.4</option></select></label>
                <label>MOC3 런타임 버전 <select disabled={exportBusy} value={cubismRuntimeVersion} onChange={event=>setCubismRuntimeVersion(event.target.value as '4.2'|'5.0'|'5.3')}><option value="4.2">SDK 4.2</option><option value="5.0">SDK 5.0</option><option value="5.3">SDK 5.3</option></select></label>
                <p>프로젝트 버전은 쓰는 Cubism 에디터에 맞추고, 런타임 버전은 모델을 받을 프로그램 요구에 맞춥니다.</p><button disabled={exportBusy} onClick={() => void exportProject("cubism")}>{exportBusy?'내보내는 중…':'CMO3 프로젝트와 MOC3 런타임'}</button>
              </details>
              {viewerId !== undefined && <div className="remote-controls">
                <button className="with-icon" onClick={() => void controlRemote("pause")}><Pause aria-hidden="true" />일시정지 / 계속</button>
                <button className="with-icon" disabled={creatorCapabilities.hotkeys["CommandOrControl+Shift+P"] === false} title={creatorCapabilities.hotkeys["CommandOrControl+Shift+P"] === false ? "복원 단축키가 사용 중이어서 마우스 관통이 꺼져 있음" : "마우스 관통 전환"} onClick={() => void controlRemote("click-through")}><PointerOff aria-hidden="true" />마우스 관통</button>
                <button className="with-icon" onClick={() => void controlRemote("pointer-tracking")}><MousePointer2 aria-hidden="true" />따라가기 / 자율</button>
                <button className="with-icon" onClick={() => void controlRemote("top")}><Pin aria-hidden="true" />항상 위 전환</button>
              </div>}
            </section>}
            {error && <div className="error" role="alert">{error}</div>}
        </aside>
        <section className="recent-projects" data-testid="recent-projects">
            <div className="recent-projects-heading">
              <div className="section-title compact"><FolderKanban aria-hidden="true" /><div><h2>최근 프로젝트</h2></div></div>
              <span>{recent.length > 0 ? `${recent.length}개` : "기록 없음"}</span>
            </div>
            {recent.length > 0 ? <div className="recent-project-list">
              {recent.map((entry) => <button key={entry.directory} title={entry.directory} onClick={() => void openRecent(entry.directory)}>
                <span className="recent-project-icon" aria-hidden="true"><FolderKanban /></span>
                <span className="recent-project-copy">
                  <strong>{entry.name}</strong>
                  <span>{entry.directory}</span>
                </span>
                <time dateTime={entry.openedAt}>{recentProjectTime(entry.openedAt)}</time>
              </button>)}
            </div> : <div className="recent-projects-empty">
              <strong>최근 프로젝트가 없음</strong>
              <span>프로젝트를 만들거나 열면 여기서 바로 들어갈 수 있습니다.</span>
            </div>}
        </section>
      </div>}
    </main>
  );
}

export function App(): React.JSX.Element {
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project");
  const revisionValue = params.get("revision");
  const revision = revisionValue !== null && Number.isInteger(Number(revisionValue)) && Number(revisionValue) >= 0 ? Number(revisionValue) : undefined;
  const [editorProject, setEditorProject] = useState(params.get("editor") === "1" && project ? project : "");
  if (params.get("viewer") === "1" && project) return <Viewer projectDirectory={project} output={params.get("output") === "spout"} {...(revision !== undefined ? { revision } : {})} />;
  const editing = Boolean(editorProject);
  return (
    <div className={`desktop-window ${editing ? "is-editor" : "is-creator"}`}>
      <WindowTitleBar title={editing ? "PuppetLoom · 바인딩·캘리브레이션 에디터" : "PuppetLoom"} />
      <div className="desktop-window-body">
        {editorProject
          ? <Suspense fallback={<main className="editor-loading"><p>에디터를 불러오는 중…</p></main>}><EditorWorkspace projectDirectory={editorProject} onBack={() => setEditorProject("")} /></Suspense>
          : <Creator onEdit={setEditorProject} />}
      </div>
    </div>
  );
}
