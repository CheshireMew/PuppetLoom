import type React from "react";
import type { CalibrationSessionSummary, ModelPhysics, MotionState, PuppetLoomProject, SecondaryMotionPart } from "@puppetloom/core";
import { isModelBehaviorAvailable, isModelExpressionAvailable, isMotionSemanticAvailable } from "@puppetloom/core/browser";
import { Activity, ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUp, ArrowUpDown, ArrowUpLeft, ArrowUpRight, Ban, Boxes, CheckCircle2, CircleAlert, CircleMinus, Drama, ExternalLink, Eye, EyeOff, Focus, Grid2X2, Heart, LayoutDashboard, Maximize2, Minimize2, Moon, Move3d, Pause, Play, Repeat2, RotateCcw, RotateCw, ScanEye, SlidersHorizontal, Smile, Sparkles, Sun, TriangleAlert, Waves, Workflow, type LucideIcon } from "lucide-react";
import { useLocale } from "../i18n/index.js";
import type { MessageKey } from "../i18n/index.js";

export type StudioSection = "overview" | "rig" | "parameters" | "dynamics" | "preview";
export type PreviewBackground = "checker" | "dark" | "light";

const studioSections: Array<{ id: StudioSection; index: string; labelKey: MessageKey; detailKey: MessageKey; icon: LucideIcon }> = [
  { id: "overview", index: "01", labelKey: "studioOverview", detailKey: "studioOverviewDetail", icon: LayoutDashboard },
  { id: "rig", index: "02", labelKey: "studioRig", detailKey: "studioRigDetail", icon: Boxes },
  { id: "parameters", index: "03", labelKey: "studioParameters", detailKey: "studioParametersDetail", icon: SlidersHorizontal },
  { id: "dynamics", index: "04", labelKey: "studioDynamics", detailKey: "studioDynamicsDetail", icon: Activity },
  { id: "preview", index: "05", labelKey: "studioPreview", detailKey: "studioPreviewDetail", icon: ScanEye }
];

const semanticLabels: Record<string, string> = {
  "head-yaw": "머리 좌우",
  "head-pitch": "머리 상하",
  "head-roll": "머리 기울기",
  "body-sway": "몸 좌우",
  "body-pitch": "몸 앞뒤",
  "body-roll": "몸 기울기",
  "gaze-x": "시선 좌우",
  "gaze-y": "시선 상하",
  breath: "호흡",
  blink: "눈 깜빡임",
  "mouth-open": "입 열기"
};

const parameterGroupLabels: Record<string, string> = {
  Head: "머리",
  Body: "몸",
  Eyes: "눈",
  Mouth: "입"
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
  if (/闭眼|眨眼|눈 감기|눈감기|깜빡|깜박|blink|closed.?eye/.test(value)) return EyeOff;
  if (/闭合|입 닫기|다물|closed.?mouth|mouth.?closed/.test(value)) return CircleMinus;
  if (/张开|开口|입 열기|입열기|open.?mouth|mouth.?open/.test(value)) return Smile;
  if (/柔和|微笑|부드러운|미소|soft|smile/.test(value)) return Heart;
  if (/惊讶|놀람|surpris/.test(value)) return CircleAlert;
  if (/认真|진지|serious|focus/.test(value)) return Focus;
  if (/困倦|疲倦|졸림|피곤|sleep|tired/.test(value)) return Moon;
  return Drama;
}

const stateLabels: Array<{ key: keyof MotionState; label: string; min: number; max: number; step: number; semantic?: "blink" | "mouth-open" }> = [
  { key: "headRoll", label: "머리 기울기", min: -1, max: 1, step: 0.01 },
  { key: "gazeX", label: "시선 좌우", min: -1, max: 1, step: 0.01 },
  { key: "gazeY", label: "시선 상하", min: -1, max: 1, step: 0.01 },
  { key: "blink", label: "눈 깜빡임", min: 0, max: 1, step: 0.01, semantic: "blink" },
  { key: "mouthOpen", label: "입 열기", min: 0, max: 1, step: 0.01, semantic: "mouth-open" },
  { key: "breath", label: "호흡", min: -1, max: 1, step: 0.01 }
];

const secondaryParts: Array<{ id: SecondaryMotionPart; label: string }> = [
  { id: "frontHair", label: "앞머리" }, { id: "backHair", label: "뒷머리" }, { id: "ahoge", label: "아호게" },
  { id: "headwear", label: "머리장식" }, { id: "ears", label: "귀" }, { id: "topCloth", label: "상의" },
  { id: "skirt", label: "치마" }, { id: "tail", label: "꼬리" }, { id: "accessory", label: "액세서리" }
];

function ratio(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round(part / whole * 100);
}

function systemStatus(count: number, readyLabel = "생성됨"): { tone: string; label: string } {
  return count > 0 ? { tone: "ready", label: readyLabel } : { tone: "missing", label: "아직 없음" };
}

export function StudioNavigation({ section, onSection }: { section: StudioSection; onSection: (section: StudioSection) => void }): React.JSX.Element {
  const { t } = useLocale();
  return <nav className="studio-navigation" aria-label={t("studioNav")}>
    {studioSections.map((item) => { const Icon = item.icon; const label = t(item.labelKey); const detail = t(item.detailKey); return <button key={item.id} aria-label={`${item.index} ${label}: ${detail}`} className={section === item.id ? "active" : ""} onClick={() => onSection(item.id)}>
      <Icon aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span>
    </button>; })}
  </nav>;
}

export function OverviewLeftPanel({ project, onSection }: { project: PuppetLoomProject; onSection: (section: StudioSection) => void }): React.JSX.Element {
  const artMeshes = project.layers.filter((layer) => layer.mesh.topology === "art").length;
  const gridMeshes = project.layers.length - artMeshes;
  const parented = project.layers.filter((layer) => layer.parentLayerId || layer.deformerId).length;
  return <aside className="studio-side-panel overview-left">
    <div className="panel-eyebrow">프로젝트 경로</div><h2>여기서 다음 단계를 정하세요</h2>
    <p className="panel-intro">각 작업 영역은 한 가지 문제를 해결합니다. “보완 필요” 항목을 먼저 처리한 뒤 깨끗한 미리보기에서 검수하세요.</p>
    <button className="starter-system-action artmesh-upgrade-action" onClick={() => onSection("rig")}><strong>{gridMeshes > 0 ? "규칙 메시를 윤곽 메시로 바꿀지 확인" : "윤곽 메시 밀도 확인"}</strong><small>{gridMeshes > 0 ? `규칙 메시 ${gridMeshes}개는 완전 불투명 사각형일 수 있으며 유효한 결과입니다. 윤곽을 변형해야 할 때만 업그레이드하세요.` : "레이어마다 중립과 9방향 자세를 비교한 뒤 저장하세요."}</small></button>
    <div className="studio-task-list">
      <button onClick={() => onSection("rig")}><Boxes aria-hidden="true" /><span><em>구조·메시</em><strong>윤곽 메시 {artMeshes}개 · 규칙 메시 {gridMeshes}개</strong><small>계층이 지정된 레이어 {parented}개</small></span></button>
      <button onClick={() => onSection("parameters")}><SlidersHorizontal aria-hidden="true" /><span><em>파라미터·자세</em><strong>파라미터 {project.model.parameters.length}개</strong><small>9방향 자세, 시선, 눈 깜빡임, 입 모양 확인</small></span></button>
      <button onClick={() => onSection("dynamics")}><Activity aria-hidden="true" /><span><em>표정·물리</em><strong>구성된 시스템 {project.model.expressions.length + project.model.physics.length + project.model.behaviors.length}개</strong><small>부위별 2차 모션은 항상 따로 캘리브레이션할 수 있습니다</small></span></button>
      <button onClick={() => onSection("preview")}><ScanEye aria-hidden="true" /><span><em>미리보기·검수</em><strong>최종 화면</strong><small>편집 표시를 숨기고 항목별로 확인한 뒤 버전 증거를 보세요</small></span></button>
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
    ? `버전 ${revision} 확인됨`
    : currentEvidence?.evidenceStatus === "unreviewed"
      ? `버전 ${revision} 검수 대기`
      : currentEvidence?.evidenceStatus === "rejected"
        ? `버전 ${revision} 무효로 표시됨`
        : "현재 버전에 비교 증거가 없습니다";
  const systems = [
    { label: "유효 메시", value: ratio(validMeshes, project.layers.length), note: `윤곽 메시 ${artMeshes}개, 나머지는 규칙 메시`, icon: Boxes },
    { label: "시맨틱 인식", value: ratio(semanticCoverage, project.layers.length), note: `레이어 ${semanticCoverage}/${project.layers.length}개`, icon: ScanEye },
    { label: "파라미터 시스템", value: Math.min(100, Math.round(project.model.parameters.length / 11 * 100)), note: `파라미터 ${project.model.parameters.length}개`, icon: SlidersHorizontal },
    { label: "검수 증거", value: evidenceReadiness, note: evidenceNote, icon: CheckCircle2 }
  ];
  const expressionStatus = systemStatus(project.model.expressions.length);
  const physicsStatus = project.model.physics.length > 0
    ? { tone: "ready", label: "구성됨" }
    : { tone: "ready", label: "자동 다이내믹" };
  const behaviorStatus = systemStatus(project.model.behaviors.length, "구성됨");
  return <aside className="studio-side-panel studio-inspector overview-inspector">
    <div className="panel-eyebrow">준비 상태</div><h2>프로젝트 완성도</h2>
    <div className="quality-hero"><span>안전 계수</span><strong>{project.quality.safetyScale.toFixed(2)}</strong><small>버전 {revision} · {project.rigLevel === "semantic" ? "전체 시맨틱 바인딩" : project.rigLevel === "grouped" ? "그룹 바인딩" : "기본 바인딩"}</small></div>
    <div className="readiness-list">{systems.map((item) => { const Icon = item.icon; return <div key={item.label} className="readiness-row"><Icon aria-hidden="true" /><div><strong>{item.label}</strong><small>{item.note}</small></div><output>{item.value}%</output><span><i style={{ width: `${item.value}%` }} /></span></div>; })}</div>
    <h3>고급 시스템</h3>
    <div className="system-status-grid">
      <div><Drama aria-hidden="true" /><span className={expressionStatus.tone}>{expressionStatus.label}</span><strong>표정</strong><small>{project.model.expressions.length}개</small></div>
      <div><Activity aria-hidden="true" /><span className={physicsStatus.tone}>{physicsStatus.label}</span><strong>파라미터 물리</strong><small>{project.model.physics.length > 0 ? `스프링 ${project.model.physics.length}개` : "부위별 2차 모션이 켜져 있습니다"}</small></div>
      <div><Workflow aria-hidden="true" /><span className={behaviorStatus.tone}>{behaviorStatus.label}</span><strong>동작</strong><small>{project.model.behaviors.length}개</small></div>
    </div>
    <p className="benchmark-note">PuppetLoom은 Cubism의 수작업 흐름을 그대로 복제할 필요는 없지만, 자동 생성된 구조·파라미터·다이내믹 시스템을 보고 조정하고 검수할 수 있어야 합니다.</p>
  </aside>;
}

export function ParameterLeftPanel({ project, selectedId, onSelect }: { project: PuppetLoomProject; selectedId: string; onSelect: (id: string) => void }): React.JSX.Element {
  const groups = [...new Set(project.model.parameters.map((parameter) => parameter.group))];
  return <aside className="studio-side-panel parameter-list-panel">
    <div className="panel-eyebrow">파라미터</div><h2>파라미터 컨트롤러</h2>
    <p className="panel-intro">파라미터는 용도별로 묶여 있습니다. 선택하면 범위와 시맨틱을 보고 화면을 실시간으로 조작할 수 있습니다.</p>
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
    <div className="panel-eyebrow">실시간 제어</div><h2>자세·파라미터</h2>
    <section className="pose-controller"><div className="section-heading"><div><h3>9방향 머리 제어</h3><small>Cubism의 2D 파라미터 컨트롤러와 같으며, 클릭하면 조합 자세를 확인할 수 있습니다</small></div><output>{state.headYaw.toFixed(2)}, {state.headPitch.toFixed(2)}</output></div>
      <div className="pose-pad">{[-0.82, 0, 0.82].flatMap((pitch) => [-0.88, 0, 0.88].map((yaw) => <button key={`${yaw}-${pitch}`} className={Math.abs(state.headYaw - yaw) < .01 && Math.abs(state.headPitch - pitch) < .01 ? "active" : ""} aria-label={`머리 자세 ${yaw}, ${pitch}`} onClick={() => onPose(yaw, pitch)}><span /></button>))}</div>
    </section>
    {parameter && <section className="selected-parameter"><div className="section-heading"><div><h3>{parameter.semantic ? semanticLabels[parameter.semantic] : parameter.name}</h3><small>{parameter.id}</small></div><output>{current.toFixed(2)}</output></div><input type="range" min={parameter.min} max={parameter.max} step={(parameter.max - parameter.min) / 200} value={current} onChange={(event) => onParameter(parameter.id, Number(event.target.value))} /><div className="range-scale"><span>{parameter.min}</span><button className="with-icon" onClick={() => onParameter(parameter.id, parameter.default)}><RotateCcw aria-hidden="true" />기본값으로</button><span>{parameter.max}</span></div></section>}
    <section className="quick-parameters"><h3>자주 쓰는 검사</h3>{stateLabels.map((item) => { const raw = state[item.key]; const value = typeof raw === "number" ? raw : 0; const available = !item.semantic || isMotionSemanticAvailable(project, item.semantic); return <label className={`range-row ${available ? "" : "is-unavailable"}`} key={String(item.key)}><span>{item.label}{!available && <small>소재 없음</small>}<output>{value.toFixed(2)}</output></span><input disabled={!available} type="range" min={item.min} max={item.max} step={item.step} value={value} onChange={(event) => onState(item.key, Number(event.target.value))} /></label>; })}</section>
    {project.model.expressions.some((expression) => isModelExpressionAvailable(project, expression)) && <section className="expression-mixer"><h3>표정 믹스</h3>{project.model.expressions.filter((expression) => isModelExpressionAvailable(project, expression)).map((expression) => { const value = state.expressions?.[expression.id] ?? 0; return <label className="range-row" key={expression.id}><span>{expression.name}<output>{value.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.01" value={value} onChange={(event) => onExpression(expression.id, Number(event.target.value))} /></label>; })}</section>}
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
    <div className="panel-eyebrow">다이내믹</div><h2>다이내믹 시스템</h2>
    {needsStarter && <button className="starter-system-action starter-dynamics-action" onClick={onCreateStarter}><span className="starter-system-icon" aria-hidden="true"><Sparkles /></span><span><strong>기본 다이내믹 시스템 보완</strong><small>현재 소재가 실제로 지원하고 아직 없는 표정, 자연 대기, 끄덕임 동작만 만듭니다</small></span></button>}
    <div className="system-catalog">
      <section><h3><span><Drama aria-hidden="true" />표정</span><output>{availableExpressions.length}/{project.model.expressions.length}</output></h3>{project.model.expressions.length === 0 ? <p>이 프로젝트에는 아직 독립 표정 프리셋이 없습니다.</p> : <div className="catalog-grid">{project.model.expressions.map((expression) => { const Icon = expressionIcon(expression.name, expression.id); const available = isModelExpressionAvailable(project, expression); return <div className={`catalog-card ${available ? "" : "is-unavailable"}`} title={available ? expression.name : `${expression.name} · 해당 소재 없음`} key={expression.id}><span className="catalog-card-icon" aria-hidden="true"><Icon /></span><span className="catalog-card-copy"><strong>{expression.name}</strong><small>{available ? `파라미터 ${Object.keys(expression.parameters).length}개` : "소재 없음, 비활성"}</small></span></div>; })}</div>}</section>
      <section><h3><span><Activity aria-hidden="true" />파라미터 물리</span><output>{project.model.physics.length}</output></h3>{project.model.physics.length === 0 ? <p>이 프로젝트는 자동 부위별 2차 모션을 사용하며, 파라미터 스프링은 아직 구성되지 않았습니다.</p> : <div className="catalog-grid">{project.model.physics.map((physics) => <div className="catalog-card" title={`${physics.name} · ${physics.inputParameterId} → ${physics.outputParameterId}`} key={physics.id}><span className="catalog-card-icon" aria-hidden="true"><Activity /></span><span className="catalog-card-copy"><strong>{physics.name}</strong><small>{physics.inputParameterId} → {physics.outputParameterId}</small></span></div>)}</div>}</section>
      <section><h3><span><Workflow aria-hidden="true" />동작 클립</span><output>{availableBehaviors.length}/{project.model.behaviors.length}</output></h3>{project.model.behaviors.length === 0 ? <p>자율 미리보기는 계속 실행할 수 있습니다. 이름 있는 동작 클립은 아직 없습니다.</p> : <div className="catalog-grid">{project.model.behaviors.map((behavior) => { const Icon = behavior.loop ? Repeat2 : Play; const available = isModelBehaviorAvailable(project, behavior); return <button disabled={!available} className={`catalog-card ${selectedBehaviorId === behavior.id && available ? "active" : ""} ${available ? "" : "is-unavailable"}`} aria-pressed={selectedBehaviorId === behavior.id && available} title={available ? `${behavior.name} · ${behavior.duration.toFixed(2)}s · ${behavior.loop ? "반복" : "한 번"} · 트랙 ${behavior.tracks.length}개` : `${behavior.name} · 해당 소재 없음`} key={behavior.id} onClick={() => onBehavior(behavior.id)}><span className="catalog-card-icon" aria-hidden="true"><Icon /></span><span className="catalog-card-copy"><strong>{behavior.name}</strong><small>{available ? `${behavior.duration.toFixed(2)}s · ${behavior.loop ? "반복" : "한 번"} · 트랙 ${behavior.tracks.length}개` : "소재 없음, 비활성"}</small></span></button>; })}</div>}</section>
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
    <div className="panel-eyebrow">실시간 다이내믹</div><h2>표정·물리 확인</h2>
    <section><div className="section-heading"><div><h3 className="with-icon"><Drama aria-hidden="true" />표정 믹스</h3><small>여러 표정을 겹칠 수 있으며 화면이 바로 갱신됩니다</small></div></div>{availableExpressions.length === 0 ? <div className="empty-system"><strong>사용 가능한 독립 표정이 없습니다</strong><span>{project.model.expressions.length > 0 ? "기존 프리셋이 없는 소재에 의존해 비활성화되었습니다." : "해당 소재가 있으면 눈 깜빡임과 입 모양 표정을 생성해 바로 확인할 수 있습니다."}</span></div> : availableExpressions.map((expression) => { const value = state.expressions?.[expression.id] ?? 0; return <label className="range-row" key={expression.id}><span>{expression.name}<output>{value.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.01" value={value} onChange={(event) => onExpression(expression.id, Number(event.target.value))} /></label>; })}</section>
    <section><div className="section-heading"><div><h3 className="with-icon"><Play aria-hidden="true" />동작 재생</h3><small>애니메이션 타임라인처럼 이름 있는 동작을 확인하세요</small></div></div>{behavior ? <><div className="transport-row"><button className={`${behaviorPlaying ? "active" : ""} with-icon`} onClick={() => onBehaviorPlaying(!behaviorPlaying)}>{behaviorPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{behaviorPlaying ? "일시 정지" : "재생"}</button><strong>{behavior.name}</strong><output>{behaviorTime.toFixed(2)} / {behavior.duration.toFixed(2)}s</output></div><input className="timeline-range" type="range" min="0" max={behavior.duration} step="0.01" value={Math.min(behaviorTime, behavior.duration)} onChange={(event) => onBehaviorTime(Number(event.target.value))} /><div className="track-summary">{behavior.tracks.map((track) => <span key={`${track.target.kind}-${track.target.id}`}>{track.target.kind === "parameter" ? "파라미터" : "표정"} · {track.target.id} · {track.keyframes.length}프레임</span>)}</div></> : <div className="empty-system"><strong>동작 클립이 아직 없습니다</strong><span>상단의 “자율 미리보기”로 자동 호흡, 눈 깜빡임, 2차 모션을 계속 확인할 수 있습니다.</span></div>}</section>
    <section><div className="section-heading"><div><h3 className="with-icon"><Waves aria-hidden="true" />부위별 2차 모션</h3><small>조절하면 바로 캘리브레이션 초안에 들어갑니다</small></div></div><label>부위<select value={secondaryPart} onChange={(event) => onSecondaryPart(event.target.value as SecondaryMotionPart)}>{secondaryParts.map((part) => <option key={part.id} value={part.id}>{part.label}</option>)}</select></label>{(["amplitude", "response", "stability"] as const).map((key) => <label className="range-row" key={key}><span>{key === "amplitude" ? "진폭" : key === "response" ? "반응" : "안정"}<output>{secondaryTuning[key].toFixed(2)}</output></span><input type="range" min="0" max={key === "amplitude" ? "1.5" : "1"} step="0.01" value={secondaryTuning[key]} onChange={(event) => onSecondaryTuning(secondaryPart, key, Number(event.target.value))} /></label>)}</section>
    {project.model.physics.length > 0 && <section><h3 className="with-icon"><Activity aria-hidden="true" />파라미터 스프링</h3>{project.model.physics.map((physics) => <article className="physics-card" key={physics.id}><strong>{physics.name}</strong><small>{physics.inputParameterId} → {physics.outputParameterId}</small>{(["inputScale", "outputScale", "response", "damping"] as const).map((key) => <label className="range-row" key={key}><span>{key === "inputScale" ? "입력 강도" : key === "outputScale" ? "출력 강도" : key === "response" ? "반응 속도" : "감쇠"}<output>{physics[key].toFixed(2)}</output></span><input type="range" min={key === "damping" ? "0" : key === "response" ? "0.1" : "-4"} max={key === "damping" ? "4" : key === "response" ? "30" : "4"} step="0.05" value={physics[key]} onChange={(event) => onPhysics(physics.id, { [key]: Number(event.target.value) })} /></label>)}</article>)}</section>}
  </aside>;
}

const previewSamples: Array<{ id: string; label: string; detail: string; state: Partial<MotionState>; icon: LucideIcon; feature?: "blink" | "mouth-open" }> = [
  { id: "neutral", label: "중립 기준", detail: "레이어 맞춤, 투명 가장자리, 기본 자세 확인", state: {}, icon: RotateCcw },
  { id: "left", label: "머리 왼쪽", detail: "얼굴형, 머리카락 가림, 이목구비 추종 확인", state: { headYaw: -.9, gazeX: -.35, bodySway: -.25 }, icon: ArrowLeft },
  { id: "right", label: "머리 오른쪽", detail: "좌우 대칭과 레이어 뚫림 확인", state: { headYaw: .9, gazeX: .35, bodySway: .25 }, icon: ArrowRight },
  { id: "up", label: "고개 들기", detail: "턱, 목, 뒷머리 이음 확인", state: { headPitch: -.78, gazeY: -.25, bodyPitch: -.2 }, icon: ArrowUp },
  { id: "down", label: "고개 숙이기", detail: "앞머리, 눈, 얼굴 압축 확인", state: { headPitch: .78, gazeY: .25, bodyPitch: .2 }, icon: ArrowDown },
  { id: "left-up", label: "왼쪽 위", detail: "왼쪽+고개 들기 겹침 윤곽 확인", state: { headYaw: -.9, headPitch: -.78, gazeX: -.35, gazeY: -.25, bodySway: -.25, bodyPitch: -.2 }, icon: ArrowUpLeft },
  { id: "right-up", label: "오른쪽 위", detail: "오른쪽+고개 들기 겹침 윤곽 확인", state: { headYaw: .9, headPitch: -.78, gazeX: .35, gazeY: -.25, bodySway: .25, bodyPitch: -.2 }, icon: ArrowUpRight },
  { id: "left-down", label: "왼쪽 아래", detail: "왼쪽+고개 숙이기 겹침 가림 확인", state: { headYaw: -.9, headPitch: .78, gazeX: -.35, gazeY: .25, bodySway: -.25, bodyPitch: .2 }, icon: ArrowDownLeft },
  { id: "right-down", label: "오른쪽 아래", detail: "오른쪽+고개 숙이기 겹침 가림 확인", state: { headYaw: .9, headPitch: .78, gazeX: .35, gazeY: .25, bodySway: .25, bodyPitch: .2 }, icon: ArrowDownRight },
  { id: "blink", label: "눈 감기", detail: "눈꺼풀 교체와 속눈썹 가림 확인", state: { blink: 1 }, icon: EyeOff, feature: "blink" },
  { id: "mouth", label: "입 열기", detail: "입 모양 레이어와 클리핑 관계 확인", state: { mouthOpen: 1 }, icon: Smile, feature: "mouth-open" }
];

export function PreviewLeftPanel({ project, activeSample, onSample }: { project: PuppetLoomProject; activeSample: string; onSample: (id: string, state: Partial<MotionState>) => void }): React.JSX.Element {
  return <aside className="studio-side-panel preview-samples-panel">
    <div className="panel-eyebrow">검수 샘플</div><h2>검수 자세</h2>
    <p className="panel-intro">9방향 머리 자세와 눈 감기·입 열기까지 고정 샘플 11개입니다. 소재가 없는 샘플은 명확히 비활성화됩니다.</p>
    <div className="preview-sample-list">{previewSamples.map((sample) => {
      const Icon = sample.icon;
      const available = !sample.feature || isMotionSemanticAvailable(project, sample.feature);
      return <button disabled={!available} className={`${activeSample === sample.id ? "active" : ""} ${available ? "" : "is-unavailable"}`} aria-pressed={activeSample === sample.id && available} key={sample.id} onClick={() => onSample(sample.id, sample.state)}><span aria-hidden="true"><Icon /></span><div><strong>{sample.label}</strong><small>{available ? sample.detail : "소재 없음. 이 프로젝트에서는 이 항목을 검사하지 않습니다"}</small></div></button>;
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
    { label: "얼굴 9방향 자세", ready: Boolean(project.runtime.semanticCage), icon: ScanEye },
    { label: "시선 추종", ready: project.runtime.features.gaze, icon: Eye },
    { label: "눈 깜빡임", ready: project.runtime.features.blink, icon: EyeOff },
    { label: "입 모양", ready: project.runtime.features.mouthMotion, icon: Smile },
    { label: "부위별 2차 모션", ready: project.layers.some((layer) => layer.weights.physics > 0), icon: Waves },
    { label: "모든 레이어 메시 유효", ready: validMeshes, icon: Boxes }
  ];
  const visualChecks = [
    { id: "head-poses", label: "9방향 머리 자세에 뚫림 없음" },
    ...(project.runtime.features.blink ? [{ id: "blink", label: "눈 감기 교체와 속눈썹 가림이 정상" }] : []),
    ...(project.runtime.features.mouthMotion ? [{ id: "mouth", label: "입 열기 모양과 클리핑 관계가 정상" }] : []),
    { id: "checker", label: "투명 배경 가장자리가 정상" },
    { id: "dark", label: "어두운 배경 가장자리가 정상" },
    { id: "light", label: "밝은 배경 가장자리가 정상" }
  ];
  const visualComplete = visualChecks.every((item) => manualChecks[item.id]);
  const backgroundModes: Array<{ id: PreviewBackground; label: string; icon: LucideIcon }> = [{ id: "checker", label: "투명", icon: Grid2X2 }, { id: "dark", label: "어두움", icon: Moon }, { id: "light", label: "밝음", icon: Sun }];
  return <aside className="studio-side-panel studio-inspector preview-inspector">
    <div className="panel-eyebrow">최종 화면</div><h2>깨끗한 미리보기</h2>
    <section><h3>화면 모드</h3><div className="segmented-control">{backgroundModes.map((item) => { const Icon = item.icon; return <button className={`${background === item.id ? "active" : ""} with-icon`} aria-pressed={background === item.id} key={item.id} onClick={() => onBackground(item.id)}><Icon aria-hidden="true" />{item.label}</button>; })}</div><button className="wide-action with-icon" onClick={() => onFocused(!focused)}>{focused ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}{focused ? "몰입 미리보기 종료" : "몰입 미리보기 (Esc로 종료)"}</button><button className={`wide-action ${autonomous ? "active" : ""} with-icon`} onClick={() => onAutonomous(!autonomous)}>{autonomous ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{autonomous ? "자율 동작 일시 정지" : "자율 동작 재생"}</button><button className="wide-action primary-action with-icon" onClick={onLaunch}><ExternalLink aria-hidden="true" />별도 캐릭터 창에서 실행</button></section>
    <section><h3>시스템 기능</h3><div className="qa-checks">{checks.map((check) => { const Icon = check.icon; const StatusIcon = check.ready ? CheckCircle2 : TriangleAlert; return <div key={check.label}><Icon className="qa-check-icon" aria-hidden="true" /><strong>{check.label}</strong><span className={check.ready ? "ready" : "review"}><StatusIcon aria-hidden="true" />{check.ready ? "사용 가능" : "소재 없음"}</span></div>; })}</div></section>
    <section><h3>이번 육안 검수</h3><div className="manual-qa-checks">{visualChecks.map((item) => <label key={item.id}><input type="checkbox" checked={Boolean(manualChecks[item.id])} onChange={(event) => onManualCheck(item.id, event.target.checked)} />{item.label}</label>)}</div><strong className={visualComplete ? "qa-complete" : "qa-incomplete"}>{visualComplete ? "이번 검수가 완료되었습니다" : "아직 확인하지 않은 항목이 있습니다"}</strong></section>
    <section className="preview-evidence-section"><h3>버전 증거</h3>{sessions.length === 0 ? <p>버전 {revision}에는 저장된 캘리브레이션이 없어 비교 증거가 없습니다.</p> : <div className="preview-evidence-list">{sessions.map((session) => <article key={session.id} className={session.toRevision === revision ? "active" : ""}><div><strong>버전 {session.toRevision} · {session.label}</strong><small>{session.evidenceStatus === "accepted" ? "확인됨" : session.evidenceStatus === "rejected" ? "무효로 표시됨" : "검수 대기"}</small></div><span><button disabled={busy} className="with-icon" onClick={() => onShowEvidence(session.id)}><Eye aria-hidden="true" />비교</button><button disabled={busy || session.evidenceStatus === "accepted"} className="with-icon" onClick={() => onMarkEvidence(session.id, "accepted")}><CheckCircle2 aria-hidden="true" />확인</button><button disabled={busy || session.evidenceStatus === "rejected"} className="with-icon" onClick={() => onMarkEvidence(session.id, "rejected")}><Ban aria-hidden="true" />무효</button></span></article>)}</div>}</section>
    <p className="benchmark-note">육안 체크는 현재 편집 개정에만 유지됩니다. 프로젝트나 초안이 바뀌면 자동으로 초기화되며, 작업 영역을 바꿔도 사라지지 않습니다.</p>
  </aside>;
}
