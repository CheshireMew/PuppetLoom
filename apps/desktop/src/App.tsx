import { useEffect, useMemo, useRef, useState } from "react";
import type { BuildReport, InspectionReport, PuppetLoomProject } from "@puppetloom/core";
import { neutralMotionState } from "@puppetloom/core/browser";
import { PuppetRenderer } from "@puppetloom/renderer";
import type { RecentProject, ViewerState } from "../electron/global.js";
import { EditorWorkspace } from "./EditorWorkspace.js";
import { WindowTitleBar } from "./WindowTitleBar.js";

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

  useEffect(() => window.puppetloom.onViewerState((next) => {
    setState(next);
    renderer.current?.setPaused(next.paused);
  }), []);

  useEffect(() => {
    let disposed = false;
    let pointerTimer = 0;
    let pointerRequestActive = false;
    void (async () => {
      try {
        const loaded = await window.puppetloom.readProject(projectDirectory, revision);
        if (disposed || !canvas.current) return;
        setProject(loaded);
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
        pointerTimer = window.setInterval(() => void updatePointer(), 1000 / 20);
        window.puppetloomRenderTestPose = (override) => {
          if (!renderer.current) return false;
          renderer.current.setPaused(true);
          renderer.current.render({ ...neutralMotionState, ...override });
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

  return (
    <main className="viewer" data-testid="viewer" aria-label={project?.name ?? "PuppetLoom viewer"}>
      <canvas ref={canvas} className="puppet-canvas" />
      <div className="drag-strip" title="拖动角色窗口"><span>{project?.name ?? "加载中"}</span></div>
      <nav className="viewer-controls" aria-label="角色窗口控制">
        <button onClick={() => act("smaller")} title="缩小">−</button>
        <button onClick={() => act("larger")} title="放大">＋</button>
        <button onClick={() => act("pause")} title="暂停或继续">{state.paused ? "继续" : "暂停"}</button>
        <button onClick={() => act("top")} title="切换置顶">{state.alwaysOnTop ? "取消置顶" : "置顶"}</button>
        <button onClick={() => act("pointer-tracking")} title="在鼠标跟随和自主观察之间切换">{state.mouseTracking ? "跟随中" : "自主"}</button>
        <button onClick={() => act("click-through")} title="启用后按 Ctrl+Shift+P 恢复鼠标">穿透</button>
        <button onClick={() => act("close")} title="关闭">×</button>
      </nav>
      {state.clickThrough && <div className="shortcut-hint">Ctrl+Shift+P 恢复鼠标</div>}
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
      <button onClick={() => void onPick()}>选择文件</button>
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
      const result = await window.puppetloom.create({ input, output, ...(reference ? { reference } : {}), seed: 42 });
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
        <button className="secondary open-project" onClick={() => void openExisting()}>打开 PuppetLoom 项目目录</button>
      </header>
      <div className="workflow">
        <section className="inputs">
          <h2>角色素材</h2>
          <DropField label="See-through 分层 PSD" value={input} accept="\\.psd$" onPick={() => choose("psd")} onDrop={setInput} />
          <DropField label="原始角色图" value={reference} accept="\\.(png|jpe?g|webp)$" optional onPick={() => choose("reference")} onDrop={setReference} />
          <section className="output-field">
            <div><strong>项目输出目录</strong><p>{output || "请选择一个新目录或空目录"}</p></div>
            <button onClick={() => void choose("output")}>选择目录</button>
          </section>
          <button className="primary" disabled={!ready} onClick={() => void create()}>{busy ? "正在创建并验证…" : "创建角色项目"}</button>
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
              {inspection.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
            </section>}
            {report && <Report report={report} />}
            {projectDirectory && <section className="result-actions">
              <p>项目已写入：<br/><code>{projectDirectory}</code></p>
              <button className="primary" onClick={() => onEdit(projectDirectory)}>打开绑定与校准编辑器</button>
              <button className="primary" onClick={() => void launch()}>打开透明角色窗口</button>
              {viewerId !== undefined && <div className="remote-controls">
                <button onClick={() => void window.puppetloom.controlViewer(viewerId, "pause")}>暂停 / 继续</button>
                <button onClick={() => void window.puppetloom.controlViewer(viewerId, "click-through")}>鼠标穿透</button>
                <button onClick={() => void window.puppetloom.controlViewer(viewerId, "pointer-tracking")}>鼠标跟随 / 自主观察</button>
                <button onClick={() => void window.puppetloom.controlViewer(viewerId, "top")}>切换置顶</button>
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
