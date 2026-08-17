import { useState } from "react";
import type React from "react";
import type {
  AnchorGraph,
  CalibrationOverrides,
  CalibrationSessionDocument,
  LayerBinding,
  PuppetLoomProject,
  RevisionComparisonResult,
  SecondaryMotionPart,
  SemanticCagePointId,
  SemanticRole,
  Side
} from "@puppetloom/core";
import { useViewportNavigation } from "./useViewportNavigation.js";

export type EditMode = "semantic" | "anchors" | "layer" | "mesh";
export type ComparisonMode = "before" | "after" | "split" | "overlay" | "difference";
export type DragTarget =
  | { kind: "semantic"; key: SemanticCagePointId }
  | { kind: "anchor"; key: keyof AnchorGraph }
  | { kind: "pivot" }
  | { kind: "secondary"; key: keyof NonNullable<LayerBinding["secondaryAnchors"]> }
  | { kind: "mesh"; index: number };

export interface ComparisonImages {
  result: RevisionComparisonResult;
  before: string;
  after: string;
  difference: string;
}

type LayerPatch = NonNullable<CalibrationOverrides["layers"]>[string];
type VertexChannel = "face" | "skull" | "head" | "body" | "gaze" | "physics" | "pin";

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
  onPatchLayer
}: {
  project: PuppetLoomProject;
  selectedLayerId: string;
  onSelect: (layerId: string) => void;
  onPatchLayer: (layerId: string, patch: LayerPatch) => void;
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
          <div key={layer.id} className={`layer-row ${selectedLayerId === layer.id ? "selected" : ""} ${layer.visible === false ? "hidden" : ""}`} style={{ paddingLeft: `${8 + layerDepth(layer, byId) * 16}px` }}>
            <button className="layer-select" onClick={() => onSelect(layer.id)}>
              <span>{layer.sourceName}</span><small>{layer.role} · {layer.side} · #{layer.order}{layer.deformerId ? ` · ${layer.deformerId}` : ""}</small>
            </button>
            <button className="layer-icon" title={layer.visible === false ? "显示图层" : "隐藏图层"} aria-label={`${layer.sourceName} ${layer.visible === false ? "显示" : "隐藏"}`} onClick={() => onPatchLayer(layer.id, { visible: layer.visible === false })}>{layer.visible === false ? "隐" : "显"}</button>
            <button className="layer-icon" title={layer.locked ? "解锁图层" : "锁定图层"} aria-label={`${layer.sourceName} ${layer.locked ? "解锁" : "锁定"}`} onClick={() => onPatchLayer(layer.id, { locked: !layer.locked })}>{layer.locked ? "锁" : "编"}</button>
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
  cleanPreview,
  selectedLayer,
  selectedVertex,
  softRadius,
  comparison,
  comparisonMode,
  splitPercent,
  onBeginDrag,
  onMoveDrag,
  onEndDrag,
  onNudge,
  onSelectVertex,
  onComparisonMode,
  onSplitPercent
}: {
  canvas: React.RefObject<HTMLCanvasElement | null>;
  project: PuppetLoomProject;
  mode: EditMode;
  showOverlay: boolean;
  cleanPreview: boolean;
  selectedLayer: LayerBinding | undefined;
  selectedVertex: number | undefined;
  softRadius: number;
  comparison: ComparisonImages | undefined;
  comparisonMode: ComparisonMode;
  splitPercent: number;
  onBeginDrag: (event: React.PointerEvent<SVGCircleElement>, target: DragTarget) => void;
  onMoveDrag: (event: React.PointerEvent<SVGSVGElement>) => void;
  onEndDrag: () => void;
  onNudge: (event: React.KeyboardEvent<SVGCircleElement>, target: DragTarget) => void;
  onSelectVertex: (index: number) => void;
  onComparisonMode: (mode: ComparisonMode) => void;
  onSplitPercent: (percent: number) => void;
}): React.JSX.Element {
  const cage = project.runtime.semanticCage;
  const meshTriangles = selectedLayer?.mesh.triangles ?? [];
  const meshPoints = selectedLayer?.mesh.points ?? [];
  const meshVertexRadius = meshPoints.length > 300 ? 0.002 : meshPoints.length > 120 ? 0.0028 : 0.0045;
  const locked = selectedLayer?.locked === true;
  const navigation = useViewportNavigation(project.canvas.width / project.canvas.height);
  return (
    <section className="viewport-panel">
      <div
        ref={navigation.viewportRef}
        className={`editor-viewport ${cleanPreview ? "clean-preview" : ""} ${navigation.panning ? "is-panning" : ""} ${navigation.spacePressed ? "is-space-ready" : ""}`}
        data-testid="editor-viewport"
        tabIndex={0}
        aria-label="角色编辑视图"
        {...navigation.viewportHandlers}
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
          {showOverlay && <svg className="editor-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" onPointerMove={onMoveDrag} onPointerUp={onEndDrag} onPointerCancel={onEndDrag}>
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
            {Object.entries(selectedLayer.secondaryAnchors ?? {}).map(([id, point]) => point && <g key={id}>
              <circle cx={point.x} cy={point.y} r="0.009" className={`handle secondary-handle ${locked ? "locked" : ""}`} tabIndex={locked ? -1 : 0} role="slider" aria-label={`${selectedLayer.sourceName} 次级锚点 ${id}`} aria-valuetext={`${point.x.toFixed(3)}, ${point.y.toFixed(3)}`} onKeyDown={(event) => onNudge(event, { kind: "secondary", key: id as keyof NonNullable<LayerBinding["secondaryAnchors"]> })} onPointerDown={(event) => onBeginDrag(event, { kind: "secondary", key: id as keyof NonNullable<LayerBinding["secondaryAnchors"]> })} />
              <text x={point.x + 0.01} y={point.y - 0.009}>{id}</text>
            </g>)}
          </>}
          {mode === "mesh" && selectedLayer && <>
            {Array.from({ length: Math.floor(meshTriangles.length / 3) }, (_, triangleIndex) => {
              const ids = meshTriangles.slice(triangleIndex * 3, triangleIndex * 3 + 3);
              return ids.map((id, edgeIndex) => { const a = meshPoints[id!]; const b = meshPoints[ids[(edgeIndex + 1) % 3]!]; return a && b ? <line key={`${triangleIndex}-${edgeIndex}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="mesh-line" /> : null; });
            })}
            {selectedVertex !== undefined && meshPoints[selectedVertex] && <circle cx={meshPoints[selectedVertex]!.x} cy={meshPoints[selectedVertex]!.y} r={softRadius} className="soft-radius" />}
            {meshPoints.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={selectedVertex === index ? 0.007 : meshVertexRadius} className={`handle mesh-handle ${selectedVertex === index ? "selected" : ""} ${locked ? "locked" : ""}`} tabIndex={locked ? -1 : 0} role="slider" aria-label={`${selectedLayer.sourceName} 网格顶点 ${index}`} aria-valuetext={`${point.x.toFixed(3)}, ${point.y.toFixed(3)}`} onFocus={() => onSelectVertex(index)} onKeyDown={(event) => onNudge(event, { kind: "mesh", index })} onPointerDown={(event) => onBeginDrag(event, { kind: "mesh", index })} />)}
          </>}
          </svg>}
        </div>
        <div className="viewport-navigation" aria-label="视图缩放控制">
          <button aria-label="缩小视图" title="缩小（-）" onClick={navigation.zoomOut}>−</button>
          <output aria-label="当前缩放比例">{navigation.zoomPercent}%</output>
          <button aria-label="放大视图" title="放大（+）" onClick={navigation.zoomIn}>+</button>
          <button className="fit-view" onClick={navigation.fit} title="适配窗口（0）">适配</button>
        </div>
      </div>
      <p className="viewport-help">{cleanPreview ? "当前隐藏所有编辑标记。滚轮缩放，拖动空白处移动视图，双击恢复适配。" : "滚轮会以鼠标位置为中心缩放；拖动空白处、按住空格拖动或使用鼠标中键可移动视图；双击空白处恢复适配。拖动控制点仍会直接校准。"}</p>

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
  onLayerProperty,
  onMoveLayer,
  onSoftRadius,
  onVertexInfluence,
  onResetLayer,
  onRuntimeTuning,
  onSecondaryPart,
  onSecondaryTuning,
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
  onLayerProperty: (patch: LayerPatch) => void;
  onMoveLayer: (direction: -1 | 1) => void;
  onSoftRadius: (radius: number) => void;
  onVertexInfluence: (channel: VertexChannel, value: number) => void;
  onResetLayer: () => void;
  onRuntimeTuning: (kind: "motionTuning" | "envelope", key: string, value: number) => void;
  onSecondaryPart: (part: SecondaryMotionPart) => void;
  onSecondaryTuning: (part: SecondaryMotionPart, key: "amplitude" | "response" | "stability", value: number) => void;
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
        </dl>
        <label className="check-row"><input type="checkbox" checked={selectedLayer.visible !== false} onChange={(event) => onLayerProperty({ visible: event.target.checked })} />参与渲染</label>
        <label className="check-row"><input type="checkbox" checked={locked} onChange={(event) => onLayerProperty({ locked: event.target.checked })} />锁定编辑</label>
        <label>语义<select disabled={locked} value={selectedLayer.role} onChange={(event) => onLayerProperty({ role: event.target.value as SemanticRole })}>{semanticRoles.map((role) => <option key={role}>{role}</option>)}</select></label>
        <label>侧别<select disabled={locked} value={selectedLayer.side} onChange={(event) => onLayerProperty({ side: event.target.value as Side })}><option value="left">角色左侧</option><option value="right">角色右侧</option><option value="center">中间 / 整体</option></select></label>
        <label>运动归属<select disabled={locked} value={selectedLayer.parentGroup} onChange={(event) => onLayerProperty({ parentGroup: event.target.value as LayerBinding["parentGroup"] })}><option value="head">头部</option><option value="body">身体</option><option value="root">根节点</option></select></label>
        <label>父图层<select disabled={locked} value={selectedLayer.parentLayerId ?? ""} onChange={(event) => onLayerProperty({ parentLayerId: event.target.value || null })}><option value="">无父图层</option>{project.layers.filter((layer) => canUseAsParent(selectedLayer.id, layer, layerMap)).map((layer) => <option key={layer.id} value={layer.id}>{layer.sourceName}</option>)}</select></label>
        <div className="order-row"><span>绘制顺序 #{selectedLayer.order}</span><button disabled={locked} onClick={() => onMoveLayer(-1)}>向后</button><button disabled={locked} onClick={() => onMoveLayer(1)}>向前</button></div>
        {(["head", "body", "gaze", "physics"] as const).map((key) => <label className="range-row" key={key}><span>{key} {selectedLayer.weights[key].toFixed(2)}</span><input disabled={locked} type="range" min="0" max="1" step="0.01" value={selectedLayer.weights[key]} onChange={(event) => onLayerProperty({ weights: { [key]: Number(event.target.value) } })} /></label>)}

        <section className="mesh-density">
          <h3>网格密度</h3>
          {selectedLayer.mesh.topology === "art" && selectedLayer.mesh.art ? <>
            <label>细节尺度（纹理像素）<input disabled={locked} type="number" min="4" max="256" value={selectedLayer.mesh.art.detail} onChange={(event) => onLayerProperty({ meshDetail: Math.max(4, Math.min(256, Math.round(Number(event.target.value) || 4))) })} /></label>
            <small>{selectedLayer.mesh.art.regions.length} 个独立区域，{selectedLayer.mesh.art.regions.reduce((count, region) => count + region.holes.length, 0)} 个孔洞。数值越小，轮廓和内部网格越密。</small>
          </> : selectedLayer.mesh.rows !== undefined && selectedLayer.mesh.cols !== undefined ? <>
            <div><label>行<input disabled={locked} type="number" min="2" max="64" value={selectedLayer.mesh.rows} onChange={(event) => onLayerProperty({ meshDensity: { rows: Math.max(2, Math.min(64, Math.round(Number(event.target.value) || 2))), cols: selectedLayer.mesh.cols! } })} /></label><label>列<input disabled={locked} type="number" min="2" max="64" value={selectedLayer.mesh.cols} onChange={(event) => onLayerProperty({ meshDensity: { rows: selectedLayer.mesh.rows!, cols: Math.max(2, Math.min(64, Math.round(Number(event.target.value) || 2))) } })} /></label></div>
            <small>规则网格仅用于完全不透明的矩形图层和旧项目兼容。</small>
          </> : <small>当前网格缺少可重建信息。</small>}
          <small>重建会重新投影权重，并退出旧顶点编辑。</small>
        </section>

        {selectedVertex !== undefined && <section className="vertex-inspector">
          <h3>顶点 {selectedVertex}</h3><p>x {meshPoints[selectedVertex]?.x.toFixed(5)} · y {meshPoints[selectedVertex]?.y.toFixed(5)}</p>
          <label className="range-row"><span>软选择半径 {softRadius.toFixed(3)}</span><input type="range" min="0.005" max="0.2" step="0.005" value={softRadius} onChange={(event) => onSoftRadius(Number(event.target.value))} /></label>
          {(["face", "skull", "head", "body", "gaze", "physics", "pin"] as const).map((channel) => {
            const fallback = channel === "pin" ? 0 : 1;
            const influenceChannels = selectedLayer.mesh.influences as Record<string, number[] | undefined> | undefined;
            const value = influenceChannels?.[channel]?.[selectedVertex] ?? fallback;
            const channelLabel = channel === "pin" ? "固定强度" : channel === "face" ? "脸部控制笼" : channel === "skull" ? "头骨控制笼" : channel === "physics" ? "次级运动" : `${channel} 顶点权重`;
            return <label className="range-row" key={channel}><span>{channelLabel} {value.toFixed(2)}</span><input disabled={locked} type="range" min="0" max="1" step="0.05" value={value} onChange={(event) => onVertexInfluence(channel, Number(event.target.value))} /></label>;
          })}
        </section>}
        <button onClick={onResetLayer} disabled={busy}>只恢复这个图层</button>
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

        <h3>分部响应</h3>
        <label>部件<select value={secondaryPart} onChange={(event) => onSecondaryPart(event.target.value as SecondaryMotionPart)}>{secondaryParts.map((part) => <option key={part.id} value={part.id}>{part.label}</option>)}</select></label>
        {(["amplitude", "response", "stability"] as const).map((key) => <label className="range-row" key={key}><span>{key} {selectedTuning[key].toFixed(2)}</span><input type="range" min="0" max={key === "amplitude" ? "1.5" : "1"} step="0.01" value={selectedTuning[key]} onChange={(event) => onSecondaryTuning(secondaryPart, key, Number(event.target.value))} /></label>)}

        <label>校准说明<input value={label} onChange={(event) => onLabel(event.target.value)} placeholder="例如：固定耳根并调整右眼外角" /></label>
        <button className="primary" disabled={!hasPending || busy} onClick={onSave}>{busy ? "正在验证并生成证据…" : "保存校准"}</button>
        <button disabled={!hasPending || busy} onClick={onDiscard}>放弃当前草稿</button>
        {notice && <p className="success">{notice}</p>}{error && <p className="error">{error}</p>}
      </section>
      </div>

      <div hidden={inspectorTab !== "history"}>
      <section className="session-panel">
        <h3>校准历史</h3>{sessions.length === 0 && <p>还没有保存过校准。</p>}
        {sessions.slice(0, 12).map((session) => <article key={session.id} className={comparison?.result.toRevision === session.toRevision ? "active" : ""}>
          <strong>r{session.toRevision} · {session.label}</strong><small>{session.evidenceStatus}</small>
          <div><button onClick={() => onShowEvidence(session.id)}>查看对比</button><button onClick={() => onRestore(session.toRevision, `恢复到 ${session.label}`)}>恢复</button><button onClick={() => onMarkEvidence(session.id, "accepted")}>确认</button><button onClick={() => onMarkEvidence(session.id, "rejected")}>无效</button></div>
        </article>)}
      </section>
      </div>
    </aside>
  );
}
