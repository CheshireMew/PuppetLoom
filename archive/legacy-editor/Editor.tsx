import { useEffect, useMemo, useRef, useState } from "react";

// Legacy editor retained for repository history and no-delete workspaces. App.tsx uses EditorWorkspace.
import type {
  AnchorGraph,
  CalibrationOverrides,
  LayerBinding,
  MotionState,
  SemanticCagePointId,
  SemanticRole
} from "@puppetloom/core";
import { applyCalibrationOverrides, mergeCalibrationOverrides, neutralMotionState } from "@puppetloom/core/browser";
import { PuppetRenderer } from "@puppetloom/renderer";
import type { DesktopCalibrationResponse, EditorWorkspace } from "../electron/global.js";

type EditMode = "semantic" | "anchors" | "layer" | "mesh";
type DragTarget =
  | { kind: "semantic"; key: SemanticCagePointId }
  | { kind: "anchor"; key: keyof AnchorGraph }
  | { kind: "pivot" }
  | { kind: "secondary"; key: keyof NonNullable<LayerBinding["secondaryAnchors"]> }
  | { kind: "mesh"; index: number };

const semanticRoles: SemanticRole[] = [
  "backHair", "frontHair", "sideHair", "face", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth", "ear", "neck", "topWear", "bottomWear", "arm", "hand", "leg", "foot", "headwear", "tail", "accessory", "unknown"
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pose(overrides: Partial<MotionState>): MotionState {
  return {
    ...neutralMotionState,
    ...overrides,
    bodySway: overrides.headYaw === undefined ? 0 : overrides.headYaw * 0.5,
    bodyPitch: overrides.headPitch === undefined ? 0 : overrides.headPitch * 0.38,
    gazeX: overrides.headYaw === undefined ? 0 : overrides.headYaw * 0.45,
    gazeY: overrides.headPitch === undefined ? 0 : overrides.headPitch * 0.3
  };
}

const editorPoses: Record<string, { label: string; state: MotionState }> = {
  neutral: { label: "中立", state: pose({}) },
  left: { label: "左转", state: pose({ headYaw: -0.9 }) },
  right: { label: "右转", state: pose({ headYaw: 0.9 }) },
  up: { label: "向上看", state: pose({ headPitch: -0.78 }) },
  down: { label: "向下看", state: pose({ headPitch: 0.78 }) },
  "left-up": { label: "左上", state: pose({ headYaw: -0.72, headPitch: -0.58 }) },
  "right-up": { label: "右上", state: pose({ headYaw: 0.72, headPitch: -0.58 }) },
  "left-down": { label: "左下", state: pose({ headYaw: -0.72, headPitch: 0.58 }) },
  "right-down": { label: "右下", state: pose({ headYaw: 0.72, headPitch: 0.58 }) }
};

function layerOverride(overrides: CalibrationOverrides, layerId: string, patch: NonNullable<CalibrationOverrides["layers"]>[string]): CalibrationOverrides {
  return mergeCalibrationOverrides(overrides, { layers: { [layerId]: patch } });
}

function relativeProjectPath(root: string, absolute: string): string {
  return absolute.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
}

export function Editor({ projectDirectory, onBack }: { projectDirectory: string; onBack: () => void }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<PuppetRenderer | undefined>(undefined);
  const drag = useRef<{ target: DragTarget; before: CalibrationOverrides } | undefined>(undefined);
  const pendingRef = useRef<CalibrationOverrides>({});
  const [workspace, setWorkspace] = useState<EditorWorkspace>();
  const [pending, setPending] = useState<CalibrationOverrides>({});
  const [undoStack, setUndoStack] = useState<CalibrationOverrides[]>([]);
  const [redoStack, setRedoStack] = useState<CalibrationOverrides[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [selectedVertex, setSelectedVertex] = useState<number>();
  const [mode, setMode] = useState<EditMode>("semantic");
  const [poseId, setPoseId] = useState("neutral");
  const [autonomous, setAutonomous] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");

  async function reload(): Promise<void> {
    const loaded = await window.puppetloom.readEditorWorkspace(projectDirectory);
    setWorkspace(loaded);
    setSelectedLayerId((current) => current && loaded.project.layers.some((layer) => layer.id === current)
      ? current
      : loaded.project.layers.find((layer) => layer.role === "face")?.id ?? loaded.project.layers.at(-1)?.id ?? "");
  }

  useEffect(() => {
    setError("");
    void reload().catch((cause) => setError(messageOf(cause)));
  }, [projectDirectory]);

  useEffect(() => {
    void window.puppetloom.setEditorMode(true);
    return () => { void window.puppetloom.setEditorMode(false); };
  }, []);

  const effectiveOverrides = useMemo(() => workspace ? mergeCalibrationOverrides(workspace.calibration.overrides, pending) : pending, [workspace, pending]);
  const project = useMemo(() => workspace ? applyCalibrationOverrides(workspace.baseProject, effectiveOverrides) : undefined, [workspace, effectiveOverrides]);
  const selectedLayer = project?.layers.find((layer) => layer.id === selectedLayerId);
  const baseLayer = workspace?.baseProject.layers.find((layer) => layer.id === selectedLayerId);
  const hasPending = Object.keys(pending).length > 0;

  useEffect(() => {
    if (!workspace || !canvas.current) return;
    let disposed = false;
    void PuppetRenderer.create(canvas.current, workspace.project, (layer) => window.puppetloom.readAsset(projectDirectory, layer)).then((created) => {
      if (disposed) { created.dispose(); return; }
      renderer.current = created;
      created.start();
      created.setPaused(true);
      created.render(editorPoses[poseId]!.state);
    }).catch((cause) => setError(messageOf(cause)));
    return () => {
      disposed = true;
      renderer.current?.dispose();
      renderer.current = undefined;
    };
  }, [workspace?.projectDirectory]);

  useEffect(() => {
    if (!project || !renderer.current) return;
    try {
      renderer.current.updateProject(project);
      renderer.current.setPaused(!autonomous);
      if (!autonomous) renderer.current.render(editorPoses[poseId]!.state);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [project, poseId, autonomous]);

  useEffect(() => () => { if (evidenceUrl) URL.revokeObjectURL(evidenceUrl); }, [evidenceUrl]);

  function commit(next: CalibrationOverrides): void {
    if (JSON.stringify(next) === JSON.stringify(pending)) return;
    setUndoStack((items) => [...items, clone(pending)]);
    setRedoStack([]);
    pendingRef.current = next;
    setPending(next);
  }

  function undo(): void {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setRedoStack((items) => [...items, clone(pending)]);
    pendingRef.current = previous;
    setPending(previous);
    setUndoStack((items) => items.slice(0, -1));
  }

  function redo(): void {
    const next = redoStack.at(-1);
    if (!next) return;
    setUndoStack((items) => [...items, clone(pending)]);
    pendingRef.current = next;
    setPending(next);
    setRedoStack((items) => items.slice(0, -1));
  }

  function beginDrag(event: React.PointerEvent<SVGCircleElement>, target: DragTarget): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { target, before: clone(pending) };
    if (target.kind === "mesh") setSelectedVertex(target.index);
  }

  function pointFromEvent(event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    };
  }

  function moveDrag(event: React.PointerEvent<SVGSVGElement>): void {
    if (!drag.current || !workspace || !selectedLayer) return;
    const position = pointFromEvent(event);
    const target = drag.current.target;
    setPending((current) => {
      let next = clone(current);
      if (target.kind === "semantic") {
        next.semanticPoints ??= {};
        next.semanticPoints[target.key] = position;
      } else if (target.kind === "anchor") {
        next.anchors ??= {};
        next.anchors[target.key] = position;
      } else if (target.kind === "pivot") {
        next = layerOverride(next, selectedLayer.id, { pivot: position });
      } else if (target.kind === "secondary") {
        next = layerOverride(next, selectedLayer.id, { secondaryAnchors: { [target.key]: position } });
      } else if (target.kind === "mesh") {
        const base = workspace.baseProject.layers.find((layer) => layer.id === selectedLayer.id)?.mesh.points[target.index];
        if (!base) return current;
        next = layerOverride(next, selectedLayer.id, { meshPointDeltas: { [target.index]: { x: position.x - base.x, y: position.y - base.y } } });
      }
      pendingRef.current = next;
      return next;
    });
  }

  function endDrag(): void {
    const active = drag.current;
    if (!active) return;
    drag.current = undefined;
    if (JSON.stringify(active.before) !== JSON.stringify(pendingRef.current)) {
      setUndoStack((items) => [...items, active.before]);
      setRedoStack([]);
    }
  }

  function setLayerProperty(patch: NonNullable<CalibrationOverrides["layers"]>[string]): void {
    if (!selectedLayer) return;
    commit(layerOverride(pending, selectedLayer.id, patch));
  }

  function setRuntimeTuning(kind: "motionTuning" | "envelope", key: string, value: number): void {
    const runtimePatch = kind === "motionTuning"
      ? { motionTuning: { [key]: value } }
      : { envelope: { [key]: value } };
    commit(mergeCalibrationOverrides(pending, { runtime: runtimePatch } as CalibrationOverrides));
  }

  function setVertexInfluence(channel: "head" | "body" | "gaze" | "physics" | "pin", value: number): void {
    if (!selectedLayer || selectedVertex === undefined) return;
    setLayerProperty({ vertexInfluences: { [channel]: { [selectedVertex]: value } } });
  }

  async function showEvidence(result: DesktopCalibrationResponse): Promise<void> {
    const relative = relativeProjectPath(projectDirectory, result.evidence.comparisonSheet);
    const blob = await window.puppetloom.readProjectFile(projectDirectory, relative);
    if (evidenceUrl) URL.revokeObjectURL(evidenceUrl);
    setEvidenceUrl(URL.createObjectURL(blob));
  }

  async function save(): Promise<void> {
    if (!hasPending) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await window.puppetloom.saveCalibration(projectDirectory, { label: label.trim() || "用户界面校准", overrides: pending });
      await showEvidence(result);
      setNotice(`已保存 revision ${result.calibration.revision}，并生成修改前后视觉证据。`);
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]); setLabel("");
      await reload();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function restoreAutomatic(): Promise<void> {
    setBusy(true); setError("");
    try {
      const result = await window.puppetloom.restoreCalibration(projectDirectory, 0, "恢复自动绑定");
      await showEvidence(result);
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]);
      setNotice(`已把自动绑定作为 revision ${result.calibration.revision} 保存，可从历史继续恢复。`);
      await reload();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function resetSelectedLayer(): Promise<void> {
    if (!selectedLayer) return;
    setBusy(true); setError("");
    try {
      const result = await window.puppetloom.saveCalibration(projectDirectory, {
        label: `恢复 ${selectedLayer.sourceName} 的自动绑定`,
        overrides: {},
        clear: { layers: [selectedLayer.id] }
      });
      await showEvidence(result);
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]);
      setNotice(`已恢复 ${selectedLayer.sourceName}，其它校准保持不变。`);
      await reload();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function markEvidence(sessionId: string, status: "accepted" | "rejected"): Promise<void> {
    try {
      await window.puppetloom.setEvidenceStatus(projectDirectory, sessionId, status);
      await reload();
    } catch (cause) { setError(messageOf(cause)); }
  }

  if (!workspace || !project) return <main className="editor-loading"><button onClick={onBack}>返回</button><p>{error || "正在加载编辑器…"}</p></main>;

  const cage = project.runtime.semanticCage;
  const meshTriangles = selectedLayer?.mesh.triangles ?? [];
  const meshPoints = selectedLayer?.mesh.points ?? [];
  const sessions = [...workspace.sessions].reverse();

  return (
    <main className="editor-shell" data-testid="editor">
      <header className="editor-header">
        <button onClick={onBack}>返回主页</button>
        <div><h1>{project.name}</h1><p>revision {workspace.calibration.revision} · {project.rigLevel} · {project.layers.length} 层</p></div>
        <div className="editor-history-actions">
          <button disabled={undoStack.length === 0} onClick={undo}>撤销</button>
          <button disabled={redoStack.length === 0} onClick={redo}>重做</button>
          <button onClick={() => void restoreAutomatic()} disabled={busy}>恢复全部自动绑定</button>
        </div>
      </header>

      <section className="editor-toolbar">
        <div className="mode-tabs">
          {(["semantic", "anchors", "layer", "mesh"] as EditMode[]).map((item) => <button className={mode === item ? "active" : ""} key={item} onClick={() => setMode(item)}>{item === "semantic" ? "脸部控制点" : item === "anchors" ? "身体锚点" : item === "layer" ? "图层轴心" : "网格顶点"}</button>)}
        </div>
        <div className="pose-tabs">
          {Object.entries(editorPoses).map(([id, item]) => <button className={!autonomous && poseId === id ? "active" : ""} key={id} onClick={() => { setAutonomous(false); setPoseId(id); }}>{item.label}</button>)}
          <button className={autonomous ? "active" : ""} onClick={() => setAutonomous((value) => !value)}>自主预览</button>
        </div>
      </section>

      <section className="editor-workspace">
        <aside className="layer-panel">
          <h2>图层</h2>
          <div className="layer-list">
            {[...project.layers].sort((a, b) => b.order - a.order).map((layer) => (
              <button key={layer.id} className={selectedLayerId === layer.id ? "selected" : ""} onClick={() => { setSelectedLayerId(layer.id); setSelectedVertex(undefined); }}>
                <span>{layer.sourceName}</span><small>{layer.role} · {layer.side}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="viewport-panel">
          <div className="editor-stage" style={{ aspectRatio: `${project.canvas.width} / ${project.canvas.height}` }}>
            <canvas ref={canvas} className="editor-canvas" />
            <svg className="editor-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
              {mode === "semantic" && cage && <>
                {[...cage.faceTriangles, ...cage.skullTriangles].flatMap((triangle, triangleIndex) => triangle.map((id, index) => {
                  const nextId = triangle[(index + 1) % 3]!;
                  const a = cage.points[id].position; const b = cage.points[nextId].position;
                  return <line key={`${triangleIndex}-${id}-${nextId}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="cage-line" />;
                }))}
                {Object.entries(cage.points).map(([id, entry]) => <circle key={id} cx={entry.position.x} cy={entry.position.y} r="0.008" className="handle semantic-handle" onPointerDown={(event) => beginDrag(event, { kind: "semantic", key: id as SemanticCagePointId })}><title>{id}</title></circle>)}
              </>}
              {mode === "anchors" && Object.entries(project.anchors).map(([id, point]) => point && <g key={id}>
                <circle cx={point.x} cy={point.y} r="0.009" className="handle anchor-handle" onPointerDown={(event) => beginDrag(event, { kind: "anchor", key: id as keyof AnchorGraph })} />
                <text x={point.x + 0.01} y={point.y - 0.009}>{id}</text>
              </g>)}
              {mode === "layer" && selectedLayer && <>
                <circle cx={selectedLayer.pivot.x} cy={selectedLayer.pivot.y} r="0.011" className="handle pivot-handle" onPointerDown={(event) => beginDrag(event, { kind: "pivot" })} />
                <text x={selectedLayer.pivot.x + 0.012} y={selectedLayer.pivot.y - 0.01}>pivot</text>
                {Object.entries(selectedLayer.secondaryAnchors ?? {}).map(([id, point]) => point && <g key={id}>
                  <circle cx={point.x} cy={point.y} r="0.009" className="handle secondary-handle" onPointerDown={(event) => beginDrag(event, { kind: "secondary", key: id as keyof NonNullable<LayerBinding["secondaryAnchors"]> })} />
                  <text x={point.x + 0.01} y={point.y - 0.009}>{id}</text>
                </g>)}
              </>}
              {mode === "mesh" && selectedLayer && <>
                {Array.from({ length: Math.floor(meshTriangles.length / 3) }, (_, triangleIndex) => {
                  const ids = meshTriangles.slice(triangleIndex * 3, triangleIndex * 3 + 3);
                  return ids.map((id, edgeIndex) => {
                    const a = meshPoints[id!]; const b = meshPoints[ids[(edgeIndex + 1) % 3]!];
                    return a && b ? <line key={`${triangleIndex}-${edgeIndex}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="mesh-line" /> : null;
                  });
                })}
                {meshPoints.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={selectedVertex === index ? "0.007" : "0.0045"} className={`handle mesh-handle ${selectedVertex === index ? "selected" : ""}`} onPointerDown={(event) => beginDrag(event, { kind: "mesh", index })} />)}
              </>}
            </svg>
          </div>
          <p className="viewport-help">拖动彩色点直接校准。修改先在内存中预览，点击保存后才写入项目并生成前后对比。</p>
          {evidenceUrl && <section className="evidence-preview"><h3>最近一次修改前 / 修改后</h3><img src={evidenceUrl} alt="最近一次校准前后对比" /></section>}
        </section>

        <aside className="inspector-panel">
          <h2>属性</h2>
          {selectedLayer ? <>
            <dl><dt>图层</dt><dd>{selectedLayer.sourceName}</dd><dt>网格</dt><dd>{selectedLayer.mesh.rows} × {selectedLayer.mesh.cols}</dd><dt>顶点</dt><dd>{selectedLayer.mesh.points.length}</dd></dl>
            <label>语义<select value={selectedLayer.role} onChange={(event) => setLayerProperty({ role: event.target.value as SemanticRole })}>{semanticRoles.map((role) => <option key={role}>{role}</option>)}</select></label>
            <label>归属<select value={selectedLayer.parentGroup} onChange={(event) => setLayerProperty({ parentGroup: event.target.value as LayerBinding["parentGroup"] })}><option value="head">头部</option><option value="body">身体</option><option value="root">根节点</option></select></label>
            {(["head", "body", "gaze", "physics"] as const).map((key) => <label className="range-row" key={key}><span>{key} {selectedLayer.weights[key].toFixed(2)}</span><input type="range" min="0" max="1" step="0.01" value={selectedLayer.weights[key]} onChange={(event) => setLayerProperty({ weights: { [key]: Number(event.target.value) } })} /></label>)}
            {selectedVertex !== undefined && <section className="vertex-inspector">
              <h3>顶点 {selectedVertex}</h3>
              <p>x {meshPoints[selectedVertex]?.x.toFixed(5)} · y {meshPoints[selectedVertex]?.y.toFixed(5)}</p>
              {(["head", "body", "gaze", "physics", "pin"] as const).map((channel) => {
                const fallback = channel === "pin" ? 0 : 1;
                const value = selectedLayer.mesh.influences?.[channel]?.[selectedVertex] ?? fallback;
                return <label className="range-row" key={channel}><span>{channel === "pin" ? "固定强度" : `${channel} 顶点权重`} {value.toFixed(2)}</span><input type="range" min="0" max="1" step="0.05" value={value} onChange={(event) => setVertexInfluence(channel, Number(event.target.value))} /></label>;
              })}
            </section>}
            <button onClick={() => void resetSelectedLayer()} disabled={busy}>只恢复这个图层</button>
          </> : <p>从左侧选择图层。</p>}

          <section className="save-panel">
            <h3>整体动作</h3>
            {(["amplitude", "response", "stability"] as const).map((key) => {
              const value = project.runtime.motionTuning?.[key] ?? ({ amplitude: 1, response: 0.72, stability: 0.42 }[key]);
              return <label className="range-row" key={key}><span>{key} {value.toFixed(2)}</span><input type="range" min="0" max={key === "amplitude" ? "1.5" : "1"} step="0.01" value={value} onChange={(event) => setRuntimeTuning("motionTuning", key, Number(event.target.value))} /></label>;
            })}
            {(["headYaw", "headPitch", "breath"] as const).map((key) => {
              const value = project.runtime.envelope[key];
              const maximum = key === "breath" ? 0.08 : 1;
              return <label className="range-row" key={key}><span>{key} {value.toFixed(3)}</span><input type="range" min="0" max={maximum} step={key === "breath" ? "0.001" : "0.01"} value={value} onChange={(event) => setRuntimeTuning("envelope", key, Number(event.target.value))} /></label>;
            })}
            <label>校准说明<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：固定耳根并调整右眼外角" /></label>
            <button className="primary" disabled={!hasPending || busy} onClick={() => void save()}>{busy ? "正在验证并生成证据…" : "保存校准"}</button>
            {notice && <p className="success">{notice}</p>}
            {error && <p className="error">{error}</p>}
          </section>

          <section className="session-panel">
            <h3>校准历史</h3>
            {sessions.length === 0 && <p>还没有保存过校准。</p>}
            {sessions.slice(0, 8).map((session) => <article key={session.id}>
              <strong>r{session.toRevision} · {session.label}</strong><small>{session.evidenceStatus}</small>
              <div><button onClick={() => void markEvidence(session.id, "accepted")}>确认有效</button><button onClick={() => void markEvidence(session.id, "rejected")}>标记无效</button></div>
            </article>)}
          </section>
        </aside>
      </section>
    </main>
  );
}
