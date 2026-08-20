import { useEffect, useMemo, useRef, useState } from "react";
import type { BuildReport, InspectionReport, PuppetLoomProject, RuntimeViewerDescriptor } from "@puppetloom/core";
import { neutralMotionState } from "@puppetloom/core/browser";
import { PuppetRenderer } from "@puppetloom/renderer";
import { Camera, CameraOff, ExternalLink, FileJson2, FileUp, FolderOpen, FolderOutput, Mic, MicOff, Minus, MousePointer2, MousePointerClick, Pause, Pin, Play, Plus, PointerOff, Repeat2, Sparkles, Square, Video, WandSparkles, X } from "lucide-react";
import type { RecentProject, ViewerState } from "../electron/global.js";
import { EditorWorkspace } from "./EditorWorkspace.js";
import { WindowTitleBar } from "./WindowTitleBar.js";
import { startFaceInput, startMicrophoneInput, type InputAdapterStatus, type RuntimeInputAdapter } from "./runtime-input.js";
import { startPerformanceRecording, type PerformanceRecorder } from "./performance-recorder.js";

type ViewerAction = "pause" | "top" | "click-through" | "pointer-tracking" | "larger" | "smaller" | "close";

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

function Viewer({ projectDirectory, revision }: { projectDirectory: string; revision?: number }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<PuppetRenderer | undefined>(undefined);
  const [project, setProject] = useState<PuppetLoomProject>();
  const [state, setState] = useState<ViewerState>({ paused: false, alwaysOnTop: true, clickThrough: false, mouseTracking: true, scale: 1 });
  const [error, setError] = useState("");
  const [cameraStatus, setCameraStatus] = useState<InputAdapterStatus>({ state: "stopped", message: "摄像头面捕未启用" });
  const [microphoneStatus, setMicrophoneStatus] = useState<InputAdapterStatus>({ state: "stopped", message: "麦克风口型未启用" });
  const [recordingInput, setRecordingInput] = useState(false);
  const [recordingPerformance, setRecordingPerformance] = useState(false);
  const [replayingInput, setReplayingInput] = useState(false);
  const [sessionMessage, setSessionMessage] = useState("");
  const [runtimeDescriptor, setRuntimeDescriptor] = useState<RuntimeViewerDescriptor>();
  const [showActions, setShowActions] = useState(false);
  const cameraInput = useRef<RuntimeInputAdapter | undefined>(undefined);
  const microphoneInput = useRef<RuntimeInputAdapter | undefined>(undefined);
  const performanceRecorder = useRef<PerformanceRecorder | undefined>(undefined);

  useEffect(() => window.puppetloom.onViewerState((next) => {
    setState(next);
    renderer.current?.setPaused(next.paused);
  }), []);

  useEffect(() => window.puppetloom.onRuntimeControl((snapshot) => renderer.current?.setRuntimeControl(snapshot)), []);

  useEffect(() => () => {
    void performanceRecorder.current?.stop().catch(() => undefined);
    performanceRecorder.current = undefined;
    void cameraInput.current?.stop();
    void microphoneInput.current?.stop();
    void window.puppetloom.releaseRuntimeSource("camera");
    void window.puppetloom.releaseRuntimeSource("microphone");
  }, []);

  useEffect(() => {
    let disposed = false;
    let pointerTimer = 0;
    let pointerRequestActive = false;
    void (async () => {
      try {
        const loaded = await window.puppetloom.readProject(projectDirectory, revision);
        if (disposed || !canvas.current) return;
        setProject(loaded);
        setRuntimeDescriptor(await window.puppetloom.runtimeDescriptor());
        renderer.current = await PuppetRenderer.create(canvas.current, loaded, (layer) => window.puppetloom.readAsset(projectDirectory, layer));
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
  }, [projectDirectory, revision]);

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
        await window.puppetloom.inputRecording("start");
        setRecordingInput(true);
        setSessionMessage("正在录制驱动输入");
      } else {
        const result = await window.puppetloom.inputRecording("stop");
        setRecordingInput(false);
        setSessionMessage(`输入会话已保存：${result.output ?? "项目 reports/input-sessions"}`);
      }
    } catch (cause) {
      setSessionMessage(`输入录制失败：${messageOf(cause)}`);
    }
  }

  async function toggleInputReplay(): Promise<void> {
    try {
      if (replayingInput) {
        await window.puppetloom.inputReplay("stop");
        setReplayingInput(false);
        setSessionMessage("输入回放已停止");
      } else {
        const result = await window.puppetloom.inputReplay("start");
        if (result.canceled) return;
        setReplayingInput(true);
        setSessionMessage(`正在回放：${result.input ?? "输入会话"}`);
      }
    } catch (cause) {
      setReplayingInput(false);
      setSessionMessage(`输入回放失败：${messageOf(cause)}`);
    }
  }

  async function togglePerformanceRecording(): Promise<void> {
    try {
      if (!performanceRecorder.current) {
        if (!canvas.current) throw new Error("角色画布尚未准备好。" );
        const recorder = await startPerformanceRecording(canvas.current, microphoneInput.current?.mediaStream, 30);
        performanceRecorder.current = recorder;
        setRecordingPerformance(true);
        setSessionMessage(microphoneInput.current?.mediaStream ? "正在录制 WebM 表演（含麦克风音轨）" : "正在录制 WebM 表演");
        return;
      }
      const recorder = performanceRecorder.current;
      performanceRecorder.current = undefined;
      const result = await recorder.stop();
      setRecordingPerformance(false);
      setSessionMessage(`WebM 表演已保存：${result.output}`);
    } catch (cause) {
      performanceRecorder.current = undefined;
      setRecordingPerformance(false);
      setSessionMessage(`WebM 表演录制失败：${messageOf(cause)}`);
    }
  }

  async function triggerTarget(target: { behaviorId?: string; expressionId?: string }): Promise<void> {
    try {
      await window.puppetloom.triggerRuntimeTarget(target);
      const selected = target.behaviorId
        ? runtimeDescriptor?.behaviors.find((value) => value.id === target.behaviorId)?.name
        : runtimeDescriptor?.expressions.find((value) => value.id === target.expressionId)?.name;
      setSessionMessage(`已触发：${selected ?? target.behaviorId ?? target.expressionId}`);
    } catch (cause) {
      setSessionMessage(`触发失败：${messageOf(cause)}`);
    }
  }

  return (
    <main className="viewer" data-testid="viewer" aria-label={project?.name ?? "PuppetLoom viewer"}>
      <canvas ref={canvas} className="puppet-canvas" />
      <div className="drag-strip" title="拖动角色窗口"><span>{project?.name ?? "加载中"}</span></div>
      {showActions && runtimeDescriptor && <aside className="action-panel" aria-label="表情与动作">
        <div className="action-group"><strong>表情</strong>{runtimeDescriptor.expressions.map((expression, index) => <button key={expression.id} onClick={() => void triggerTarget({ expressionId: expression.id })} title={index < 4 ? `快捷键 Ctrl+Shift+${index + 1}` : expression.id}>{expression.name}</button>)}</div>
        <div className="action-group"><strong>动作</strong>{runtimeDescriptor.behaviors.map((behavior, index) => <button key={behavior.id} onClick={() => void triggerTarget({ behaviorId: behavior.id })} title={index < 4 ? `快捷键 Ctrl+Shift+${index + 5}` : behavior.id}>{behavior.name}</button>)}</div>
      </aside>}
      <nav className="viewer-controls" aria-label="角色窗口控制">
        <button className="icon-only" aria-label="缩小角色窗口" onClick={() => act("smaller")} title="缩小角色窗口"><Minus aria-hidden="true" /></button>
        <button className="icon-only" aria-label="放大角色窗口" onClick={() => act("larger")} title="放大角色窗口"><Plus aria-hidden="true" /></button>
        <button className={`icon-only ${state.paused ? "is-active" : ""}`} aria-label={state.paused ? "继续播放" : "暂停播放"} aria-pressed={state.paused} onClick={() => act("pause")} title={state.paused ? "继续播放" : "暂停播放"}>{state.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</button>
        <button className={`icon-only ${state.alwaysOnTop ? "is-active" : ""}`} aria-label={state.alwaysOnTop ? "取消置顶" : "置顶窗口"} aria-pressed={state.alwaysOnTop} onClick={() => act("top")} title={state.alwaysOnTop ? "取消置顶" : "置顶窗口"}><Pin aria-hidden="true" /></button>
        <button className={`icon-only ${state.mouseTracking ? "is-active" : ""}`} aria-label={state.mouseTracking ? "切换为自主观察" : "切换为鼠标跟随"} aria-pressed={state.mouseTracking} onClick={() => act("pointer-tracking")} title={state.mouseTracking ? "当前跟随鼠标；点击切换为自主观察" : "当前自主观察；点击切换为鼠标跟随"}>{state.mouseTracking ? <MousePointer2 aria-hidden="true" /> : <Sparkles aria-hidden="true" />}</button>
        <button className={`icon-only ${cameraInput.current ? "is-active" : ""}`} aria-label={cameraInput.current ? "关闭摄像头面捕" : "开启摄像头面捕"} aria-pressed={Boolean(cameraInput.current)} onClick={() => void toggleCamera()} title={cameraStatus.message}>{cameraInput.current ? <Camera aria-hidden="true" /> : <CameraOff aria-hidden="true" />}</button>
        <button className={`icon-only ${microphoneInput.current ? "is-active" : ""}`} aria-label={microphoneInput.current ? "关闭麦克风口型" : "开启麦克风口型"} aria-pressed={Boolean(microphoneInput.current)} onClick={() => void toggleMicrophone()} title={microphoneStatus.message}>{microphoneInput.current ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}</button>
        <button className={`icon-only ${recordingInput ? "is-recording" : ""}`} aria-label={recordingInput ? "停止并保存输入录制" : "录制驱动输入"} aria-pressed={recordingInput} onClick={() => void toggleInputRecording()} title={recordingInput ? "停止并保存驱动输入" : "把摄像头、麦克风、快捷键和外部控制保存为可回放 JSON"}>{recordingInput ? <Square aria-hidden="true" /> : <FileJson2 aria-hidden="true" />}</button>
        <button className={`icon-only ${recordingPerformance ? "is-recording" : ""}`} aria-label={recordingPerformance ? "停止并保存 WebM 表演" : "录制 WebM 表演"} aria-pressed={recordingPerformance} onClick={() => void togglePerformanceRecording()} title={recordingPerformance ? "停止并保存当前角色画面" : "录制当前角色窗口最终画面；麦克风已开启时同时录制音轨"}>{recordingPerformance ? <Square aria-hidden="true" /> : <Video aria-hidden="true" />}</button>
        <button className={`icon-only ${replayingInput ? "is-active" : ""}`} aria-label={replayingInput ? "停止输入回放" : "回放输入会话"} aria-pressed={replayingInput} onClick={() => void toggleInputReplay()} title={replayingInput ? "停止输入回放" : "选择并回放输入会话 JSON"}><Repeat2 aria-hidden="true" /></button>
        <button className={`icon-only ${showActions ? "is-active" : ""}`} aria-label={showActions ? "关闭表情动作面板" : "打开表情动作面板"} aria-pressed={showActions} onClick={() => setShowActions((value) => !value)} title="表情与动作；Ctrl+Shift+1…8 可快捷触发"><WandSparkles aria-hidden="true" /></button>
        <button className={`icon-only ${state.clickThrough ? "is-active" : ""}`} aria-label={state.clickThrough ? "关闭鼠标穿透" : "开启鼠标穿透"} aria-pressed={state.clickThrough} onClick={() => act("click-through")} title={state.clickThrough ? "关闭鼠标穿透" : "开启鼠标穿透；按 Ctrl+Shift+P 恢复鼠标"}>{state.clickThrough ? <PointerOff aria-hidden="true" /> : <MousePointerClick aria-hidden="true" />}</button>
        <button className="icon-only viewer-close" aria-label="关闭角色窗口" onClick={() => act("close")} title="关闭角色窗口"><X aria-hidden="true" /></button>
      </nav>
      {state.clickThrough && <div className="shortcut-hint">Ctrl+Shift+P 恢复鼠标</div>}
      {(cameraStatus.state === "starting" || cameraStatus.state === "lost" || cameraStatus.state === "error" || microphoneStatus.state === "starting" || microphoneStatus.state === "error") && <div className="input-status">{cameraStatus.state !== "stopped" && cameraStatus.message}{cameraStatus.state !== "stopped" && microphoneStatus.state !== "stopped" ? " · " : ""}{microphoneStatus.state !== "stopped" && microphoneStatus.message}</div>}
      {sessionMessage && <div className="session-status" onClick={() => setSessionMessage("")}>{sessionMessage}</div>}
      {error && <div className="viewer-error">{error}</div>}
    </main>
  );
}

function DropField({ label, value, accept, optional, onPick, onDrop }: {
  label: string;
  value: string;
  accept: string;
  optional?: boolean;
  onPick: () => Promise<void>;
  onDrop: (path: string) => void;
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
        if (!file || !file.name.toLowerCase().match(accept)) return;
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
  return (
    <section className="report" data-testid="build-report">
      <div><span>绑定等级</span><strong>{report.rigLevel}</strong></div>
      <div><span>安全缩放</span><strong>{report.safetyScale.toFixed(2)}</strong></div>
      <div><span>保留图层</span><strong>{report.layerCount}</strong></div>
      <div><span>素材请求</span><strong>{report.assetRequestCount}</strong></div>
      <div><span>Alpha 连通域</span><strong>{report.importPreflight.sourceComponentCount}</strong></div>
      <div><span>自动清理噪点</span><strong>{report.importPreflight.confirmedNoiseComponentCount} / {report.importPreflight.confirmedNoisePixelCount}px</strong></div>
      <div><span>保留绘画细节</span><strong>{report.importPreflight.suspectedDetailComponentCount} / {report.importPreflight.suspectedDetailPixelCount}px</strong></div>
      <div><span>智能拆分</span><strong>{report.importPreflight.componentSplitCount}</strong></div>
      <p>启用：{report.enabledFeatures.join("、") || "仅安全整体运动"}</p>
      {report.disabledFeatures.length > 0 && <p>禁用：{report.disabledFeatures.join("、")}</p>}
      {report.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
    </section>
  );
}

function Creator({ onEdit }: { onEdit: (projectDirectory: string) => void }): React.JSX.Element {
  const [input, setInput] = useState("");
  const [reference, setReference] = useState("");
  const [output, setOutput] = useState("");
  const [preserveAlphaNoise, setPreserveAlphaNoise] = useState(false);
  const [inspection, setInspection] = useState<InspectionReport>();
  const [report, setReport] = useState<BuildReport>();
  const [projectDirectory, setProjectDirectory] = useState("");
  const [viewerId, setViewerId] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<RecentProject[]>([]);

  useEffect(() => { void window.puppetloom.recentProjects().then(setRecent).catch(() => setRecent([])); }, []);

  useEffect(() => {
    if (!input) { setInspection(undefined); return; }
    const timer = window.setTimeout(() => {
      void window.puppetloom.inspect(input).then(setInspection).catch((cause) => setError(messageOf(cause)));
    }, 100);
    return () => window.clearTimeout(timer);
  }, [input]);

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
    setBusy(true); setError(""); setReport(undefined);
    try {
      const result = await window.puppetloom.create({ input, output, ...(reference ? { reference } : {}), ...(preserveAlphaNoise ? { preserveAlphaNoise: true } : {}), seed: 42 });
      setReport(result.report);
      setProjectDirectory(result.outputDirectory);
      void window.puppetloom.recentProjects().then(setRecent).catch(() => undefined);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openExisting(): Promise<void> {
    const directory = await window.puppetloom.chooseProject();
    if (!directory) return;
    try {
      await window.puppetloom.readProject(directory);
      setProjectDirectory(directory);
      onEdit(directory);
    } catch (cause) { setError(messageOf(cause)); }
  }

  async function openRecent(directory: string): Promise<void> {
    setError("");
    try {
      await window.puppetloom.readProject(directory);
      onEdit(directory);
    } catch (cause) {
      setError(`无法打开最近项目：${messageOf(cause)}`);
    }
  }

  async function launch(): Promise<void> {
    if (!projectDirectory) return;
    const launched = await window.puppetloom.launchViewer(projectDirectory);
    setViewerId(launched.id);
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
          <DropField label="See-through 分层 PSD" value={input} accept="\\.psd$" onPick={() => choose("psd")} onDrop={setInput} />
          <DropField label="原始角色图" value={reference} accept="\\.(png|jpe?g|webp)$" optional onPick={() => choose("reference")} onDrop={setReference} />
          <section className="output-field">
            <div><strong>项目输出目录</strong><p>{output || "请选择一个新目录或空目录"}</p></div>
            <button className="with-icon" onClick={() => void choose("output")}><FolderOutput aria-hidden="true" />选择目录</button>
          </section>
          <label className="check-row"><input type="checkbox" checked={preserveAlphaNoise} onChange={(event) => setPreserveAlphaNoise(event.target.checked)} />高级：保留所有高置信度 Alpha 噪点（源 PSD 始终保留）</label>
          <button className="primary with-icon" disabled={!ready} onClick={() => void create()}><Sparkles aria-hidden="true" />{busy ? "正在创建并验证…" : "创建角色项目"}</button>
          <p className="policy">缺少三态嘴形时嘴部保持不动；接入后只偶发一次缓慢开合，不连续无声说话。缺少闭眼素材不会阻塞创建。</p>
        </section>
        <div className="launch-sidebar">
          <aside className="status-panel">
            <h2>自动检查</h2>
            {!inspection && !report && <div className="empty-state">放入 PSD 后，这里会显示识别结果、绑定等级和禁用功能。</div>}
            {inspection && !report && <section className="inspection">
              <div><span>画布</span><strong>{inspection.canvas.width} × {inspection.canvas.height}</strong></div>
              <div><span>可见图层</span><strong>{inspection.visibleLayerCount}</strong></div>
              <div><span>识别图层</span><strong>{inspection.recognizedLayerCount}</strong></div>
              <div><span>建议绑定</span><strong>{inspection.suggestedRigLevel}</strong></div>
              <div><span>Alpha 连通域</span><strong>{inspection.preflight.sourceComponentCount}</strong></div>
              <div><span>自动清理噪点</span><strong>{inspection.preflight.confirmedNoiseComponentCount} / {inspection.preflight.confirmedNoisePixelCount}px</strong></div>
              <div><span>保留绘画细节</span><strong>{inspection.preflight.suspectedDetailComponentCount} / {inspection.preflight.suspectedDetailPixelCount}px</strong></div>
              <div><span>连通域拆分</span><strong>{inspection.preflight.componentSplitCount}</strong></div>
              {inspection.preflight.fallbackSplitCount > 0 && <div><span>中心回退拆分</span><strong>{inspection.preflight.fallbackSplitCount}</strong></div>}
              {inspection.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
            </section>}
            {report && <Report report={report} />}
            {projectDirectory && <section className="result-actions">
              <p>项目已写入：<br/><code>{projectDirectory}</code></p>
              <button className="primary with-icon" onClick={() => onEdit(projectDirectory)}><ExternalLink aria-hidden="true" />打开绑定与校准编辑器</button>
              <button className="primary with-icon" onClick={() => void launch()}><Play aria-hidden="true" />打开透明角色窗口</button>
              {viewerId !== undefined && <div className="remote-controls">
                <button className="with-icon" onClick={() => void window.puppetloom.controlViewer(viewerId, "pause")}><Pause aria-hidden="true" />暂停 / 继续</button>
                <button className="with-icon" onClick={() => void window.puppetloom.controlViewer(viewerId, "click-through")}><PointerOff aria-hidden="true" />鼠标穿透</button>
                <button className="with-icon" onClick={() => void window.puppetloom.controlViewer(viewerId, "pointer-tracking")}><MousePointer2 aria-hidden="true" />跟随 / 自主</button>
                <button className="with-icon" onClick={() => void window.puppetloom.controlViewer(viewerId, "top")}><Pin aria-hidden="true" />切换置顶</button>
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
