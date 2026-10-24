import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CalibrationOverrides,
  MotionState,
  PuppetLoomProject,
  RevisionComparisonResult
} from "@puppetloom/core";
import {
  applyCalibrationOverridesForInteractivePreview,
  deformedPoints,
  deformedPointsForPreview,
  mergeCalibrationOverridesForPreview,
  neutralMotionState,
  poseCorrectionSamples,
  rebaseCalibrationOverridesForPreview,
  isModelBehaviorAvailable
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
import { useEditorValidation } from "./editor/useEditorValidation.js";
import { useLocale } from "./i18n/index.js";

export function EditorWorkspace({ projectDirectory, onBack }: { projectDirectory: string; onBack: () => void }): React.JSX.Element {
  const { t } = useLocale();
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
  const [previewChecks, setPreviewChecks] = useState<Record<string, boolean>>({});
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [meshUpgrading, setMeshUpgrading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draftStatus, setDraftStatus] = useState<"idle" | "waiting" | "saving" | "saved" | "error">("idle");
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
    setSelectedParameterId((current) => loaded.project.model.parameters.some((parameter) => parameter.id === current)
      ? current
      : loaded.project.model.parameters[0]?.id ?? "");
    setSelectedBehaviorId((current) => loaded.project.model.behaviors.some((behavior) => behavior.id === current && isModelBehaviorAvailable(loaded.project, behavior))
      ? current
      : loaded.project.model.behaviors.find((behavior) => isModelBehaviorAvailable(loaded.project, behavior))?.id ?? "");
    if (restoreDraft && loaded.draft) {
      pendingRef.current = loaded.draft.overrides;
      setPending(loaded.draft.overrides);
      setLabel(loaded.draft.label ?? "");
      setNotice(`${new Date(loaded.draft.updatedAt).toLocaleString()}에 자동 저장된 초안을 복원했습니다.`);
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
  const effectiveOverrides = useMemo(() => workspace ? mergeCalibrationOverridesForPreview(workspace.calibration.overrides, pending) : pending, [workspace, pending]);
  const interactiveOverrides = useMemo(() => workspace
    ? rebaseCalibrationOverridesForPreview(workspace.calibration.overrides, pending)
    : pending, [workspace, pending]);
  // A draft must stay spatially stable while a point is dragged. Safety is
  // reported below and enforced by the save transaction, never by silently
  // shrinking the whole runtime envelope during pointer movement.
  const project = useMemo(() => workspace
    ? hasPending ? applyCalibrationOverridesForInteractivePreview(workspace.project, interactiveOverrides) : workspace.project
    : undefined, [workspace, interactiveOverrides, hasPending]);
  const previewCheckRevisionKey = `${projectDirectory}:${workspace?.calibration.revision ?? -1}:${JSON.stringify(interactiveOverrides)}`;
  useEffect(() => {
    setPreviewChecks({});
  }, [previewCheckRevisionKey]);
  const { poseChecks, draftSafetyChecks, error: validationError, validateNow } = useEditorValidation(project);
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
    ? deformedPointsForPreview(renderProject, renderSelectedLayer, previewState)
    : [], [renderProject, renderSelectedLayer, previewState]);
  const liveMeshPoints = useCallback(() => {
    const state = renderer.current?.motionState;
    return renderProject && renderSelectedLayer && state ? deformedPoints(renderProject, renderSelectedLayer, state) : undefined;
  }, [renderProject, renderSelectedLayer]);

  useEffect(() => {
    if (validationError) setError(`백그라운드 안전 검사 실패: ${validationError}`);
  }, [validationError]);

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
    const behavior = project.model.behaviors.find((candidate) => candidate.id === selectedBehaviorId && isModelBehaviorAvailable(project, candidate));
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
      const selectedBehavior = project?.model.behaviors.find((candidate) => candidate.id === selectedBehaviorId && isModelBehaviorAvailable(project, candidate));
      if (selectedBehavior) next.behavior = { id: selectedBehavior.id, timeSeconds: behaviorTime };
      else delete next.behavior;
      return next;
    });
  }, [project, selectedBehaviorId, behaviorTime]);

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
    setMeshUpgrading,
    posedMeshPoints
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
    operationLock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const failed = (await validateNow(project!)).draftSafetyChecks.filter((check) => !check.passed);
      if (failed.length > 0) {
        const firstIssue = failed[0]?.issues[0]?.message ?? "안전하지 않은 자세가 있습니다";
        setError(`현재 초안을 저장하지 못했습니다. 안전 자세 ${failed.length}개가 통과하지 못했습니다. ${firstIssue} 먼저 미세 조정하거나 이번 변경을 실행 취소하세요.`);
        setSection("rig"); setMode("mesh"); setEditorOverlayVisible(true);
        if (failed[0]?.id && editorPoses[failed[0].id]) selectPose(failed[0].id);
        return;
      }
      cancelScheduled();
      const result = await window.puppetloom.saveCalibration(projectDirectory, { baseRevision: workspace!.calibration.revision, label: label.trim() || "UI 캘리브레이션", overrides: pending });
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]); setLabel(""); setDraftStatus("idle");
      await reload();
      try {
        await showEvidence(result);
        setNotice(`버전 ${result.calibration.revision}을 저장했습니다. 안전 계수 ${result.project.quality.safetyScale.toFixed(2)}.`);
      } catch (cause) {
        setNotice(`버전 ${result.calibration.revision}은 저장됐지만 비교 이미지를 잠시 표시할 수 없습니다: ${messageOf(cause)}`);
      }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); operationLock.current = false; }
  }

  async function restoreRevision(revision: number, restoreLabel: string): Promise<void> {
    if (revision === workspace?.calibration.revision) { setError("이미 이 버전입니다. 다시 복원할 필요가 없습니다."); return; }
    if (hasPending) { setError("먼저 현재 초안을 저장하거나 명시적으로 버린 뒤 이전 버전을 복원하세요. 초안은 그대로 유지됩니다."); return; }
    if (!window.confirm(`버전 ${revision}을 새 현재 버전으로 복원할까요? 기존 기록은 삭제되지 않습니다.`)) return;
    operationLock.current = true; setBusy(true); setError("");
    try {
      const result = await window.puppetloom.restoreCalibration(projectDirectory, revision, workspace!.calibration.revision, restoreLabel);
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]); setLabel("");
      await reload();
      try {
        await showEvidence(result);
        setNotice(`버전 ${revision}을 새 버전 ${result.calibration.revision}으로 복원했습니다.`);
      } catch (cause) {
        setNotice(`버전 ${result.calibration.revision}은 복원됐지만 비교 이미지를 잠시 표시할 수 없습니다: ${messageOf(cause)}`);
      }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); operationLock.current = false; }
  }

  async function resetSelectedLayer(): Promise<void> {
    if (!selectedLayer) return;
    if (!workspace?.calibration.overrides.layers?.[selectedLayer.id]) { setError("이 레이어는 자동 바인딩을 사용 중이며 복원할 수동 캘리브레이션이 없습니다."); return; }
    if (hasPending) { setError("먼저 현재 초안을 저장하거나 명시적으로 버린 뒤 자동 바인딩을 복원하세요. 초안은 그대로 유지됩니다."); return; }
    if (!window.confirm(`“${selectedLayer.sourceName}”의 자동 바인딩을 복원할까요? 다른 레이어는 바뀌지 않습니다.`)) return;
    operationLock.current = true; setBusy(true); setError("");
    try {
      const result = await window.puppetloom.saveCalibration(projectDirectory, { baseRevision: workspace!.calibration.revision, label: `${selectedLayer.sourceName} 자동 바인딩 복원`, overrides: {}, clear: { layers: [selectedLayer.id] } });
      pendingRef.current = {}; setPending({}); setUndoStack([]); setRedoStack([]);
      await reload();
      try {
        await showEvidence(result);
        setNotice(`${selectedLayer.sourceName}을(를) 복원했습니다. 다른 캘리브레이션은 그대로입니다.`);
      } catch (cause) {
        setNotice(`${selectedLayer.sourceName}을(를) 복원했지만 비교 이미지를 잠시 표시할 수 없습니다: ${messageOf(cause)}`);
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
    catch (cause) { setError(`나가기 전 초안 저장 실패: ${messageOf(cause)}`); return; }
    onBack();
  }

  async function discardDraft(): Promise<void> {
    if (!hasPending || !window.confirm("제출하지 않은 현재 초안을 버릴까요? 저장된 캘리브레이션 기록은 바뀌지 않습니다.")) return;
    cancelScheduled();
    try {
      await window.puppetloom.discardCalibrationDraft(projectDirectory);
      pendingRef.current = {};
      setPending({}); setUndoStack([]); setRedoStack([]); setLabel(""); setDraftStatus("idle"); setError("");
      setNotice("현재 초안을 버렸습니다. 저장된 캘리브레이션은 그대로입니다.");
    } catch (cause) { setError(`초안을 버릴 수 없습니다: ${messageOf(cause)}`); }
  }

  async function launchViewer(): Promise<void> {
    setError("");
    try {
      await window.puppetloom.launchViewer(projectDirectory, {
        ...(project ? { project } : {}),
        sourceLabel: hasPending ? "저장되지 않은 초안 미리보기" : `저장된 revision ${workspace?.calibration.revision ?? 0}`
      });
      setNotice(hasPending ? "캐릭터 창을 저장되지 않은 현재 초안으로 업데이트했습니다. 저장 전에는 미리보기만 가능합니다." : "캐릭터 창을 열고 현재 버전에 동기화했습니다. 다시 실행하면 같은 창이 업데이트됩니다.");
    } catch (cause) {
      setError(`캐릭터 창을 열 수 없습니다: ${messageOf(cause)}`);
    }
  }

  if (!workspace || !project) return <main className="editor-loading"><button className="with-icon" onClick={onBack}><ArrowLeft aria-hidden="true" />{t("editorBack")}</button><p>{error || t("editorLoading")}</p></main>;

  const sessions = [...workspace.sessions].reverse();
  const selectedTuning = { amplitude: 1, response: 0.5, stability: 0.5, ...(project.runtime.secondaryMotionTuning?.[secondaryPart] ?? {}) };
  const correctedSamples = new Map(poseCorrectionSamples(project.model, selectedLayerId)
    .map((sample) => [`${sample.yaw},${sample.pitch}`, sample.pointCount]));
  const neutralCorrectionCount = Object.keys(effectiveOverrides.layers?.[selectedLayerId]?.meshPointDeltas ?? {}).length;
  const currentPoseCheck = poseChecks[poseId];
  const draftSafetyPassed = draftSafetyChecks.length > 0 && draftSafetyChecks.every((check) => check.passed);
  const currentPoseLabel = editorPoses[poseId]?.label ?? "사용자 지정 자세";
  const canRestoreAll = workspace.calibration.revision > 0 && Object.keys(workspace.calibration.overrides).length > 0;
  const canResetSelectedLayer = Boolean(selectedLayer && workspace.calibration.overrides.layers?.[selectedLayer.id]);

  return (
    <main className={`editor-shell section-${section} ${focusedPreview ? "focus-preview" : ""}`} data-testid="editor">
      {focusedPreview && <button className="exit-focus-preview icon-only" aria-label="몰입 미리보기 종료" title="몰입 미리보기 종료" onClick={() => setFocusedPreview(false)}><Minimize2 aria-hidden="true" /></button>}
      {(error || notice) && <div className={`editor-feedback ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "status"}><span>{error || notice}</span><button className="icon-only" aria-label="알림 닫기" title="알림 닫기" onClick={() => { setError(""); setNotice(""); }}><X aria-hidden="true" /></button></div>}
      {interactionLocked && <div className="editor-operation-shield" role="status" aria-live="polite"><div className="spinner"/><strong>{meshUpgrading ? "윤곽 메시를 생성하고 검증하는 중…" : "캘리브레이션 작업을 완료하는 중…"}</strong><span>완료될 때까지 편집이 잠시 잠깁니다. 현재 초안은 덮어쓰이지 않습니다.</span></div>}
      <header className="editor-header">
        <button className="icon-only editor-back" aria-label={t("goHome")} title={t("goHome")} disabled={interactionLocked} onClick={() => void leaveEditor()}><ArrowLeft aria-hidden="true" /></button>
        <div><h1>{project.name}</h1><p>{t("revisionMeta", { revision: workspace.calibration.revision, rig: project.rigLevel === "semantic" ? t("rigSemantic") : project.rigLevel === "grouped" ? t("rigGrouped") : t("rigBasic"), layers: project.layers.length, safety: workspace.project.quality.safetyScale.toFixed(2) })}{draftSafetyChecks.length ? (draftSafetyPassed ? t("draftAllPassed") : t("draftUnsafe")) : ""}</p></div>
        <div className="editor-history-actions">
          <span className={`draft-state ${draftStatus}`}>{draftStatus === "saving" ? t("autoSaving") : draftStatus === "saved" ? t("draftSaved") : draftStatus === "error" ? t("draftSaveFailed") : draftStatus === "waiting" ? t("autoSaveWaiting") : ""}</span>
          <button className="icon-only" aria-label={t("undo")} aria-keyshortcuts="Control+Z Meta+Z" disabled={interactionLocked || undoStack.length === 0} onClick={undo} title={t("undoShortcut")}><Undo2 aria-hidden="true" /></button>
          <button className="icon-only" aria-label={t("redo")} aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z" disabled={interactionLocked || redoStack.length === 0} onClick={redo} title={t("redoShortcut")}><Redo2 aria-hidden="true" /></button>
          <button className="icon-only" aria-label={t("restoreAllBinding")} title={canRestoreAll ? t("restoreAllBinding") : t("noManualCalibration")} onClick={() => void restoreRevision(0, t("restoreAllBinding"))} disabled={interactionLocked || hasPending || !canRestoreAll}><RotateCcw aria-hidden="true" /></button>
          <button className="header-save with-icon" aria-label={t("saveChanges")} disabled={!hasPending || interactionLocked} onClick={() => void save()}><Save aria-hidden="true" />{busy ? t("validating") : t("save")}</button>
          <button className="with-icon" aria-label={t("launchCharacter")} disabled={interactionLocked} onClick={() => void launchViewer()}><ExternalLink aria-hidden="true" />{t("launch")}</button>
        </div>
      </header>

      <StudioNavigation section={section} onSection={(next) => { setSection(next); if (next !== "preview") setFocusedPreview(false); }} />

      <section className="editor-toolbar">
        {section === "rig" ? <><div className="mode-tabs">{(["semantic", "anchors", "layer", "mesh"] as EditMode[]).map((item) => {
          const active = editorOverlayVisible && mode === item;
          const label = item === "semantic" ? "얼굴 컨트롤 포인트" : item === "anchors" ? "몸 앵커" : item === "layer" ? "레이어 피벗" : "메시·가중치";
          const Icon = item === "semantic" ? ScanFace : item === "anchors" ? Bone : item === "layer" ? Anchor : Grid3x3;
          return <button aria-pressed={active} className={`${active ? "active" : ""} with-icon`} key={item} title={active ? `다시 클릭하면 ${label} 숨김` : `${label} 표시`} onClick={() => {
            if (active) setEditorOverlayVisible(false);
            else {
              setMode(item); setEditorOverlayVisible(true);
              if (item === "mesh") { setAutonomous(false); setBehaviorPlaying(false); if (!editorPoses[poseId]) selectPose("neutral"); }
            }
          }}><Icon aria-hidden="true" />{label}</button>;
        })}{editorOverlayVisible && mode === "mesh" && <>
          <button aria-pressed={showNeutralMeshReference} className={`${showNeutralMeshReference ? "active" : ""} with-icon`} title="실시간 변형 메시 아래에 중립 메시를 겹쳐 표시" onClick={() => setShowNeutralMeshReference((value) => !value)}><View aria-hidden="true" />중립 참조</button>
          <button disabled={!hasPending} className={`${showDraftBefore ? "active" : ""} with-icon`} onPointerDown={() => setShowDraftBefore(true)} onPointerUp={() => setShowDraftBefore(false)} onPointerCancel={() => setShowDraftBefore(false)} onPointerLeave={() => setShowDraftBefore(false)}><GitCompare aria-hidden="true" />누르고 있으면 수정 전</button>
          <span className={`pose-edit-status ${currentPoseCheck?.passed === false ? "warning" : ""}`}>보정 중: {currentPoseLabel}{poseId === "neutral" ? " (기본 메시)" : " (자세 키셰이프)"}</span>
        </>}</div><div className="pose-tabs">{Object.entries(editorPoses).map(([id, item]) => {
          const key = `${item.state.headYaw},${item.state.headPitch}`;
          const corrected = id === "neutral" ? neutralCorrectionCount > 0 : (correctedSamples.get(key) ?? 0) > 0;
          const check = poseChecks[id];
          const Icon = item.icon;
          const status = `${corrected ? ", 수동 미세 조정됨" : ", 아직 미세 조정 안 함"}${check?.passed === false ? `, ${check.issues[0]?.message ?? "안전 검사 실패"}` : ""}`;
          return <button className={`pose-shortcut icon-only ${!autonomous && poseId === id ? "active" : ""} ${corrected ? "is-corrected" : ""} ${check?.passed === false ? "pose-warning" : ""}`} aria-label={`${item.label}${status}`} title={`${item.label}${status}`} key={id} onClick={() => selectPose(id)}><Icon aria-hidden="true" /></button>;
        })}<button className={`${autonomous ? "active" : ""} with-icon`} onClick={() => setAutonomous((value) => !value)}>{autonomous ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{autonomous ? "동작 일시 정지" : "자율 미리보기"}</button></div></>
          : <><div className="workspace-context"><strong>{section === "overview" ? "완성도를 먼저 확인한 뒤 작업 영역으로 이동하세요" : section === "parameters" ? "파라미터를 드래그하거나 9방향 컨트롤러를 클릭하면 화면이 바로 갱신됩니다" : section === "dynamics" ? "표정, 동작, 2차 모션을 한 화면에서 함께 확인하세요" : "편집 표시가 숨겨져 최종 화면만 보입니다"}</strong><small>{section === "overview" ? "모든 데이터는 현재 프로젝트에서 오므로 시스템이 적용됐는지 추측할 필요가 없습니다." : section === "parameters" ? "현재 값은 프로젝트에 기록되지 않으며, 캘리브레이션 파라미터를 바꿀 때만 초안에 들어갑니다." : section === "dynamics" ? "2차 모션과 파라미터 물리 조정은 캘리브레이션 초안에 들어갑니다." : "9방향 머리 자세와 소재가 실제로 지원하는 눈 감기·입 열기를 차례로 확인하세요."}</small></div><div className="pose-tabs"><button className="with-icon" onClick={() => selectPose("neutral")}><RotateCcw aria-hidden="true" />중립으로</button><button className={`${autonomous ? "active" : ""} with-icon`} onClick={() => { setBehaviorPlaying(false); setAutonomous((value) => !value); }}>{autonomous ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{autonomous ? "자율 동작 일시 정지" : "자율 동작 재생"}</button></div></>}
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
        /> : section === "parameters" ? <ParameterLeftPanel project={project} selectedId={selectedParameterId} onSelect={setSelectedParameterId} /> : section === "dynamics" ? <DynamicsLeftPanel project={project} selectedBehaviorId={selectedBehaviorId} onBehavior={(id) => { setSelectedBehaviorId(id); setBehaviorTime(0); setBehaviorPlaying(false); setAutonomous(false); }} onCreateStarter={createStarterDynamics} /> : <PreviewLeftPanel project={project} activeSample={activePreviewSample} onSample={selectPreviewSample} />}
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
        {section === "overview" ? <OverviewInspector project={project} revision={workspace.calibration.revision} sessions={sessions} /> : section === "rig" ? <EditorInspectorPanel
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
          currentRevision={workspace.calibration.revision}
          canResetLayer={canResetSelectedLayer}
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
        /> : section === "parameters" ? <ParameterInspector project={project} state={previewState} selectedId={selectedParameterId} onParameter={setPreviewParameter} onState={setPreviewField} onPose={setPreviewPose} onExpression={setPreviewExpression} /> : section === "dynamics" ? <DynamicsInspector project={project} state={previewState} selectedBehaviorId={selectedBehaviorId} behaviorTime={behaviorTime} behaviorPlaying={behaviorPlaying} secondaryPart={secondaryPart} secondaryTuning={selectedTuning} onExpression={setPreviewExpression} onBehaviorTime={(value) => { setBehaviorTime(value); setAutonomous(false); }} onBehaviorPlaying={(value) => { setBehaviorPlaying(value); setAutonomous(false); }} onSecondaryPart={setSecondaryPart} onSecondaryTuning={setSecondaryTuning} onPhysics={patchPhysics} /> : <PreviewInspector project={project} revision={workspace.calibration.revision} sessions={sessions} background={previewBackground} focused={focusedPreview} autonomous={autonomous} manualChecks={previewChecks} busy={busy} onBackground={setPreviewBackground} onFocused={setFocusedPreview} onAutonomous={(value) => { setBehaviorPlaying(false); setAutonomous(value); }} onLaunch={() => void launchViewer()} onManualCheck={(id, checked) => setPreviewChecks((current) => ({ ...current, [id]: checked }))} onShowEvidence={(sessionId) => void showSessionEvidence(sessionId)} onMarkEvidence={(sessionId, status) => void markEvidence(sessionId, status)} />}
      </section>
    </main>
  );
}
