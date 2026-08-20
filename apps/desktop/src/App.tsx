import { useEffect, useMemo, useRef, useState } from "react";
import type { BuildReport, InspectionReport, PuppetLoomProject, RuntimeViewerDescriptor } from "@puppetloom/core";
import { neutralMotionState } from "@puppetloom/core/browser";
import { PuppetRenderer } from "@puppetloom/renderer";
import { Camera, CameraOff, ExternalLink, FileJson2, FileUp, FolderOpen, FolderOutput, Mic, MicOff, Minus, MousePointer2, MousePointerClick, Pause, Pin, Play, Plus, PointerOff, Repeat2, Sparkles, Square, Video, WandSparkles, X } from "lucide-react";
import type { DesktopCreatePhase, DesktopCreateRequest, RecentProject, ViewerCapabilities, ViewerState } from "../electron/global.js";
import { EditorWorkspace } from "./EditorWorkspace.js";
import { WindowTitleBar } from "./WindowTitleBar.js";
import { startFaceInput, startMicrophoneInput, type InputAdapterStatus, type RuntimeInputAdapter } from "./runtime-input.js";
import { startPerformanceRecording, type PerformanceRecorder, type PerformanceRecordingInputSession, type PerformanceRecordingOptions } from "./performance-recorder.js";

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

function Viewer({ projectDirectory, revision }: { projectDirectory: string; revision?: number }): React.JSX.Element {
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
  const [replayingInput, setReplayingInput] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<{ text: string; path?: string }>();
  const [runtimeDescriptor, setRuntimeDescriptor] = useState<RuntimeViewerDescriptor>();
  const [showActions, setShowActions] = useState(false);
  const [showRecordingSettings, setShowRecordingSettings] = useState(false);
  const [recordingSettings, setRecordingSettings] = useState<ViewerRecordingSettings>({ background: "transparent", backgroundColor: "#00ff00", width: 1080, height: 1080, fps: 30, durationSeconds: 0, includeAudio: true });
  const [recordingPreview, setRecordingPreview] = useState<{ url: string; output: string }>();
  const cameraInput = useRef<RuntimeInputAdapter | undefined>(undefined);
  const microphoneInput = useRef<RuntimeInputAdapter | undefined>(undefined);
  const performanceRecorder = useRef<PerformanceRecorder | undefined>(undefined);
  const performanceOwnsInput = useRef(false);
  const performanceStopTimer = useRef<number | undefined>(undefined);
  const finishingPerformance = useRef(false);

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
    if (next.reason === "finished") setSessionMessage({ text: "输入回放已完成" });
    if (next.reason === "stopped") setSessionMessage({ text: "输入回放已停止" });
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
  }, []);

  useEffect(() => () => {
    if (recordingPreview) void window.puppetloom.releaseProjectMedia(recordingPreview.url);
  }, [recordingPreview]);

  useEffect(() => {
    let disposed = false;
    let pointerTimer = 0;
    let pointerRequestActive = false;
    void (async () => {
      try {
        if (!project || disposed || !canvas.current) return;
        setRuntimeDescriptor(await window.puppetloom.runtimeDescriptor());
        renderer.current?.dispose();
        renderer.current = await PuppetRenderer.create(canvas.current, project, (layer) => window.puppetloom.readAsset(projectDirectory, layer));
        renderer.current.start();
        const updatePointer = async () => {
          if (disposed || pointerRequestActive || !renderer.current) return;
          pointerRequestActive = true;
          try {
            renderer.current.setLookTarget(await window.puppetloom.pointerTarget());
          } catch {
            renderer.current?.setLookTarget({ x: 0, y: 0, strength: 0 });
          } finally {
            pointerRequestActive = false;
          }
        };
        void updatePointer();
        // The motion controller interpolates this target every rendered frame;
        // a 10 Hz screen-coordinate sample remains smooth while avoiding a
        // cross-process round trip on every third frame.
        pointerTimer = window.setInterval(() => void updatePointer(), 1000 / 10);
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
      delete window.puppetloomRenderTestPose;
      delete window.puppetloomRenderCurrentFrame;
      renderer.current?.dispose();
    };
  }, [projectDirectory, project, revision]);

  async function act(action: ViewerAction): Promise<void> {
    const next = await window.puppetloom.viewerAction(action);
    if (next) {
      setState(next);
      renderer.current?.setPaused(next.paused);
    }
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
      const input = await startMicrophoneInput((mouthOpen) => {
        void window.puppetloom.setRuntimeSource({ id: "microphone", priority: 65, blend: 1, ttlMs: 250, motion: { mouthOpen } });
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
        if (recordingPerformance || performanceRecorder.current) throw new Error("WebM 表演正在同步录制输入，请先结束表演录制。" );
        await window.puppetloom.inputRecording("start");
        setRecordingInput(true);
        setSessionMessage({ text: "正在录制驱动输入" });
      } else {
        const result = await window.puppetloom.inputRecording("stop");
        setRecordingInput(false);
        setSessionMessage({ text: "输入会话已保存", ...(result.output ? { path: result.output } : {}) });
      }
    } catch (cause) {
      setSessionMessage({ text: `输入录制失败：${messageOf(cause)}` });
    }
  }

  async function toggleInputReplay(): Promise<void> {
    try {
      if (replayingInput) {
        await window.puppetloom.inputReplay("stop");
        setReplayingInput(false);
        setSessionMessage({ text: "输入回放已停止" });
      } else {
        const result = await window.puppetloom.inputReplay("start");
        if (result.canceled) return;
        setReplayingInput(true);
        setSessionMessage({ text: "正在回放输入会话", ...(result.input ? { path: result.input } : {}) });
      }
    } catch (cause) {
      setReplayingInput(false);
      setSessionMessage({ text: `输入回放失败：${messageOf(cause)}` });
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
      if (recordingInput) throw new Error("请先结束单独的驱动输入录制；WebM 录制会自动创建自己的同步输入会话。" );
      const options = recordingOptions();
      await window.puppetloom.inputRecording("start");
      performanceOwnsInput.current = true;
      setRecordingInput(true);
      try {
        performanceRecorder.current = await startPerformanceRecording(
          canvas.current,
          options,
          recordingSettings.includeAudio ? microphoneInput.current?.mediaStream : undefined
        );
      } catch (cause) {
        const input = await window.puppetloom.inputRecording("stop").catch(() => undefined);
        performanceOwnsInput.current = false;
        setRecordingInput(false);
        if (input?.output) setSessionMessage({ text: `WebM 未能开始；同步输入已单独保存：${messageOf(cause)}`, path: input.output });
        throw cause;
      }
      setRecordingPerformance(true);
      setShowRecordingSettings(false);
      setSessionMessage({ text: microphoneInput.current?.mediaStream && recordingSettings.includeAudio ? "正在录制 WebM 表演、同步输入与麦克风音轨" : "正在录制 WebM 表演与同步输入" });
      if (options.targetDurationMs !== undefined) performanceStopTimer.current = window.setTimeout(() => void finishPerformanceRecording(), options.targetDurationMs);
    } catch (cause) {
      if (!performanceRecorder.current) {
        setRecordingPerformance(false);
        setSessionMessage((current) => current?.path ? current : { text: `WebM 表演录制失败：${messageOf(cause)}` });
      }
    }
  }

  async function finishPerformanceRecording(): Promise<void> {
    const activeRecorder = performanceRecorder.current;
    if (!activeRecorder || finishingPerformance.current) return;
    finishingPerformance.current = true;
    performanceRecorder.current = undefined;
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
      setRecordingPerformance(false);
      try {
        const url = await window.puppetloom.projectMediaUrl(projectDirectory, result.relativeOutput);
        setRecordingPreview({ url, output: result.output });
      } catch (cause) {
        inputError = [inputError, `预览读取失败：${messageOf(cause)}`].filter(Boolean).join("；");
      }
      setSessionMessage({ text: inputError ? `WebM 表演已保存，但${inputError}` : "WebM 表演与同步输入已保存", path: result.output });
    } catch (cause) {
      setRecordingPerformance(false);
      setSessionMessage({ text: `WebM 表演录制失败：${messageOf(cause)}` });
    } finally {
      finishingPerformance.current = false;
    }
  }

  async function togglePerformanceRecording(): Promise<void> {
    if (performanceRecorder.current) await finishPerformanceRecording();
    else setShowRecordingSettings((value) => !value);
  }

  async function triggerTarget(target: { behaviorId?: string; expressionId?: string }): Promise<void> {
    try {
      await window.puppetloom.triggerRuntimeTarget(target);
      const selected = target.behaviorId
        ? runtimeDescriptor?.behaviors.find((value) => value.id === target.behaviorId)?.name
        : runtimeDescriptor?.expressions.find((value) => value.id === target.expressionId)?.name;
      setSessionMessage({ text: `已触发：${selected ?? target.behaviorId ?? target.expressionId}` });
    } catch (cause) {
      setSessionMessage({ text: `触发失败：${messageOf(cause)}` });
    }
  }

  return (
    <main className="viewer" data-testid="viewer" aria-label={project?.name ?? "PuppetLoom viewer"}>
      <canvas ref={canvas} className="puppet-canvas" />
      <div className="drag-strip" title={`拖动角色窗口 · ${sourceLabel}`}><span>{project?.name ?? "加载中"}</span><small>{sourceLabel}</small></div>
      {showActions && runtimeDescriptor && <aside className="action-panel" aria-label="表情与动作">
        <div className="action-group"><strong>表情</strong>{runtimeDescriptor.expressions.map((expression, index) => { const key = `CommandOrControl+Shift+${index + 1}`; return <button key={expression.id} onClick={() => void triggerTarget({ expressionId: expression.id })} title={index < 4 ? capabilities.hotkeys[key] ? `快捷键 Ctrl+Shift+${index + 1}` : "系统快捷键不可用，请点击触发" : expression.id}>{expression.name}</button>; })}</div>
        <div className="action-group"><strong>动作</strong>{runtimeDescriptor.behaviors.map((behavior, index) => { const key = `CommandOrControl+Shift+${index + 5}`; return <button key={behavior.id} onClick={() => void triggerTarget({ behaviorId: behavior.id })} title={index < 4 ? capabilities.hotkeys[key] ? `快捷键 Ctrl+Shift+${index + 5}` : "系统快捷键不可用，请点击触发" : behavior.id}>{behavior.name}</button>; })}</div>
        {Object.entries(capabilities.hotkeys).some(([key, available]) => key !== "CommandOrControl+Shift+P" && !available) && <p className="hotkey-warning">部分系统快捷键已被其它软件占用；面板按钮仍可正常使用。</p>}
      </aside>}
      {showRecordingSettings && !recordingPerformance && <aside className="recording-panel" aria-label="WebM 录制设置">
        <div className="recording-panel-heading"><strong>WebM 录制</strong><button aria-label="关闭 WebM 录制设置" onClick={() => setShowRecordingSettings(false)}><X aria-hidden="true" /></button></div>
        <label><span>背景</span><select aria-label="录制背景" value={recordingSettings.background} onChange={(event) => setRecordingSettings((current) => ({ ...current, background: event.target.value as RecordingBackgroundChoice }))}><option value="transparent">透明</option><option value="black">黑色</option><option value="white">白色</option><option value="green">绿幕</option><option value="custom">自定义纯色</option></select></label>
        {recordingSettings.background === "custom" && <label><span>背景颜色</span><input aria-label="自定义录制背景颜色" type="color" value={recordingSettings.backgroundColor} onChange={(event) => setRecordingSettings((current) => ({ ...current, backgroundColor: event.target.value }))} /></label>}
        <div className="recording-grid">
          <label><span>宽度</span><input aria-label="录制宽度" type="number" min="64" max="4096" step="1" value={recordingSettings.width} onChange={(event) => setRecordingSettings((current) => ({ ...current, width: Number(event.target.value) }))} /></label>
          <label><span>高度</span><input aria-label="录制高度" type="number" min="64" max="4096" step="1" value={recordingSettings.height} onChange={(event) => setRecordingSettings((current) => ({ ...current, height: Number(event.target.value) }))} /></label>
          <label><span>帧率</span><select aria-label="录制帧率" value={recordingSettings.fps} onChange={(event) => setRecordingSettings((current) => ({ ...current, fps: Number(event.target.value) as ViewerRecordingSettings["fps"] }))}><option value="24">24 FPS</option><option value="30">30 FPS</option><option value="60">60 FPS</option></select></label>
          <label><span>自动停止</span><input aria-label="录制时长秒数" type="number" min="0" max="3600" step="1" value={recordingSettings.durationSeconds} onChange={(event) => setRecordingSettings((current) => ({ ...current, durationSeconds: Number(event.target.value) }))} /><small>秒，0 为手动</small></label>
        </div>
        <label className="recording-checkbox"><input type="checkbox" checked={recordingSettings.includeAudio} disabled={!microphoneInput.current?.mediaStream} onChange={(event) => setRecordingSettings((current) => ({ ...current, includeAudio: event.target.checked }))} /><span>{microphoneInput.current?.mediaStream ? "录入已开启的麦克风音轨" : "先开启麦克风，才能录入音轨"}</span></label>
        <p>每次都会同步保存一份可回放的驱动输入 JSON；视频按所选尺寸等比居中，不拉伸角色。</p>
        <button className="recording-start" onClick={() => void startConfiguredPerformanceRecording()}>开始录制表演</button>
      </aside>}
      {recordingPreview && <aside className="recording-preview" aria-label="WebM 录制预览"><div><strong>刚刚保存的表演</strong><button aria-label="关闭 WebM 录制预览" onClick={() => setRecordingPreview(undefined)}><X aria-hidden="true" /></button></div><video aria-label="WebM 录制预览视频" controls src={recordingPreview.url} /><button onClick={() => void window.puppetloom.revealPath(recordingPreview.output)}>在文件夹中显示</button></aside>}
      <nav className="viewer-controls" aria-label="角色窗口控制">
        <button className="icon-only" aria-label="缩小角色窗口" onClick={() => act("smaller")} title="缩小角色窗口"><Minus aria-hidden="true" /></button>
        <button className="icon-only" aria-label="放大角色窗口" onClick={() => act("larger")} title="放大角色窗口"><Plus aria-hidden="true" /></button>
        <button className={`icon-only ${state.paused ? "is-active" : ""}`} aria-label={state.paused ? "继续播放" : "暂停播放"} aria-pressed={state.paused} onClick={() => act("pause")} title={state.paused ? "继续播放" : "暂停播放"}>{state.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</button>
        <button className={`icon-only ${state.alwaysOnTop ? "is-active" : ""}`} aria-label={state.alwaysOnTop ? "取消置顶" : "置顶窗口"} aria-pressed={state.alwaysOnTop} onClick={() => act("top")} title={state.alwaysOnTop ? "取消置顶" : "置顶窗口"}><Pin aria-hidden="true" /></button>
        <button className={`icon-only ${state.mouseTracking ? "is-active" : ""}`} aria-label={state.mouseTracking ? "切换为自主观察" : "切换为鼠标跟随"} aria-pressed={state.mouseTracking} onClick={() => act("pointer-tracking")} title={state.mouseTracking ? "当前跟随鼠标；点击切换为自主观察" : "当前自主观察；点击切换为鼠标跟随"}>{state.mouseTracking ? <MousePointer2 aria-hidden="true" /> : <Sparkles aria-hidden="true" />}</button>
        <button className={`icon-only ${cameraInput.current ? "is-active" : ""}`} aria-label={cameraInput.current ? "关闭摄像头面捕" : "开启摄像头面捕"} aria-pressed={Boolean(cameraInput.current)} onClick={() => void toggleCamera()} title={cameraStatus.message}>{cameraInput.current ? <Camera aria-hidden="true" /> : <CameraOff aria-hidden="true" />}</button>
        <button className={`icon-only ${microphoneInput.current ? "is-active" : ""}`} aria-label={microphoneInput.current ? "关闭麦克风口型" : "开启麦克风口型"} aria-pressed={Boolean(microphoneInput.current)} onClick={() => void toggleMicrophone()} title={microphoneStatus.message}>{microphoneInput.current ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}</button>
        <button className={`icon-only ${recordingInput ? "is-recording" : ""}`} disabled={recordingPerformance} aria-label={recordingInput ? "停止并保存输入录制" : "录制驱动输入"} aria-pressed={recordingInput} onClick={() => void toggleInputRecording()} title={recordingPerformance ? "WebM 表演正在自动同步录制输入" : recordingInput ? "停止并保存驱动输入" : "把摄像头、麦克风、快捷键和外部控制保存为可回放 JSON"}>{recordingInput ? <Square aria-hidden="true" /> : <FileJson2 aria-hidden="true" />}</button>
        <button className={`icon-only ${recordingPerformance ? "is-recording" : showRecordingSettings ? "is-active" : ""}`} aria-label={recordingPerformance ? "停止并保存 WebM 表演" : "录制 WebM 表演"} aria-pressed={recordingPerformance} onClick={() => void togglePerformanceRecording()} title={recordingPerformance ? "停止并保存当前角色画面和同步输入" : "设置透明或纯色背景、分辨率、帧率、时长与可选音轨"}>{recordingPerformance ? <Square aria-hidden="true" /> : <Video aria-hidden="true" />}</button>
        <button className={`icon-only ${replayingInput ? "is-active" : ""}`} aria-label={replayingInput ? "停止输入回放" : "回放输入会话"} aria-pressed={replayingInput} onClick={() => void toggleInputReplay()} title={replayingInput ? "停止输入回放" : "选择并回放输入会话 JSON"}><Repeat2 aria-hidden="true" /></button>
        <button className={`icon-only ${showActions ? "is-active" : ""}`} aria-label={showActions ? "关闭表情动作面板" : "打开表情动作面板"} aria-pressed={showActions} onClick={() => setShowActions((value) => !value)} title={Object.entries(capabilities.hotkeys).some(([key, available]) => key !== "CommandOrControl+Shift+P" && !available) ? "表情与动作；快捷键被占用时请点击面板按钮" : "表情与动作；Ctrl+Shift+1…8 可快捷触发"}><WandSparkles aria-hidden="true" /></button>
        <button className={`icon-only ${state.clickThrough ? "is-active" : ""}`} disabled={!state.clickThrough && capabilities.hotkeys["CommandOrControl+Shift+P"] === false} aria-label={state.clickThrough ? "关闭鼠标穿透" : "开启鼠标穿透"} aria-pressed={state.clickThrough} onClick={() => act("click-through")} title={state.clickThrough ? "关闭鼠标穿透" : capabilities.hotkeys["CommandOrControl+Shift+P"] ? "开启鼠标穿透；按 Ctrl+Shift+P 恢复鼠标" : "恢复快捷键被其它软件占用，因此已停用鼠标穿透"}>{state.clickThrough ? <PointerOff aria-hidden="true" /> : <MousePointerClick aria-hidden="true" />}</button>
        <button className="icon-only viewer-close" aria-label="关闭角色窗口" onClick={() => act("close")} title="关闭角色窗口"><X aria-hidden="true" /></button>
      </nav>
      {state.clickThrough && <div className="shortcut-hint">{capabilities.hotkeys["CommandOrControl+Shift+P"] ? "Ctrl+Shift+P 恢复鼠标" : "恢复快捷键被占用；请从创建页的远程控制关闭鼠标穿透"}</div>}
      {(cameraStatus.state === "starting" || cameraStatus.state === "calibrating" || cameraStatus.state === "lost" || cameraStatus.state === "error" || microphoneStatus.state === "starting" || microphoneStatus.state === "error") && <div className="input-status">{cameraStatus.state !== "stopped" && cameraStatus.message}{cameraStatus.state !== "stopped" && microphoneStatus.state !== "stopped" ? " · " : ""}{microphoneStatus.state !== "stopped" && microphoneStatus.message}</div>}
      {sessionMessage && <div className="session-status" role="status"><strong>{sessionMessage.text}</strong>{sessionMessage.path && <code title={sessionMessage.path}>{sessionMessage.path}</code>}<span>{sessionMessage.path && <><button onClick={() => void window.puppetloom.revealPath(sessionMessage.path!)}>在文件夹中显示</button><button onClick={() => void window.puppetloom.copyText(sessionMessage.path!)}>复制路径</button></>}<button aria-label="关闭提示" onClick={() => setSessionMessage(undefined)}>关闭</button></span></div>}
      {error && <div className="viewer-error">{error}</div>}
    </main>
  );
}

function DropField({ label, value, accept, optional, onPick, onDrop, onReject }: {
  label: string;
  value: string;
  accept: string;
  optional?: boolean;
  onPick: () => Promise<void>;
  onDrop: (path: string) => void;
  onReject?: (message: string) => void;
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  return (
    <section
      className={`drop-field ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (!file) return;
        if (!file.name.toLowerCase().match(accept)) { onReject?.(`不支持 ${file.name}。`); return; }
        onDrop(window.puppetloom.pathForFile(file));
      }}
    >
      <div><strong>{label}</strong>{optional && <span className="optional">可选</span>}</div>
      <p>{value || "拖到这里，或从本机选择"}</p>
      <button className="with-icon" onClick={() => void onPick()}><FileUp aria-hidden="true" />选择文件</button>
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
  const inspectionGeneration = useRef(0);
  const createOperationId = useRef<string | undefined>(undefined);

  useEffect(() => { void window.puppetloom.recentProjects().then(setRecent).catch(() => setRecent([])); }, []);
  useEffect(() => { void window.puppetloom.viewerCapabilities().then(setCreatorCapabilities).catch(() => undefined); }, []);

  useEffect(() => window.puppetloom.onCreateProgress((progress) => {
    if (progress.operationId === createOperationId.current) setCreatePhase(progress.phase);
  }), []);

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
    setBusy(true); setError(""); setReport(undefined);
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
      <header>
        <div className="mark">PL</div>
        <div><h1>PuppetLoom</h1><p>分层 PSD 进去，一个克制、稳定、会自己动的角色出来。</p></div>
        <button className="secondary open-project with-icon" onClick={() => void openExisting()}><FolderOpen aria-hidden="true" />打开 PuppetLoom 项目目录</button>
      </header>
      <div className="workflow">
        <section className="inputs">
          <h2>角色素材</h2>
          <DropField label="分层 PSD" value={input} accept="\\.psd$" onPick={() => choose("psd")} onDrop={setInput} onReject={() => setError("这里只能放入 .psd 文件。 ")} />
          <DropField label="原始角色图" value={reference} accept="\\.(png|jpe?g|webp)$" optional onPick={() => choose("reference")} onDrop={setReference} onReject={() => setError("参考图仅支持 PNG、JPG 或 WebP。 ")} />
          <label className="text-field"><span>项目名称 <small>可选</small></span><input value={name} maxLength={80} placeholder="留空时使用 PSD 文件名" onChange={(event) => setName(event.target.value)} /></label>
          <section className="output-field">
            <div><strong>项目输出目录</strong><p>{output || "请选择一个新目录或空目录"}</p></div>
            <button className="with-icon" onClick={() => void choose("output")}><FolderOutput aria-hidden="true" />选择目录</button>
          </section>
          <fieldset className="alpha-policy"><legend>透明像素处理</legend><div className="alpha-default"><strong>自动清理确认噪点</strong><small>始终分析 Alpha；默认只移除极小、淡色、孤立的高置信度噪点，疑似高光、细发丝和装饰继续保留。</small></div><details><summary>高级选项</summary><label><input type="checkbox" name="preserve-alpha-noise" checked={alphaCleanup === "preserve-all"} onChange={(event) => setAlphaCleanup(event.target.checked ? "preserve-all" : "automatic")} /><span><strong>保留所有高置信度噪点</strong><small>仅用于排查误判。源 PSD 无论是否开启都不会被修改。</small></span></label></details></fieldset>
          <button className="primary with-icon" disabled={!ready} onClick={() => void create()}><Sparkles aria-hidden="true" />{busy ? `${createPhase === "importing" ? "正在读取 PSD" : createPhase === "rigging" ? "正在生成绑定" : createPhase === "writing" ? "正在写入纹理与项目" : createPhase === "validating" ? "正在验证全部输出" : "正在发布最终项目"}${busySeconds ? ` · ${busySeconds} 秒` : ""}` : "创建角色项目"}</button>
          {busy && <button className="cancel-create" onClick={() => void cancelCreate()}>安全停止创建</button>}
          <p className="policy">缺少三态嘴形时嘴部保持不动；接入后只偶发一次缓慢开合，不连续无声说话。缺少闭眼素材不会阻塞创建。</p>
        </section>
        <div className="launch-sidebar">
          <aside className="status-panel">
            <h2>自动检查</h2>
            {inspecting && <div className="empty-state" role="status">正在读取 PSD 图层和透明像素…</div>}
            {!inspecting && !inspection && !report && <div className="empty-state">放入 PSD 后，这里会显示识别结果、绑定等级和禁用功能。</div>}
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
              <p>项目已写入：<br/><code>{projectDirectory}</code></p><div className="path-actions"><button onClick={() => void window.puppetloom.revealPath(projectDirectory)}>在文件夹中显示</button><button onClick={() => void window.puppetloom.copyText(projectDirectory)}>复制路径</button></div>
              <button className="primary with-icon" onClick={() => onEdit(projectDirectory)}><ExternalLink aria-hidden="true" />打开绑定与校准编辑器</button>
              <button className="primary with-icon" onClick={() => void launch()}><Play aria-hidden="true" />打开透明角色窗口</button>
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
              <h2>最近项目</h2>
              <span>{recent.length > 0 ? `${recent.length} 个` : "尚无记录"}</span>
            </div>
            {recent.length > 0 ? <div className="recent-project-list">
              {recent.map((entry) => <button key={entry.directory} title={entry.directory} onClick={() => void openRecent(entry.directory)}>
                <span className="recent-project-icon" aria-hidden="true">PL</span>
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
        </div>
      </div>
    </main>
  );
}

export function App(): React.JSX.Element {
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project");
  const revisionValue = params.get("revision");
  const revision = revisionValue !== null && Number.isInteger(Number(revisionValue)) && Number(revisionValue) >= 0 ? Number(revisionValue) : undefined;
  const [editorProject, setEditorProject] = useState(params.get("editor") === "1" && project ? project : "");
  if (params.get("viewer") === "1" && project) return <Viewer projectDirectory={project} {...(revision !== undefined ? { revision } : {})} />;
  const editing = Boolean(editorProject);
  return (
    <div className={`desktop-window ${editing ? "is-editor" : "is-creator"}`}>
      <WindowTitleBar title={editing ? "PuppetLoom · 绑定与校准编辑器" : "PuppetLoom"} />
      <div className="desktop-window-body">
        {editorProject
          ? <EditorWorkspace projectDirectory={editorProject} onBack={() => setEditorProject("")} />
          : <Creator onEdit={setEditorProject} />}
      </div>
    </div>
  );
}
