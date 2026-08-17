import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CalibrationOverrides,
  LayerBinding,
  MotionState,
  RevisionComparisonResult,
  SecondaryMotionPart
} from "@puppetloom/core";
import { applyCalibrationOverrides, applySafetyLimits, mergeCalibrationOverrides, neutralMotionState } from "@puppetloom/core/browser";
import { PuppetRenderer } from "@puppetloom/renderer";
import type { DesktopCalibrationResponse, EditorWorkspace as EditorWorkspaceData } from "../electron/global.js";
import {
  EditorInspectorPanel,
  EditorLayerPanel,
  EditorViewportPanel,
  type ComparisonImages,
  type ComparisonMode,
  type DragTarget,
  type EditMode
} from "./editor/EditorPresentation.js";
import { useEditorDraftPersistence } from "./editor/useEditorDraftPersistence.js";

interface MeshDragSnapshot {
  selected: number;
  selectedPoint: { x: number; y: number };
  points: Array<{ x: number; y: number }>;
  basePoints: Array<{ x: number; y: number }>;
  pins: number[];
}


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
  neutral: { label: "中立", state: pose({}) }, left: { label: "左转", state: pose({ headYaw: -0.9 }) }, right: { label: "右转", state: pose({ headYaw: 0.9 }) },
  up: { label: "向上看", state: pose({ headPitch: -0.78 }) }, down: { label: "向下看", state: pose({ headPitch: 0.78 }) },
  "left-up": { label: "左上", state: pose({ headYaw: -0.72, headPitch: -0.58 }) }, "right-up": { label: "右上", state: pose({ headYaw: 0.72, headPitch: -0.58 }) },
  "left-down": { label: "左下", state: pose({ headYaw: -0.72, headPitch: 0.58 }) }, "right-down": { label: "右下", state: pose({ headYaw: 0.72, headPitch: 0.58 }) }
};

function layerOverride(overrides: CalibrationOverrides, layerId: string, patch: NonNullable<CalibrationOverrides["layers"]>[string]): CalibrationOverrides {
  return mergeCalibrationOverrides(overrides, { layers: { [layerId]: patch } });
}

function relativeProjectPath(root: string, absolute: string): string {
  return absolute.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function EditorWorkspace({ projectDirectory, onBack }: { projectDirectory: string; onBack: () => void }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<PuppetRenderer | undefined>(undefined);
  const drag = useRef<{ target: DragTarget; before: CalibrationOverrides; mesh?: MeshDragSnapshot } | undefined>(undefined);
  const [workspace, setWorkspace] = useState<EditorWorkspaceData>();
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
  const [draftStatus, setDraftStatus] = useState<"idle" | "waiting" | "saving" | "saved" | "error">("idle");
  const [softRadius, setSoftRadius] = useState(0.035);
  const [secondaryPart, setSecondaryPart] = useState<SecondaryMotionPart>("frontHair");
  const [comparison, setComparison] = useState<ComparisonImages>();
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("split");
  const [splitPercent, setSplitPercent] = useState(50);
  const { pendingRef, cancelScheduled, flushDraft } = useEditorDraftPersistence({
    projectDirectory,
    revision: workspace?.calibration.revision,
    pending,
    label,
    busy,
    setDraftStatus,
    setError
  });

  async function reload(restoreDraft = false): Promise<void> {
    const loaded = await window.puppetloom.readEditorWorkspace(projectDirectory);
    setWorkspace(loaded);
    setSelectedLayerId((current) => current && loaded.project.layers.some((layer) => layer.id === current)
      ? current
      : loaded.project.layers.find((layer) => layer.role === "face")?.id ?? loaded.project.layers.at(-1)?.id ?? "");
    if (restoreDraft && loaded.draft) {
      pendingRef.current = loaded.draft.overrides;
      setPending(loaded.draft.overrides);
      setLabel(loaded.draft.label ?? "");
      setNotice(`已恢复 ${new Date(loaded.draft.updatedAt).toLocaleString()} 自动保存的草稿。`);
      setDraftStatus("saved");
    }
  }

  useEffect(() => {
    setError("");
    void reload(true).catch((cause) => setError(messageOf(cause)));
  }, [projectDirectory]);

  useEffect(() => {
    void window.puppetloom.setEditorMode(true, projectDirectory);
    return () => { void window.puppetloom.setEditorMode(false); };
  }, [projectDirectory]);

  const effectiveOverrides = useMemo(() => workspace ? mergeCalibrationOverrides(workspace.calibration.overrides, pending) : pending, [workspace, pending]);
  const project = useMemo(() => workspace ? applySafetyLimits(applyCalibrationOverrides(workspace.baseProject, effectiveOverrides)) : undefined, [workspace, effectiveOverrides]);
  const selectedLayer = project?.layers.find((layer) => layer.id === selectedLayerId);
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

  useEffect(() => () => {
    for (const url of comparison ? [comparison.before, comparison.after, comparison.difference] : []) URL.revokeObjectURL(url);
  }, [comparison]);

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

  function meshBaseline(layerId: string): LayerBinding | undefined {
    if (!workspace) return undefined;
    const overrides = clone(effectiveOverrides);
    const layer = overrides.layers?.[layerId];
    if (layer) {
      delete layer.meshPointDeltas;
      delete layer.vertexInfluences;
    }
    return applyCalibrationOverrides(workspace.baseProject, overrides).layers.find((candidate) => candidate.id === layerId);
  }

  function beginDrag(event: React.PointerEvent<SVGCircleElement>, target: DragTarget): void {
    if (event.button !== 0) return;
    if ((target.kind === "mesh" || target.kind === "pivot" || target.kind === "secondary") && selectedLayer?.locked) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const active: { target: DragTarget; before: CalibrationOverrides; mesh?: MeshDragSnapshot } = { target, before: clone(pending) };
    if (target.kind === "mesh" && selectedLayer) {
      const baseline = meshBaseline(selectedLayer.id);
      const selectedPoint = selectedLayer.mesh.points[target.index];
      if (!baseline || !selectedPoint || baseline.mesh.points.length !== selectedLayer.mesh.points.length) return;
      active.mesh = {
        selected: target.index,
        selectedPoint: clone(selectedPoint),
        points: clone(selectedLayer.mesh.points),
        basePoints: clone(baseline.mesh.points),
        pins: clone(selectedLayer.mesh.influences?.pin ?? Array(selectedLayer.mesh.points.length).fill(0))
      };
      setSelectedVertex(target.index);
    }
    drag.current = active;
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
    const active = drag.current;
    const target = active.target;
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
      } else if (target.kind === "mesh" && active.mesh) {
        const dx = position.x - active.mesh.selectedPoint.x;
        const dy = position.y - active.mesh.selectedPoint.y;
        const deltas: Record<string, { x: number; y: number }> = {};
        for (let index = 0; index < active.mesh.points.length; index += 1) {
          const start = active.mesh.points[index]!;
          const base = active.mesh.basePoints[index]!;
          const distance = Math.hypot(start.x - active.mesh.selectedPoint.x, start.y - active.mesh.selectedPoint.y);
          if (index !== active.mesh.selected && distance > softRadius) continue;
          const falloff = index === active.mesh.selected ? 1 : (1 - smoothstep(distance / Math.max(0.001, softRadius))) ** 2;
          const movable = falloff * (1 - (active.mesh.pins[index] ?? 0));
          deltas[index] = { x: start.x + dx * movable - base.x, y: start.y + dy * movable - base.y };
        }
        next = layerOverride(next, selectedLayer.id, { meshPointDeltas: deltas });
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

  function nudgeWithKeyboard(event: React.KeyboardEvent<SVGCircleElement>, target: DragTarget): void {
    const offsets: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }
    };
    const offset = offsets[event.key];
    if (!offset || !workspace) return;
    if ((target.kind === "mesh" || target.kind === "pivot" || target.kind === "secondary") && selectedLayer?.locked) return;
    event.preventDefault();
    const amount = event.shiftKey ? 0.01 : 0.001;
    const shifted = (point: { x: number; y: number }) => ({
      x: Math.max(0, Math.min(1, point.x + offset.x * amount)),
      y: Math.max(0, Math.min(1, point.y + offset.y * amount))
    });
    let next = clone(pending);
    if (target.kind === "semantic") {
      const point = project?.runtime.semanticCage?.points[target.key].position;
      if (!point) return;
      next.semanticPoints ??= {};
      next.semanticPoints[target.key] = shifted(point);
    } else if (target.kind === "anchor") {
      const point = project?.anchors[target.key];
      if (!point) return;
      next.anchors ??= {};
      next.anchors[target.key] = shifted(point);
    } else if (target.kind === "pivot" && selectedLayer) {
      next = layerOverride(next, selectedLayer.id, { pivot: shifted(selectedLayer.pivot) });
    } else if (target.kind === "secondary" && selectedLayer) {
      const point = selectedLayer.secondaryAnchors?.[target.key];
      if (!point) return;
      next = layerOverride(next, selectedLayer.id, { secondaryAnchors: { [target.key]: shifted(point) } });
    } else if (target.kind === "mesh" && selectedLayer) {
      setSelectedVertex(target.index);
      if ((selectedLayer.mesh.influences?.pin?.[target.index] ?? 0) >= 1) return;
      const baseline = meshBaseline(selectedLayer.id);
      const point = selectedLayer.mesh.points[target.index];
      const basePoint = baseline?.mesh.points[target.index];
      if (!point || !basePoint) return;
      const position = shifted(point);
      next = layerOverride(next, selectedLayer.id, { meshPointDeltas: { [target.index]: { x: position.x - basePoint.x, y: position.y - basePoint.y } } });
    }
    commit(next);
  }

  function patchLayer(layerId: string, patch: NonNullable<CalibrationOverrides["layers"]>[string]): void {
    commit(layerOverride(pending, layerId, patch));
  }

  function setLayerProperty(patch: NonNullable<CalibrationOverrides["layers"]>[string]): void {
    if (!selectedLayer) return;
    patchLayer(selectedLayer.id, patch);
  }

  function setRuntimeTuning(kind: "motionTuning" | "envelope", key: string, value: number): void {
    const runtimePatch = kind === "motionTuning" ? { motionTuning: { [key]: value } } : { envelope: { [key]: value } };
    commit(mergeCalibrationOverrides(pending, { runtime: runtimePatch } as CalibrationOverrides));
  }

  function setSecondaryTuning(part: SecondaryMotionPart, key: "amplitude" | "response" | "stability", value: number): void {
    commit(mergeCalibrationOverrides(pending, { runtime: { secondaryMotionTuning: { [part]: { [key]: value } } } }));
  }

  function setVertexInfluence(channel: "face" | "skull" | "head" | "body" | "gaze" | "physics" | "pin", value: number): void {
    if (!selectedLayer || selectedVertex === undefined) return;
    setLayerProperty({ vertexInfluences: { [channel]: { [selectedVertex]: value } } });
  }

  function moveSelectedLayer(direction: -1 | 1): void {
    if (!selectedLayer) return;
    const ascending = [...(project?.layers ?? [])].sort((left, right) => left.order - right.order);
    const index = ascending.findIndex((layer) => layer.id === selectedLayer.id);
    const other = ascending[index + direction];
    if (!other) return;
    let next = layerOverride(pending, selectedLayer.id, { order: other.order });
    next = layerOverride(next, other.id, { order: selectedLayer.order });
    commit(next);
  }

  async function loadComparison(result: RevisionComparisonResult): Promise<void> {
    const paths = ["before-evidence.png", "after-evidence.png", "difference.png"].map((name) => relativeProjectPath(projectDirectory, `${result.outputDirectory}/${name}`));
    const blobs = await Promise.all(paths.map((path) => window.puppetloom.readProjectFile(projectDirectory, path)));
    setComparison({ result, before: URL.createObjectURL(blobs[0]!), after: URL.createObjectURL(blobs[1]!), difference: URL.createObjectURL(blobs[2]!) });
    setComparisonMode("split");
  }

  async function showEvidence(result: DesktopCalibrationResponse): Promise<void> {
    await loadComparison(result.evidence);
  }

  async function showSessionEvidence(sessionId: string): Promise<void> {
    setBusy(true); setError("");
    try { await loadComparison(await window.puppetloom.calibrationEvidence(projectDirectory, sessionId)); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function save(): Promise<void> {
    if (!hasPending) return;
    cancelScheduled();
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await window.puppetloom.saveCalibration(projectDirectory, { baseRevision: workspace!.calibration.revision, label: label.trim() || "用户界面校准", overrides: pending });
      await showEvidence(result);
      setNotice(`已保存 revision ${result.calibration.revision}，安全系数 ${result.project.quality.safetyScale.toFixed(2)}。`);
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]); setLabel(""); setDraftStatus("idle");
      await reload();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function restoreRevision(revision: number, restoreLabel: string): Promise<void> {
    setBusy(true); setError("");
    try {
      if (hasPending) { setError("请先保存或明确放弃当前草稿，再恢复历史版本。草稿仍然保留。" ); return; }
      const result = await window.puppetloom.restoreCalibration(projectDirectory, revision, workspace!.calibration.revision, restoreLabel);
      await showEvidence(result);
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]); setLabel("");
      setNotice(`已把 revision ${revision} 恢复为新的 revision ${result.calibration.revision}。`);
      await reload();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function resetSelectedLayer(): Promise<void> {
    if (!selectedLayer) return;
    setBusy(true); setError("");
    try {
      if (hasPending) { setError("请先保存或明确放弃当前草稿，再恢复自动绑定。草稿仍然保留。" ); return; }
      const result = await window.puppetloom.saveCalibration(projectDirectory, { baseRevision: workspace!.calibration.revision, label: `恢复 ${selectedLayer.sourceName} 的自动绑定`, overrides: {}, clear: { layers: [selectedLayer.id] } });
      await showEvidence(result);
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]);
      setNotice(`已恢复 ${selectedLayer.sourceName}，其它校准保持不变。`);
      await reload();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function markEvidence(sessionId: string, status: "accepted" | "rejected"): Promise<void> {
    try { await window.puppetloom.setEvidenceStatus(projectDirectory, sessionId, status); await reload(); }
    catch (cause) { setError(messageOf(cause)); }
  }

  async function leaveEditor(): Promise<void> {
    try { await flushDraft(); }
    catch (cause) { setError(`离开前保存草稿失败：${messageOf(cause)}`); return; }
    onBack();
  }

  async function discardDraft(): Promise<void> {
    if (!hasPending || !window.confirm("放弃当前未提交草稿？已保存的校准历史不会改变。")) return;
    cancelScheduled();
    try {
      await window.puppetloom.discardCalibrationDraft(projectDirectory);
      pendingRef.current = {};
      setPending({}); setUndoStack([]); setRedoStack([]); setLabel(""); setDraftStatus("idle"); setError("");
      setNotice("当前草稿已明确放弃；历史校准未改变。" );
    } catch (cause) { setError(`无法放弃草稿：${messageOf(cause)}`); }
  }

  async function launchViewer(): Promise<void> {
    setError("");
    try {
      await window.puppetloom.launchViewer(projectDirectory);
      setNotice("角色窗口已打开；重复运行会唤回同一个窗口。");
    } catch (cause) {
      setError(`无法打开角色窗口：${messageOf(cause)}`);
    }
  }

  if (!workspace || !project) return <main className="editor-loading"><button onClick={onBack}>返回</button><p>{error || "正在加载编辑器…"}</p></main>;

  const sessions = [...workspace.sessions].reverse();
  const selectedTuning = { amplitude: 1, response: 0.5, stability: 0.5, ...(project.runtime.secondaryMotionTuning?.[secondaryPart] ?? {}) };

  return (
    <main className="editor-shell" data-testid="editor">
      <header className="editor-header">
        <button onClick={() => void leaveEditor()}>返回主页</button>
        <div><h1>{project.name}</h1><p>revision {workspace.calibration.revision} · {project.rigLevel} · {project.layers.length} 层 · 安全系数 {project.quality.safetyScale.toFixed(2)}</p></div>
        <div className="editor-history-actions">
          <span className={`draft-state ${draftStatus}`}>{draftStatus === "saving" ? "正在自动保存" : draftStatus === "saved" ? "草稿已保存" : draftStatus === "error" ? "草稿保存失败" : draftStatus === "waiting" ? "等待自动保存" : ""}</span>
          <button onClick={() => void launchViewer()}>运行角色窗口</button>
          <button disabled={undoStack.length === 0} onClick={undo}>撤销</button>
          <button disabled={redoStack.length === 0} onClick={redo}>重做</button>
          <button onClick={() => void restoreRevision(0, "恢复全部自动绑定")} disabled={busy}>恢复全部自动绑定</button>
        </div>
      </header>

      <section className="editor-toolbar">
        <div className="mode-tabs">
          {(["semantic", "anchors", "layer", "mesh"] as EditMode[]).map((item) => <button className={mode === item ? "active" : ""} key={item} onClick={() => setMode(item)}>{item === "semantic" ? "脸部控制点" : item === "anchors" ? "身体锚点" : item === "layer" ? "图层轴心" : "网格与权重"}</button>)}
        </div>
        <div className="pose-tabs">
          {Object.entries(editorPoses).map(([id, item]) => <button className={!autonomous && poseId === id ? "active" : ""} key={id} onClick={() => { setAutonomous(false); setPoseId(id); }}>{item.label}</button>)}
          <button className={autonomous ? "active" : ""} onClick={() => setAutonomous((value) => !value)}>自主预览</button>
        </div>
      </section>

      <section className="editor-workspace">
        <EditorLayerPanel
          project={project}
          selectedLayerId={selectedLayerId}
          onSelect={(layerId) => { setSelectedLayerId(layerId); setSelectedVertex(undefined); }}
          onPatchLayer={patchLayer}
        />
        <EditorViewportPanel
          canvas={canvas}
          project={project}
          mode={mode}
          selectedLayer={selectedLayer}
          selectedVertex={selectedVertex}
          softRadius={softRadius}
          comparison={comparison}
          comparisonMode={comparisonMode}
          splitPercent={splitPercent}
          onBeginDrag={beginDrag}
          onMoveDrag={moveDrag}
          onEndDrag={endDrag}
          onNudge={nudgeWithKeyboard}
          onSelectVertex={setSelectedVertex}
          onComparisonMode={setComparisonMode}
          onSplitPercent={setSplitPercent}
        />
        <EditorInspectorPanel
          project={project}
          selectedLayer={selectedLayer}
          selectedVertex={selectedVertex}
          softRadius={softRadius}
          secondaryPart={secondaryPart}
          selectedTuning={selectedTuning}
          label={label}
          hasPending={hasPending}
          busy={busy}
          notice={notice}
          error={error}
          sessions={sessions}
          comparison={comparison}
          onLayerProperty={setLayerProperty}
          onMoveLayer={moveSelectedLayer}
          onSoftRadius={setSoftRadius}
          onVertexInfluence={setVertexInfluence}
          onResetLayer={() => void resetSelectedLayer()}
          onRuntimeTuning={setRuntimeTuning}
          onSecondaryPart={setSecondaryPart}
          onSecondaryTuning={setSecondaryTuning}
          onLabel={setLabel}
          onSave={() => void save()}
          onDiscard={() => void discardDraft()}
          onShowEvidence={(sessionId) => void showSessionEvidence(sessionId)}
          onRestore={(revision, restoreLabel) => void restoreRevision(revision, restoreLabel)}
          onMarkEvidence={(sessionId, status) => void markEvidence(sessionId, status)}
        />
      </section>
    </main>
  );
}
