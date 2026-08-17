import type React from "react";
import type { ModelPhysics, MotionState, PuppetLoomProject, SecondaryMotionPart } from "@puppetloom/core";

export type StudioSection = "overview" | "rig" | "parameters" | "dynamics" | "preview";
export type PreviewBackground = "checker" | "dark" | "light";

const studioSections: Array<{ id: StudioSection; index: string; label: string; detail: string }> = [
  { id: "overview", index: "01", label: "项目总览", detail: "完成度与下一步" },
  { id: "rig", index: "02", label: "结构与网格", detail: "层级、轴心和权重" },
  { id: "parameters", index: "03", label: "参数与姿态", detail: "直接检查可动范围" },
  { id: "dynamics", index: "04", label: "表情与物理", detail: "表情、行为和次级运动" },
  { id: "preview", index: "05", label: "预览与验收", detail: "干净画面与版本证据" }
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

const stateLabels: Array<{ key: keyof MotionState; label: string; min: number; max: number; step: number }> = [
  { key: "headRoll", label: "头部倾斜", min: -1, max: 1, step: 0.01 },
  { key: "gazeX", label: "视线左右", min: -1, max: 1, step: 0.01 },
  { key: "gazeY", label: "视线上下", min: -1, max: 1, step: 0.01 },
  { key: "blink", label: "眨眼", min: 0, max: 1, step: 0.01 },
  { key: "mouthOpen", label: "张嘴", min: 0, max: 1, step: 0.01 },
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
    {studioSections.map((item) => <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => onSection(item.id)}>
      <span className="studio-index">{item.index}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span>
    </button>)}
  </nav>;
}

export function OverviewLeftPanel({ project, onSection, upgradingMeshes, onUpgradeMeshes }: { project: PuppetLoomProject; onSection: (section: StudioSection) => void; upgradingMeshes: boolean; onUpgradeMeshes: () => void }): React.JSX.Element {
  const artMeshes = project.layers.filter((layer) => layer.mesh.topology === "art").length;
  const parented = project.layers.filter((layer) => layer.parentLayerId || layer.deformerId).length;
  return <aside className="studio-side-panel overview-left">
    <div className="panel-eyebrow">PROJECT MAP</div><h2>从这里判断下一步</h2>
    <p className="panel-intro">每个工作区解决一个明确问题。先处理标为“待完善”的项目，再进入干净预览验收。</p>
    <button className="starter-system-action artmesh-upgrade-action" disabled={upgradingMeshes} onClick={onUpgradeMeshes}><strong>{upgradingMeshes ? "正在读取纹理轮廓…" : artMeshes < project.layers.length ? "升级旧网格" : "按推荐密度重建网格"}</strong><small>{artMeshes < project.layers.length ? "从现有 PNG 的 Alpha 轮廓生成 ArtMesh，结果先进入草稿，不覆盖基础项目" : "重新生成轮廓与内部三角形并投影现有权重，用于统一网格质量"}</small></button>
    <div className="studio-task-list">
      <button onClick={() => onSection("rig")}><span>结构与网格</span><strong>{artMeshes}/{project.layers.length} ArtMesh</strong><small>{parented} 个图层已有层级归属</small></button>
      <button onClick={() => onSection("parameters")}><span>参数与姿态</span><strong>{project.model.parameters.length} 个参数</strong><small>检查九向姿态、视线、眨眼与口型</small></button>
      <button onClick={() => onSection("dynamics")}><span>表情与物理</span><strong>{project.model.expressions.length + project.model.physics.length + project.model.behaviors.length} 个已编排系统</strong><small>分部次级运动始终可单独校准</small></button>
      <button onClick={() => onSection("preview")}><span>预览与验收</span><strong>最终画面</strong><small>隐藏编辑标记，逐项检查并查看版本证据</small></button>
    </div>
  </aside>;
}

export function OverviewInspector({ project, revision, sessionCount }: { project: PuppetLoomProject; revision: number; sessionCount: number }): React.JSX.Element {
  const artMeshes = project.layers.filter((layer) => layer.mesh.topology === "art").length;
  const semanticCoverage = project.layers.filter((layer) => layer.role !== "unknown").length;
  const systems = [
    { label: "Alpha ArtMesh", value: ratio(artMeshes, project.layers.length), note: `${artMeshes}/${project.layers.length} 个图层` },
    { label: "语义识别", value: ratio(semanticCoverage, project.layers.length), note: `${semanticCoverage}/${project.layers.length} 个图层` },
    { label: "参数系统", value: Math.min(100, Math.round(project.model.parameters.length / 11 * 100)), note: `${project.model.parameters.length} 个参数` },
    { label: "验收证据", value: Math.min(100, sessionCount * 25), note: `${sessionCount} 个历史版本` }
  ];
  const expressionStatus = systemStatus(project.model.expressions.length);
  const physicsStatus = systemStatus(project.model.physics.length, "已编排");
  const behaviorStatus = systemStatus(project.model.behaviors.length, "已编排");
  return <aside className="studio-side-panel studio-inspector overview-inspector">
    <div className="panel-eyebrow">READINESS</div><h2>项目完成度</h2>
    <div className="quality-hero"><span>安全系数</span><strong>{project.quality.safetyScale.toFixed(2)}</strong><small>revision {revision} · {project.rigLevel}</small></div>
    <div className="readiness-list">{systems.map((item) => <div key={item.label} className="readiness-row"><div><strong>{item.label}</strong><small>{item.note}</small></div><output>{item.value}%</output><span><i style={{ width: `${item.value}%` }} /></span></div>)}</div>
    <h3>高级系统</h3>
    <div className="system-status-grid">
      <div><span className={expressionStatus.tone}>{expressionStatus.label}</span><strong>表情</strong><small>{project.model.expressions.length} 个</small></div>
      <div><span className={physicsStatus.tone}>{physicsStatus.label}</span><strong>参数物理</strong><small>{project.model.physics.length} 组</small></div>
      <div><span className={behaviorStatus.tone}>{behaviorStatus.label}</span><strong>行为</strong><small>{project.model.behaviors.length} 段</small></div>
    </div>
    <p className="benchmark-note">PuppetLoom 不需要复制 Cubism 的全部手工流程，但必须让自动生成的结构、参数和动态系统可见、可调、可验收。</p>
  </aside>;
}

export function ParameterLeftPanel({ project, selectedId, onSelect }: { project: PuppetLoomProject; selectedId: string; onSelect: (id: string) => void }): React.JSX.Element {
  const groups = [...new Set(project.model.parameters.map((parameter) => parameter.group))];
  return <aside className="studio-side-panel parameter-list-panel">
    <div className="panel-eyebrow">PARAMETERS</div><h2>参数控制器</h2>
    <p className="panel-intro">参数按用途分组。选择后可查看范围、语义归属并实时驱动画面。</p>
    {groups.map((group) => <section className="parameter-group" key={group}><h3>{group}</h3>{project.model.parameters.filter((parameter) => parameter.group === group).map((parameter) => <button className={selectedId === parameter.id ? "active" : ""} key={parameter.id} onClick={() => onSelect(parameter.id)}><span>{parameter.name}</span><small>{parameter.semantic ? semanticLabels[parameter.semantic] : parameter.id}</small></button>)}</section>)}
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
    <div className="panel-eyebrow">LIVE CONTROL</div><h2>姿态与参数</h2>
    <section className="pose-controller"><div className="section-heading"><div><h3>九向头部控制</h3><small>与 Cubism 的二维参数控制器一致，点击即可检查组合姿态</small></div><output>{state.headYaw.toFixed(2)}, {state.headPitch.toFixed(2)}</output></div>
      <div className="pose-pad">{[-0.82, 0, 0.82].flatMap((pitch) => [-0.88, 0, 0.88].map((yaw) => <button key={`${yaw}-${pitch}`} className={Math.abs(state.headYaw - yaw) < .01 && Math.abs(state.headPitch - pitch) < .01 ? "active" : ""} aria-label={`头部姿态 ${yaw}, ${pitch}`} onClick={() => onPose(yaw, pitch)}><span /></button>))}</div>
    </section>
    {parameter && <section className="selected-parameter"><div className="section-heading"><div><h3>{parameter.name}</h3><small>{parameter.semantic ? semanticLabels[parameter.semantic] : parameter.id}</small></div><output>{current.toFixed(2)}</output></div><input type="range" min={parameter.min} max={parameter.max} step={(parameter.max - parameter.min) / 200} value={current} onChange={(event) => onParameter(parameter.id, Number(event.target.value))} /><div className="range-scale"><span>{parameter.min}</span><button onClick={() => onParameter(parameter.id, parameter.default)}>恢复默认</button><span>{parameter.max}</span></div></section>}
    <section className="quick-parameters"><h3>常用检查</h3>{stateLabels.map((item) => { const raw = state[item.key]; const value = typeof raw === "number" ? raw : 0; return <label className="range-row" key={String(item.key)}><span>{item.label}<output>{value.toFixed(2)}</output></span><input type="range" min={item.min} max={item.max} step={item.step} value={value} onChange={(event) => onState(item.key, Number(event.target.value))} /></label>; })}</section>
    {project.model.expressions.length > 0 && <section className="expression-mixer"><h3>表情混合</h3>{project.model.expressions.map((expression) => { const value = state.expressions?.[expression.id] ?? 0; return <label className="range-row" key={expression.id}><span>{expression.name}<output>{value.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.01" value={value} onChange={(event) => onExpression(expression.id, Number(event.target.value))} /></label>; })}</section>}
  </aside>;
}

export function DynamicsLeftPanel({ project, selectedBehaviorId, onBehavior, onCreateStarter }: { project: PuppetLoomProject; selectedBehaviorId: string; onBehavior: (id: string) => void; onCreateStarter: () => void }): React.JSX.Element {
  return <aside className="studio-side-panel dynamics-list-panel">
    <div className="panel-eyebrow">DYNAMICS</div><h2>动态系统</h2>
    {(project.model.expressions.length === 0 || project.model.behaviors.length === 0) && <button className="starter-system-action" onClick={onCreateStarter}><strong>生成基础动态系统</strong><small>创建闭眼、开口、惊讶，以及自然待机和点头行为</small></button>}
    <div className="system-catalog">
      <section><h3>表情 <span>{project.model.expressions.length}</span></h3>{project.model.expressions.length === 0 ? <p>当前项目还没有独立表情预设。</p> : project.model.expressions.map((expression) => <div className="catalog-row" key={expression.id}><strong>{expression.name}</strong><small>{Object.keys(expression.parameters).length} 个参数</small></div>)}</section>
      <section><h3>参数物理 <span>{project.model.physics.length}</span></h3>{project.model.physics.length === 0 ? <p>当前项目使用自动分部次级运动；尚未编排参数弹簧。</p> : project.model.physics.map((physics) => <div className="catalog-row" key={physics.id}><strong>{physics.name}</strong><small>{physics.inputParameterId} → {physics.outputParameterId}</small></div>)}</section>
      <section><h3>行为片段 <span>{project.model.behaviors.length}</span></h3>{project.model.behaviors.length === 0 ? <p>自主预览仍可运行；尚未制作具名行为片段。</p> : project.model.behaviors.map((behavior) => <button className={selectedBehaviorId === behavior.id ? "active" : ""} key={behavior.id} onClick={() => onBehavior(behavior.id)}><strong>{behavior.name}</strong><small>{behavior.duration.toFixed(2)}s · {behavior.loop ? "循环" : "单次"} · {behavior.tracks.length} 轨</small></button>)}</section>
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
  const behavior = project.model.behaviors.find((candidate) => candidate.id === selectedBehaviorId);
  return <aside className="studio-side-panel studio-inspector dynamics-inspector">
    <div className="panel-eyebrow">LIVE DYNAMICS</div><h2>表情与物理检查</h2>
    <section><div className="section-heading"><div><h3>表情混合</h3><small>多表情可叠加，画面会立即更新</small></div></div>{project.model.expressions.length === 0 ? <div className="empty-system"><strong>尚无独立表情</strong><span>眨眼和口型仍可在“参数与姿态”中直接检查。</span></div> : project.model.expressions.map((expression) => { const value = state.expressions?.[expression.id] ?? 0; return <label className="range-row" key={expression.id}><span>{expression.name}<output>{value.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.01" value={value} onChange={(event) => onExpression(expression.id, Number(event.target.value))} /></label>; })}</section>
    <section><div className="section-heading"><div><h3>行为播放</h3><small>像动画时间线一样检查具名动作</small></div></div>{behavior ? <><div className="transport-row"><button className={behaviorPlaying ? "active" : ""} onClick={() => onBehaviorPlaying(!behaviorPlaying)}>{behaviorPlaying ? "暂停" : "播放"}</button><strong>{behavior.name}</strong><output>{behaviorTime.toFixed(2)} / {behavior.duration.toFixed(2)}s</output></div><input className="timeline-range" type="range" min="0" max={behavior.duration} step="0.01" value={Math.min(behaviorTime, behavior.duration)} onChange={(event) => onBehaviorTime(Number(event.target.value))} /><div className="track-summary">{behavior.tracks.map((track) => <span key={`${track.target.kind}-${track.target.id}`}>{track.target.kind === "parameter" ? "参数" : "表情"} · {track.target.id} · {track.keyframes.length} 帧</span>)}</div></> : <div className="empty-system"><strong>尚无行为片段</strong><span>使用顶部“自主预览”仍可检查自动呼吸、眨眼和次级运动。</span></div>}</section>
    <section><div className="section-heading"><div><h3>分部次级运动</h3><small>调节后立即进入校准草稿</small></div></div><label>部件<select value={secondaryPart} onChange={(event) => onSecondaryPart(event.target.value as SecondaryMotionPart)}>{secondaryParts.map((part) => <option key={part.id} value={part.id}>{part.label}</option>)}</select></label>{(["amplitude", "response", "stability"] as const).map((key) => <label className="range-row" key={key}><span>{key === "amplitude" ? "摆幅" : key === "response" ? "响应" : "稳定"}<output>{secondaryTuning[key].toFixed(2)}</output></span><input type="range" min="0" max={key === "amplitude" ? "1.5" : "1"} step="0.01" value={secondaryTuning[key]} onChange={(event) => onSecondaryTuning(secondaryPart, key, Number(event.target.value))} /></label>)}</section>
    {project.model.physics.length > 0 && <section><h3>参数弹簧</h3>{project.model.physics.map((physics) => <article className="physics-card" key={physics.id}><strong>{physics.name}</strong><small>{physics.inputParameterId} → {physics.outputParameterId}</small>{(["inputScale", "outputScale", "response", "damping"] as const).map((key) => <label className="range-row" key={key}><span>{key}<output>{physics[key].toFixed(2)}</output></span><input type="range" min={key === "damping" ? "0" : key === "response" ? "0.1" : "-4"} max={key === "damping" ? "4" : key === "response" ? "30" : "4"} step="0.05" value={physics[key]} onChange={(event) => onPhysics(physics.id, { [key]: Number(event.target.value) })} /></label>)}</article>)}</section>}
  </aside>;
}

const previewSamples: Array<{ id: string; label: string; detail: string; state: Partial<MotionState> }> = [
  { id: "neutral", label: "中立基准", detail: "检查拼层、透明边和默认姿态", state: {} },
  { id: "left", label: "头部左转", detail: "检查脸型、头发遮挡和五官跟随", state: { headYaw: -.9, gazeX: -.35, bodySway: -.25 } },
  { id: "right", label: "头部右转", detail: "检查左右是否对称、层级是否穿帮", state: { headYaw: .9, gazeX: .35, bodySway: .25 } },
  { id: "up", label: "抬头", detail: "检查下巴、脖子和后发衔接", state: { headPitch: -.78, gazeY: -.25, bodyPitch: -.2 } },
  { id: "down", label: "低头", detail: "检查刘海、眼睛与脸部压缩", state: { headPitch: .78, gazeY: .25, bodyPitch: .2 } },
  { id: "blink", label: "闭眼", detail: "检查眼皮替换和睫毛遮挡", state: { blink: 1 } },
  { id: "mouth", label: "张嘴", detail: "检查口型图层和裁剪关系", state: { mouthOpen: 1 } }
];

export function PreviewLeftPanel({ activeSample, onSample }: { activeSample: string; onSample: (id: string, state: Partial<MotionState>) => void }): React.JSX.Element {
  return <aside className="studio-side-panel preview-samples-panel"><div className="panel-eyebrow">QA SAMPLES</div><h2>验收姿态</h2><p className="panel-intro">固定样本比随意拖动更容易发现穿帮。每次改动后按同一顺序复查。</p><div className="preview-sample-list">{previewSamples.map((sample, index) => <button className={activeSample === sample.id ? "active" : ""} key={sample.id} onClick={() => onSample(sample.id, sample.state)}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{sample.label}</strong><small>{sample.detail}</small></div></button>)}</div></aside>;
}

export function PreviewInspector({
  project,
  background,
  focused,
  autonomous,
  onBackground,
  onFocused,
  onAutonomous,
  onLaunch
}: {
  project: PuppetLoomProject;
  background: PreviewBackground;
  focused: boolean;
  autonomous: boolean;
  onBackground: (background: PreviewBackground) => void;
  onFocused: (focused: boolean) => void;
  onAutonomous: (autonomous: boolean) => void;
  onLaunch: () => void;
}): React.JSX.Element {
  const checks = [
    { label: "脸部九向姿态", ready: Boolean(project.runtime.semanticCage) },
    { label: "眼神与眨眼", ready: project.runtime.features.blink },
    { label: "口型", ready: project.runtime.features.mouthMotion },
    { label: "分部次级运动", ready: project.layers.some((layer) => layer.weights.physics > 0) },
    { label: "轮廓 ArtMesh", ready: project.layers.every((layer) => layer.mesh.topology === "art") }
  ];
  return <aside className="studio-side-panel studio-inspector preview-inspector"><div className="panel-eyebrow">PRESENTATION</div><h2>干净预览</h2><section><h3>画面模式</h3><div className="segmented-control">{(["checker", "dark", "light"] as PreviewBackground[]).map((item) => <button className={background === item ? "active" : ""} key={item} onClick={() => onBackground(item)}>{item === "checker" ? "透明" : item === "dark" ? "深色" : "浅色"}</button>)}</div><button className="wide-action" onClick={() => onFocused(!focused)}>{focused ? "退出沉浸预览" : "沉浸预览"}</button><button className={`wide-action ${autonomous ? "active" : ""}`} onClick={() => onAutonomous(!autonomous)}>{autonomous ? "暂停自主动作" : "播放自主动作"}</button><button className="wide-action primary-action" onClick={onLaunch}>在独立角色窗口运行</button></section><section><h3>能力检查</h3><div className="qa-checks">{checks.map((check) => <div key={check.label}><span className={check.ready ? "ready" : "review"}>{check.ready ? "就绪" : "复核"}</span><strong>{check.label}</strong></div>)}</div></section><p className="benchmark-note">编辑标记在此工作区完全隐藏。透明、深色和浅色背景都通过，才算视觉验收完成。</p></aside>;
}
