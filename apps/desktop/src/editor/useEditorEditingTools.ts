import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  AuthoringModel,
  CalibrationOverrides,
  FaceDepthLandmark,
  LayerBinding,
  MotionState,
  Point,
  PuppetLoomProject,
  SecondaryMotionPart,
  TorsoVolumeLandmark,
  TorsoVolumeProfile
} from "@puppetloom/core";
import {
  applyCalibrationOverridesForPreview,
  defaultTorsoVolumeProfile,
  deformedPointsForPreview,
  evaluateLayerAuthoring,
  invertDeformedPoint,
  mergeCalibrationOverridesForPreview,
  meshGeodesicDistances,
  neutralMotionState,
  poseCorrectionPointDeltas,
  reprojectLayerPoseCorrections,
  reprojectSparsePointDeltas,
  setPoseCorrectionPointDeltas,
  isModelBehaviorAvailable
} from "@puppetloom/core/browser";
import type { EditorWorkspace as EditorWorkspaceData } from "../../electron/global.js";
import type { DragTarget, EditMode, MeshSelectionMode } from "./EditorPresentation.js";
import type { StudioSection } from "./EditorStudioPanels.js";
import { clone, editorPoses, layerOverride, messageOf, smoothstep } from "./EditorWorkspaceModel.js";
import { validateEditorProject } from "./useEditorValidation.js";

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

interface EditorEditingToolsOptions {
  projectDirectory: string;
  workspace: EditorWorkspaceData | undefined;
  project: PuppetLoomProject | undefined;
  selectedLayer: LayerBinding | undefined;
  selectedLayerId: string;
  effectiveOverrides: CalibrationOverrides;
  pending: CalibrationOverrides;
  setPending: Dispatch<SetStateAction<CalibrationOverrides>>;
  pendingRef: { current: CalibrationOverrides };
  setUndoStack: Dispatch<SetStateAction<CalibrationOverrides[]>>;
  setRedoStack: Dispatch<SetStateAction<CalibrationOverrides[]>>;
  operationLock: { current: boolean };
  commit: (next: CalibrationOverrides, group?: string, internal?: boolean) => void;
  previewState: MotionState;
  poseId: string;
  setPoseId: Dispatch<SetStateAction<string>>;
  setPreviewState: Dispatch<SetStateAction<MotionState>>;
  setAutonomous: Dispatch<SetStateAction<boolean>>;
  setBehaviorPlaying: Dispatch<SetStateAction<boolean>>;
  setSelectedBehaviorId: Dispatch<SetStateAction<string>>;
  setBehaviorTime: Dispatch<SetStateAction<number>>;
  setActivePreviewSample: Dispatch<SetStateAction<string>>;
  setMode: Dispatch<SetStateAction<EditMode>>;
  setSection: Dispatch<SetStateAction<StudioSection>>;
  setEditorOverlayVisible: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  setMeshUpgrading: Dispatch<SetStateAction<boolean>>;
  posedMeshPoints: Point[];
}

export function useEditorEditingTools({
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
}: EditorEditingToolsOptions) {
  const drag = useRef<{ target: DragTarget; before: CalibrationOverrides; mesh?: MeshDragSnapshot } | undefined>(undefined);
  const [selectedVertex, setSelectedVertex] = useState<number>();
  const [selectedVertices, setSelectedVertices] = useState<number[]>([]);
  const [softSelectionEnabled, setSoftSelectionEnabled] = useState(false);
  const [softRadius, setSoftRadius] = useState(0.035);
  const [secondaryPart, setSecondaryPart] = useState<SecondaryMotionPart>("frontHair");

  function meshBaselinePoints(layer: LayerBinding): Point[] {
    const deltas = effectiveOverrides.layers?.[layer.id]?.meshPointDeltas;
    return layer.mesh.points.map((point, index) => {
      const delta = deltas?.[String(index)];
      return delta ? { x: point.x - delta.x, y: point.y - delta.y } : point;
    });
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
      const selected = target.kind === "mesh"
        ? (selectedVertices.includes(target.index) ? selectedVertices : [target.index])
        : selectedVertices;
      const displayedPoints = posedMeshPoints.length === selectedLayer.mesh.points.length
        ? posedMeshPoints
        : deformedPointsForPreview(project, selectedLayer, previewState);
      const authoredPoints = evaluateLayerAuthoring(project, selectedLayer, previewState).points;
      const basePoints = meshBaselinePoints(selectedLayer);
      if (selected.length === 0 || basePoints.length !== selectedLayer.mesh.points.length) return;
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
        basePoints,
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
            const authoredStart = invertDeformedPoint(project, selectedLayer, start, previewState, index, initial);
            // Pose corrections are incremental edits on top of the visible pose.
            // Subtracting the inverted start point prevents procedural pose motion
            // from being recorded again when render and inverse baselines differ.
            poseDeltas[String(index)] = {
              x: previous.x + authored.x - authoredStart.x,
              y: previous.y + authored.y - authoredStart.y
            };
          }
        }
        next = poseId === "neutral"
          ? layerOverride(next, selectedLayer.id, { meshPointDeltas: deltas })
          : mergeCalibrationOverridesForPreview(next, { model: setPoseCorrectionPointDeltas(active.mesh.model, selectedLayer.id, previewState.headYaw, previewState.headPitch, poseDeltas) });
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
      const displayedPoints = posedMeshPoints.length === selectedLayer.mesh.points.length
        ? posedMeshPoints
        : deformedPointsForPreview(project!, selectedLayer, previewState);
      const point = displayedPoints[target.index];
      const basePoint = meshBaselinePoints(selectedLayer)[target.index];
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
        const authoredStart = invertDeformedPoint(project!, selectedLayer, point, previewState, target.index, initial);
        poseDeltas[String(target.index)] = {
          x: previous.x + authored.x - authoredStart.x,
          y: previous.y + authored.y - authoredStart.y
        };
        next = mergeCalibrationOverridesForPreview(next, { model: setPoseCorrectionPointDeltas(project!.model, selectedLayer.id, previewState.headYaw, previewState.headPitch, poseDeltas) });
      }
    }
    const targetKey = target.kind === "semantic" || target.kind === "anchor" || target.kind === "secondary" ? String(target.key) : target.kind === "mesh" ? String(target.index) : target.kind;
    commit(next, `nudge:${target.kind}:${targetKey}`);
  }

  function patchLayer(layerId: string, patch: NonNullable<CalibrationOverrides["layers"]>[string]): void {
    const detail = patch.weights ? `weights:${Object.keys(patch.weights).sort().join(",")}`
      : patch.vertexInfluences ? `influences:${Object.keys(patch.vertexInfluences).sort().join(",")}`
        : Object.keys(patch).sort().join(",");
    commit(layerOverride(pendingRef.current, layerId, patch), `layer:${layerId}:${detail}`);
  }

  function setLayerProperty(patch: NonNullable<CalibrationOverrides["layers"]>[string]): void {
    if (!selectedLayer) return;
    if (patch.meshDensity || patch.meshDetail !== undefined) { setSelectedVertex(undefined); setSelectedVertices([]); }
    patchLayer(selectedLayer.id, patch);
  }

  function setRuntimeTuning(kind: "motionTuning" | "envelope", key: string, value: number): void {
    const runtimePatch = kind === "motionTuning" ? { motionTuning: { [key]: value } } : { envelope: { [key]: value } };
    commit(mergeCalibrationOverridesForPreview(pendingRef.current, { runtime: runtimePatch } as CalibrationOverrides), `runtime:${kind}:${key}`);
  }

  function setSecondaryTuning(part: SecondaryMotionPart, key: "amplitude" | "response" | "stability", value: number): void {
    commit(mergeCalibrationOverridesForPreview(pendingRef.current, { runtime: { secondaryMotionTuning: { [part]: { [key]: value } } } }), `secondary:${part}:${key}`);
  }

  function setFaceDepth(landmark: FaceDepthLandmark, depth: number): void {
    const profile = project?.runtime.poseField?.faceDepthProfile;
    if (!profile) return;
    commit(mergeCalibrationOverridesForPreview(pendingRef.current, {
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
    commit(mergeCalibrationOverridesForPreview(pendingRef.current, { runtime: { torsoVolumeProfile: profile } }), `torso:${landmark}`);
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
    commit(mergeCalibrationOverridesForPreview(pendingRef.current, { model }), `physics:${physicsId}:${Object.keys(patch).sort().join(",")}`);
  }

  function createStarterDynamics(): void {
    if (!project) return;
    const model = clone(project.model);
    const bySemantic = new Map(model.parameters.flatMap((parameter) => parameter.semantic ? [[parameter.semantic, parameter.id]] : []));
    const blink = project.runtime.features.blink ? bySemantic.get("blink") : undefined;
    const mouth = project.runtime.features.mouthMotion ? bySemantic.get("mouth-open") : undefined;
    const pitch = bySemantic.get("head-pitch");
    const yaw = bySemantic.get("head-yaw");
    const breath = bySemantic.get("breath");
    const expressionIds = new Set(model.expressions.map((expression) => expression.id));
    if (blink && !expressionIds.has("expression-closed-eyes")) model.expressions.push({ id: "expression-closed-eyes", name: "闭眼", parameters: { [blink]: 1 } });
    if (mouth && !expressionIds.has("expression-speaking")) model.expressions.push({ id: "expression-speaking", name: "开口", parameters: { [mouth]: 1 } });
    const surprised = Object.fromEntries([[pitch, -0.2], [mouth, 0.82]].filter((entry): entry is [string, number] => Boolean(entry[0])));
    if (!expressionIds.has("expression-surprised") && Object.keys(surprised).length > 0) model.expressions.push({ id: "expression-surprised", name: "惊讶", parameters: surprised });

    const idleTracks = [
      yaw ? { target: { kind: "parameter" as const, id: yaw }, keyframes: [{ time: 0, value: 0 }, { time: 1.5, value: 0.14 }, { time: 3, value: 0 }, { time: 4.5, value: -0.12 }, { time: 6, value: 0 }] } : undefined,
      pitch ? { target: { kind: "parameter" as const, id: pitch }, keyframes: [{ time: 0, value: 0 }, { time: 2, value: -0.06 }, { time: 4, value: 0.05 }, { time: 6, value: 0 }] } : undefined,
      breath ? { target: { kind: "parameter" as const, id: breath }, keyframes: [{ time: 0, value: -0.7 }, { time: 3, value: 0.7 }, { time: 6, value: -0.7 }] } : undefined,
      blink ? { target: { kind: "parameter" as const, id: blink }, keyframes: [{ time: 0, value: 0 }, { time: 1.8, value: 0 }, { time: 1.92, value: 1, easing: "smoothstep" as const }, { time: 2.04, value: 0, easing: "smoothstep" as const }, { time: 6, value: 0 }] } : undefined
    ].filter((track): track is NonNullable<typeof track> => Boolean(track));
    const behaviorIds = new Set(model.behaviors.map((behavior) => behavior.id));
    if (!behaviorIds.has("behavior-idle") && idleTracks.length > 0) model.behaviors.push({ id: "behavior-idle", name: "自然待机", duration: 6, loop: true, autoplay: true, tracks: idleTracks });
    if (!behaviorIds.has("behavior-nod") && pitch) model.behaviors.push({
      id: "behavior-nod", name: "点头", duration: 1.6, loop: false,
      tracks: [{ target: { kind: "parameter", id: pitch }, keyframes: [{ time: 0, value: 0 }, { time: 0.48, value: 0.62 }, { time: 0.92, value: -0.16 }, { time: 1.6, value: 0 }] }]
    });
    const next = mergeCalibrationOverridesForPreview(pendingRef.current, { model });
    if (JSON.stringify(next) === JSON.stringify(pendingRef.current)) {
      setNotice("当前素材支持的基础表情和行为已经齐全。" );
      return;
    }
    commit(next);
    setSelectedBehaviorId(model.behaviors.find((behavior) => isModelBehaviorAvailable(project, behavior))?.id ?? "");
    setBehaviorTime(0);
    setNotice("已生成当前素材支持的基础表情和行为；确认效果后保存更改。" );
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
      const next = mergeCalibrationOverridesForPreview(pendingRef.current, {
        model,
        layers: { [selectedLayer.id]: { mesh, ...(neutralDeltas ? { meshPointDeltas: neutralDeltas } : {}) } }
      });
      const candidate = applyCalibrationOverridesForPreview(workspace!.baseProject, mergeCalibrationOverridesForPreview(workspace!.calibration.overrides, next));
      const failed = (await validateEditorProject(candidate)).draftSafetyChecks.filter((check) => !check.passed);
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


  return {
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
    hasActiveDrag: () => Boolean(drag.current),
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
  };
}
