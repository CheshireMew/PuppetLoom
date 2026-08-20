import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthoringModel,
  CalibrationOverrides,
  FaceDepthLandmark,
  LayerBinding,
  MotionState,
  Point,
  PoseValidation,
  RevisionComparisonResult,
  SecondaryMotionPart,
  TorsoVolumeLandmark,
  TorsoVolumeProfile
} from "@puppetloom/core";
import {
  applyCalibrationOverrides,
  defaultTorsoVolumeProfile,
  deformedPoints,
  evaluateLayerAuthoring,
  invertDeformedPoint,
  mergeCalibrationOverrides,
  meshGeodesicDistances,
  neutralMotionState,
  poseCorrectionPointDeltas,
  poseCorrectionSamples,
  reprojectLayerPoseCorrections,
  reprojectSparsePointDeltas,
  setPoseCorrectionPointDeltas,
  validateProjectPoses,
  validatePose
} from "@puppetloom/core/browser";
import { PuppetRenderer } from "@puppetloom/renderer";
import { ArrowLeft, ExternalLink, Minimize2, Pause, Play, Redo2, RotateCcw, Save, Undo2 } from "lucide-react";
import type { DesktopCalibrationResponse, EditorWorkspace as EditorWorkspaceData } from "../electron/global.js";
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

interface MeshDragSnapshot {
  selected: number[];
  pointerStart: Point;
  center: Point;
  displayedPoints: Point[];
  authoredPoints: Point[];
  basePoints: Array<{ x: number; y: number }>;
  correctionDeltas: Record<string, Point>;
  model: AuthoringModel;
  pins: number[];
  distances: number[];
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
  neutral: { label: "中立", state: pose({}) }, left: { label: "左转", state: pose({ headYaw: -1 }) }, right: { label: "右转", state: pose({ headYaw: 1 }) },
  up: { label: "向上看", state: pose({ headPitch: -1 }) }, down: { label: "向下看", state: pose({ headPitch: 1 }) },
  "left-up": { label: "左上", state: pose({ headYaw: -1, headPitch: -1 }) }, "right-up": { label: "右上", state: pose({ headYaw: 1, headPitch: -1 }) },
  "left-down": { label: "左下", state: pose({ headYaw: -1, headPitch: 1 }) }, "right-down": { label: "右下", state: pose({ headYaw: 1, headPitch: 1 }) }
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

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select");
}

export function EditorWorkspace({ projectDirectory, onBack }: { projectDirectory: string; onBack: () => void }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<PuppetRenderer | undefined>(undefined);
  const drag = useRef<{ target: DragTarget; before: CalibrationOverrides; mesh?: MeshDragSnapshot } | undefined>(undefined);
  const operationLock = useRef(false);
  const historyGroup = useRef<{ key: string; at: number } | undefined>(undefined);
  const [workspace, setWorkspace] = useState<EditorWorkspaceData>();
  const [pending, setPending] = useState<CalibrationOverrides>({});
  const [undoStack, setUndoStack] = useState<CalibrationOverrides[]>([]);
  const [redoStack, setRedoStack] = useState<CalibrationOverrides[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [selectedVertex, setSelectedVertex] = useState<number>();
  const [selectedVertices, setSelectedVertices] = useState<number[]>([]);
  const [section, setSection] = useState<StudioSection>("overview");
  const [mode, setMode] = useState<EditMode>("semantic");
  const [editorOverlayVisible, setEditorOverlayVisible] = useState(false);
  const [showNeutralMeshReference, setShowNeutralMeshReference] = useState(false);
  const [showDraftBefore, setShowDraftBefore] = useState(false);
  const [soloSelectedLayer, setSoloSelectedLayer] = useState(false);
  const [poseId, setPoseId] = useState("neutral");
  const [autonomous, setAutonomous] = useState(false);
  const [previewState, setPreviewState] = useState<MotionState>(() => clone(neutralMotionState));
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
  const [softSelectionEnabled, setSoftSelectionEnabled] = useState(false);
  const [softRadius, setSoftRadius] = useState(0.035);
  const [secondaryPart, setSecondaryPart] = useState<SecondaryMotionPart>("frontHair");
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

  const effectiveOverrides = useMemo(() => workspace ? mergeCalibrationOverrides(workspace.calibration.overrides, pending) : pending, [workspace, pending]);
  // A draft must stay spatially stable while a point is dragged. Safety is
  // reported below and enforced by the save transaction, never by silently
  // shrinking the whole runtime envelope during pointer movement.
  const project = useMemo(() => workspace ? applyCalibrationOverrides(workspace.baseProject, effectiveOverrides) : undefined, [workspace, effectiveOverrides]);
  const selectedLayer = project?.layers.find((layer) => layer.id === selectedLayerId);
  const hasPending = Object.keys(pending).length > 0;
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
      renderer.current = created;
      created.start();
      created.setPaused(true);
      created.render(previewState);
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
      renderer.current.updateProject(renderProject);
      renderer.current.setPaused(!autonomous);
      if (!autonomous) renderer.current.render(previewState);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [renderProject, previewState, autonomous]);

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

  useEffect(() => {
    function handleHistoryShortcut(event: KeyboardEvent): void {
      if (event.key === "Escape" && drag.current) {
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

  function pointFromPointer(event: React.PointerEvent<SVGElement>): Point {
    const svg = event.currentTarget.ownerSVGElement ?? (event.currentTarget instanceof SVGSVGElement ? event.currentTarget : undefined);
    const rect = svg?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    };
  }

  function updateMeshSelection(indices: number[], mode: MeshSelectionMode): void {
    if (!selectedLayer) return;
    const valid = [...new Set(indices)].filter((index) => Number.isInteger(index) && index >= 0 && index < selectedLayer.mesh.points.length);
    let next: number[];
    if (mode === "replace") {
      next = valid;
    } else if (mode === "add") {
      next = [...selectedVertices, ...valid.filter((index) => !selectedVertices.includes(index))];
    } else {
      next = [...selectedVertices];
      valid.forEach((index) => {
        const existing = next.indexOf(index);
        if (existing >= 0) next.splice(existing, 1);
        else next.push(index);
      });
    }
    setSelectedVertices(next);
    setSelectedVertex(next.at(-1));
  }

  function beginDrag(event: React.PointerEvent<SVGElement>, target: DragTarget): void {
    if (event.button !== 0 || operationLock.current) return;
    const meshTarget = target.kind === "mesh" || target.kind === "mesh-move" || target.kind === "mesh-scale" || target.kind === "mesh-rotate";
    if ((meshTarget || target.kind === "pivot" || target.kind === "secondary") && selectedLayer?.locked) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const active: { target: DragTarget; before: CalibrationOverrides; mesh?: MeshDragSnapshot } = { target, before: clone(pending) };
    if (meshTarget && selectedLayer && project) {
      const baseline = meshBaseline(selectedLayer.id);
      const selected = target.kind === "mesh"
        ? (selectedVertices.includes(target.index) ? selectedVertices : [target.index])
        : selectedVertices;
      const displayedPoints = deformedPoints(project, selectedLayer, previewState);
      const authoredPoints = evaluateLayerAuthoring(project, selectedLayer, previewState).points;
      if (!baseline || selected.length === 0 || baseline.mesh.points.length !== selectedLayer.mesh.points.length) return;
      const selectedPoints = selected.map((index) => displayedPoints[index]).filter((point): point is Point => Boolean(point));
      if (selectedPoints.length !== selected.length) return;
      const minX = Math.min(...selectedPoints.map((point) => point.x));
      const maxX = Math.max(...selectedPoints.map((point) => point.x));
      const minY = Math.min(...selectedPoints.map((point) => point.y));
      const maxY = Math.max(...selectedPoints.map((point) => point.y));
      const distanceSets = selected.map((index) => meshGeodesicDistances(selectedLayer.mesh.points, selectedLayer.mesh.triangles, index));
      const distances = selectedLayer.mesh.points.map((_, index) => Math.min(...distanceSets.map((items) => items[index] ?? Number.POSITIVE_INFINITY)));
      active.mesh = {
        selected,
        pointerStart: target.kind === "mesh" ? clone(displayedPoints[target.index]!) : pointFromPointer(event),
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
        displayedPoints: clone(displayedPoints),
        authoredPoints: clone(authoredPoints),
        basePoints: clone(baseline.mesh.points),
        correctionDeltas: poseCorrectionPointDeltas(project.model, selectedLayer.id, previewState.headYaw, previewState.headPitch),
        model: clone(project.model),
        pins: clone(selectedLayer.mesh.influences?.pin ?? Array(selectedLayer.mesh.points.length).fill(0)),
        distances
      };
      setSelectedVertices(selected);
      setSelectedVertex(selected.at(-1));
      setAutonomous(false);
      setBehaviorPlaying(false);
    }
    drag.current = active;
  }

  function pointFromEvent(event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } {
    return pointFromPointer(event);
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
      } else if ((target.kind === "mesh" || target.kind === "mesh-move" || target.kind === "mesh-scale" || target.kind === "mesh-rotate") && active.mesh && project) {
        const dx = position.x - active.mesh.pointerStart.x;
        const dy = position.y - active.mesh.pointerStart.y;
        const selected = new Set(active.mesh.selected);
        const startDistance = Math.max(1e-6, Math.hypot(active.mesh.pointerStart.x - active.mesh.center.x, active.mesh.pointerStart.y - active.mesh.center.y));
        const scale = Math.max(0.2, Math.min(5, Math.hypot(position.x - active.mesh.center.x, position.y - active.mesh.center.y) / startDistance));
        const angle = Math.atan2(position.y - active.mesh.center.y, position.x - active.mesh.center.x)
          - Math.atan2(active.mesh.pointerStart.y - active.mesh.center.y, active.mesh.pointerStart.x - active.mesh.center.x);
        const deltas: Record<string, { x: number; y: number }> = {};
        const poseDeltas = clone(active.mesh.correctionDeltas);
        for (let index = 0; index < active.mesh.displayedPoints.length; index += 1) {
          const start = active.mesh.displayedPoints[index]!;
          const distance = active.mesh.distances[index] ?? Number.POSITIVE_INFINITY;
          if (!selected.has(index) && (target.kind !== "mesh" || !softSelectionEnabled || distance > softRadius)) continue;
          const falloff = selected.has(index) ? 1 : (1 - smoothstep(distance / Math.max(0.001, softRadius))) ** 2;
          const movable = falloff * (1 - (active.mesh.pins[index] ?? 0));
          let transformed = { x: start.x + dx, y: start.y + dy };
          if (target.kind === "mesh-scale") transformed = {
            x: active.mesh.center.x + (start.x - active.mesh.center.x) * scale,
            y: active.mesh.center.y + (start.y - active.mesh.center.y) * scale
          };
          if (target.kind === "mesh-rotate") {
            const localX = start.x - active.mesh.center.x;
            const localY = start.y - active.mesh.center.y;
            transformed = {
              x: active.mesh.center.x + localX * Math.cos(angle) - localY * Math.sin(angle),
              y: active.mesh.center.y + localX * Math.sin(angle) + localY * Math.cos(angle)
            };
          }
          const desired = { x: start.x + (transformed.x - start.x) * movable, y: start.y + (transformed.y - start.y) * movable };
          const authored = invertDeformedPoint(project, selectedLayer, desired, previewState, index, active.mesh.authoredPoints[index]!);
          if (poseId === "neutral") {
            const base = active.mesh.basePoints[index]!;
            deltas[index] = { x: authored.x - base.x, y: authored.y - base.y };
          } else {
            const previous = active.mesh.correctionDeltas[String(index)] ?? { x: 0, y: 0 };
            const initial = active.mesh.authoredPoints[index]!;
            poseDeltas[String(index)] = { x: previous.x + authored.x - initial.x, y: previous.y + authored.y - initial.y };
          }
        }
        next = poseId === "neutral"
          ? layerOverride(next, selectedLayer.id, { meshPointDeltas: deltas })
          : mergeCalibrationOverrides(next, { model: setPoseCorrectionPointDeltas(active.mesh.model, selectedLayer.id, previewState.headYaw, previewState.headPitch, poseDeltas) });
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

  function cancelDrag(): void {
    const active = drag.current;
    if (!active) return;
    drag.current = undefined;
    pendingRef.current = clone(active.before);
    setPending(clone(active.before));
    setNotice("已取消本次拖动。" );
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
      setSelectedVertices([target.index]);
      if ((selectedLayer.mesh.influences?.pin?.[target.index] ?? 0) >= 1) return;
      const baseline = meshBaseline(selectedLayer.id);
      const point = deformedPoints(project!, selectedLayer, previewState)[target.index];
      const basePoint = baseline?.mesh.points[target.index];
      if (!point || !basePoint) return;
      const position = shifted(point);
      const authoredPoints = evaluateLayerAuthoring(project!, selectedLayer, previewState).points;
      const authored = invertDeformedPoint(project!, selectedLayer, position, previewState, target.index, authoredPoints[target.index]!);
      if (poseId === "neutral") {
        next = layerOverride(next, selectedLayer.id, { meshPointDeltas: { [target.index]: { x: authored.x - basePoint.x, y: authored.y - basePoint.y } } });
      } else {
        const poseDeltas = poseCorrectionPointDeltas(project!.model, selectedLayer.id, previewState.headYaw, previewState.headPitch);
        const previous = poseDeltas[String(target.index)] ?? { x: 0, y: 0 };
        const initial = authoredPoints[target.index]!;
        poseDeltas[String(target.index)] = { x: previous.x + authored.x - initial.x, y: previous.y + authored.y - initial.y };
        next = mergeCalibrationOverrides(next, { model: setPoseCorrectionPointDeltas(project!.model, selectedLayer.id, previewState.headYaw, previewState.headPitch, poseDeltas) });
      }
    }
    const targetKey = target.kind === "semantic" || target.kind === "anchor" || target.kind === "secondary" ? String(target.key) : target.kind === "mesh" ? String(target.index) : target.kind;
    commit(next, `nudge:${target.kind}:${targetKey}`);
  }

  function patchLayer(layerId: string, patch: NonNullable<CalibrationOverrides["layers"]>[string]): void {
    const detail = patch.weights ? `weights:${Object.keys(patch.weights).sort().join(",")}`
      : patch.vertexInfluences ? `influences:${Object.keys(patch.vertexInfluences).sort().join(",")}`
        : Object.keys(patch).sort().join(",");
    commit(layerOverride(pending, layerId, patch), `layer:${layerId}:${detail}`);
  }

  function setLayerProperty(patch: NonNullable<CalibrationOverrides["layers"]>[string]): void {
    if (!selectedLayer) return;
    if (patch.meshDensity || patch.meshDetail !== undefined) { setSelectedVertex(undefined); setSelectedVertices([]); }
    patchLayer(selectedLayer.id, patch);
  }

  function setRuntimeTuning(kind: "motionTuning" | "envelope", key: string, value: number): void {
    const runtimePatch = kind === "motionTuning" ? { motionTuning: { [key]: value } } : { envelope: { [key]: value } };
    commit(mergeCalibrationOverrides(pending, { runtime: runtimePatch } as CalibrationOverrides), `runtime:${kind}:${key}`);
  }

  function setSecondaryTuning(part: SecondaryMotionPart, key: "amplitude" | "response" | "stability", value: number): void {
    commit(mergeCalibrationOverrides(pending, { runtime: { secondaryMotionTuning: { [part]: { [key]: value } } } }), `secondary:${part}:${key}`);
  }

  function setFaceDepth(landmark: FaceDepthLandmark, depth: number): void {
    const profile = project?.runtime.poseField?.faceDepthProfile;
    if (!profile) return;
    commit(mergeCalibrationOverrides(pending, {
      runtime: {
        poseField: {
          faceDepthProfile: {
            ...clone(profile),
            points: profile.points.map((point) => point.id === landmark ? { ...point, depth } : point)
          }
        }
      }
    }), `face-depth:${landmark}`);
  }

  function setTorsoVolume(landmark: TorsoVolumeLandmark | "strength", value: number): void {
    const profile: TorsoVolumeProfile = clone(project?.runtime.torsoVolumeProfile ?? defaultTorsoVolumeProfile(1));
    if (landmark === "strength") profile.strength = value;
    else profile.points = profile.points.map((point) => point.id === landmark ? { ...point, depth: value } : point);
    commit(mergeCalibrationOverrides(pending, { runtime: { torsoVolumeProfile: profile } }), `torso:${landmark}`);
  }

  function setVertexInfluence(channel: "face" | "skull" | "head" | "body" | "gaze" | "physics" | "pin" | "headAttachment" | "physicsRelease", value: number): void {
    if (!selectedLayer || selectedVertex === undefined) return;
    setLayerProperty({ vertexInfluences: { [channel]: { [selectedVertex]: value } } });
  }

  function setPreviewParameter(parameterId: string, value: number): void {
    setAutonomous(false);
    setPreviewState((current) => ({ ...current, parameters: { ...(current.parameters ?? {}), [parameterId]: value } }));
  }

  function setPreviewField(key: keyof MotionState, value: number): void {
    setAutonomous(false);
    setPreviewState((current) => ({ ...current, [key]: value }));
  }

  function setPreviewExpression(expressionId: string, value: number): void {
    setAutonomous(false);
    setPreviewState((current) => ({ ...current, expressions: { ...(current.expressions ?? {}), [expressionId]: value } }));
  }

  function setPreviewPose(yaw: number, pitch: number): void {
    setAutonomous(false);
    setPoseId(Object.entries(editorPoses).find(([, item]) => Math.abs(item.state.headYaw - yaw) < 0.02 && Math.abs(item.state.headPitch - pitch) < 0.02)?.[0] ?? "custom");
    setActivePreviewSample("custom");
    setPreviewState((current) => {
      const parameters = { ...(current.parameters ?? {}) };
      const yawParameter = project?.model.parameters.find((parameter) => parameter.semantic === "head-yaw");
      const pitchParameter = project?.model.parameters.find((parameter) => parameter.semantic === "head-pitch");
      if (yawParameter) parameters[yawParameter.id] = yaw;
      if (pitchParameter) parameters[pitchParameter.id] = pitch;
      return {
        ...current,
        headYaw: yaw,
        headPitch: pitch,
        bodySway: yaw * 0.5,
        bodyPitch: pitch * 0.38,
        gazeX: yaw * 0.45,
        gazeY: pitch * 0.3,
        parameters
      };
    });
  }

  function selectPose(id: string): void {
    const selected = editorPoses[id];
    if (!selected) return;
    setPoseId(id);
    setActivePreviewSample(id);
    setAutonomous(false);
    setPreviewState(clone(selected.state));
  }

  function selectPreviewSample(id: string, state: Partial<MotionState>): void {
    setActivePreviewSample(id);
    setPoseId(id in editorPoses ? id : "custom");
    setAutonomous(false);
    setBehaviorPlaying(false);
    setPreviewState({ ...clone(neutralMotionState), ...state });
  }

  function patchPhysics(physicsId: string, patch: Partial<{ inputScale: number; outputScale: number; response: number; damping: number }>): void {
    if (!project) return;
    const model = clone(project.model);
    const index = model.physics.findIndex((physics) => physics.id === physicsId);
    if (index < 0) return;
    model.physics[index] = { ...model.physics[index]!, ...patch };
    commit(mergeCalibrationOverrides(pending, { model }), `physics:${physicsId}:${Object.keys(patch).sort().join(",")}`);
  }

  function createStarterDynamics(): void {
    if (!project) return;
    const model = clone(project.model);
    const bySemantic = new Map(model.parameters.flatMap((parameter) => parameter.semantic ? [[parameter.semantic, parameter.id]] : []));
    const blink = bySemantic.get("blink");
    const mouth = bySemantic.get("mouth-open");
    const pitch = bySemantic.get("head-pitch");
    const yaw = bySemantic.get("head-yaw");
    const breath = bySemantic.get("breath");
    if (model.expressions.length === 0) {
      if (blink) model.expressions.push({ id: "expression-closed-eyes", name: "闭眼", parameters: { [blink]: 1 } });
      if (mouth) model.expressions.push({ id: "expression-speaking", name: "开口", parameters: { [mouth]: 1 } });
      const surprised = Object.fromEntries([[pitch, -0.2], [blink, 0], [mouth, 0.82]].filter((entry): entry is [string, number] => Boolean(entry[0])));
      if (Object.keys(surprised).length > 0) model.expressions.push({ id: "expression-surprised", name: "惊讶", parameters: surprised });
    }
    if (model.behaviors.length === 0) {
      const idleTracks = [
        yaw ? { target: { kind: "parameter" as const, id: yaw }, keyframes: [{ time: 0, value: 0 }, { time: 1.5, value: 0.14 }, { time: 3, value: 0 }, { time: 4.5, value: -0.12 }, { time: 6, value: 0 }] } : undefined,
        pitch ? { target: { kind: "parameter" as const, id: pitch }, keyframes: [{ time: 0, value: 0 }, { time: 2, value: -0.06 }, { time: 4, value: 0.05 }, { time: 6, value: 0 }] } : undefined,
        breath ? { target: { kind: "parameter" as const, id: breath }, keyframes: [{ time: 0, value: -0.7 }, { time: 3, value: 0.7 }, { time: 6, value: -0.7 }] } : undefined,
        blink ? { target: { kind: "parameter" as const, id: blink }, keyframes: [{ time: 0, value: 0 }, { time: 1.8, value: 0 }, { time: 1.92, value: 1, easing: "smoothstep" as const }, { time: 2.04, value: 0, easing: "smoothstep" as const }, { time: 6, value: 0 }] } : undefined
      ].filter((track): track is NonNullable<typeof track> => Boolean(track));
      if (idleTracks.length > 0) model.behaviors.push({ id: "behavior-idle", name: "自然待机", duration: 6, loop: true, autoplay: true, tracks: idleTracks });
      if (pitch) model.behaviors.push({
        id: "behavior-nod", name: "点头", duration: 1.6, loop: false,
        tracks: [{ target: { kind: "parameter", id: pitch }, keyframes: [{ time: 0, value: 0 }, { time: 0.48, value: 0.62 }, { time: 0.92, value: -0.16 }, { time: 1.6, value: 0 }] }]
      });
    }
    commit(mergeCalibrationOverrides(pending, { model }));
    setSelectedBehaviorId(model.behaviors[0]?.id ?? "");
    setBehaviorTime(0);
    setNotice("已生成基础表情和行为预览；确认效果后保存更改。" );
  }

  async function upgradeSelectedMesh(): Promise<void> {
    if (!selectedLayer) return;
    const previousTopology = selectedLayer.mesh.topology;
    const previousPoints = selectedLayer.mesh.points.length;
    const previousTriangles = Math.floor(selectedLayer.mesh.triangles.length / 3);
    operationLock.current = true;
    setMeshUpgrading(true);
    setError("");
    try {
      const replacements = await window.puppetloom.generateArtMeshes(projectDirectory, [selectedLayer.id]);
      const mesh = replacements[selectedLayer.id];
      if (!mesh) {
        setNotice("当前图层没有生成新的轮廓网格；完全不透明的矩形素材会继续使用规则网格。" );
        return;
      }
      const neutralDeltas = reprojectSparsePointDeltas(selectedLayer.mesh, mesh, effectiveOverrides.layers?.[selectedLayer.id]?.meshPointDeltas);
      const model = reprojectLayerPoseCorrections(project!.model, selectedLayer.id, selectedLayer.mesh, mesh);
      const next = mergeCalibrationOverrides(pending, {
        model,
        layers: { [selectedLayer.id]: { mesh, ...(neutralDeltas ? { meshPointDeltas: neutralDeltas } : {}) } }
      });
      const candidate = applyCalibrationOverrides(workspace!.baseProject, mergeCalibrationOverrides(workspace!.calibration.overrides, next));
      const failed = validateProjectPoses(candidate).filter((check) => !check.passed);
      if (failed.length > 0) {
        throw new Error(`网格重建结果未通过全姿态质量门：${failed[0]!.issues[0]?.message ?? failed[0]!.id}。原网格和当前草稿均未改动。`);
      }
      commit(next, undefined, true);
      setSelectedVertex(undefined);
      setSelectedVertices([]);
      setMode("mesh");
      setEditorOverlayVisible(true);
      setSection("rig");
      const action = previousTopology === "art" ? "重新生成" : "升级";
      setNotice(`已${action}“${selectedLayer.sourceName}”的 Alpha ArtMesh：顶点 ${previousPoints} → ${mesh.points.length}，三角形 ${previousTriangles} → ${Math.floor(mesh.triangles.length / 3)}。请检查中立与九向姿态后再保存。`);
    } catch (cause) {
      setError(`当前图层网格升级失败：${messageOf(cause)}`);
    } finally {
      setMeshUpgrading(false);
      operationLock.current = false;
    }
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
      {(error || notice) && <div className={`editor-feedback ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "status"}><span>{error || notice}</span><button aria-label="关闭提示" onClick={() => { setError(""); setNotice(""); }}>关闭</button></div>}
      {interactionLocked && <div className="editor-operation-shield" role="status" aria-live="polite"><div className="spinner"/><strong>{meshUpgrading ? "正在生成并验证轮廓网格…" : "正在完成校准事务…"}</strong><span>完成前编辑已暂时锁定，当前草稿不会被覆盖。</span></div>}
      <header className="editor-header">
        <button className="with-icon" disabled={interactionLocked} onClick={() => void leaveEditor()}><ArrowLeft aria-hidden="true" />返回主页</button>
        <div><h1>{project.name}</h1><p>版本 {workspace.calibration.revision} · {project.rigLevel === "semantic" ? "完整语义绑定" : project.rigLevel === "grouped" ? "分组绑定" : "基础绑定"} · {project.layers.length} 层 · 已保存安全系数 {workspace.project.quality.safetyScale.toFixed(2)}{draftSafetyChecks.length ? ` · 草稿${draftSafetyPassed ? "通过全姿态检查" : "存在不安全姿态"}` : ""}</p></div>
        <div className="editor-history-actions">
          <span className={`draft-state ${draftStatus}`}>{draftStatus === "saving" ? "正在自动保存" : draftStatus === "saved" ? "草稿已保存" : draftStatus === "error" ? "草稿保存失败" : draftStatus === "waiting" ? "等待自动保存" : ""}</span>
          <button className="icon-only" aria-label="撤销" aria-keyshortcuts="Control+Z Meta+Z" disabled={interactionLocked || undoStack.length === 0} onClick={undo} title="撤销（Ctrl+Z）"><Undo2 aria-hidden="true" /></button>
          <button className="icon-only" aria-label="重做" aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z" disabled={interactionLocked || redoStack.length === 0} onClick={redo} title="重做（Ctrl+Y / Ctrl+Shift+Z）"><Redo2 aria-hidden="true" /></button>
          <button className="with-icon" onClick={() => void restoreRevision(0, "恢复全部自动绑定")} disabled={interactionLocked}><RotateCcw aria-hidden="true" />恢复全部自动绑定</button>
          <button className="header-save with-icon" disabled={!hasPending || interactionLocked} onClick={() => void save()}><Save aria-hidden="true" />{busy ? "正在验证…" : "保存更改"}</button>
          <button className="with-icon" disabled={interactionLocked} onClick={() => void launchViewer()}><ExternalLink aria-hidden="true" />运行角色窗口</button>
        </div>
      </header>

      <StudioNavigation section={section} onSection={(next) => { setSection(next); if (next !== "preview") setFocusedPreview(false); }} />

      <section className="editor-toolbar">
        {section === "rig" ? <><div className="mode-tabs">{(["semantic", "anchors", "layer", "mesh"] as EditMode[]).map((item) => {
          const active = editorOverlayVisible && mode === item;
          const label = item === "semantic" ? "脸部控制点" : item === "anchors" ? "身体锚点" : item === "layer" ? "图层轴心" : "网格与权重";
          return <button aria-pressed={active} className={active ? "active" : ""} key={item} title={active ? `再次点击隐藏${label}` : `显示${label}`} onClick={() => {
            if (active) setEditorOverlayVisible(false);
            else {
              setMode(item); setEditorOverlayVisible(true);
              if (item === "mesh") { setAutonomous(false); setBehaviorPlaying(false); if (!editorPoses[poseId]) selectPose("neutral"); }
            }
          }}>{label}</button>;
        })}{editorOverlayVisible && mode === "mesh" && <>
          <button aria-pressed={showNeutralMeshReference} className={showNeutralMeshReference ? "active" : ""} title="在实时变形网格下叠加中立网格" onClick={() => setShowNeutralMeshReference((value) => !value)}>中立参考</button>
          <button disabled={!hasPending} className={showDraftBefore ? "active" : ""} onPointerDown={() => setShowDraftBefore(true)} onPointerUp={() => setShowDraftBefore(false)} onPointerCancel={() => setShowDraftBefore(false)} onPointerLeave={() => setShowDraftBefore(false)}>按住看修改前</button>
          <span className={`pose-edit-status ${currentPoseCheck?.passed === false ? "warning" : ""}`}>正在校正：{currentPoseLabel}{poseId === "neutral" ? "（基础网格）" : "（姿态关键形）"}</span>
        </>}</div><div className="pose-tabs">{Object.entries(editorPoses).map(([id, item]) => {
          const key = `${item.state.headYaw},${item.state.headPitch}`;
          const corrected = id === "neutral" ? neutralCorrectionCount > 0 : (correctedSamples.get(key) ?? 0) > 0;
          const check = poseChecks[id];
          return <button className={`${!autonomous && poseId === id ? "active" : ""} ${check?.passed === false ? "pose-warning" : ""}`} title={`${item.label}${corrected ? "已有人工微调" : "尚未微调"}${check?.passed === false ? `；${check.issues[0]?.message ?? "安全检查未通过"}` : ""}`} key={id} onClick={() => selectPose(id)}>{item.label}{corrected ? " ·" : ""}{check?.passed === false ? " !" : ""}</button>;
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
