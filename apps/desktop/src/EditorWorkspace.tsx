import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CalibrationOverrides,
  MotionState,
  PoseValidation,
  PuppetLoomProject,
  RevisionComparisonResult
} from "@puppetloom/core";
import {
  applyCalibrationOverrides,
  deformedPoints,
  mergeCalibrationOverrides,
  neutralMotionState,
  poseCorrectionSamples,
  validateProjectPoses,
  validatePose
} from "@puppetloom/core/browser";
import { PuppetRenderer } from "@puppetloom/renderer";
import { Anchor, ArrowLeft, Bone, ExternalLink, GitCompare, Grid3x3, Minimize2, Pause, Play, Redo2, RotateCcw, Save, ScanFace, Undo2, View, X } from "lucide-react";
import type { DesktopCalibrationResponse, EditorWorkspace as EditorWorkspaceData } from "../electron/global.js";
import { clone, editorPoses, isTextEditingTarget, messageOf, relativeProjectPath } from "./editor/EditorWorkspaceModel.js";
import { useEditorEditingTools } from "./editor/useEditorEditingTools.js";
import {
  EditorInspectorPanel,
  EditorLayerPanel,
  EditorViewportPanel,
  type ComparisonImages,
  type ComparisonMode,
  type DragTarget,
  type EditMode,
  type MeshSelectionMode
} from "./editor/EditorPresentation.js";
import {
  DynamicsInspector,
  DynamicsLeftPanel,
  OverviewInspector,
  OverviewLeftPanel,
  ParameterInspector,
  ParameterLeftPanel,
  PreviewInspector,
  PreviewLeftPanel,
  StudioNavigation,
  type PreviewBackground,
  type StudioSection
} from "./editor/EditorStudioPanels.js";
import { useEditorDraftPersistence } from "./editor/useEditorDraftPersistence.js";

export function EditorWorkspace({ projectDirectory, onBack }: { projectDirectory: string; onBack: () => void }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<PuppetRenderer | undefined>(undefined);
  const operationLock = useRef(false);
  const historyGroup = useRef<{ key: string; at: number } | undefined>(undefined);
  const [workspace, setWorkspace] = useState<EditorWorkspaceData>();
  const [pending, setPending] = useState<CalibrationOverrides>({});
  const [undoStack, setUndoStack] = useState<CalibrationOverrides[]>([]);
  const [redoStack, setRedoStack] = useState<CalibrationOverrides[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [section, setSection] = useState<StudioSection>("overview");
  const [mode, setMode] = useState<EditMode>("semantic");
  const [editorOverlayVisible, setEditorOverlayVisible] = useState(false);
  const [showNeutralMeshReference, setShowNeutralMeshReference] = useState(false);
  const [showDraftBefore, setShowDraftBefore] = useState(false);
  const [soloSelectedLayer, setSoloSelectedLayer] = useState(false);
  const [poseId, setPoseId] = useState("neutral");
  const [autonomous, setAutonomous] = useState(false);
  const [previewState, setPreviewState] = useState<MotionState>(() => clone(neutralMotionState));
  const autonomousRef = useRef(autonomous);
  const previewStateRef = useRef(previewState);
  const renderProjectRef = useRef<PuppetLoomProject | undefined>(undefined);
  const [selectedParameterId, setSelectedParameterId] = useState("param-head-yaw");
  const [selectedBehaviorId, setSelectedBehaviorId] = useState("");
  const [behaviorTime, setBehaviorTime] = useState(0);
  const [behaviorPlaying, setBehaviorPlaying] = useState(false);
  const [previewBackground, setPreviewBackground] = useState<PreviewBackground>("checker");
  const [focusedPreview, setFocusedPreview] = useState(false);
  const [activePreviewSample, setActivePreviewSample] = useState("neutral");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [meshUpgrading, setMeshUpgrading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draftStatus, setDraftStatus] = useState<"idle" | "waiting" | "saving" | "saved" | "error">("idle");
  const [comparison, setComparison] = useState<ComparisonImages>();
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("split");
  const [splitPercent, setSplitPercent] = useState(50);
  const [poseChecks, setPoseChecks] = useState<Record<string, PoseValidation>>({});
  const [draftSafetyChecks, setDraftSafetyChecks] = useState<PoseValidation[]>([]);
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
    setSelectedParameterId((current) => loaded.project.model.parameters.some((parameter) => parameter.id === current)
      ? current
      : loaded.project.model.parameters[0]?.id ?? "");
    setSelectedBehaviorId((current) => loaded.project.model.behaviors.some((behavior) => behavior.id === current)
      ? current
      : loaded.project.model.behaviors[0]?.id ?? "");
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
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    void window.puppetloom.setEditorMode(true, projectDirectory);
    return () => { void window.puppetloom.setEditorMode(false); };
  }, [projectDirectory]);

  const hasPending = Object.keys(pending).length > 0;
  const effectiveOverrides = useMemo(() => workspace ? mergeCalibrationOverrides(workspace.calibration.overrides, pending) : pending, [workspace, pending]);
  // A draft must stay spatially stable while a point is dragged. Safety is
  // reported below and enforced by the save transaction, never by silently
  // shrinking the whole runtime envelope during pointer movement.
  const project = useMemo(() => workspace
    ? hasPending ? applyCalibrationOverrides(workspace.baseProject, effectiveOverrides) : workspace.project
    : undefined, [workspace, effectiveOverrides, hasPending]);
  const selectedLayer = project?.layers.find((layer) => layer.id === selectedLayerId);
  const interactionLocked = busy || meshUpgrading;
  const renderProject = useMemo(() => {
    const source = showDraftBefore ? workspace?.project : project;
    if (!source || !soloSelectedLayer || section !== "rig") return source;
    return {
      ...source,
      layers: source.layers.map((layer) => layer.id === selectedLayerId
        ? { ...layer, visible: true }
        : { ...layer, visible: false })
    };
  }, [project, section, selectedLayerId, showDraftBefore, soloSelectedLayer, workspace?.project]);
  autonomousRef.current = autonomous;
  previewStateRef.current = previewState;
  renderProjectRef.current = renderProject;
  const renderSelectedLayer = renderProject?.layers.find((layer) => layer.id === selectedLayerId);
  const posedMeshPoints = useMemo(() => renderProject && renderSelectedLayer
    ? deformedPoints(renderProject, renderSelectedLayer, previewState)
    : [], [renderProject, renderSelectedLayer, previewState]);
  const liveMeshPoints = useCallback(() => {
    const state = renderer.current?.motionState;
    return renderProject && renderSelectedLayer && state ? deformedPoints(renderProject, renderSelectedLayer, state) : undefined;
  }, [renderProject, renderSelectedLayer]);

  useEffect(() => {
    if (!project) return;
    const timeout = window.setTimeout(() => {
      setPoseChecks(Object.fromEntries(Object.entries(editorPoses).map(([id, item]) => [id, validatePose(project, id, item.state)])));
      setDraftSafetyChecks(validateProjectPoses(project));
    }, 240);
    return () => window.clearTimeout(timeout);
  }, [project]);

  useEffect(() => {
    if (!workspace || !canvas.current) return;
    let disposed = false;
    void PuppetRenderer.create(canvas.current, workspace.project, (layer) => window.puppetloom.readAsset(projectDirectory, layer)).then((created) => {
      if (disposed) { created.dispose(); return; }
      try {
        const latestProject = renderProjectRef.current;
        if (latestProject && latestProject !== created.project) created.updateProject(latestProject);
        renderer.current = created;
        created.start();
        created.setPaused(!autonomousRef.current);
        if (!autonomousRef.current) created.render(previewStateRef.current);
      } catch (cause) {
        created.dispose();
        throw cause;
      }
    }).catch((cause) => setError(messageOf(cause)));
    return () => {
      disposed = true;
      renderer.current?.dispose();
      renderer.current = undefined;
    };
  }, [workspace?.projectDirectory]);

  useEffect(() => {
    if (!renderProject || !renderer.current) return;
    try {
      if (renderer.current.project !== renderProject) renderer.current.updateProject(renderProject);
      if (!autonomousRef.current) renderer.current.render(previewStateRef.current);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [renderProject]);

  useEffect(() => {
    if (!renderer.current) return;
    renderer.current.setPaused(!autonomous);
    if (!autonomous) renderer.current.render(previewState);
  }, [previewState, autonomous]);

  useEffect(() => {
    if (!behaviorPlaying || !project) return;
    const behavior = project.model.behaviors.find((candidate) => candidate.id === selectedBehaviorId);
    if (!behavior) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.max(0, now - previous) / 1000;
      previous = now;
      setBehaviorTime((current) => behavior.loop ? (current + elapsed) % behavior.duration : Math.min(behavior.duration, current + elapsed));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [behaviorPlaying, project, selectedBehaviorId]);

  useEffect(() => {
    setPreviewState((current) => {
      const next = { ...current };
      if (selectedBehaviorId) next.behavior = { id: selectedBehaviorId, timeSeconds: behaviorTime };
      else delete next.behavior;
      return next;
    });
  }, [selectedBehaviorId, behaviorTime]);

  useEffect(() => () => {
    for (const url of comparison ? [comparison.before, comparison.after, comparison.difference] : []) URL.revokeObjectURL(url);
  }, [comparison]);

  function commit(next: CalibrationOverrides, group?: string, internal = false): void {
    if (operationLock.current && !internal) return;
    if (JSON.stringify(next) === JSON.stringify(pending)) return;
    const now = Date.now();
    const grouped = Boolean(group && historyGroup.current?.key === group && now - historyGroup.current.at < 750);
    if (!grouped) setUndoStack((items) => [...items, clone(pending)]);
    historyGroup.current = group ? { key: group, at: now } : undefined;
    setRedoStack([]);
    pendingRef.current = next;
    setPending(next);
  }

  function undo(): void {
    if (operationLock.current) return;
    const previous = undoStack.at(-1);
    if (!previous) return;
    setRedoStack((items) => [...items, clone(pending)]);
    pendingRef.current = previous;
    setPending(previous);
    setUndoStack((items) => items.slice(0, -1));
  }

  function redo(): void {
    if (operationLock.current) return;
    const next = redoStack.at(-1);
    if (!next) return;
    setUndoStack((items) => [...items, clone(pending)]);
    pendingRef.current = next;
    setPending(next);
    setRedoStack((items) => items.slice(0, -1));
  }

  const {
    selectedVertex,
    setSelectedVertex,
    selectedVertices,
    setSelectedVertices,
    softSelectionEnabled,
    setSoftSelectionEnabled,
    softRadius,
    setSoftRadius,
    secondaryPart,
    setSecondaryPart,
    hasActiveDrag,
    updateMeshSelection,
    beginDrag,
    moveDrag,
    endDrag,
    cancelDrag,
    nudgeWithKeyboard,
    patchLayer,
    setLayerProperty,
    setRuntimeTuning,
    setSecondaryTuning,
    setFaceDepth,
    setTorsoVolume,
    setVertexInfluence,
    setPreviewParameter,
    setPreviewField,
    setPreviewExpression,
    setPreviewPose,
    selectPose,
    selectPreviewSample,
    patchPhysics,
    createStarterDynamics,
    upgradeSelectedMesh,
    moveSelectedLayer
  } = useEditorEditingTools({
    projectDirectory,
    workspace,
    project,
    selectedLayer,
    selectedLayerId,
    effectiveOverrides,
    pending,
    setPending,
    pendingRef,
    setUndoStack,
    setRedoStack,
    operationLock,
    commit,
    previewState,
    poseId,
    setPoseId,
    setPreviewState,
    setAutonomous,
    setBehaviorPlaying,
    setSelectedBehaviorId,
    setBehaviorTime,
    setActivePreviewSample,
    setMode,
    setSection,
    setEditorOverlayVisible,
    setNotice,
    setError,
    setMeshUpgrading
  });

  useEffect(() => {
    function handleHistoryShortcut(event: KeyboardEvent): void {
      if (event.key === "Escape" && hasActiveDrag()) {
        event.preventDefault();
        cancelDrag();
        return;
      }
      if (event.key === "Escape" && focusedPreview) {
        event.preventDefault();
        setFocusedPreview(false);
        return;
      }
      if (event.defaultPrevented || event.repeat || event.altKey || (!event.ctrlKey && !event.metaKey) || isTextEditingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const wantsUndo = key === "z" && !event.shiftKey;
      const wantsRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
      if (wantsUndo && undoStack.length > 0) {
        event.preventDefault();
        undo();
      } else if (wantsRedo && redoStack.length > 0) {
        event.preventDefault();
        redo();
      }
    }

    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [focusedPreview, pending, redoStack, undoStack]);

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
    operationLock.current = true; setBusy(true); setError("");
    try { await loadComparison(await window.puppetloom.calibrationEvidence(projectDirectory, sessionId)); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); operationLock.current = false; }
  }

  async function save(): Promise<void> {
    if (!hasPending) return;
    const failed = validateProjectPoses(project!).filter((check) => !check.passed);
    if (failed.length > 0) {
      const firstIssue = failed[0]?.issues[0]?.message ?? "存在不安全姿态";
      setError(`当前草稿未保存：${failed.length} 个安全姿态未通过。${firstIssue} 请先微调或撤销这次改动。`);
      setSection("rig"); setMode("mesh"); setEditorOverlayVisible(true);
      if (failed[0]?.id && editorPoses[failed[0].id]) selectPose(failed[0].id);
      return;
    }
    cancelScheduled();
    operationLock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await window.puppetloom.saveCalibration(projectDirectory, { baseRevision: workspace!.calibration.revision, label: label.trim() || "用户界面校准", overrides: pending });
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]); setLabel(""); setDraftStatus("idle");
      await reload();
      try {
        await showEvidence(result);
        setNotice(`已保存版本 ${result.calibration.revision}，安全系数 ${result.project.quality.safetyScale.toFixed(2)}。`);
      } catch (cause) {
        setNotice(`版本 ${result.calibration.revision} 已保存，但对比图暂时无法显示：${messageOf(cause)}`);
      }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); operationLock.current = false; }
  }

  async function restoreRevision(revision: number, restoreLabel: string): Promise<void> {
    if (hasPending) { setError("请先保存或明确放弃当前草稿，再恢复历史版本。草稿仍然保留。" ); return; }
    if (!window.confirm(`把版本 ${revision} 恢复为一个新的当前版本？现有历史不会删除。`)) return;
    operationLock.current = true; setBusy(true); setError("");
    try {
      const result = await window.puppetloom.restoreCalibration(projectDirectory, revision, workspace!.calibration.revision, restoreLabel);
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]); setLabel("");
      await reload();
      try {
        await showEvidence(result);
        setNotice(`已把版本 ${revision} 恢复为新的版本 ${result.calibration.revision}。`);
      } catch (cause) {
        setNotice(`版本 ${result.calibration.revision} 已恢复，但对比图暂时无法显示：${messageOf(cause)}`);
      }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); operationLock.current = false; }
  }

  async function resetSelectedLayer(): Promise<void> {
    if (!selectedLayer) return;
    if (hasPending) { setError("请先保存或明确放弃当前草稿，再恢复自动绑定。草稿仍然保留。" ); return; }
    if (!window.confirm(`恢复“${selectedLayer.sourceName}”的自动绑定？其它图层不会改变。`)) return;
    operationLock.current = true; setBusy(true); setError("");
    try {
      const result = await window.puppetloom.saveCalibration(projectDirectory, { baseRevision: workspace!.calibration.revision, label: `恢复 ${selectedLayer.sourceName} 的自动绑定`, overrides: {}, clear: { layers: [selectedLayer.id] } });
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]);
      await reload();
      try {
        await showEvidence(result);
        setNotice(`已恢复 ${selectedLayer.sourceName}，其它校准保持不变。`);
      } catch (cause) {
        setNotice(`已恢复 ${selectedLayer.sourceName}，但对比图暂时无法显示：${messageOf(cause)}`);
      }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); operationLock.current = false; }
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
      await window.puppetloom.launchViewer(projectDirectory, {
        ...(project ? { project } : {}),
        sourceLabel: hasPending ? "未保存草稿预览" : `已保存 revision ${workspace?.calibration.revision ?? 0}`
      });
      setNotice(hasPending ? "角色窗口已更新为当前未保存草稿；保存前仅用于预览。" : "角色窗口已打开并同步到当前版本。重复运行会更新同一个窗口。");
    } catch (cause) {
      setError(`无法打开角色窗口：${messageOf(cause)}`);
    }
  }

  if (!workspace || !project) return <main className="editor-loading"><button className="with-icon" onClick={onBack}><ArrowLeft aria-hidden="true" />返回</button><p>{error || "正在加载编辑器…"}</p></main>;

  const sessions = [...workspace.sessions].reverse();
  const selectedTuning = { amplitude: 1, response: 0.5, stability: 0.5, ...(project.runtime.secondaryMotionTuning?.[secondaryPart] ?? {}) };
  const correctedSamples = new Map(poseCorrectionSamples(project.model, selectedLayerId)
    .map((sample) => [`${sample.yaw},${sample.pitch}`, sample.pointCount]));
  const neutralCorrectionCount = Object.keys(effectiveOverrides.layers?.[selectedLayerId]?.meshPointDeltas ?? {}).length;
  const currentPoseCheck = poseChecks[poseId];
  const draftSafetyPassed = draftSafetyChecks.length > 0 && draftSafetyChecks.every((check) => check.passed);
  const currentPoseLabel = editorPoses[poseId]?.label ?? "自定义姿态";

  return (
    <main className={`editor-shell section-${section} ${focusedPreview ? "focus-preview" : ""}`} data-testid="editor">
      {focusedPreview && <button className="exit-focus-preview icon-only" aria-label="退出沉浸预览" title="退出沉浸预览" onClick={() => setFocusedPreview(false)}><Minimize2 aria-hidden="true" /></button>}
      {(error || notice) && <div className={`editor-feedback ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "status"}><span>{error || notice}</span><button className="icon-only" aria-label="关闭提示" title="关闭提示" onClick={() => { setError(""); setNotice(""); }}><X aria-hidden="true" /></button></div>}
      {interactionLocked && <div className="editor-operation-shield" role="status" aria-live="polite"><div className="spinner"/><strong>{meshUpgrading ? "正在生成并验证轮廓网格…" : "正在完成校准事务…"}</strong><span>完成前编辑已暂时锁定，当前草稿不会被覆盖。</span></div>}
      <header className="editor-header">
        <button className="icon-only editor-back" aria-label="返回主页" title="返回主页" disabled={interactionLocked} onClick={() => void leaveEditor()}><ArrowLeft aria-hidden="true" /></button>
        <div><h1>{project.name}</h1><p>版本 {workspace.calibration.revision} · {project.rigLevel === "semantic" ? "完整语义绑定" : project.rigLevel === "grouped" ? "分组绑定" : "基础绑定"} · {project.layers.length} 层 · 已保存安全系数 {workspace.project.quality.safetyScale.toFixed(2)}{draftSafetyChecks.length ? ` · 草稿${draftSafetyPassed ? "通过全姿态检查" : "存在不安全姿态"}` : ""}</p></div>
        <div className="editor-history-actions">
          <span className={`draft-state ${draftStatus}`}>{draftStatus === "saving" ? "正在自动保存" : draftStatus === "saved" ? "草稿已保存" : draftStatus === "error" ? "草稿保存失败" : draftStatus === "waiting" ? "等待自动保存" : ""}</span>
          <button className="icon-only" aria-label="撤销" aria-keyshortcuts="Control+Z Meta+Z" disabled={interactionLocked || undoStack.length === 0} onClick={undo} title="撤销（Ctrl+Z）"><Undo2 aria-hidden="true" /></button>
          <button className="icon-only" aria-label="重做" aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z" disabled={interactionLocked || redoStack.length === 0} onClick={redo} title="重做（Ctrl+Y / Ctrl+Shift+Z）"><Redo2 aria-hidden="true" /></button>
          <button className="icon-only" aria-label="恢复全部自动绑定" title="恢复全部自动绑定" onClick={() => void restoreRevision(0, "恢复全部自动绑定")} disabled={interactionLocked}><RotateCcw aria-hidden="true" /></button>
          <button className="header-save with-icon" aria-label="保存更改" disabled={!hasPending || interactionLocked} onClick={() => void save()}><Save aria-hidden="true" />{busy ? "正在验证…" : "保存"}</button>
          <button className="with-icon" aria-label="运行角色窗口" disabled={interactionLocked} onClick={() => void launchViewer()}><ExternalLink aria-hidden="true" />运行</button>
        </div>
      </header>

      <StudioNavigation section={section} onSection={(next) => { setSection(next); if (next !== "preview") setFocusedPreview(false); }} />

      <section className="editor-toolbar">
        {section === "rig" ? <><div className="mode-tabs">{(["semantic", "anchors", "layer", "mesh"] as EditMode[]).map((item) => {
          const active = editorOverlayVisible && mode === item;
          const label = item === "semantic" ? "脸部控制点" : item === "anchors" ? "身体锚点" : item === "layer" ? "图层轴心" : "网格与权重";
          const Icon = item === "semantic" ? ScanFace : item === "anchors" ? Bone : item === "layer" ? Anchor : Grid3x3;
          return <button aria-pressed={active} className={`${active ? "active" : ""} with-icon`} key={item} title={active ? `再次点击隐藏${label}` : `显示${label}`} onClick={() => {
            if (active) setEditorOverlayVisible(false);
            else {
              setMode(item); setEditorOverlayVisible(true);
              if (item === "mesh") { setAutonomous(false); setBehaviorPlaying(false); if (!editorPoses[poseId]) selectPose("neutral"); }
            }
          }}><Icon aria-hidden="true" />{label}</button>;
        })}{editorOverlayVisible && mode === "mesh" && <>
          <button aria-pressed={showNeutralMeshReference} className={`${showNeutralMeshReference ? "active" : ""} with-icon`} title="在实时变形网格下叠加中立网格" onClick={() => setShowNeutralMeshReference((value) => !value)}><View aria-hidden="true" />中立参考</button>
          <button disabled={!hasPending} className={`${showDraftBefore ? "active" : ""} with-icon`} onPointerDown={() => setShowDraftBefore(true)} onPointerUp={() => setShowDraftBefore(false)} onPointerCancel={() => setShowDraftBefore(false)} onPointerLeave={() => setShowDraftBefore(false)}><GitCompare aria-hidden="true" />按住看修改前</button>
          <span className={`pose-edit-status ${currentPoseCheck?.passed === false ? "warning" : ""}`}>正在校正：{currentPoseLabel}{poseId === "neutral" ? "（基础网格）" : "（姿态关键形）"}</span>
        </>}</div><div className="pose-tabs">{Object.entries(editorPoses).map(([id, item]) => {
          const key = `${item.state.headYaw},${item.state.headPitch}`;
          const corrected = id === "neutral" ? neutralCorrectionCount > 0 : (correctedSamples.get(key) ?? 0) > 0;
          const check = poseChecks[id];
          const Icon = item.icon;
          const status = `${corrected ? "，已有人工微调" : "，尚未微调"}${check?.passed === false ? `，${check.issues[0]?.message ?? "安全检查未通过"}` : ""}`;
          return <button className={`pose-shortcut icon-only ${!autonomous && poseId === id ? "active" : ""} ${corrected ? "is-corrected" : ""} ${check?.passed === false ? "pose-warning" : ""}`} aria-label={`${item.label}${status}`} title={`${item.label}${status}`} key={id} onClick={() => selectPose(id)}><Icon aria-hidden="true" /></button>;
        })}<button className={`${autonomous ? "active" : ""} with-icon`} onClick={() => setAutonomous((value) => !value)}>{autonomous ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{autonomous ? "暂停动作" : "自主预览"}</button></div></>
          : <><div className="workspace-context"><strong>{section === "overview" ? "先判断完整度，再进入具体工作区" : section === "parameters" ? "拖动参数或点击九向控制器，画面会实时更新" : section === "dynamics" ? "表情、行为和次级运动在同一画面中联动检查" : "编辑标记已经隐藏，只看最终呈现"}</strong><small>{section === "overview" ? "所有数据都来自当前项目，不用猜测系统是否生效。" : section === "parameters" ? "当前值不会写入项目，只有校准参数修改才会进入草稿。" : section === "dynamics" ? "次级运动和参数物理的调整会进入校准草稿。" : "建议依次检查中立、左右、上下、闭眼和张嘴。"}</small></div><div className="pose-tabs"><button className="with-icon" onClick={() => selectPose("neutral")}><RotateCcw aria-hidden="true" />恢复中立</button><button className={`${autonomous ? "active" : ""} with-icon`} onClick={() => { setBehaviorPlaying(false); setAutonomous((value) => !value); }}>{autonomous ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{autonomous ? "暂停自主动作" : "播放自主动作"}</button></div></>}
      </section>

      <section className={`editor-workspace preview-background-${previewBackground}`}>
        {section === "overview" ? <OverviewLeftPanel project={project} onSection={setSection} /> : section === "rig" ? <EditorLayerPanel
          project={project}
          selectedLayerId={selectedLayerId}
          onSelect={(layerId) => { setSelectedLayerId(layerId); setSelectedVertex(undefined); setSelectedVertices([]); }}
          onPatchLayer={patchLayer}
          soloSelectedLayer={soloSelectedLayer}
          onSolo={(layerId) => {
            if (soloSelectedLayer && selectedLayerId === layerId) setSoloSelectedLayer(false);
            else {
              setSelectedLayerId(layerId);
              setSelectedVertex(undefined);
              setSelectedVertices([]);
              setSoloSelectedLayer(true);
            }
          }}
        /> : section === "parameters" ? <ParameterLeftPanel project={project} selectedId={selectedParameterId} onSelect={setSelectedParameterId} /> : section === "dynamics" ? <DynamicsLeftPanel project={project} selectedBehaviorId={selectedBehaviorId} onBehavior={(id) => { setSelectedBehaviorId(id); setBehaviorTime(0); setBehaviorPlaying(false); setAutonomous(false); }} onCreateStarter={createStarterDynamics} /> : <PreviewLeftPanel activeSample={activePreviewSample} onSample={selectPreviewSample} />}
        <EditorViewportPanel
          canvas={canvas}
          project={project}
          mode={mode}
          showOverlay={section === "rig" && editorOverlayVisible && !showDraftBefore}
          showNeutralMeshReference={showNeutralMeshReference}
          posedMeshPoints={posedMeshPoints}
          liveMeshPoints={liveMeshPoints}
          animateMesh={autonomous && mode === "mesh" && editorOverlayVisible}
          cleanPreview={section !== "rig"}
          selectedLayer={selectedLayer}
          selectedVertex={selectedVertex}
          selectedVertices={selectedVertices}
          softSelectionEnabled={softSelectionEnabled}
          softRadius={softRadius}
          comparison={comparison}
          comparisonMode={comparisonMode}
          splitPercent={splitPercent}
          onBeginDrag={beginDrag}
          onMoveDrag={moveDrag}
          onEndDrag={endDrag}
          onCancelDrag={cancelDrag}
          onSelectMeshVertices={updateMeshSelection}
          onNudge={nudgeWithKeyboard}
          onComparisonMode={setComparisonMode}
          onSplitPercent={setSplitPercent}
          onCloseComparison={() => setComparison(undefined)}
        />
        {section === "overview" ? <OverviewInspector project={project} revision={workspace.calibration.revision} sessionCount={sessions.length} /> : section === "rig" ? <EditorInspectorPanel
          project={project}
          selectedLayer={selectedLayer}
          selectedVertex={selectedVertex}
          softSelectionEnabled={softSelectionEnabled}
          softRadius={softRadius}
          secondaryPart={secondaryPart}
          selectedTuning={selectedTuning}
          label={label}
          hasPending={hasPending}
          busy={busy}
          sessions={sessions}
          comparison={comparison}
          meshUpgrading={meshUpgrading}
          onLayerProperty={setLayerProperty}
          onMoveLayer={moveSelectedLayer}
          onSoftSelectionEnabled={setSoftSelectionEnabled}
          onSoftRadius={setSoftRadius}
          onVertexInfluence={setVertexInfluence}
          onResetLayer={() => void resetSelectedLayer()}
          onUpgradeMesh={() => void upgradeSelectedMesh()}
          onRuntimeTuning={setRuntimeTuning}
          onSecondaryPart={setSecondaryPart}
          onSecondaryTuning={setSecondaryTuning}
          onFaceDepth={setFaceDepth}
          onTorsoVolume={setTorsoVolume}
          onLabel={setLabel}
          onSave={() => void save()}
          onDiscard={() => void discardDraft()}
          onShowEvidence={(sessionId) => void showSessionEvidence(sessionId)}
          onRestore={(revision, restoreLabel) => void restoreRevision(revision, restoreLabel)}
          onMarkEvidence={(sessionId, status) => void markEvidence(sessionId, status)}
        /> : section === "parameters" ? <ParameterInspector project={project} state={previewState} selectedId={selectedParameterId} onParameter={setPreviewParameter} onState={setPreviewField} onPose={setPreviewPose} onExpression={setPreviewExpression} /> : section === "dynamics" ? <DynamicsInspector project={project} state={previewState} selectedBehaviorId={selectedBehaviorId} behaviorTime={behaviorTime} behaviorPlaying={behaviorPlaying} secondaryPart={secondaryPart} secondaryTuning={selectedTuning} onExpression={setPreviewExpression} onBehaviorTime={(value) => { setBehaviorTime(value); setAutonomous(false); }} onBehaviorPlaying={(value) => { setBehaviorPlaying(value); setAutonomous(false); }} onSecondaryPart={setSecondaryPart} onSecondaryTuning={setSecondaryTuning} onPhysics={patchPhysics} /> : <PreviewInspector project={project} background={previewBackground} focused={focusedPreview} autonomous={autonomous} onBackground={setPreviewBackground} onFocused={setFocusedPreview} onAutonomous={(value) => { setBehaviorPlaying(false); setAutonomous(value); }} onLaunch={() => void launchViewer()} />}
      </section>
    </main>
  );
}
