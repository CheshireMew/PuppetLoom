import type React from "react";
import type { CalibrationSessionSummary, ModelPhysics, MotionState, PuppetLoomProject, SecondaryMotionPart } from "@puppetloom/core";
import { isModelBehaviorAvailable, isModelExpressionAvailable, isMotionSemanticAvailable } from "@puppetloom/core/browser";
import { Activity, ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUp, ArrowUpDown, ArrowUpLeft, ArrowUpRight, Ban, Boxes, CheckCircle2, CircleAlert, CircleMinus, Drama, ExternalLink, Eye, EyeOff, Focus, Grid2X2, Heart, LayoutDashboard, Maximize2, Minimize2, Moon, Move3d, Pause, Play, Repeat2, RotateCcw, RotateCw, ScanEye, SlidersHorizontal, Smile, Sparkles, Sun, TriangleAlert, Waves, Workflow, type LucideIcon } from "lucide-react";

export type StudioSection = "overview" | "rig" | "parameters" | "dynamics" | "preview";
export type PreviewBackground = "checker" | "dark" | "light";

const studioSections: Array<{ id: StudioSection; index: string; label: string; detail: string; icon: LucideIcon }> = [
  { id: "overview", index: "01", label: "项目总览", detail: "完成度与下一步", icon: LayoutDashboard },
  { id: "rig", index: "02", label: "结构与网格", detail: "层级、轴心和权重", icon: Boxes },
  { id: "parameters", index: "03", label: "参数与姿态", detail: "直接检查可动范围", icon: SlidersHorizontal },
  { id: "dynamics", index: "04", label: "表情与物理", detail: "表情、行为和次级运动", icon: Activity },
  { id: "preview", index: "05", label: "预览与验收", detail: "干净画面与版本证据", icon: ScanEye }
];

const semanticLabels: Record<string, string> = {
  "head-yaw": "头部左右",
  "head-pitch": "头部上下",
  "head-roll": "头部倾斜",
  "body-sway": "身体左右",
  "body-pitch": "身体前后",
  "body-roll": "身体倾斜",
  "gaze-x": "视线左右",
  "gaze-y": "视线上下",
  breath: "呼吸",
  blink: "眨眼",
  "mouth-open": "张嘴"
};

const parameterGroupLabels: Record<string, string> = {
  Head: "头部",
  Body: "身体",
  Eyes: "眼睛",
  Mouth: "嘴部"
};

const semanticParameterIcons: Record<string, LucideIcon> = {
  "head-yaw": ArrowLeftRight,
  "head-pitch": ArrowUpDown,
  "head-roll": RotateCw,
  "body-sway": ArrowLeftRight,
  "body-pitch": Move3d,
  "body-roll": RotateCw,
  "gaze-x": ScanEye,
  "gaze-y": ScanEye,
  breath: Waves,
  blink: EyeOff,
  "mouth-open": Smile
};

function expressionIcon(name: string, id: string): LucideIcon {
  const value = `${name} ${id}`.toLocaleLowerCase();
  if (/闭眼|眨眼|blink|closed.?eye/.test(value)) return EyeOff;
  if (/闭合|closed.?mouth|mouth.?closed/.test(value)) return CircleMinus;
  if (/张开|开口|open.?mouth|mouth.?open/.test(value)) return Smile;
  if (/柔和|微笑|soft|smile/.test(value)) return Heart;
  if (/惊讶|surpris/.test(value)) return CircleAlert;
  if (/认真|serious|focus/.test(value)) return Focus;
  if (/困倦|疲倦|sleep|tired/.test(value)) return Moon;
  return Drama;
}

const stateLabels: Array<{ key: keyof MotionState; label: string; min: number; max: number; step: number; semantic?: "blink" | "mouth-open" }> = [
  { key: "headRoll", label: "头部倾斜", min: -1, max: 1, step: 0.01 },
  { key: "gazeX", label: "视线左右", min: -1, max: 1, step: 0.01 },
  { key: "gazeY", label: "视线上下", min: -1, max: 1, step: 0.01 },
  { key: "blink", label: "眨眼", min: 0, max: 1, step: 0.01, semantic: "blink" },
  { key: "mouthOpen", label: "张嘴", min: 0, max: 1, step: 0.01, semantic: "mouth-open" },
  { key: "breath", label: "呼吸", min: -1, max: 1, step: 0.01 }
];

const secondaryParts: Array<{ id: SecondaryMotionPart; label: string }> = [
  { id: "frontHair", label: "前发" }, { id: "backHair", label: "后发" }, { id: "ahoge", label: "呆毛" },
  { id: "headwear", label: "头饰" }, { id: "ears", label: "耳部" }, { id: "topCloth", label: "上衣" },
  { id: "skirt", label: "裙摆" }, { id: "tail", label: "尾巴" }, { id: "accessory", label: "配饰" }
];

function ratio(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round(part / whole * 100);
}

function systemStatus(count: number, readyLabel = "已生成"): { tone: string; label: string } {
  return count > 0 ? { tone: "ready", label: readyLabel } : { tone: "missing", label: "待生成" };
}

export function StudioNavigation({ section, onSection }: { section: StudioSection; onSection: (section: StudioSection) => void }): React.JSX.Element {
  return <nav className="studio-navigation" aria-label="编辑工作区">
    {studioSections.map((item) => { const Icon = item.icon; return <button key={item.id} aria-label={`${item.index} ${item.label}：${item.detail}`} className={section === item.id ? "active" : ""} onClick={() => onSection(item.id)}>
      <Icon aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.detail}</small></span>
    </button>; })}
  </nav>;
}

export function OverviewLeftPanel({ project, onSection }: { project: PuppetLoomProject; onSection: (section: StudioSection) => void }): React.JSX.Element {
  const artMeshes = project.layers.filter((layer) => layer.mesh.topology === "art").length;
  const gridMeshes = project.layers.length - artMeshes;
  const parented = project.layers.filter((layer) => layer.parentLayerId || layer.deformerId).length;
  return <aside className="studio-side-panel overview-left">
    <div className="panel-eyebrow">项目路线</div><h2>从这里判断下一步</h2>
    <p className="panel-intro">每个工作区解决一个明确问题。先处理标为“待完善”的项目，再进入干净预览验收。</p>
    <button className="starter-system-action artmesh-upgrade-action" onClick={() => onSection("rig")}><strong>{gridMeshes > 0 ? "检查规则网格是否需要轮廓网格" : "检查轮廓网格密度"}</strong><small>{gridMeshes > 0 ? `${gridMeshes} 个规则网格可能是完全不透明矩形，属于有效结果；只有轮廓需要变形时才升级。` : "逐层对比中立与九向姿态后再保存。"}</small></button>
    <div className="studio-task-list">
      <button onClick={() => onSection("rig")}><Boxes aria-hidden="true" /><span><em>结构与网格</em><strong>{artMeshes} 个轮廓网格 · {gridMeshes} 个规则网格</strong><small>{parented} 个图层已有层级归属</small></span></button>
      <button onClick={() => onSection("parameters")}><SlidersHorizontal aria-hidden="true" /><span><em>参数与姿态</em><strong>{project.model.parameters.length} 个参数</strong><small>检查九向姿态、视线、眨眼与口型</small></span></button>
      <button onClick={() => onSection("dynamics")}><Activity aria-hidden="true" /><span><em>表情与物理</em><strong>{project.model.expressions.length + project.model.physics.length + project.model.behaviors.length} 个已编排系统</strong><small>分部次级运动始终可单独校准</small></span></button>
      <button onClick={() => onSection("preview")}><ScanEye aria-hidden="true" /><span><em>预览与验收</em><strong>最终画面</strong><small>隐藏编辑标记，逐项检查并查看版本证据</small></span></button>
    </div>
  </aside>;
}

export function OverviewInspector({ project, revision, sessions }: { project: PuppetLoomProject; revision: number; sessions: CalibrationSessionSummary[] }): React.JSX.Element {
  const artMeshes = project.layers.filter((layer) => layer.mesh.topology === "art").length;
  const validMeshes = project.layers.filter((layer) => layer.mesh.points.length >= 4 && layer.mesh.triangles.length >= 3 && layer.mesh.triangles.every((index) => Number.isInteger(index) && index >= 0 && index < layer.mesh.points.length)).length;
  const semanticCoverage = project.layers.filter((layer) => layer.role !== "unknown").length;
  const currentEvidence = sessions.find((session) => session.toRevision === revision);
  const evidenceReadiness = currentEvidence?.evidenceStatus === "accepted" ? 100 : currentEvidence?.evidenceStatus === "unreviewed" ? 50 : 0;
  const evidenceNote = currentEvidence?.evidenceStatus === "accepted"
    ? `版本 ${revision} 已确认`
    : currentEvidence?.evidenceStatus === "unreviewed"
      ? `版本 ${revision} 待检查`
      : currentEvidence?.evidenceStatus === "rejected"
        ? `版本 ${revision} 已标记无效`
        : "当前版本尚无对比证据";
  const systems = [
    { label: "有效网格", value: ratio(validMeshes, project.layers.length), note: `${artMeshes} 个轮廓网格，其余为规则网格`, icon: Boxes },
    { label: "语义识别", value: ratio(semanticCoverage, project.layers.length), note: `${semanticCoverage}/${project.layers.length} 个图层`, icon: ScanEye },
    { label: "参数系统", value: Math.min(100, Math.round(project.model.parameters.length / 11 * 100)), note: `${project.model.parameters.length} 个参数`, icon: SlidersHorizontal },
    { label: "验收证据", value: evidenceReadiness, note: evidenceNote, icon: CheckCircle2 }
  ];
  const expressionStatus = systemStatus(project.model.expressions.length);
  const physicsStatus = project.model.physics.length > 0
    ? { tone: "ready", label: "已编排" }
    : { tone: "ready", label: "自动动态" };
  const behaviorStatus = systemStatus(project.model.behaviors.length, "已编排");
  return <aside className="studio-side-panel studio-inspector overview-inspector">
    <div className="panel-eyebrow">就绪程度</div><h2>项目完成度</h2>
    <div className="quality-hero"><span>安全系数</span><strong>{project.quality.safetyScale.toFixed(2)}</strong><small>版本 {revision} · {project.rigLevel === "semantic" ? "完整语义绑定" : project.rigLevel === "grouped" ? "分组绑定" : "基础绑定"}</small></div>
    <div className="readiness-list">{systems.map((item) => { const Icon = item.icon; return <div key={item.label} className="readiness-row"><Icon aria-hidden="true" /><div><strong>{item.label}</strong><small>{item.note}</small></div><output>{item.value}%</output><span><i style={{ width: `${item.value}%` }} /></span></div>; })}</div>
    <h3>高级系统</h3>
    <div className="system-status-grid">
      <div><Drama aria-hidden="true" /><span className={expressionStatus.tone}>{expressionStatus.label}</span><strong>表情</strong><small>{project.model.expressions.length} 个</small></div>
      <div><Activity aria-hidden="true" /><span className={physicsStatus.tone}>{physicsStatus.label}</span><strong>参数物理</strong><small>{project.model.physics.length > 0 ? `${project.model.physics.length} 组弹簧` : "分部次级运动已启用"}</small></div>
      <div><Workflow aria-hidden="true" /><span className={behaviorStatus.tone}>{behaviorStatus.label}</span><strong>行为</strong><small>{project.model.behaviors.length} 段</small></div>
    </div>
    <p className="benchmark-note">PuppetLoom 不需要复制 Cubism 的全部手工流程，但必须让自动生成的结构、参数和动态系统可见、可调、可验收。</p>
  </aside>;
}

export function ParameterLeftPanel({ project, selectedId, onSelect }: { project: PuppetLoomProject; selectedId: string; onSelect: (id: string) => void }): React.JSX.Element {
  const groups = [...new Set(project.model.parameters.map((parameter) => parameter.group))];
  return <aside className="studio-side-panel parameter-list-panel">
    <div className="panel-eyebrow">参数</div><h2>参数控制器</h2>
    <p className="panel-intro">参数按用途分组。选择后可查看范围、语义归属并实时驱动画面。</p>
    {groups.map((group) => <section className="parameter-group" key={group}><h3>{parameterGroupLabels[group] ?? group}</h3><div className="parameter-card-grid">{project.model.parameters.filter((parameter) => parameter.group === group).map((parameter) => {
      const semantic = parameter.semantic ?? "";
      const Icon = semanticParameterIcons[semantic] ?? SlidersHorizontal;
      const description = semantic ? semanticLabels[semantic] ?? semantic : parameter.id;
      const displayName = semantic ? description : parameter.name;
      return <button className={`parameter-card ${selectedId === parameter.id ? "active" : ""}`} aria-pressed={selectedId === parameter.id} aria-label={`${displayName}，${parameter.id}`} title={`${displayName} · ${parameter.id}`} key={parameter.id} onClick={() => onSelect(parameter.id)}><span className="parameter-card-icon" aria-hidden="true"><Icon /></span><span className="parameter-card-copy"><strong>{displayName}</strong><small>{parameter.id}</small></span></button>;
    })}</div></section>)}
  </aside>;
}

export function ParameterInspector({
  project,
  state,
  selectedId,
  onParameter,
  onState,
  onPose,
  onExpression
}: {
  project: PuppetLoomProject;
  state: MotionState;
  selectedId: string;
  onParameter: (id: string, value: number) => void;
  onState: (key: keyof MotionState, value: number) => void;
  onPose: (yaw: number, pitch: number) => void;
  onExpression: (id: string, value: number) => void;
}): React.JSX.Element {
  const parameter = project.model.parameters.find((candidate) => candidate.id === selectedId) ?? project.model.parameters[0];
  const current = parameter ? state.parameters?.[parameter.id] ?? parameter.default : 0;
  return <aside className="studio-side-panel studio-inspector parameter-inspector">
    <div className="panel-eyebrow">实时控制</div><h2>姿态与参数</h2>
    <section className="pose-controller"><div className="section-heading"><div><h3>九向头部控制</h3><small>与 Cubism 的二维参数控制器一致，点击即可检查组合姿态</small></div><output>{state.headYaw.toFixed(2)}, {state.headPitch.toFixed(2)}</output></div>
      <div className="pose-pad">{[-0.82, 0, 0.82].flatMap((pitch) => [-0.88, 0, 0.88].map((yaw) => <button key={`${yaw}-${pitch}`} className={Math.abs(state.headYaw - yaw) < .01 && Math.abs(state.headPitch - pitch) < .01 ? "active" : ""} aria-label={`头部姿态 ${yaw}, ${pitch}`} onClick={() => onPose(yaw, pitch)}><span /></button>))}</div>
    </section>
    {parameter && <section className="selected-parameter"><div className="section-heading"><div><h3>{parameter.semantic ? semanticLabels[parameter.semantic] : parameter.name}</h3><small>{parameter.id}</small></div><output>{current.toFixed(2)}</output></div><input type="range" min={parameter.min} max={parameter.max} step={(parameter.max - parameter.min) / 200} value={current} onChange={(event) => onParameter(parameter.id, Number(event.target.value))} /><div className="range-scale"><span>{parameter.min}</span><button className="with-icon" onClick={() => onParameter(parameter.id, parameter.default)}><RotateCcw aria-hidden="true" />恢复默认</button><span>{parameter.max}</span></div></section>}
    <section className="quick-parameters"><h3>常用检查</h3>{stateLabels.map((item) => { const raw = state[item.key]; const value = typeof raw === "number" ? raw : 0; const available = !item.semantic || isMotionSemanticAvailable(project, item.semantic); return <label className={`range-row ${available ? "" : "is-unavailable"}`} key={String(item.key)}><span>{item.label}{!available && <small>素材未提供</small>}<output>{value.toFixed(2)}</output></span><input disabled={!available} type="range" min={item.min} max={item.max} step={item.step} value={value} onChange={(event) => onState(item.key, Number(event.target.value))} /></label>; })}</section>
    {project.model.expressions.some((expression) => isModelExpressionAvailable(project, expression)) && <section className="expression-mixer"><h3>表情混合</h3>{project.model.expressions.filter((expression) => isModelExpressionAvailable(project, expression)).map((expression) => { const value = state.expressions?.[expression.id] ?? 0; return <label className="range-row" key={expression.id}><span>{expression.name}<output>{value.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.01" value={value} onChange={(event) => onExpression(expression.id, Number(event.target.value))} /></label>; })}</section>}
  </aside>;
}

export function DynamicsLeftPanel({ project, selectedBehaviorId, onBehavior, onCreateStarter }: { project: PuppetLoomProject; selectedBehaviorId: string; onBehavior: (id: string) => void; onCreateStarter: () => void }): React.JSX.Element {
  const availableExpressions = project.model.expressions.filter((expression) => isModelExpressionAvailable(project, expression));
  const availableBehaviors = project.model.behaviors.filter((behavior) => isModelBehaviorAvailable(project, behavior));
  const canCreateSurprised = project.runtime.features.mouthMotion || project.model.parameters.some((parameter) => parameter.semantic === "head-pitch");
  const desiredExpressions = [project.runtime.features.blink ? "expression-closed-eyes" : undefined, project.runtime.features.mouthMotion ? "expression-speaking" : undefined, canCreateSurprised ? "expression-surprised" : undefined].filter((id): id is string => Boolean(id));
  const canCreateIdle = project.model.parameters.some((parameter) => ["head-yaw", "head-pitch", "breath"].includes(parameter.semantic ?? ""))
    || project.runtime.features.blink && project.model.parameters.some((parameter) => parameter.semantic === "blink");
  const desiredBehaviors = [canCreateIdle ? "behavior-idle" : undefined, project.model.parameters.some((parameter) => parameter.semantic === "head-pitch") ? "behavior-nod" : undefined].filter((id): id is string => Boolean(id));
  const needsStarter = desiredExpressions.some((id) => !availableExpressions.some((expression) => expression.id === id))
    || desiredBehaviors.some((id) => !availableBehaviors.some((behavior) => behavior.id === id));
  return <aside className="studio-side-panel dynamics-list-panel">
    <div className="panel-eyebrow">动态</div><h2>动态系统</h2>
    {needsStarter && <button className="starter-system-action starter-dynamics-action" onClick={onCreateStarter}><span className="starter-system-icon" aria-hidden="true"><Sparkles /></span><span><strong>补全基础动态系统</strong><small>只创建当前素材真正支持且尚未存在的表情、自然待机和点头行为</small></span></button>}
    <div className="system-catalog">
      <section><h3><span><Drama aria-hidden="true" />表情</span><output>{availableExpressions.length}/{project.model.expressions.length}</output></h3>{project.model.expressions.length === 0 ? <p>当前项目还没有独立表情预设。</p> : <div className="catalog-grid">{project.model.expressions.map((expression) => { const Icon = expressionIcon(expression.name, expression.id); const available = isModelExpressionAvailable(project, expression); return <div className={`catalog-card ${available ? "" : "is-unavailable"}`} title={available ? expression.name : `${expression.name} · 缺少对应素材`} key={expression.id}><span className="catalog-card-icon" aria-hidden="true"><Icon /></span><span className="catalog-card-copy"><strong>{expression.name}</strong><small>{available ? `${Object.keys(expression.parameters).length} 个参数` : "素材未提供，已停用"}</small></span></div>; })}</div>}</section>
      <section><h3><span><Activity aria-hidden="true" />参数物理</span><output>{project.model.physics.length}</output></h3>{project.model.physics.length === 0 ? <p>当前项目使用自动分部次级运动；尚未编排参数弹簧。</p> : <div className="catalog-grid">{project.model.physics.map((physics) => <div className="catalog-card" title={`${physics.name} · ${physics.inputParameterId} → ${physics.outputParameterId}`} key={physics.id}><span className="catalog-card-icon" aria-hidden="true"><Activity /></span><span className="catalog-card-copy"><strong>{physics.name}</strong><small>{physics.inputParameterId} → {physics.outputParameterId}</small></span></div>)}</div>}</section>
      <section><h3><span><Workflow aria-hidden="true" />行为片段</span><output>{availableBehaviors.length}/{project.model.behaviors.length}</output></h3>{project.model.behaviors.length === 0 ? <p>自主预览仍可运行；尚未制作具名行为片段。</p> : <div className="catalog-grid">{project.model.behaviors.map((behavior) => { const Icon = behavior.loop ? Repeat2 : Play; const available = isModelBehaviorAvailable(project, behavior); return <button disabled={!available} className={`catalog-card ${selectedBehaviorId === behavior.id && available ? "active" : ""} ${available ? "" : "is-unavailable"}`} aria-pressed={selectedBehaviorId === behavior.id && available} title={available ? `${behavior.name} · ${behavior.duration.toFixed(2)}s · ${behavior.loop ? "循环" : "单次"} · ${behavior.tracks.length} 轨` : `${behavior.name} · 缺少对应素材`} key={behavior.id} onClick={() => onBehavior(behavior.id)}><span className="catalog-card-icon" aria-hidden="true"><Icon /></span><span className="catalog-card-copy"><strong>{behavior.name}</strong><small>{available ? `${behavior.duration.toFixed(2)}s · ${behavior.loop ? "循环" : "单次"} · ${behavior.tracks.length} 轨` : "素材未提供，已停用"}</small></span></button>; })}</div>}</section>
    </div>
  </aside>;
}

export function DynamicsInspector({
  project,
  state,
  selectedBehaviorId,
  behaviorTime,
  behaviorPlaying,
  secondaryPart,
  secondaryTuning,
  onExpression,
  onBehaviorTime,
  onBehaviorPlaying,
  onSecondaryPart,
  onSecondaryTuning,
  onPhysics
}: {
  project: PuppetLoomProject;
  state: MotionState;
  selectedBehaviorId: string;
  behaviorTime: number;
  behaviorPlaying: boolean;
  secondaryPart: SecondaryMotionPart;
  secondaryTuning: { amplitude: number; response: number; stability: number };
  onExpression: (id: string, value: number) => void;
  onBehaviorTime: (value: number) => void;
  onBehaviorPlaying: (value: boolean) => void;
  onSecondaryPart: (part: SecondaryMotionPart) => void;
  onSecondaryTuning: (part: SecondaryMotionPart, key: "amplitude" | "response" | "stability", value: number) => void;
  onPhysics: (id: string, patch: Partial<Pick<ModelPhysics, "inputScale" | "outputScale" | "response" | "damping">>) => void;
}): React.JSX.Element {
  const availableExpressions = project.model.expressions.filter((expression) => isModelExpressionAvailable(project, expression));
  const behavior = project.model.behaviors.find((candidate) => candidate.id === selectedBehaviorId && isModelBehaviorAvailable(project, candidate));
  return <aside className="studio-side-panel studio-inspector dynamics-inspector">
    <div className="panel-eyebrow">实时动态</div><h2>表情与物理检查</h2>
    <section><div className="section-heading"><div><h3 className="with-icon"><Drama aria-hidden="true" />表情混合</h3><small>多表情可叠加，画面会立即更新</small></div></div>{availableExpressions.length === 0 ? <div className="empty-system"><strong>没有可用的独立表情</strong><span>{project.model.expressions.length > 0 ? "现有预设依赖缺少的素材，已经停用。" : "有对应素材后，可生成并直接检查眨眼和口型表情。"}</span></div> : availableExpressions.map((expression) => { const value = state.expressions?.[expression.id] ?? 0; return <label className="range-row" key={expression.id}><span>{expression.name}<output>{value.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.01" value={value} onChange={(event) => onExpression(expression.id, Number(event.target.value))} /></label>; })}</section>
    <section><div className="section-heading"><div><h3 className="with-icon"><Play aria-hidden="true" />行为播放</h3><small>像动画时间线一样检查具名动作</small></div></div>{behavior ? <><div className="transport-row"><button className={`${behaviorPlaying ? "active" : ""} with-icon`} onClick={() => onBehaviorPlaying(!behaviorPlaying)}>{behaviorPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{behaviorPlaying ? "暂停" : "播放"}</button><strong>{behavior.name}</strong><output>{behaviorTime.toFixed(2)} / {behavior.duration.toFixed(2)}s</output></div><input className="timeline-range" type="range" min="0" max={behavior.duration} step="0.01" value={Math.min(behaviorTime, behavior.duration)} onChange={(event) => onBehaviorTime(Number(event.target.value))} /><div className="track-summary">{behavior.tracks.map((track) => <span key={`${track.target.kind}-${track.target.id}`}>{track.target.kind === "parameter" ? "参数" : "表情"} · {track.target.id} · {track.keyframes.length} 帧</span>)}</div></> : <div className="empty-system"><strong>尚无行为片段</strong><span>使用顶部“自主预览”仍可检查自动呼吸、眨眼和次级运动。</span></div>}</section>
    <section><div className="section-heading"><div><h3 className="with-icon"><Waves aria-hidden="true" />分部次级运动</h3><small>调节后立即进入校准草稿</small></div></div><label>部件<select value={secondaryPart} onChange={(event) => onSecondaryPart(event.target.value as SecondaryMotionPart)}>{secondaryParts.map((part) => <option key={part.id} value={part.id}>{part.label}</option>)}</select></label>{(["amplitude", "response", "stability"] as const).map((key) => <label className="range-row" key={key}><span>{key === "amplitude" ? "摆幅" : key === "response" ? "响应" : "稳定"}<output>{secondaryTuning[key].toFixed(2)}</output></span><input type="range" min="0" max={key === "amplitude" ? "1.5" : "1"} step="0.01" value={secondaryTuning[key]} onChange={(event) => onSecondaryTuning(secondaryPart, key, Number(event.target.value))} /></label>)}</section>
    {project.model.physics.length > 0 && <section><h3 className="with-icon"><Activity aria-hidden="true" />参数弹簧</h3>{project.model.physics.map((physics) => <article className="physics-card" key={physics.id}><strong>{physics.name}</strong><small>{physics.inputParameterId} → {physics.outputParameterId}</small>{(["inputScale", "outputScale", "response", "damping"] as const).map((key) => <label className="range-row" key={key}><span>{key === "inputScale" ? "输入强度" : key === "outputScale" ? "输出强度" : key === "response" ? "响应速度" : "阻尼"}<output>{physics[key].toFixed(2)}</output></span><input type="range" min={key === "damping" ? "0" : key === "response" ? "0.1" : "-4"} max={key === "damping" ? "4" : key === "response" ? "30" : "4"} step="0.05" value={physics[key]} onChange={(event) => onPhysics(physics.id, { [key]: Number(event.target.value) })} /></label>)}</article>)}</section>}
  </aside>;
}

const previewSamples: Array<{ id: string; label: string; detail: string; state: Partial<MotionState>; icon: LucideIcon; feature?: "blink" | "mouth-open" }> = [
  { id: "neutral", label: "中立基准", detail: "检查拼层、透明边和默认姿态", state: {}, icon: RotateCcw },
  { id: "left", label: "头部左转", detail: "检查脸型、头发遮挡和五官跟随", state: { headYaw: -.9, gazeX: -.35, bodySway: -.25 }, icon: ArrowLeft },
  { id: "right", label: "头部右转", detail: "检查左右是否对称、层级是否穿帮", state: { headYaw: .9, gazeX: .35, bodySway: .25 }, icon: ArrowRight },
  { id: "up", label: "抬头", detail: "检查下巴、脖子和后发衔接", state: { headPitch: -.78, gazeY: -.25, bodyPitch: -.2 }, icon: ArrowUp },
  { id: "down", label: "低头", detail: "检查刘海、眼睛与脸部压缩", state: { headPitch: .78, gazeY: .25, bodyPitch: .2 }, icon: ArrowDown },
  { id: "left-up", label: "左上", detail: "检查左转与抬头叠加后的轮廓", state: { headYaw: -.9, headPitch: -.78, gazeX: -.35, gazeY: -.25, bodySway: -.25, bodyPitch: -.2 }, icon: ArrowUpLeft },
  { id: "right-up", label: "右上", detail: "检查右转与抬头叠加后的轮廓", state: { headYaw: .9, headPitch: -.78, gazeX: .35, gazeY: -.25, bodySway: .25, bodyPitch: -.2 }, icon: ArrowUpRight },
  { id: "left-down", label: "左下", detail: "检查左转与低头叠加后的遮挡", state: { headYaw: -.9, headPitch: .78, gazeX: -.35, gazeY: .25, bodySway: -.25, bodyPitch: .2 }, icon: ArrowDownLeft },
  { id: "right-down", label: "右下", detail: "检查右转与低头叠加后的遮挡", state: { headYaw: .9, headPitch: .78, gazeX: .35, gazeY: .25, bodySway: .25, bodyPitch: .2 }, icon: ArrowDownRight },
  { id: "blink", label: "闭眼", detail: "检查眼皮替换和睫毛遮挡", state: { blink: 1 }, icon: EyeOff, feature: "blink" },
  { id: "mouth", label: "张嘴", detail: "检查口型图层和裁剪关系", state: { mouthOpen: 1 }, icon: Smile, feature: "mouth-open" }
];

export function PreviewLeftPanel({ project, activeSample, onSample }: { project: PuppetLoomProject; activeSample: string; onSample: (id: string, state: Partial<MotionState>) => void }): React.JSX.Element {
  return <aside className="studio-side-panel preview-samples-panel">
    <div className="panel-eyebrow">验收样本</div><h2>验收姿态</h2>
    <p className="panel-intro">九向头部姿态加闭眼和张嘴，共 11 个固定样本；缺少素材的样本会明确停用。</p>
    <div className="preview-sample-list">{previewSamples.map((sample) => {
      const Icon = sample.icon;
      const available = !sample.feature || isMotionSemanticAvailable(project, sample.feature);
      return <button disabled={!available} className={`${activeSample === sample.id ? "active" : ""} ${available ? "" : "is-unavailable"}`} aria-pressed={activeSample === sample.id && available} key={sample.id} onClick={() => onSample(sample.id, sample.state)}><span aria-hidden="true"><Icon /></span><div><strong>{sample.label}</strong><small>{available ? sample.detail : "素材未提供，当前项目不检查此项"}</small></div></button>;
    })}</div>
  </aside>;
}

export function PreviewInspector({
  project,
  revision,
  sessions,
  background,
  focused,
  autonomous,
  manualChecks,
  busy,
  onBackground,
  onFocused,
  onAutonomous,
  onLaunch,
  onManualCheck,
  onShowEvidence,
  onMarkEvidence
}: {
  project: PuppetLoomProject;
  revision: number;
  sessions: CalibrationSessionSummary[];
  background: PreviewBackground;
  focused: boolean;
  autonomous: boolean;
  manualChecks: Record<string, boolean>;
  busy: boolean;
  onBackground: (background: PreviewBackground) => void;
  onFocused: (focused: boolean) => void;
  onAutonomous: (autonomous: boolean) => void;
  onLaunch: () => void;
  onManualCheck: (id: string, checked: boolean) => void;
  onShowEvidence: (sessionId: string) => void;
  onMarkEvidence: (sessionId: string, status: "accepted" | "rejected") => void;
}): React.JSX.Element {
  const validMeshes = project.layers.every((layer) => layer.mesh.points.length >= 4 && layer.mesh.triangles.length >= 3 && layer.mesh.triangles.every((index) => index >= 0 && index < layer.mesh.points.length));
  const checks = [
    { label: "脸部九向姿态", ready: Boolean(project.runtime.semanticCage), icon: ScanEye },
    { label: "视线跟随", ready: project.runtime.features.gaze, icon: Eye },
    { label: "眨眼", ready: project.runtime.features.blink, icon: EyeOff },
    { label: "口型", ready: project.runtime.features.mouthMotion, icon: Smile },
    { label: "分部次级运动", ready: project.layers.some((layer) => layer.weights.physics > 0), icon: Waves },
    { label: "全部图层网格有效", ready: validMeshes, icon: Boxes }
  ];
  const visualChecks = [
    { id: "head-poses", label: "九向头部姿态无穿帮" },
    ...(project.runtime.features.blink ? [{ id: "blink", label: "闭眼替换和睫毛遮挡正常" }] : []),
    ...(project.runtime.features.mouthMotion ? [{ id: "mouth", label: "张嘴口型和裁剪关系正常" }] : []),
    { id: "checker", label: "透明背景边缘正常" },
    { id: "dark", label: "深色背景边缘正常" },
    { id: "light", label: "浅色背景边缘正常" }
  ];
  const visualComplete = visualChecks.every((item) => manualChecks[item.id]);
  const backgroundModes: Array<{ id: PreviewBackground; label: string; icon: LucideIcon }> = [{ id: "checker", label: "透明", icon: Grid2X2 }, { id: "dark", label: "深色", icon: Moon }, { id: "light", label: "浅色", icon: Sun }];
  return <aside className="studio-side-panel studio-inspector preview-inspector">
    <div className="panel-eyebrow">最终呈现</div><h2>干净预览</h2>
    <section><h3>画面模式</h3><div className="segmented-control">{backgroundModes.map((item) => { const Icon = item.icon; return <button className={`${background === item.id ? "active" : ""} with-icon`} aria-pressed={background === item.id} key={item.id} onClick={() => onBackground(item.id)}><Icon aria-hidden="true" />{item.label}</button>; })}</div><button className="wide-action with-icon" onClick={() => onFocused(!focused)}>{focused ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}{focused ? "退出沉浸预览" : "沉浸预览（Esc 退出）"}</button><button className={`wide-action ${autonomous ? "active" : ""} with-icon`} onClick={() => onAutonomous(!autonomous)}>{autonomous ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{autonomous ? "暂停自主动作" : "播放自主动作"}</button><button className="wide-action primary-action with-icon" onClick={onLaunch}><ExternalLink aria-hidden="true" />在独立角色窗口运行</button></section>
    <section><h3>系统能力</h3><div className="qa-checks">{checks.map((check) => { const Icon = check.icon; const StatusIcon = check.ready ? CheckCircle2 : TriangleAlert; return <div key={check.label}><Icon className="qa-check-icon" aria-hidden="true" /><strong>{check.label}</strong><span className={check.ready ? "ready" : "review"}><StatusIcon aria-hidden="true" />{check.ready ? "可用" : "素材未提供"}</span></div>; })}</div></section>
    <section><h3>本轮目视验收</h3><div className="manual-qa-checks">{visualChecks.map((item) => <label key={item.id}><input type="checkbox" checked={Boolean(manualChecks[item.id])} onChange={(event) => onManualCheck(item.id, event.target.checked)} />{item.label}</label>)}</div><strong className={visualComplete ? "qa-complete" : "qa-incomplete"}>{visualComplete ? "本轮验收已完成" : "尚有项目未确认"}</strong></section>
    <section className="preview-evidence-section"><h3>版本证据</h3>{sessions.length === 0 ? <p>版本 {revision} 尚未保存过校准，因此没有对比证据。</p> : <div className="preview-evidence-list">{sessions.map((session) => <article key={session.id} className={session.toRevision === revision ? "active" : ""}><div><strong>版本 {session.toRevision} · {session.label}</strong><small>{session.evidenceStatus === "accepted" ? "已确认" : session.evidenceStatus === "rejected" ? "已标记无效" : "待检查"}</small></div><span><button disabled={busy} className="with-icon" onClick={() => onShowEvidence(session.id)}><Eye aria-hidden="true" />对比</button><button disabled={busy || session.evidenceStatus === "accepted"} className="with-icon" onClick={() => onMarkEvidence(session.id, "accepted")}><CheckCircle2 aria-hidden="true" />确认</button><button disabled={busy || session.evidenceStatus === "rejected"} className="with-icon" onClick={() => onMarkEvidence(session.id, "rejected")}><Ban aria-hidden="true" />无效</button></span></article>)}</div>}</section>
    <p className="benchmark-note">目视勾选只在当前编辑修订内保留；项目或草稿发生变化时会自动失效，切换工作区不会丢失。</p>
  </aside>;
}
