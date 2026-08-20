import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import type {
  AnchorGraph,
  CalibrationOverrides,
  CalibrationSessionDocument,
  FaceDepthLandmark,
  LayerBinding,
  Point,
  PuppetLoomProject,
  RevisionComparisonResult,
  SecondaryMotionPart,
  SemanticCagePointId,
  SemanticRole,
  Side,
  TorsoVolumeLandmark
} from "@puppetloom/core";
import { ArrowDown, ArrowUp, Ban, Check, Eye, EyeOff, Lock, LockOpen, RotateCcw, Save, Scan, ScanEye, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { useViewportNavigation } from "./useViewportNavigation.js";

export type EditMode = "semantic" | "anchors" | "layer" | "mesh";
export type ComparisonMode = "before" | "after" | "split" | "overlay" | "difference";
export type MeshSelectionMode = "replace" | "add" | "toggle";
export type DragTarget =
  | { kind: "semantic"; key: SemanticCagePointId }
  | { kind: "anchor"; key: keyof AnchorGraph }
  | { kind: "pivot" }
  | { kind: "secondary"; key: keyof NonNullable<LayerBinding["secondaryAnchors"]> }
  | { kind: "mesh"; index: number }
  | { kind: "mesh-move" }
  | { kind: "mesh-scale" }
  | { kind: "mesh-rotate" };

export interface ComparisonImages {
  result: RevisionComparisonResult;
  before: string;
  after: string;
  difference: string;
}

type LayerPatch = NonNullable<CalibrationOverrides["layers"]>[string];
type VertexChannel = "face" | "skull" | "head" | "body" | "gaze" | "physics" | "pin" | "headAttachment" | "physicsRelease";

function meshEdgePath(points: Point[], triangles: number[]): string {
  const commands: string[] = [];
  const edges = new Set<string>();
  const append = (left: number | undefined, right: number | undefined): void => {
    if (left === undefined || right === undefined) return;
    const key = left < right ? `${left},${right}` : `${right},${left}`;
    if (edges.has(key)) return;
    const a = points[left];
    const b = points[right];
    if (!a || !b) return;
    edges.add(key);
    commands.push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
  };
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index];
    const b = triangles[index + 1];
    const c = triangles[index + 2];
    append(a, b); append(b, c); append(c, a);
  }
  return commands.join("");
}

function artMeshQuality(layer: LayerBinding): { balanced: boolean; label: string } | undefined {
  const mesh = layer.mesh;
  if (mesh.topology !== "art" || !mesh.art || mesh.uvs.length !== mesh.points.length) return undefined;
  const edges = new Map<string, number>();
  const addEdge = (left: number, right: number): void => {
    const key = left < right ? `${left},${right}` : `${right},${left}`;
    if (edges.has(key)) return;
    const a = mesh.uvs[left];
    const b = mesh.uvs[right];
    if (!a || !b) return;
    edges.set(key, Math.hypot(
      (a.x - b.x) * mesh.art!.textureSize.width,
      (a.y - b.y) * mesh.art!.textureSize.height
    ));
  };
  let worstAspect = 1;
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const ids = mesh.triangles.slice(index, index + 3);
    if (ids.length < 3) continue;
    addEdge(ids[0]!, ids[1]!);
    addEdge(ids[1]!, ids[2]!);
    addEdge(ids[2]!, ids[0]!);
    const lengths = [
      edges.get(ids[0]! < ids[1]! ? `${ids[0]},${ids[1]}` : `${ids[1]},${ids[0]}`),
      edges.get(ids[1]! < ids[2]! ? `${ids[1]},${ids[2]}` : `${ids[2]},${ids[1]}`),
      edges.get(ids[2]! < ids[0]! ? `${ids[2]},${ids[0]}` : `${ids[0]},${ids[2]}`)
    ].filter((length): length is number => length !== undefined).sort((a, b) => a - b);
    if (lengths.length === 3) worstAspect = Math.max(worstAspect, lengths[2]! / Math.max(0.001, lengths[0]!));
  }
  const shortThreshold = Math.max(1.5, mesh.art.detail * 0.3);
  const shortEdges = [...edges.values()].filter((length) => length < shortThreshold).length;
  const shortRatio = edges.size > 0 ? shortEdges / edges.size : 0;
  const balanced = shortRatio <= 0.1 && worstAspect <= 12;
  return {
    balanced,
    label: balanced
      ? `均衡 · 最差边比 ${worstAspect.toFixed(1)}:1`
      : `需要重建 · ${shortEdges} 条过短边 · 最差边比 ${worstAspect.toFixed(1)}:1`
  };
}

const semanticRoles: SemanticRole[] = [
  "backHair", "frontHair", "sideHair", "face", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth", "ear", "neck", "topWear", "bottomWear", "arm", "hand", "leg", "foot", "headwear", "tail", "accessory", "unknown"
];

const secondaryParts: Array<{ id: SecondaryMotionPart; label: string }> = [
  { id: "frontHair", label: "前发" }, { id: "backHair", label: "后发" }, { id: "ahoge", label: "呆毛" },
  { id: "headwear", label: "头饰" }, { id: "ears", label: "耳部" }, { id: "topCloth", label: "上衣" },
  { id: "skirt", label: "裙摆" }, { id: "tail", label: "尾巴" }, { id: "accessory", label: "配饰" }
];

function layerDepth(layer: LayerBinding, byId: Map<string, LayerBinding>): number {
  let depth = 0;
  let current = layer;
  const visited = new Set([layer.id]);
  while (current.parentLayerId && !visited.has(current.parentLayerId)) {
    const parent = byId.get(current.parentLayerId);
    if (!parent) break;
    visited.add(parent.id);
    current = parent;
    depth += 1;
  }
  return depth;
}

function canUseAsParent(childId: string, candidate: LayerBinding, byId: Map<string, LayerBinding>): boolean {
  let current: LayerBinding | undefined = candidate;
  const visited = new Set<string>();
  while (current) {
    if (current.id === childId) return false;
    if (!current.parentLayerId || visited.has(current.parentLayerId)) return true;
    visited.add(current.parentLayerId);
    current = byId.get(current.parentLayerId);
  }
  return true;
}

export function EditorLayerPanel({
  project,
  selectedLayerId,
  onSelect,
  onPatchLayer,
  soloSelectedLayer,
  onSolo
}: {
  project: PuppetLoomProject;
  selectedLayerId: string;
  onSelect: (layerId: string) => void;
  onPatchLayer: (layerId: string, patch: LayerPatch) => void;
  soloSelectedLayer: boolean;
  onSolo: (layerId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [orderMode, setOrderMode] = useState<"hierarchy" | "draw">("hierarchy");
  const byId = new Map(project.layers.map((layer) => [layer.id, layer]));
  const drawOrdered = [...project.layers].sort((left, right) => right.order - left.order);
  const hierarchyOrdered: LayerBinding[] = [];
  const appended = new Set<string>();
  const append = (layer: LayerBinding) => {
    if (appended.has(layer.id)) return;
    appended.add(layer.id);
    hierarchyOrdered.push(layer);
    drawOrdered.filter((candidate) => candidate.parentLayerId === layer.id).forEach(append);
  };
  drawOrdered.filter((layer) => !layer.parentLayerId || !byId.has(layer.parentLayerId)).forEach(append);
  drawOrdered.forEach(append);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const ordered = (orderMode === "hierarchy" ? hierarchyOrdered : drawOrdered).filter((layer) => !normalizedQuery || [layer.sourceName, layer.role, layer.side, layer.deformerId, layer.parentGroup].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)));
  return (
    <aside className="layer-panel">
      <div className="layer-panel-heading"><div><div className="panel-eyebrow">RIG TREE</div><h2>图层结构</h2></div><output>{ordered.length}/{project.layers.length}</output></div>
      <input className="layer-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、语义或变形器" />
      <div className="layer-order-tabs"><button className={orderMode === "hierarchy" ? "active" : ""} onClick={() => setOrderMode("hierarchy")}>结构层级</button><button className={orderMode === "draw" ? "active" : ""} onClick={() => setOrderMode("draw")}>绘制顺序</button></div>
      <div className="layer-list">
        {ordered.map((layer) => (
          <div key={layer.id} className={`layer-row ${selectedLayerId === layer.id ? "selected" : ""} ${layer.visible === false ? "hidden" : ""} ${soloSelectedLayer && selectedLayerId === layer.id ? "solo" : ""}`} style={{ paddingLeft: `${8 + layerDepth(layer, byId) * 16}px` }}>
            <button className="layer-select" onClick={() => onSelect(layer.id)}>
              <span>{layer.sourceName}</span><small>{layer.role} · {layer.side} · #{layer.order}{layer.deformerId ? ` · ${layer.deformerId}` : ""}</small>
            </button>
            <button className={`layer-icon ${layer.visible === false ? "is-off" : ""}`} title={layer.visible === false ? "显示图层" : "隐藏图层"} aria-label={`${layer.sourceName} ${layer.visible === false ? "显示" : "隐藏"}`} onClick={() => onPatchLayer(layer.id, { visible: layer.visible === false })}>{layer.visible === false ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</button>
            <button className={`layer-icon ${layer.locked ? "is-off" : ""}`} title={layer.locked ? "解锁图层" : "锁定图层"} aria-label={`${layer.sourceName} ${layer.locked ? "解锁" : "锁定"}`} onClick={() => onPatchLayer(layer.id, { locked: !layer.locked })}>{layer.locked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}</button>
            <button className={`layer-icon layer-solo ${soloSelectedLayer && selectedLayerId === layer.id ? "is-active" : ""}`} aria-pressed={soloSelectedLayer && selectedLayerId === layer.id} title={soloSelectedLayer && selectedLayerId === layer.id ? "恢复显示全部图层" : "仅显示此图层"} aria-label={`${layer.sourceName} ${soloSelectedLayer && selectedLayerId === layer.id ? "恢复显示全部图层" : "仅显示此图层"}`} onClick={() => onSolo(layer.id)}><ScanEye aria-hidden="true" /></button>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function EditorViewportPanel({
  canvas,
  project,
  mode,
  showOverlay,
  showNeutralMeshReference,
  posedMeshPoints,
  liveMeshPoints,
  animateMesh,
  cleanPreview,
  selectedLayer,
  selectedVertex,
  selectedVertices,
  softSelectionEnabled,
  softRadius,
  comparison,
  comparisonMode,
  splitPercent,
  onBeginDrag,
  onMoveDrag,
  onEndDrag,
  onCancelDrag,
  onSelectMeshVertices,
  onNudge,
  onComparisonMode,
  onSplitPercent
}: {
  canvas: React.RefObject<HTMLCanvasElement | null>;
  project: PuppetLoomProject;
  mode: EditMode;
  showOverlay: boolean;
  showNeutralMeshReference: boolean;
  posedMeshPoints: Point[];
  liveMeshPoints: () => Point[] | undefined;
  animateMesh: boolean;
  cleanPreview: boolean;
  selectedLayer: LayerBinding | undefined;
  selectedVertex: number | undefined;
  selectedVertices: number[];
  softSelectionEnabled: boolean;
  softRadius: number;
  comparison: ComparisonImages | undefined;
  comparisonMode: ComparisonMode;
  splitPercent: number;
  onBeginDrag: (event: React.PointerEvent<SVGElement>, target: DragTarget) => void;
  onMoveDrag: (event: React.PointerEvent<SVGSVGElement>) => void;
  onEndDrag: () => void;
  onCancelDrag: () => void;
  onSelectMeshVertices: (indices: number[], mode: MeshSelectionMode) => void;
  onNudge: (event: React.KeyboardEvent<SVGCircleElement>, target: DragTarget) => void;
  onComparisonMode: (mode: ComparisonMode) => void;
  onSplitPercent: (percent: number) => void;
}): React.JSX.Element {
  const cage = project.runtime.semanticCage;
  const meshTriangles = selectedLayer?.mesh.triangles ?? [];
  const neutralMeshPoints = selectedLayer?.mesh.points ?? [];
  const [animatedMesh, setAnimatedMesh] = useState<{ layerId: string; points: Point[] }>();
  const [hoveredMeshVertex, setHoveredMeshVertex] = useState<number>();
  useEffect(() => {
    if (!animateMesh || !selectedLayer) {
      setAnimatedMesh(undefined);
      return;
    }
    let animationFrame = 0;
    let previousUpdate = 0;
    const layerId = selectedLayer.id;
    const update = (now: number) => {
      if (now - previousUpdate >= 1000 / 30) {
        const points = liveMeshPoints();
        if (points) setAnimatedMesh({ layerId, points });
        previousUpdate = now;
      }
      animationFrame = requestAnimationFrame(update);
    };
    animationFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrame);
  }, [animateMesh, liveMeshPoints, selectedLayer?.id]);
  const meshPoints = animateMesh && animatedMesh && animatedMesh.layerId === selectedLayer?.id ? animatedMesh.points : posedMeshPoints;
  const clearMeshSelection = useCallback(() => {
    if (mode === "mesh" && selectedVertices.length > 0) onSelectMeshVertices([], "replace");
  }, [mode, onSelectMeshVertices, selectedVertices.length]);
  const navigation = useViewportNavigation(project.canvas.width / project.canvas.height, clearMeshSelection);
  const meshSelectionGesture = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    start: Point;
    end: Point;
    moved: boolean;
  } | undefined>(undefined);
  const [meshSelectionBox, setMeshSelectionBox] = useState<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    start: Point;
    end: Point;
    moved: boolean;
  }>();
  const screenPixel = 1 / Math.max(1, Math.sqrt(navigation.stageSize.width * navigation.stageSize.height) * navigation.transform.zoom);
  const meshVertexRadius = screenPixel * (meshPoints.length > 300 ? 1.15 : meshPoints.length > 120 ? 1.35 : 1.55);
  // Keep the visible point Cubism-thin while retaining a practical 13 px hit
  // target. A larger target makes neighbouring vertices overlap and steals
  // ordinary canvas-pan gestures in dense meshes.
  const meshHitRadius = screenPixel * 6.5;
  const selectedSet = new Set(selectedVertices);
  const selectedMeshBounds = selectedVertices.length > 1 ? (() => {
    const points = selectedVertices.map((index) => meshPoints[index]).filter((point): point is Point => Boolean(point));
    if (points.length < 2) return undefined;
    const padding = screenPixel * 4;
    const left = Math.max(0, Math.min(...points.map((point) => point.x)) - padding);
    const top = Math.max(0, Math.min(...points.map((point) => point.y)) - padding);
    const right = Math.min(1, Math.max(...points.map((point) => point.x)) + padding);
    const bottom = Math.min(1, Math.max(...points.map((point) => point.y)) + padding);
    return { x: left, y: top, width: right - left, height: bottom - top };
  })() : undefined;
  const locked = selectedLayer?.locked === true;
  const meshViewportRect = (): DOMRect | undefined => navigation.stageRef.current?.querySelector<SVGSVGElement>(".editor-overlay")?.getBoundingClientRect()
    ?? navigation.stageRef.current?.getBoundingClientRect();
  const normalizedMeshPoint = (clientX: number, clientY: number): Point | undefined => {
    const rect = meshViewportRect();
    if (!rect) return undefined;
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)))
    };
  };
  const nearestMeshVertexAt = (clientX: number, clientY: number, maximumPixels = 7): number | undefined => {
    const rect = meshViewportRect();
    if (!rect || meshPoints.length === 0) return undefined;
    let nearest: number | undefined;
    let nearestDistance = maximumPixels;
    meshPoints.forEach((point, index) => {
      const distance = Math.hypot(
        clientX - (rect.left + point.x * rect.width),
        clientY - (rect.top + point.y * rect.height)
      );
      if (distance >= nearestDistance) return;
      nearest = index;
      nearestDistance = distance;
    });
    return nearest;
  };
  const nearestMeshVertex = (event: React.PointerEvent<SVGElement>, maximumPixels = 7): number | undefined => nearestMeshVertexAt(event.clientX, event.clientY, maximumPixels);
  const moveOverlayPointer = (event: React.PointerEvent<SVGSVGElement>): void => {
    onMoveDrag(event);
    if (mode === "mesh" && !locked && !animateMesh) setHoveredMeshVertex(nearestMeshVertex(event));
  };
  const beginViewportPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const viewportControl = event.target instanceof Element && Boolean(event.target.closest(".viewport-navigation"));
    if (event.button === 0 && event.shiftKey && mode === "mesh" && selectedLayer && !animateMesh && !viewportControl) {
      const start = normalizedMeshPoint(event.clientX, event.clientY);
      if (!start) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      const gesture = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        start,
        end: start,
        moved: false
      };
      meshSelectionGesture.current = gesture;
      setMeshSelectionBox(gesture);
      return;
    }
    navigation.viewportHandlers.onPointerDownCapture(event);
  };
  const moveViewportPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const gesture = meshSelectionGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      navigation.viewportHandlers.onPointerMoveCapture(event);
      return;
    }
    const end = normalizedMeshPoint(event.clientX, event.clientY);
    if (!end) return;
    event.preventDefault();
    event.stopPropagation();
    const next = {
      ...gesture,
      end,
      moved: gesture.moved || Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) >= 4
    };
    meshSelectionGesture.current = next;
    setMeshSelectionBox(next);
  };
  const finishViewportPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const gesture = meshSelectionGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      navigation.viewportHandlers.onPointerUpCapture(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const end = normalizedMeshPoint(event.clientX, event.clientY) ?? gesture.end;
    const moved = gesture.moved || Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) >= 4;
    meshSelectionGesture.current = undefined;
    setMeshSelectionBox(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (moved) {
      const left = Math.min(gesture.start.x, end.x);
      const right = Math.max(gesture.start.x, end.x);
      const top = Math.min(gesture.start.y, end.y);
      const bottom = Math.max(gesture.start.y, end.y);
      const enclosed = meshPoints.flatMap((point, index) => point.x >= left && point.x <= right && point.y >= top && point.y <= bottom ? [index] : []);
      onSelectMeshVertices(enclosed, "add");
    } else {
      const nearest = nearestMeshVertexAt(event.clientX, event.clientY);
      if (nearest !== undefined) onSelectMeshVertices([nearest], "toggle");
    }
  };
  const cancelViewportPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (meshSelectionGesture.current?.pointerId !== event.pointerId) {
      navigation.viewportHandlers.onPointerCancelCapture(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    meshSelectionGesture.current = undefined;
    setMeshSelectionBox(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const loseViewportPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (meshSelectionGesture.current?.pointerId === event.pointerId) {
      meshSelectionGesture.current = undefined;
      setMeshSelectionBox(undefined);
      return;
    }
    navigation.viewportHandlers.onLostPointerCapture(event);
  };
  return (
    <section className="viewport-panel">
      <div
        ref={navigation.viewportRef}
        className={`editor-viewport ${cleanPreview ? "clean-preview" : ""} ${navigation.panning ? "is-panning" : ""} ${navigation.spacePressed ? "is-space-ready" : ""} ${meshSelectionBox ? "is-box-selecting" : ""}`}
        data-testid="editor-viewport"
        tabIndex={0}
        aria-label="角色编辑视图"
        {...navigation.viewportHandlers}
        onPointerDownCapture={beginViewportPointer}
        onPointerMoveCapture={moveViewportPointer}
        onPointerUpCapture={finishViewportPointer}
        onPointerCancelCapture={cancelViewportPointer}
        onLostPointerCapture={loseViewportPointer}
      >
        <div
          ref={navigation.stageRef}
          className="editor-stage"
          data-testid="editor-stage"
          style={{
            width: `${navigation.stageSize.width}px`,
            height: `${navigation.stageSize.height}px`,
            aspectRatio: `${project.canvas.width} / ${project.canvas.height}`,
            transform: `translate3d(${navigation.transform.x}px, ${navigation.transform.y}px, 0) scale(${navigation.transform.zoom})`
          }}
        >
          <canvas ref={canvas} className="editor-canvas" />
          {showOverlay && <svg className="editor-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" onPointerMove={moveOverlayPointer} onPointerLeave={() => setHoveredMeshVertex(undefined)} onPointerUp={onEndDrag} onPointerCancel={onCancelDrag}>
          {mode === "semantic" && cage && <>
            {[...cage.faceTriangles, ...cage.skullTriangles].flatMap((triangle, triangleIndex) => triangle.map((id, index) => {
              const nextId = triangle[(index + 1) % 3]!; const a = cage.points[id].position; const b = cage.points[nextId].position;
              return <line key={`${triangleIndex}-${id}-${nextId}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="cage-line" />;
            }))}
            {Object.entries(cage.points).map(([id, entry]) => <g key={id}>
              <circle cx={entry.position.x} cy={entry.position.y} r="0.011" className="handle-hit" tabIndex={0} role="slider" aria-label={`脸部控制点 ${id}`} aria-valuetext={`${entry.position.x.toFixed(3)}, ${entry.position.y.toFixed(3)}`} onKeyDown={(event) => onNudge(event, { kind: "semantic", key: id as SemanticCagePointId })} onPointerDown={(event) => onBeginDrag(event, { kind: "semantic", key: id as SemanticCagePointId })}><title>{id}</title></circle>
              <circle cx={entry.position.x} cy={entry.position.y} r="0.0025" className="handle semantic-handle handle-visible" aria-hidden="true" />
            </g>)}
          </>}
          {mode === "anchors" && Object.entries(project.anchors).map(([id, point]) => point && <g key={id}>
            <circle cx={point.x} cy={point.y} r="0.009" className="handle anchor-handle" tabIndex={0} role="slider" aria-label={`身体锚点 ${id}`} aria-valuetext={`${point.x.toFixed(3)}, ${point.y.toFixed(3)}`} onKeyDown={(event) => onNudge(event, { kind: "anchor", key: id as keyof AnchorGraph })} onPointerDown={(event) => onBeginDrag(event, { kind: "anchor", key: id as keyof AnchorGraph })} />
            <text x={point.x + 0.01} y={point.y - 0.009}>{id}</text>
          </g>)}
          {mode === "layer" && selectedLayer && <>
            <circle cx={selectedLayer.pivot.x} cy={selectedLayer.pivot.y} r="0.011" className={`handle pivot-handle ${locked ? "locked" : ""}`} tabIndex={locked ? -1 : 0} role="slider" aria-label={`${selectedLayer.sourceName} 轴心`} aria-valuetext={`${selectedLayer.pivot.x.toFixed(3)}, ${selectedLayer.pivot.y.toFixed(3)}`} onKeyDown={(event) => onNudge(event, { kind: "pivot" })} onPointerDown={(event) => onBeginDrag(event, { kind: "pivot" })} />
            <text x={selectedLayer.pivot.x + 0.012} y={selectedLayer.pivot.y - 0.01}>pivot</text>
            {selectedLayer.hairStrands?.map((strand, index) => <g key={strand.id} className="hair-strand-guide">
              <line x1={strand.root.x} y1={strand.root.y} x2={strand.tip.x} y2={strand.tip.y} className="hair-strand-line" />
              <circle cx={strand.root.x} cy={strand.root.y} r="0.004" className="hair-strand-root" />
              <circle cx={strand.tip.x} cy={strand.tip.y} r="0.004" className="hair-strand-tip" />
              <text x={strand.tip.x + 0.006} y={strand.tip.y}>{index + 1}</text>
            </g>)}
            {Object.entries(selectedLayer.secondaryAnchors ?? {}).map(([id, point]) => point && <g key={id}>
              <circle cx={point.x} cy={point.y} r="0.009" className={`handle secondary-handle ${locked ? "locked" : ""}`} tabIndex={locked ? -1 : 0} role="slider" aria-label={`${selectedLayer.sourceName} 次级锚点 ${id}`} aria-valuetext={`${point.x.toFixed(3)}, ${point.y.toFixed(3)}`} onKeyDown={(event) => onNudge(event, { kind: "secondary", key: id as keyof NonNullable<LayerBinding["secondaryAnchors"]> })} onPointerDown={(event) => onBeginDrag(event, { kind: "secondary", key: id as keyof NonNullable<LayerBinding["secondaryAnchors"]> })} />
              <text x={point.x + 0.01} y={point.y - 0.009}>{id}</text>
            </g>)}
          </>}
          {mode === "mesh" && selectedLayer && <>
            {showNeutralMeshReference && <path d={meshEdgePath(neutralMeshPoints, meshTriangles)} className="mesh-line mesh-neutral-reference" />}
            <path d={meshEdgePath(meshPoints, meshTriangles)} className="mesh-line mesh-deformed" />
            {softSelectionEnabled && selectedVertex !== undefined && meshPoints[selectedVertex] && <circle cx={meshPoints[selectedVertex]!.x} cy={meshPoints[selectedVertex]!.y} r={softRadius} className="soft-radius" />}
            {meshPoints.map((point, index) => <g key={index} className="mesh-vertex-target">
              <circle cx={point.x} cy={point.y} r={meshHitRadius} className="handle-hit mesh-handle-hit" tabIndex={locked || animateMesh ? -1 : 0} role="slider" aria-disabled={locked || animateMesh} aria-label={`${selectedLayer.sourceName} 网格顶点 ${index}；按住 Shift 可多选`} aria-valuetext={`${point.x.toFixed(3)}, ${point.y.toFixed(3)}`} onKeyDown={locked || animateMesh ? undefined : (event) => onNudge(event, { kind: "mesh", index })} onPointerDown={locked || animateMesh ? undefined : (event) => {
                const nearest = nearestMeshVertex(event);
                if (nearest !== undefined) onBeginDrag(event, { kind: "mesh", index: nearest });
              }} />
              <circle cx={point.x} cy={point.y} r={meshVertexRadius} className={`handle handle-visible mesh-handle ${selectedSet.has(index) ? "selected" : ""} ${hoveredMeshVertex === index ? "hovered" : ""} ${locked || animateMesh ? "locked" : ""}`} aria-hidden="true" />
            </g>)}
            {selectedMeshBounds && !locked && !animateMesh && <rect
              {...selectedMeshBounds}
              className="handle-hit mesh-selection-move-area"
              aria-label={`移动已选择的 ${selectedVertices.length} 个网格顶点`}
              onPointerDown={(event) => onBeginDrag(event, { kind: "mesh-move" })}
            />}
            {meshSelectionBox?.moved && <rect
              x={Math.min(meshSelectionBox.start.x, meshSelectionBox.end.x)}
              y={Math.min(meshSelectionBox.start.y, meshSelectionBox.end.y)}
              width={Math.abs(meshSelectionBox.end.x - meshSelectionBox.start.x)}
              height={Math.abs(meshSelectionBox.end.y - meshSelectionBox.start.y)}
              className="mesh-selection-box"
              aria-hidden="true"
            />}
          </>}
          </svg>}
        </div>
        <div className="viewport-navigation" aria-label="视图缩放控制">
          <button className="icon-only" aria-label="缩小视图" title="缩小（-）" onClick={navigation.zoomOut}><ZoomOut aria-hidden="true" /></button>
          <output aria-label="当前缩放比例">{navigation.zoomPercent}%</output>
          <button className="icon-only" aria-label="放大视图" title="放大（+）" onClick={navigation.zoomIn}><ZoomIn aria-hidden="true" /></button>
          <button className="fit-view icon-only" aria-label="适配" onClick={navigation.fit} title="适配窗口（0）"><Scan aria-hidden="true" /></button>
        </div>
      </div>
      <p className="viewport-help">{cleanPreview ? "当前隐藏所有编辑标记。滚轮缩放，拖动空白处移动视图，双击恢复适配。" : mode === "mesh" ? selectedVertices.length > 1 ? `已选择 ${selectedVertices.length} 个点；拖动任意一个黄色节点即可整体移动。单击空白取消选择，Shift+拖动框选更多节点，Shift+单击可增减单点。` : "鼠标靠近节点会自动高亮，按下即可直接拖动。单击空白取消选择；按住 Shift 拖动可框选，Shift+单击可增减单点。" : "滚轮会以鼠标位置为中心缩放；拖动空白处、按住空格拖动或使用鼠标中键可移动视图；双击空白处恢复适配。拖动控制点仍会直接校准。"}</p>

      {comparison && <section className="evidence-preview" data-testid="comparison-view">
        <div className="comparison-header"><h3>revision {comparison.result.fromRevision} → {comparison.result.toRevision}</h3><div className="comparison-tabs">{(["before", "after", "split", "overlay", "difference"] as ComparisonMode[]).map((item) => <button key={item} className={comparisonMode === item ? "active" : ""} onClick={() => onComparisonMode(item)}>{item === "before" ? "修改前" : item === "after" ? "修改后" : item === "split" ? "分割" : item === "overlay" ? "叠加" : "差异"}</button>)}</div></div>
        {comparisonMode === "split" && <label className="split-control">分割位置 <input type="range" min="0" max="100" value={splitPercent} onChange={(event) => onSplitPercent(Number(event.target.value))} /></label>}
        <div className={`comparison-canvas ${comparisonMode}`}>
          {comparisonMode === "before" && <img src={comparison.before} alt="校准修改前" />}
          {comparisonMode === "after" && <img src={comparison.after} alt="校准修改后" />}
          {comparisonMode === "difference" && <img src={comparison.difference} alt="校准差异" />}
          {comparisonMode === "overlay" && <><img src={comparison.before} alt="校准修改前" /><img className="comparison-overlay-image" src={comparison.after} alt="校准修改后叠加" /></>}
          {comparisonMode === "split" && <><img src={comparison.before} alt="校准修改前" /><img className="comparison-split-image" style={{ clipPath: `inset(0 ${100 - splitPercent}% 0 0)` }} src={comparison.after} alt="校准修改后分割" /><span className="split-line" style={{ left: `${splitPercent}%` }} /></>}
        </div>
      </section>}
    </section>
  );
}

export function EditorInspectorPanel({
  project,
  selectedLayer,
  selectedVertex,
  softSelectionEnabled,
  softRadius,
  secondaryPart,
  selectedTuning,
  label,
  hasPending,
  busy,
  notice,
  error,
  sessions,
  comparison,
  meshUpgrading,
  onLayerProperty,
  onMoveLayer,
  onSoftSelectionEnabled,
  onSoftRadius,
  onVertexInfluence,
  onResetLayer,
  onUpgradeMesh,
  onRuntimeTuning,
  onSecondaryPart,
  onSecondaryTuning,
  onFaceDepth,
  onTorsoVolume,
  onLabel,
  onSave,
  onDiscard,
  onShowEvidence,
  onRestore,
  onMarkEvidence
}: {
  project: PuppetLoomProject;
  selectedLayer: LayerBinding | undefined;
  selectedVertex: number | undefined;
  softSelectionEnabled: boolean;
  softRadius: number;
  secondaryPart: SecondaryMotionPart;
  selectedTuning: { amplitude: number; response: number; stability: number };
  label: string;
  hasPending: boolean;
  busy: boolean;
  notice: string;
  error: string;
  sessions: CalibrationSessionDocument[];
  comparison: ComparisonImages | undefined;
  meshUpgrading: boolean;
  onLayerProperty: (patch: LayerPatch) => void;
  onMoveLayer: (direction: -1 | 1) => void;
  onSoftSelectionEnabled: (enabled: boolean) => void;
  onSoftRadius: (radius: number) => void;
  onVertexInfluence: (channel: VertexChannel, value: number) => void;
  onResetLayer: () => void;
  onUpgradeMesh: () => void;
  onRuntimeTuning: (kind: "motionTuning" | "envelope", key: string, value: number) => void;
  onSecondaryPart: (part: SecondaryMotionPart) => void;
  onSecondaryTuning: (part: SecondaryMotionPart, key: "amplitude" | "response" | "stability", value: number) => void;
  onFaceDepth: (landmark: FaceDepthLandmark, depth: number) => void;
  onTorsoVolume: (landmark: TorsoVolumeLandmark | "strength", value: number) => void;
  onLabel: (label: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onShowEvidence: (sessionId: string) => void;
  onRestore: (revision: number, label: string) => void;
  onMarkEvidence: (sessionId: string, status: "accepted" | "rejected") => void;
}): React.JSX.Element {
  const [inspectorTab, setInspectorTab] = useState<"layer" | "motion" | "history">("layer");
  const locked = selectedLayer?.locked === true;
  const meshPoints = selectedLayer?.mesh.points ?? [];
  const meshQuality = selectedLayer ? artMeshQuality(selectedLayer) : undefined;
  const layerMap = new Map(project.layers.map((layer) => [layer.id, layer]));
  return (
    <aside className="inspector-panel">
      <div className="layer-panel-heading"><div><div className="panel-eyebrow">INSPECTOR</div><h2>属性</h2></div></div>
      <div className="inspector-tabs"><button className={inspectorTab === "layer" ? "active" : ""} onClick={() => setInspectorTab("layer")}>图层</button><button className={inspectorTab === "motion" ? "active" : ""} onClick={() => setInspectorTab("motion")}>动作</button><button className={inspectorTab === "history" ? "active" : ""} onClick={() => setInspectorTab("history")}>版本</button></div>
      <div hidden={inspectorTab !== "layer"}>
      {selectedLayer ? <>
        <dl>
          <dt>图层</dt><dd>{selectedLayer.sourceName}</dd>
          <dt>网格</dt><dd>{selectedLayer.mesh.topology === "art" ? "Alpha ArtMesh" : `${selectedLayer.mesh.rows} × ${selectedLayer.mesh.cols} 规则网格`}</dd>
          <dt>顶点 / 三角形</dt><dd>{selectedLayer.mesh.points.length} / {Math.floor(selectedLayer.mesh.triangles.length / 3)}</dd>
          {selectedLayer.hairStrands && <><dt>头发房束</dt><dd>{selectedLayer.hairStrands.length} 条 · 平均置信度 {(selectedLayer.hairStrands.reduce((sum, strand) => sum + strand.confidence, 0) / selectedLayer.hairStrands.length).toFixed(2)}</dd></>}
          {meshQuality && <><dt>网格质量</dt><dd className={meshQuality.balanced ? "mesh-quality-good" : "mesh-quality-warning"}>{meshQuality.label}</dd></>}
        </dl>
        <label className="check-row"><input type="checkbox" checked={selectedLayer.visible !== false} onChange={(event) => onLayerProperty({ visible: event.target.checked })} />参与渲染</label>
        <label className="check-row"><input type="checkbox" checked={locked} onChange={(event) => onLayerProperty({ locked: event.target.checked })} />锁定编辑</label>
        <label>语义<select disabled={locked} value={selectedLayer.role} onChange={(event) => onLayerProperty({ role: event.target.value as SemanticRole })}>{semanticRoles.map((role) => <option key={role}>{role}</option>)}</select></label>
        <label>侧别<select disabled={locked} value={selectedLayer.side} onChange={(event) => onLayerProperty({ side: event.target.value as Side })}><option value="left">角色左侧</option><option value="right">角色右侧</option><option value="center">中间 / 整体</option></select></label>
        <label>运动归属<select disabled={locked} value={selectedLayer.parentGroup} onChange={(event) => onLayerProperty({ parentGroup: event.target.value as LayerBinding["parentGroup"] })}><option value="head">头部</option><option value="body">身体</option><option value="root">根节点</option></select></label>
        <label>父图层<select disabled={locked} value={selectedLayer.parentLayerId ?? ""} onChange={(event) => onLayerProperty({ parentLayerId: event.target.value || null })}><option value="">无父图层</option>{project.layers.filter((layer) => canUseAsParent(selectedLayer.id, layer, layerMap)).map((layer) => <option key={layer.id} value={layer.id}>{layer.sourceName}</option>)}</select></label>
        <div className="order-row"><span>绘制顺序 #{selectedLayer.order}</span><button className="icon-only" aria-label="向后移动一层" title="向后移动一层" disabled={locked} onClick={() => onMoveLayer(-1)}><ArrowDown aria-hidden="true" /></button><button className="icon-only" aria-label="向前移动一层" title="向前移动一层" disabled={locked} onClick={() => onMoveLayer(1)}><ArrowUp aria-hidden="true" /></button></div>
        {(["head", "body", "gaze", "physics"] as const).map((key) => <label className="range-row" key={key}><span>{key} {selectedLayer.weights[key].toFixed(2)}</span><input disabled={locked} type="range" min="0" max="1" step="0.01" value={selectedLayer.weights[key]} onChange={(event) => onLayerProperty({ weights: { [key]: Number(event.target.value) } })} /></label>)}

        <section className="mesh-density">
          <h3>网格密度</h3>
          {selectedLayer.mesh.topology === "art" && selectedLayer.mesh.art ? <>
            <label>细节尺度（纹理像素）<input disabled={locked} type="number" min="4" max="256" value={selectedLayer.mesh.art.detail} onChange={(event) => onLayerProperty({ meshDetail: Math.max(4, Math.min(256, Math.round(Number(event.target.value) || 4))) })} /></label>
            <small>{selectedLayer.mesh.art.regions.length} 个独立区域，{selectedLayer.mesh.art.regions.reduce((count, region) => count + region.holes.length, 0)} 个孔洞。数值越小，轮廓和内部网格越密。</small>
            <button disabled={locked || busy || meshUpgrading} onClick={onUpgradeMesh}>{meshUpgrading ? "正在重新计算轮廓与三角形…" : "按当前细节重新生成网格"}</button>
          </> : selectedLayer.mesh.rows !== undefined && selectedLayer.mesh.cols !== undefined ? <>
            <div><label>行<input disabled={locked} type="number" min="2" max="64" value={selectedLayer.mesh.rows} onChange={(event) => onLayerProperty({ meshDensity: { rows: Math.max(2, Math.min(64, Math.round(Number(event.target.value) || 2))), cols: selectedLayer.mesh.cols! } })} /></label><label>列<input disabled={locked} type="number" min="2" max="64" value={selectedLayer.mesh.cols} onChange={(event) => onLayerProperty({ meshDensity: { rows: selectedLayer.mesh.rows!, cols: Math.max(2, Math.min(64, Math.round(Number(event.target.value) || 2))) } })} /></label></div>
            <small>规则网格仅用于完全不透明的矩形图层和旧项目兼容。</small>
            <button disabled={locked || busy || meshUpgrading} onClick={onUpgradeMesh}>{meshUpgrading ? "正在读取当前纹理轮廓…" : "将当前图层升级为轮廓 ArtMesh"}</button>
          </> : <small>当前网格缺少可重建信息。</small>}
          <small>每次只重建当前图层并重新投影权重；保存前请检查中立、左右、上下和对角姿态。</small>
        </section>

        {selectedVertex !== undefined && <section className="vertex-inspector">
          <h3>顶点 {selectedVertex}</h3><p>x {meshPoints[selectedVertex]?.x.toFixed(5)} · y {meshPoints[selectedVertex]?.y.toFixed(5)}</p>
          <label className="check-row"><input type="checkbox" checked={softSelectionEnabled} onChange={(event) => onSoftSelectionEnabled(event.target.checked)} />带动相邻顶点（软选择）</label>
          <label className="range-row"><span>影响半径 {softRadius.toFixed(3)}</span><input disabled={!softSelectionEnabled} type="range" min="0.005" max="0.2" step="0.005" value={softRadius} onChange={(event) => onSoftRadius(Number(event.target.value))} /></label>
          {(["face", "skull", "head", "body", "gaze", "physics", "pin", "headAttachment", "physicsRelease"] as const).map((channel) => {
            const fallback = channel === "pin" || channel === "physicsRelease" ? 0 : 1;
            const influenceChannels = selectedLayer.mesh.influences as Record<string, number[] | undefined> | undefined;
            const value = influenceChannels?.[channel]?.[selectedVertex] ?? fallback;
            const channelLabel = channel === "pin" ? "固定强度"
              : channel === "headAttachment" ? "头皮吸附"
                : channel === "physicsRelease" ? "物理释放"
                  : channel === "face" ? "脸部控制笼"
                    : channel === "skull" ? "头骨控制笼"
                      : channel === "physics" ? "次级运动"
                        : `${channel} 顶点权重`;
            return <label className="range-row" key={channel}><span>{channelLabel} {value.toFixed(2)}</span><input disabled={locked} type="range" min="0" max="1" step="0.05" value={value} onChange={(event) => onVertexInfluence(channel, Number(event.target.value))} /></label>;
          })}
        </section>}
        <button className="with-icon" onClick={onResetLayer} disabled={busy}><RotateCcw aria-hidden="true" />只恢复这个图层</button>
      </> : <p>从左侧选择图层。</p>}
      </div>

      <div hidden={inspectorTab !== "motion"}>
      <section className="authoring-summary">
        <h3>绑定系统</h3>
        <div className="authoring-counts">
          <span><strong>{project.model.parameters.length}</strong> 参数</span>
          <span><strong>{project.model.bindings.length}</strong> 绑定</span>
          <span><strong>{project.model.deformers.length}</strong> 变形器</span>
          <span><strong>{project.model.expressions.length}</strong> 表情</span>
          <span><strong>{project.model.physics.length}</strong> 物理</span>
          <span><strong>{project.model.behaviors.length}</strong> 行为</span>
        </div>
        {selectedLayer?.deformerId && <p>当前图层挂接：<code>{selectedLayer.deformerId}</code></p>}
        <details>
          <summary>参数与语义</summary>
          <ul>{project.model.parameters.map((parameter) => <li key={parameter.id}><code>{parameter.id}</code><span>{parameter.min} · {parameter.default} · {parameter.max}{parameter.semantic ? ` · ${parameter.semantic}` : ""}</span></li>)}</ul>
        </details>
        {project.model.expressions.length > 0 && <details><summary>表情</summary><ul>{project.model.expressions.map((expression) => <li key={expression.id}><code>{expression.id}</code><span>{Object.keys(expression.parameters).length} 个参数</span></li>)}</ul></details>}
        {project.model.behaviors.length > 0 && <details><summary>行为</summary><ul>{project.model.behaviors.map((behavior) => <li key={behavior.id}><code>{behavior.id}</code><span>{behavior.duration}s · {behavior.loop ? "循环" : "单次"}{behavior.autoplay ? " · 自动" : ""}</span></li>)}</ul></details>}
        <small>结构修改由 <code>puppetloom author</code> 事务完成；这里用于核对 AI 写入结果和图层挂接。</small>
      </section>

      <section className="save-panel">
        <h3>整体动作</h3>
        {(["amplitude", "response", "stability"] as const).map((key) => { const value = project.runtime.motionTuning?.[key] ?? ({ amplitude: 1, response: 0.72, stability: 0.42 }[key]); return <label className="range-row" key={key}><span>{key} {value.toFixed(2)}</span><input type="range" min="0" max={key === "amplitude" ? "1.5" : "1"} step="0.01" value={value} onChange={(event) => onRuntimeTuning("motionTuning", key, Number(event.target.value))} /></label>; })}
        {(["headYaw", "headPitch", "breath"] as const).map((key) => { const value = project.runtime.envelope[key]; const maximum = key === "breath" ? 0.08 : 1; return <label className="range-row" key={key}><span>{key} {value.toFixed(3)}</span><input type="range" min="0" max={maximum} step={key === "breath" ? "0.001" : "0.01"} value={value} onChange={(event) => onRuntimeTuning("envelope", key, Number(event.target.value))} /></label>; })}

        {project.runtime.poseField?.faceDepthProfile && <>
          <h3>侧脸深度</h3>
          <small>按额头、鼻根、鼻尖、上下唇和下巴控制转头时的前后层次；正面中立状态不受影响。</small>
          {project.runtime.poseField.faceDepthProfile.points.map((point) => <label className="range-row" key={point.id}><span>{point.id} {point.depth.toFixed(3)}</span><input type="range" min="-0.2" max="0.35" step="0.005" value={point.depth} onChange={(event) => onFaceDepth(point.id, Number(event.target.value))} /></label>)}
        </>}

        <h3>躯干体积（可选）</h3>
        <label className="range-row"><span>作用强度 {(project.runtime.torsoVolumeProfile?.strength ?? 0).toFixed(2)}</span><input type="range" min="0" max="2" step="0.05" value={project.runtime.torsoVolumeProfile?.strength ?? 0} onChange={(event) => onTorsoVolume("strength", Number(event.target.value))} /></label>
        {project.runtime.torsoVolumeProfile?.points.map((point) => <label className="range-row" key={point.id}><span>{point.id} {point.depth.toFixed(3)}</span><input type="range" min="-0.3" max="0.3" step="0.005" value={point.depth} onChange={(event) => onTorsoVolume(point.id, Number(event.target.value))} /></label>)}

        <h3>分部响应</h3>
        <label>部件<select value={secondaryPart} onChange={(event) => onSecondaryPart(event.target.value as SecondaryMotionPart)}>{secondaryParts.map((part) => <option key={part.id} value={part.id}>{part.label}</option>)}</select></label>
        {(["amplitude", "response", "stability"] as const).map((key) => <label className="range-row" key={key}><span>{key} {selectedTuning[key].toFixed(2)}</span><input data-testid={`secondary-${key}`} type="range" min="0" max={key === "amplitude" ? "1.5" : "1"} step="0.01" value={selectedTuning[key]} onChange={(event) => onSecondaryTuning(secondaryPart, key, Number(event.target.value))} /></label>)}

        <label>校准说明<input value={label} onChange={(event) => onLabel(event.target.value)} placeholder="例如：固定耳根并调整右眼外角" /></label>
        <button className="primary with-icon" disabled={!hasPending || busy} onClick={onSave}><Save aria-hidden="true" />{busy ? "正在验证并生成证据…" : "保存校准"}</button>
        <button className="with-icon" disabled={!hasPending || busy} onClick={onDiscard}><Trash2 aria-hidden="true" />放弃当前草稿</button>
        {notice && <p className="success">{notice}</p>}{error && <p className="error">{error}</p>}
      </section>
      </div>

      <div hidden={inspectorTab !== "history"}>
      <section className="session-panel">
        <h3>校准历史</h3>{sessions.length === 0 && <p>还没有保存过校准。</p>}
        {sessions.slice(0, 12).map((session) => <article key={session.id} className={comparison?.result.toRevision === session.toRevision ? "active" : ""}>
          <strong>r{session.toRevision} · {session.label}</strong><small>{session.evidenceStatus}</small>
          <div><button className="with-icon" onClick={() => onShowEvidence(session.id)}><Eye aria-hidden="true" />查看对比</button><button className="with-icon" onClick={() => onRestore(session.toRevision, `恢复到 ${session.label}`)}><RotateCcw aria-hidden="true" />恢复</button><button className="with-icon" onClick={() => onMarkEvidence(session.id, "accepted")}><Check aria-hidden="true" />确认</button><button className="with-icon" onClick={() => onMarkEvidence(session.id, "rejected")}><Ban aria-hidden="true" />无效</button></div>
        </article>)}
      </section>
      </div>
    </aside>
  );
}
