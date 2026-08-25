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
  if (Number.isNaN(date.getTime())) return "最近打开";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function rigLevelLabel(level: PuppetLoomProject["rigLevel"]): string {
  return level === "semantic" ? "完整语义绑定" : level === "grouped" ? "分组绑定" : "基础绑定";
}

const featureLabels: Record<string, string> = {
  headTurn: "头部转动", bodyFollow: "身体跟随", gaze: "视线跟随", hairPhysics: "头发物理", blink: "眨眼", mouthMotion: "口型"
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
  const [sourceLabel, setSourceLabel] = useState("正在读取预览来源");
  const [capabilities, setCapabilities] = useState<ViewerCapabilities>({ hotkeys: {} });
  const [state, setState] = useState<ViewerState>({ paused: false, alwaysOnTop: true, clickThrough: false, mouseTracking: true, scale: 1 });
  const [error, setError] = useState("");
  const [cameraStatus, setCameraStatus] = useState<InputAdapterStatus>({ state: "stopped", message: "摄像头面捕未启用" });
  const [microphoneStatus, setMicrophoneStatus] = useState<InputAdapterStatus>({ state: "stopped", message: "麦克风口型未启用" });
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
    const refresh = () => void window.puppetloom.spoutOutput("status").then((status) => { if (!disposed) setSpoutStatus(status); }).catch(() => undefined);
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
    if (next.reason === "finished") setTransientMessage("动作数据回放已完成");
    if (next.reason === "stopped") setTransientMessage("动作数据回放已停止");
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
      setCameraStatus({ state: "starting", message: "正在启动摄像头…" });
      const input = await startFaceInput(await window.puppetloom.runtimeAssets(), (motion) => {
        void window.puppetloom.setRuntimeSource({ id: "camera", priority: 55, blend: 1, ttlMs: 250, motion });
      }, setCameraStatus);
      cameraInput.current = input;
    } catch (cause) {
      setCameraStatus({ state: "error", message: `摄像头面捕无法启动：${messageOf(cause)}` });
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
      setMicrophoneStatus({ state: "starting", message: "正在启动麦克风…" });
      const input = await startMicrophoneInput((motion) => {
        void window.puppetloom.setRuntimeSource({ id: "microphone", priority: 65, blend: 1, ttlMs: 250, motion });
      }, setMicrophoneStatus);
      microphoneInput.current = input;
    } catch (cause) {
      setMicrophoneStatus({ state: "error", message: `麦克风口型无法启动：${messageOf(cause)}` });
      await window.puppetloom.releaseRuntimeSource("microphone");
    }
  }

  async function toggleInputRecording(): Promise<void> {
    try {
      if (!recordingInput) {
        if (recordingPerformance || performanceRecorder.current) throw new Error("视频正在录制，请先结束视频录制。" );
        if (replayingInput) throw new Error("请先停止动作数据回放。" );
        renderer.current?.restartMotion();
        await window.puppetloom.inputRecording("start");
        setRecordingInput(true);
        setSessionMessage(undefined);
        setRecordingClock({ kind: "input", startedAt: Date.now() });
      } else {
        const result = await window.puppetloom.inputRecording("stop");
        setRecordingInput(false);
        setRecordingClock(undefined);
        setSessionMessage({ text: "动作数据已保存", ...(result.output ? { path: result.output } : {}) });
      }
    } catch (cause) {
      setRecordingInput(false);
      setRecordingClock(undefined);
      setSessionMessage({ text: `动作数据录制失败：${messageOf(cause)}` });
    }
  }

  async function toggleInputReplay(): Promise<void> {
    try {
      if (replayingInput) {
        await window.puppetloom.inputReplay("stop");
        setReplayingInput(false);
        setTransientMessage("动作数据回放已停止");
      } else {
        if (recordingInput) throw new Error("请先停止动作数据录制。" );
        const result = await window.puppetloom.inputReplay("start");
        if (result.canceled) return;
        setReplayingInput(true);
        setSessionMessage(undefined);
        setTransientMessage("正在回放动作数据；实时输入已暂时隔离");
      }
    } catch (cause) {
      setReplayingInput(false);
      setSessionMessage({ text: `动作数据回放失败：${messageOf(cause)}` });
    }
  }

  function recordingOptions(): PerformanceRecordingOptions {
    const width = Math.round(recordingSettings.width);
    const height = Math.round(recordingSettings.height);
    if (!Number.isInteger(width) || width < 64 || width > 4096 || !Number.isInteger(height) || height < 64 || height > 4096) throw new Error("录制宽高必须是 64 到 4096 之间的整数。" );
    if (!Number.isFinite(recordingSettings.durationSeconds) || recordingSettings.durationSeconds < 0 || recordingSettings.durationSeconds > 3600) throw new Error("自动停止时长必须在 0 到 3600 秒之间；0 表示手动停止。" );
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
      if (performanceRecorder.current || finishingPerformance.current) throw new Error("当前表演录制尚未结束。" );
      if (!canvas.current) throw new Error("角色画布尚未准备好。" );
      if (!renderer.current) throw new Error("角色渲染器尚未准备好。" );
      if (recordingInput) throw new Error("请先结束单独的动作数据录制。" );
      if (replayingInput) throw new Error("请先停止动作数据回放。" );
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
        if (input?.output) setSessionMessage({ text: `视频未能开始；动作数据已单独保存：${messageOf(cause)}`, path: input.output });
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
        setSessionMessage((current) => current?.path ? current : { text: `视频录制失败：${messageOf(cause)}` });
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
          if (!input.output || input.durationMs === undefined || input.events === undefined) throw new Error("输入服务没有返回完整会话摘要。" );
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
          ...(inputError ? { note: "视频已保存；动作数据未能完整保存：" + inputError } : inputSession ? { note: "视频和动作数据均已保存。" } : {})
        });
        setSessionMessage(undefined);
      } catch (cause) {
        previewFailure = messageOf(cause);
        setSessionMessage({
          text: [inputError ? "视频已保存，但动作数据未能完整保存：" + inputError : "视频已保存", "预览读取失败：" + previewFailure].join("；"),
          path: result.output
        });
      }
    } catch (cause) {
      setSessionMessage({ text: `视频录制失败：${messageOf(cause)}` });
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
      setTransientMessage(`已触发：${selected ?? target.behaviorId ?? target.expressionId}`);
    } catch (cause) {
      setSessionMessage({ text: `触发失败：${messageOf(cause)}` });
    }
  }

  async function dismissInputStatus(kind: "camera" | "microphone"): Promise<void> {
    if (kind === "camera") {
      const input = cameraInput.current;
      cameraInput.current = undefined;
      await input?.stop().catch(() => undefined);
      await window.puppetloom.releaseRuntimeSource("camera").catch(() => undefined);
      setCameraStatus({ state: "stopped", message: "摄像头面捕未启用" });
    } else {
      const input = microphoneInput.current;
      microphoneInput.current = undefined;
      await input?.stop().catch(() => undefined);
      await window.puppetloom.releaseRuntimeSource("microphone").catch(() => undefined);
      setMicrophoneStatus({ state: "stopped", message: "麦克风口型未启用" });
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
      setSessionMessage({ text: `Spout2 输出失败：${messageOf(cause)}` });
    }
  }

  async function selectCharacterState(next: CharacterStateSelection): Promise<void> {
    try {
      await window.puppetloom.setRuntimeSource({ id: "viewer-character-state", priority: 45, blend: 1, characterState: next });
      setSelectedCharacterState(next);
    } catch (cause) { setSessionMessage({ text: `状态切换失败：${messageOf(cause)}` }); }
  }

  async function refreshTakes(): Promise<void> { try { setTakes(await window.puppetloom.listTakes()); } catch (cause) { setSessionMessage({ text: `Take 列表读取失败：${messageOf(cause)}` }); } }
  async function importTake(): Promise<void> { try { const take = await window.puppetloom.importTake(); if (take) { await refreshTakes(); setTransientMessage(`已导入 Take：${take.name}`); } } catch (cause) { setSessionMessage({ text: `Take 导入失败：${messageOf(cause)}` }); } }
  async function saveTakeEdit(): Promise<void> {
    if (!takeEdit) return;
    try {
      const edited = await window.puppetloom.editTake(takeEdit.id, { trim: { startMs: Math.round(takeEdit.startSeconds * 1000), endMs: Math.round(takeEdit.endSeconds * 1000) }, speed: takeEdit.speed, smoothWindow: takeEdit.smoothWindow });
      await refreshTakes(); setTakeEdit(undefined); setTransientMessage(`已创建编辑版：${edited.name}`);
    } catch (cause) { setSessionMessage({ text: `Take 编辑失败：${messageOf(cause)}` }); }
  }

  return (
    <main
      className={`viewer ${output ? "is-output" : ""} ${draggingWindow ? "is-window-dragging" : ""}`}
      data-testid="viewer"
      aria-label={project?.name ?? "PuppetLoom viewer"}
      onWheel={zoomViewerWithWheel}
      onPointerDown={beginViewerDrag}
      onPointerMove={moveViewerDrag}
      onPointerUp={endViewerDrag}
      onPointerCancel={endViewerDrag}
      onLostPointerCapture={endViewerDrag}
    >
      <canvas ref={canvas} className="puppet-canvas" />
      <div className="drag-strip" title={`按住拖动角色窗口 · 滚轮缩放 · ${sourceLabel}`}><span>{project?.name ?? "加载中"}</span><small>{sourceLabel}</small></div>
      {showActions && runtimeDescriptor && <aside className="action-panel" aria-label="表情与动作">
        <div className="action-group"><strong>表情</strong>{runtimeDescriptor.expressions.map((expression, index) => { const key = `CommandOrControl+Shift+${index + 1}`; return <button className="with-icon" key={expression.id} onClick={() => void triggerTarget({ expressionId: expression.id })} title={index < 4 ? capabilities.hotkeys[key] ? `快捷键 Ctrl+Shift+${index + 1}` : "系统快捷键不可用，请点击触发" : expression.id}><Smile aria-hidden="true" />{expression.name}</button>; })}</div>
        <div className="action-group"><strong>动作</strong>{runtimeDescriptor.behaviors.map((behavior, index) => { const key = `CommandOrControl+Shift+${index + 5}`; return <button className="with-icon" key={behavior.id} onClick={() => void triggerTarget({ behaviorId: behavior.id })} title={index < 4 ? capabilities.hotkeys[key] ? `快捷键 Ctrl+Shift+${index + 5}` : "系统快捷键不可用，请点击触发" : behavior.id}><Activity aria-hidden="true" />{behavior.name}</button>; })}</div>
        {runtimeDescriptor.production && <><div className="action-group character-presets"><strong>状态预设</strong>{runtimeDescriptor.production.presets.map((preset) => <button className={selectedCharacterState.presetId === preset.id ? "is-active" : ""} key={preset.id} onClick={() => void selectCharacterState({ presetId: preset.id })}>{preset.name}</button>)}</div><div className="action-group character-variants"><strong>服装与造型</strong>{runtimeDescriptor.production.variants.map((group) => <label key={group.id}><span>{group.name}</span><select value={selectedCharacterState.variants?.[group.id] ?? group.defaultOptionId} onChange={(event) => void selectCharacterState({ variants: { ...(selectedCharacterState.variants ?? {}), [group.id]: event.target.value }, ...(selectedCharacterState.props ? { props: selectedCharacterState.props } : {}) })}>{group.options.map((option) => <option value={option.id} key={option.id}>{option.name}</option>)}</select></label>)}</div><div className="action-group character-props"><strong>道具</strong>{runtimeDescriptor.production.props.map((prop) => { const selected = selectedCharacterState.props?.includes(prop.id) ?? prop.defaultEnabled ?? false; return <label key={prop.id}><input type="checkbox" checked={selected} onChange={(event) => { const current = new Set(selectedCharacterState.props ?? runtimeDescriptor.production!.props.filter((value) => value.defaultEnabled).map((value) => value.id)); event.target.checked ? current.add(prop.id) : current.delete(prop.id); void selectCharacterState({ ...(selectedCharacterState.variants ? { variants: selectedCharacterState.variants } : {}), props: [...current] }); }} />{prop.name}</label>; })}</div></>}
        {Object.entries(capabilities.hotkeys).some(([key, available]) => key !== "CommandOrControl+Shift+P" && !available) && <p className="hotkey-warning">部分系统快捷键已被其它软件占用；面板按钮仍可正常使用。</p>}
      </aside>}
      {showRecordingSettings && !recordingPerformance && <aside className="recording-panel" aria-label="视频录制设置">
        <div className="recording-panel-heading"><strong>录制视频</strong><button aria-label="关闭视频录制设置" onClick={() => setShowRecordingSettings(false)}><X aria-hidden="true" /></button></div>
        <label><span>背景</span><select aria-label="录制背景" value={recordingSettings.background} onChange={(event) => setRecordingSettings((current) => ({ ...current, background: event.target.value as RecordingBackgroundChoice }))}><option value="transparent">透明</option><option value="black">黑色</option><option value="white">白色</option><option value="green">绿幕</option><option value="custom">自定义纯色</option></select></label>
        {recordingSettings.background === "custom" && <label><span>背景颜色</span><input aria-label="自定义录制背景颜色" type="color" value={recordingSettings.backgroundColor} onChange={(event) => setRecordingSettings((current) => ({ ...current, backgroundColor: event.target.value }))} /></label>}
        <div className="recording-grid">
          <label><span>宽度</span><input aria-label="录制宽度" type="number" min="64" max="4096" step="1" value={recordingSettings.width} onChange={(event) => setRecordingSettings((current) => ({ ...current, width: Number(event.target.value) }))} /></label>
          <label><span>高度</span><input aria-label="录制高度" type="number" min="64" max="4096" step="1" value={recordingSettings.height} onChange={(event) => setRecordingSettings((current) => ({ ...current, height: Number(event.target.value) }))} /></label>
          <label><span>帧率</span><select aria-label="录制帧率" value={recordingSettings.fps} onChange={(event) => setRecordingSettings((current) => ({ ...current, fps: Number(event.target.value) as ViewerRecordingSettings["fps"] }))}><option value="24">24 FPS</option><option value="30">30 FPS</option><option value="60">60 FPS</option></select></label>
          <label><span>自动停止</span><input aria-label="录制时长秒数" type="number" min="0" max="3600" step="1" value={recordingSettings.durationSeconds} onChange={(event) => setRecordingSettings((current) => ({ ...current, durationSeconds: Number(event.target.value) }))} /><small>秒，0 为手动</small></label>
        </div>
        <label className="recording-checkbox"><input type="checkbox" checked={recordingSettings.includeAudio} disabled={!microphoneInput.current?.mediaStream} onChange={(event) => setRecordingSettings((current) => ({ ...current, includeAudio: event.target.checked }))} /><span>{microphoneInput.current?.mediaStream ? "录入已开启的麦克风音轨" : "先开启麦克风，才能录入音轨"}</span></label>
        <label className="recording-checkbox recording-data-option"><input type="checkbox" checked={recordingSettings.includeMotionData} onChange={(event) => setRecordingSettings((current) => ({ ...current, includeMotionData: event.target.checked }))} /><span><strong>同时保存动作数据</strong><small>用于在同一项目版本上重放鼠标跟随、面捕、口型、表情、动作和外部控制；不包含摄像头原片或声音。</small></span></label>
        <p>视频按所选尺寸等比居中保存为 WebM，不拉伸角色。动作数据是可选的独立 JSON，普通录制无需开启。</p>
        <button className="recording-start with-icon" disabled={recordingInput || replayingInput} onClick={() => void startConfiguredPerformanceRecording()}><Video aria-hidden="true" />开始录制视频</button>
        <section className="spout-output"><strong>Spout2 共享纹理</strong><p>使用上面的宽高与帧率，通过 D3D11 共享透明画面；OBS、TouchDesigner 等软件会看到发送器名称。</p><button className={`with-icon ${spoutStatus?.active ? "is-active" : ""}`} disabled={spoutStatus?.supported === false} onClick={() => void toggleSpoutOutput()}><RadioTower aria-hidden="true" />{spoutStatus?.active ? "停止 Spout2 输出" : "开始 Spout2 输出"}</button>{spoutStatus?.active && <small>{spoutStatus.senderName} · {spoutStatus.width}×{spoutStatus.height} · {spoutStatus.fps} FPS · 已发送 {spoutStatus.frames ?? 0} 帧{spoutStatus.droppedFrames ? ` · 丢弃 ${spoutStatus.droppedFrames} 帧` : ""}</small>}{spoutStatus?.supported === false && <small>{spoutStatus.message}</small>}</section>
        <details className="recording-advanced">
          <summary><ChevronRight aria-hidden="true" />动作数据工具</summary>
          <p>单独记录或回放动作数据，适合修改角色后做同输入对比和排查问题。回放时实时来源会暂时隔离。</p>
          <div>
            <button className={`with-icon ${recordingInput ? "is-recording" : ""}`} disabled={replayingInput} onClick={() => void toggleInputRecording()}>{recordingInput ? <Square aria-hidden="true" /> : <FileJson2 aria-hidden="true" />}{recordingInput ? "停止并保存动作数据" : "单独录制动作数据"}</button>
            <button className={`with-icon ${replayingInput ? "is-active" : ""}`} disabled={recordingInput} onClick={() => void toggleInputReplay()}><Repeat2 aria-hidden="true" />{replayingInput ? "停止动作数据回放" : "回放动作数据"}</button>
          </div>
          <section className="take-library"><header><strong>Take 库</strong><span><button onClick={() => void importTake()}>导入</button><button onClick={() => void refreshTakes()}>刷新</button></span></header>{takes.length === 0 ? <p>尚未导入 Take。原始动作会话和每个编辑版都会独立保留。</p> : takes.map((take) => <article key={take.id}><div><strong>{take.name}</strong><small>{formatDuration(take.durationMs)} · {take.events} 个事件{take.parentTakeId ? " · 编辑版" : ""}</small></div><span><button onClick={() => { void window.puppetloom.replayTake(take.id).then(() => setReplayingInput(true)).catch((cause) => setSessionMessage({ text: messageOf(cause) })); }}>回放</button><button onClick={() => setTakeEdit({ id: take.id, startSeconds: 0, endSeconds: take.durationMs / 1000, speed: 1, smoothWindow: 1 })}>编辑</button></span></article>)}{takeEdit && <div className="take-editor"><strong>创建非破坏性编辑版</strong><label>开始（秒）<input type="number" min="0" step="0.1" value={takeEdit.startSeconds} onChange={(event) => setTakeEdit({ ...takeEdit, startSeconds: Number(event.target.value) })} /></label><label>结束（秒）<input type="number" min="0.1" step="0.1" value={takeEdit.endSeconds} onChange={(event) => setTakeEdit({ ...takeEdit, endSeconds: Number(event.target.value) })} /></label><label>速度<select value={takeEdit.speed} onChange={(event) => setTakeEdit({ ...takeEdit, speed: Number(event.target.value) })}><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><label>平滑窗口<input type="number" min="1" max="120" step="1" value={takeEdit.smoothWindow} onChange={(event) => setTakeEdit({ ...takeEdit, smoothWindow: Number(event.target.value) })} /></label><span><button onClick={() => setTakeEdit(undefined)}>取消</button><button className="primary" onClick={() => void saveTakeEdit()}>保存新版本</button></span></div>}</section>
        </details>
      </aside>}
      {recordingPreview && <aside className="recording-preview" aria-label="视频录制预览"><div><strong>刚刚保存的视频</strong><button aria-label="关闭视频录制预览" onClick={() => setRecordingPreview(undefined)}><X aria-hidden="true" /></button></div><video aria-label="视频录制预览" controls src={recordingPreview.url} />{recordingPreview.note && <p>{recordingPreview.note}</p>}<button className="with-icon" onClick={() => void window.puppetloom.revealPath(recordingPreview.output)}><FolderOpen aria-hidden="true" />在文件夹中显示</button></aside>}
      <nav className="viewer-controls" aria-label="角色窗口控制">
        <button className="icon-only" aria-label="缩小角色窗口" onClick={() => act("smaller")} title="缩小角色窗口"><Minus aria-hidden="true" /></button>
        <button className="icon-only" aria-label="放大角色窗口" onClick={() => act("larger")} title="放大角色窗口"><Plus aria-hidden="true" /></button>
        <button className={`icon-only ${state.paused ? "is-active" : ""}`} aria-label={state.paused ? "继续播放" : "暂停播放"} aria-pressed={state.paused} onClick={() => act("pause")} title={state.paused ? "继续播放" : "暂停播放"}>{state.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</button>
        <button className={`icon-only ${state.alwaysOnTop ? "is-active" : ""}`} aria-label={state.alwaysOnTop ? "取消置顶" : "置顶窗口"} aria-pressed={state.alwaysOnTop} onClick={() => act("top")} title={state.alwaysOnTop ? "取消置顶" : "置顶窗口"}><Pin aria-hidden="true" /></button>
        <button className={`icon-only ${state.mouseTracking ? "is-active" : ""}`} aria-label={state.mouseTracking ? "切换为自主观察" : "切换为鼠标跟随"} aria-pressed={state.mouseTracking} onClick={() => act("pointer-tracking")} title={state.mouseTracking ? "当前跟随鼠标；点击切换为自主观察" : "当前自主观察；点击切换为鼠标跟随"}>{state.mouseTracking ? <MousePointer2 aria-hidden="true" /> : <Sparkles aria-hidden="true" />}</button>
        <button className={`icon-only ${cameraInput.current ? "is-active" : ""}`} aria-label={cameraInput.current ? "关闭摄像头面捕" : "开启摄像头面捕"} aria-pressed={Boolean(cameraInput.current)} onClick={() => void toggleCamera()} title={cameraStatus.message}>{cameraInput.current ? <Camera aria-hidden="true" /> : <CameraOff aria-hidden="true" />}</button>
        <button className={`icon-only ${microphoneInput.current ? "is-active" : ""}`} aria-label={microphoneInput.current ? "关闭麦克风口型" : "开启麦克风口型"} aria-pressed={Boolean(microphoneInput.current)} onClick={() => void toggleMicrophone()} title={microphoneStatus.message}>{microphoneInput.current ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}</button>
        <button disabled={recordingFinalizing} className={`icon-only ${recordingPerformance || recordingInput ? "is-recording" : showRecordingSettings || replayingInput || recordingFinalizing ? "is-active" : ""}`} aria-label={recordingFinalizing ? "正在完成视频文件" : recordingPerformance ? "停止并保存视频" : "录制视频"} aria-pressed={recordingPerformance} onClick={() => void togglePerformanceRecording()} title={recordingFinalizing ? "正在完成视频文件，请稍候" : recordingPerformance ? "停止并保存当前角色视频" : recordingInput ? "动作数据正在录制；点击打开录制面板" : replayingInput ? "动作数据正在回放；点击打开录制面板" : "设置背景、分辨率、帧率、时长、音轨与可选动作数据"}>{recordingPerformance ? <Square aria-hidden="true" /> : <Video aria-hidden="true" />}</button>
        <button className={`icon-only ${showActions ? "is-active" : ""}`} aria-label={showActions ? "关闭表情动作面板" : "打开表情动作面板"} aria-pressed={showActions} onClick={() => { setShowRecordingSettings(false); setShowActions((value) => !value); }} title={Object.entries(capabilities.hotkeys).some(([key, available]) => key !== "CommandOrControl+Shift+P" && !available) ? "表情与动作；快捷键被占用时请点击面板按钮" : "表情与动作；Ctrl+Shift+1…8 可快捷触发"}><WandSparkles aria-hidden="true" /></button>
        <button className={`icon-only ${state.clickThrough ? "is-active" : ""}`} disabled={!state.clickThrough && capabilities.hotkeys["CommandOrControl+Shift+P"] === false} aria-label={state.clickThrough ? "关闭鼠标穿透" : "开启鼠标穿透"} aria-pressed={state.clickThrough} onClick={() => act("click-through")} title={state.clickThrough ? "关闭鼠标穿透" : capabilities.hotkeys["CommandOrControl+Shift+P"] ? "开启鼠标穿透；按 Ctrl+Shift+P 恢复鼠标" : "恢复快捷键被其它软件占用，因此已停用鼠标穿透"}>{state.clickThrough ? <PointerOff aria-hidden="true" /> : <MousePointerClick aria-hidden="true" />}</button>
        <button className="icon-only viewer-close" aria-label="关闭角色窗口" onClick={() => act("close")} title="关闭角色窗口"><X aria-hidden="true" /></button>
      </nav>
      {state.clickThrough && <div className="shortcut-hint">{capabilities.hotkeys["CommandOrControl+Shift+P"] ? "Ctrl+Shift+P 恢复鼠标" : "恢复快捷键被占用；请从创建页的远程控制关闭鼠标穿透"}</div>}
      <div className="viewer-status-stack">
      {spoutStatus?.active && <div className="spout-operation" role="status"><RadioTower aria-hidden="true" /><strong>Spout2 输出中</strong><small>{spoutStatus.senderName} · {spoutStatus.width}×{spoutStatus.height}@{spoutStatus.fps}</small></div>}
      {recordingClock && <div className="recording-operation" role="timer" aria-live="off"><span className="recording-dot" aria-hidden="true" /><strong>{recordingClock.kind === "video" ? "视频录制中" : "动作数据录制中"}</strong><time>{formatDuration(recordingElapsedMs)}</time>{recordingClock.targetDurationMs !== undefined && <small>剩余 {formatDuration(Math.max(0, recordingClock.targetDurationMs - recordingElapsedMs))}</small>}</div>}
      {recordingFinalizing && <div className="recording-operation is-finalizing" role="status"><strong>正在完成视频文件…</strong><small>正在写入最后的数据并准备预览，请勿关闭窗口。</small></div>}
      {replayingInput && <div className="replay-operation" role="status"><Repeat2 aria-hidden="true" /><strong>正在回放动作数据</strong><small>实时输入已暂时隔离</small></div>}
      {(cameraStatus.state === "starting" || cameraStatus.state === "calibrating" || cameraStatus.state === "lost" || cameraStatus.state === "error") && <div className={`input-status ${cameraStatus.state === "error" || cameraStatus.state === "lost" ? "is-error" : ""}`}><span>{cameraStatus.message}</span>{(cameraStatus.state === "error" || cameraStatus.state === "lost") && <button className="icon-only" aria-label="关闭摄像头提示" title="关闭摄像头提示" onClick={() => void dismissInputStatus("camera")}><X aria-hidden="true" /></button>}</div>}
      {(microphoneStatus.state === "starting" || microphoneStatus.state === "error") && <div className={`input-status microphone-status ${microphoneStatus.state === "error" ? "is-error" : ""}`}><span>{microphoneStatus.message}</span>{microphoneStatus.state === "error" && <button className="icon-only" aria-label="关闭麦克风提示" title="关闭麦克风提示" onClick={() => void dismissInputStatus("microphone")}><X aria-hidden="true" /></button>}</div>}
      {transientMessage && <div className="viewer-toast" role="status">{transientMessage}</div>}
      {sessionMessage && <div className="session-status" role="status"><strong>{sessionMessage.text}</strong>{sessionMessage.path && <code title={sessionMessage.path}>{sessionMessage.path}</code>}<span>{sessionMessage.path && <><button className="with-icon" onClick={() => void window.puppetloom.revealPath(sessionMessage.path!)}><FolderOpen aria-hidden="true" />在文件夹中显示</button><button className="with-icon" onClick={() => void window.puppetloom.copyText(sessionMessage.path!)}><ClipboardCopy aria-hidden="true" />复制路径</button></>}<button className="icon-only" aria-label="关闭提示" title="关闭提示" onClick={() => setSessionMessage(undefined)}><X aria-hidden="true" /></button></span></div>}
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
        if (!file.name.toLowerCase().match(accept)) { onReject?.(`不支持 ${file.name}。`); return; }
        onDrop(window.puppetloom.pathForFile(file));
      }}
    >
      <div className="drop-field-identity"><span className="field-icon" aria-hidden="true">{icon}</span><span><strong>{label}</strong>{optional && <span className="optional">可选</span>}<small>{value || "拖到这里，或从本机选择"}</small></span></div>
      <span className="drop-field-actions">{value && onClear && <button disabled={disabled} className="with-icon clear-file" onClick={onClear}><X aria-hidden="true" />清除</button>}<button disabled={disabled} className="with-icon" onClick={() => void onPick()}><FileUp aria-hidden="true" />选择文件</button></span>
    </section>
  );
}

function Report({ report }: { report: BuildReport }): React.JSX.Element {
  const cleanupLabel = report.importPreflight.cleanupMode === "preserve-all" ? "保留全部像素" : report.importPreflight.cleanupMode === "remove-all-tiny" ? "移除全部微小连通域" : "仅移除确认噪点";
  return (
    <section className="report" data-testid="build-report">
      <div><span>绑定等级</span><strong>{rigLevelLabel(report.rigLevel)}</strong></div>
      <div><span>安全缩放</span><strong>{report.safetyScale.toFixed(2)}</strong></div>
      <div><span>保留图层</span><strong>{report.layerCount}</strong></div>
      <div><span>素材请求</span><strong>{report.assetRequestCount}</strong></div>
      <div><span>Alpha 连通域</span><strong>{report.importPreflight.sourceComponentCount}</strong></div>
      <div><span>透明像素策略</span><strong>{cleanupLabel}</strong></div>
      <div><span>实际清理</span><strong>{report.importPreflight.cleanupApplied ? `${report.importPreflight.confirmedNoiseComponentCount} 处 / ${report.importPreflight.confirmedNoisePixelCount}px` : "未移除像素"}</strong></div>
      <div><span>保留绘画细节</span><strong>{report.importPreflight.suspectedDetailComponentCount} / {report.importPreflight.suspectedDetailPixelCount}px</strong></div>
      <div><span>智能拆分</span><strong>{report.importPreflight.componentSplitCount}</strong></div>
      <p>启用：{report.enabledFeatures.map((feature) => featureLabels[feature] ?? feature).join("、") || "仅安全整体运动"}</p>
      {report.disabledFeatures.length > 0 && <p>素材不足而未启用：{report.disabledFeatures.map((feature) => featureLabels[feature] ?? feature).join("、")}</p>}
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
        if (generation === inspectionGeneration.current) setError(`PSD 检查失败：${messageOf(cause)}`);
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
  const readinessMessage = busy ? "正在创建，请等待当前操作完成。" : !input ? "请选择分层 PSD。" : !output ? "请选择项目输出目录。" : "素材和输出目录已就绪。";

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
      setError(detail.includes("用户已停止创建") ? "创建已安全停止，最终项目目录没有发布。临时操作证据仍保留，便于检查或恢复。" : detail);
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
    if (requested) setError("正在安全停止：已写入的临时操作证据会保留，最终项目目录不会发布。 ");
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
      const result = await window.puppetloom.exportProject(projectDirectory, format);
      const target = result?.outputDirectory ?? result?.output;
      if (target) { await window.puppetloom.revealPath(target); }
    } catch (cause) { setError(`导出失败：${messageOf(cause)}`); }
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
      setError("角色窗口已经关闭，请重新打开。 ");
    }
  }

  return (
    <main className="app-shell" data-testid="creator">
      <header className="creator-header">
        <div className="creator-header-copy">
          <div className="mark" aria-hidden="true"><Sparkles /></div>
          <div><span className="creator-eyebrow">角色工作台</span><h1>创建角色项目</h1><p>准备分层素材，PuppetLoom 会完成预检、绑定和项目初始化。</p></div>
        </div>
        <div className="creator-header-actions"><button className="secondary with-icon" onClick={() => setProductionSection("source")}><FileImage aria-hidden="true" />素材准备</button><button className="secondary with-icon" onClick={() => setProductionSection("library")}><FolderKanban aria-hidden="true" />项目体检</button><button className="secondary open-project with-icon" onClick={() => void openExisting()}><FolderOpen aria-hidden="true" />打开已有项目</button></div>
      </header>
      {productionSection ? <ProductionCenter initialSection={productionSection} onClose={() => setProductionSection(undefined)} onEdit={onEdit} /> : <div className="workflow">
        <section className="inputs">
          <div className="section-title"><FileImage aria-hidden="true" /><div><h2>角色素材</h2><p>选择源文件并指定项目位置</p></div></div>
          <DropField label="分层 PSD" value={input} accept="\\.psd$" icon={<FileImage />} disabled={busy} onPick={() => choose("psd")} onDrop={setInput} onClear={() => setInput("")} onReject={() => setError("这里只能放入 .psd 文件。 ")} />
          <DropField label="原始角色图" value={reference} accept="\\.(png|jpe?g|webp)$" icon={<ImageIcon />} optional disabled={busy} onPick={() => choose("reference")} onDrop={setReference} onClear={() => setReference("")} onReject={() => setError("参考图仅支持 PNG、JPG 或 WebP。 ")} />
          <label className="text-field"><span>项目名称 <small>可选</small></span><input disabled={busy} value={name} maxLength={80} placeholder="留空时使用 PSD 文件名" onChange={(event) => setName(event.target.value)} /></label>
          <section className="output-field">
            <div className="drop-field-identity"><span className="field-icon" aria-hidden="true"><FolderOutput /></span><span><strong>项目输出目录</strong><small>{output || "请选择一个新目录或空目录"}</small></span></div>
            <button disabled={busy} className="with-icon" onClick={() => void choose("output")}><FolderOutput aria-hidden="true" />选择目录</button>
          </section>
          <fieldset disabled={busy} className="alpha-policy"><legend>透明像素处理</legend><div className="alpha-default"><strong>自动清理确认噪点</strong><small>始终分析 Alpha；默认只移除极小、淡色、孤立的高置信度噪点，疑似高光、细发丝和装饰继续保留。</small></div><details><summary><ChevronRight aria-hidden="true" />高级选项</summary><label><input type="checkbox" name="preserve-alpha-noise" checked={alphaCleanup === "preserve-all"} onChange={(event) => setAlphaCleanup(event.target.checked ? "preserve-all" : "automatic")} /><span><strong>保留所有高置信度噪点</strong><small>仅用于排查误判。源 PSD 无论是否开启都不会被修改。</small></span></label></details></fieldset>
          <button className="primary with-icon" disabled={!ready} onClick={() => void create()}><Sparkles aria-hidden="true" />{busy ? `${createPhase === "importing" ? "正在读取 PSD" : createPhase === "rigging" ? "正在生成绑定" : createPhase === "writing" ? "正在写入纹理与项目" : createPhase === "validating" ? "正在验证全部输出" : "正在发布最终项目"}${busySeconds ? ` · ${busySeconds} 秒` : ""}` : "创建角色项目"}</button>
          <p className={"creation-readiness" + (ready ? " is-ready" : "")} role="status">{readinessMessage}</p>
          {busy && <button className="cancel-create with-icon" onClick={() => void cancelCreate()}><Square aria-hidden="true" />安全停止创建</button>}
          <p className="policy">缺少三态嘴形时嘴部保持不动；接入后只偶发一次缓慢开合，不连续无声说话。缺少闭眼素材不会阻塞创建。</p>
        </section>
        <aside className="status-panel">
            <div className="section-title"><ScanSearch aria-hidden="true" /><div><h2>自动检查</h2><p>识别结果与能力预检</p></div></div>
            {inspecting && <div className="empty-state" role="status">正在读取 PSD 图层和透明像素…</div>}
            {!inspecting && !inspection && !report && <div className="empty-state"><strong>等待角色素材</strong><span>选择分层 PSD 后，这里会显示图层识别、建议绑定和能力限制。</span></div>}
            {inspection && !report && <section className="inspection">
              <div><span>画布</span><strong>{inspection.canvas.width} × {inspection.canvas.height}</strong></div>
              <div><span>可见图层</span><strong>{inspection.visibleLayerCount}</strong></div>
              <div><span>识别图层</span><strong>{inspection.recognizedLayerCount}</strong></div>
              <div><span>建议绑定</span><strong>{rigLevelLabel(inspection.suggestedRigLevel)}</strong></div>
              <div><span>Alpha 连通域</span><strong>{inspection.preflight.sourceComponentCount}</strong></div>
              <div><span>透明像素策略</span><strong>{inspection.preflight.cleanupMode === "preserve-all" ? "保留全部像素" : inspection.preflight.cleanupMode === "automatic" ? "仅移除确认噪点" : "移除全部微小连通域"}</strong></div>
              <div><span>预计移除</span><strong>{inspection.preflight.cleanupApplied ? `${inspection.preflight.confirmedNoiseComponentCount} 处 / ${inspection.preflight.confirmedNoisePixelCount}px` : "不移除像素"}</strong></div>
              <div><span>保留绘画细节</span><strong>{inspection.preflight.suspectedDetailComponentCount} / {inspection.preflight.suspectedDetailPixelCount}px</strong></div>
              <div><span>连通域拆分</span><strong>{inspection.preflight.componentSplitCount}</strong></div>
              {inspection.preflight.fallbackSplitCount > 0 && <div><span>中心回退拆分</span><strong>{inspection.preflight.fallbackSplitCount}</strong></div>}
              {inspection.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
            </section>}
            {report && <Report report={report} />}
            {projectDirectory && <section className="result-actions">
              <p>项目已写入：<br/><code>{projectDirectory}</code></p><div className="path-actions"><button className="with-icon" onClick={() => void window.puppetloom.revealPath(projectDirectory)}><FolderOpen aria-hidden="true" />在文件夹中显示</button><button className="with-icon" onClick={() => void window.puppetloom.copyText(projectDirectory)}><ClipboardCopy aria-hidden="true" />复制路径</button></div>
              <button className="primary with-icon" onClick={() => onEdit(projectDirectory)}><ExternalLink aria-hidden="true" />打开绑定与校准编辑器</button>
              <button className="primary with-icon" onClick={() => void launch()}><Play aria-hidden="true" />打开透明角色窗口</button>
              <details className="export-center"><summary><FolderOutput aria-hidden="true" />导出中心</summary><p>导出不会覆盖现有目录。视频与 Take 在角色窗口中管理。</p><div><button disabled={exportBusy} onClick={() => void exportProject("portable")}>可移植项目</button><button disabled={exportBusy} onClick={() => void exportProject("web")}>Web / OBS</button><button disabled={exportBusy} onClick={() => void exportProject("cubism")}>Cubism 交接包</button></div></details>
              {viewerId !== undefined && <div className="remote-controls">
                <button className="with-icon" onClick={() => void controlRemote("pause")}><Pause aria-hidden="true" />暂停 / 继续</button>
                <button className="with-icon" disabled={creatorCapabilities.hotkeys["CommandOrControl+Shift+P"] === false} title={creatorCapabilities.hotkeys["CommandOrControl+Shift+P"] === false ? "恢复快捷键被占用，已停用鼠标穿透" : "切换鼠标穿透"} onClick={() => void controlRemote("click-through")}><PointerOff aria-hidden="true" />鼠标穿透</button>
                <button className="with-icon" onClick={() => void controlRemote("pointer-tracking")}><MousePointer2 aria-hidden="true" />跟随 / 自主</button>
                <button className="with-icon" onClick={() => void controlRemote("top")}><Pin aria-hidden="true" />切换置顶</button>
              </div>}
            </section>}
            {error && <div className="error" role="alert">{error}</div>}
        </aside>
        <section className="recent-projects" data-testid="recent-projects">
            <div className="recent-projects-heading">
              <div className="section-title compact"><FolderKanban aria-hidden="true" /><div><h2>最近项目</h2></div></div>
              <span>{recent.length > 0 ? `${recent.length} 个` : "尚无记录"}</span>
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
              <strong>还没有最近项目</strong>
              <span>创建或打开项目后，会在这里快速进入。</span>
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
      <WindowTitleBar title={editing ? "PuppetLoom · 绑定与校准编辑器" : "PuppetLoom"} />
      <div className="desktop-window-body">
        {editorProject
          ? <Suspense fallback={<main className="editor-loading"><p>正在加载编辑器…</p></main>}><EditorWorkspace projectDirectory={editorProject} onBack={() => setEditorProject("")} /></Suspense>
          : <Creator onEdit={setEditorProject} />}
      </div>
    </div>
  );
}
