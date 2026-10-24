import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isModelBehaviorAvailable, isModelExpressionAvailable } from "./runtime-capabilities.js";
import { listCalibrationSessions, loadCalibration, loadCalibrationDraft, loadProject } from "./project.js";
import type { PuppetLoomProject } from "./types.js";
import { verifyProject } from "./verify.js";

export type ProjectHealthSeverity = "error" | "warning" | "info";
export type ProjectHealthCategory = "files" | "source" | "history" | "evidence" | "rig" | "assets" | "performance";

export interface ProjectHealthIssue {
  code: string;
  severity: ProjectHealthSeverity;
  category: ProjectHealthCategory;
  message: string;
  suggestion?: string;
}

export interface ProjectCapabilitySummary {
  rigLevel: PuppetLoomProject["rigLevel"];
  safetyScale: number;
  layers: number;
  recognizedLayers: number;
  parameters: number;
  expressions: { total: number; available: number };
  behaviors: { total: number; available: number };
  features: PuppetLoomProject["runtime"]["features"];
  missingProductionAssets: Array<"closed-eyes" | "mouth-shapes">;
  production: {
    variantGroups: number;
    variantOptions: number;
    props: number;
    presets: number;
    motionLimits: number;
    collisions: number;
  };
}

export interface ProjectHealthReport {
  version: 1;
  generatedAt: string;
  projectDirectory: string;
  project: string;
  revision: number;
  valid: boolean;
  score: number;
  capabilities: ProjectCapabilitySummary;
  evidence: { total: number; accepted: number; rejected: number; unreviewed: number };
  draft: { present: boolean; updatedAt?: string; label?: string };
  performances: { videos: number; inputSessions: number; takes: number; incompleteVideos: number };
  issues: ProjectHealthIssue[];
  nextActions: string[];
}

export interface ProjectLibraryReport {
  version: 1;
  generatedAt: string;
  root: string;
  projects: ProjectHealthReport[];
  failures: Array<{ directory: string; message: string }>;
  summary: {
    total: number;
    valid: number;
    needsAttention: number;
    averageScore: number;
    missingClosedEyes: number;
    missingMouthShapes: number;
    pendingEvidence: number;
  };
}

async function performanceSummary(root: string): Promise<ProjectHealthReport["performances"]> {
  const directory = join(root, "reports", "performances");
  let entries: Dirent[];
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else throw cause;
  }
  let takes = 0;
  try {
    takes = (await readdir(join(root, "performances", "takes"), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".take.json")).length;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return {
    videos: entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".webm") && !entry.name.toLowerCase().endsWith(".partial.webm")).length,
    inputSessions: entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".input.json")).length,
    takes,
    incompleteVideos: entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".partial.webm")).length
  };
}

function pushVerificationIssues(issues: ProjectHealthIssue[], report: Awaited<ReturnType<typeof verifyProject>>): void {
  for (const path of report.missingTextures) issues.push({ code: "missing-texture", severity: "error", category: "files", message: `텍스처가 없습니다: ${path}`, suggestion: "텍스처 파일을 복원하거나, 여전히 일치하는 원본 PSD에서 프로젝트를 다시 만드세요." });
  for (const item of report.invalidTextures) issues.push({ code: "invalid-texture", severity: "error", category: "files", message: `${item.path}: ${item.reason}`, suggestion: "프로젝트 텍스처를 수동으로 바꾸지 마세요. 보충 소재나 마이그레이션으로 새 revision을 만드세요." });
  for (const message of report.sourceIssues) issues.push({ code: "source-integrity", severity: "error", category: "source", message, suggestion: "원본 소스 파일을 복원하세요. 소스 PSD가 실제로 바뀌었다면 migrate로 새 프로젝트를 만드세요." });
  for (const message of report.historyIssues) issues.push({ code: "history-integrity", severity: "error", category: "history", message, suggestion: "추가 기록을 멈추고 마지막으로 검증 가능한 revision에서 복원하세요." });
  for (const message of report.evidenceIssues) issues.push({ code: "evidence-integrity", severity: "error", category: "evidence", message, suggestion: "해당 revision의 증거를 다시 생성하세요. 증거가 없는 버전은 납품 기준으로 쓸 수 없습니다." });
  for (const pose of report.quality.poseValidations.filter((item) => !item.passed)) issues.push({ code: `unsafe-pose:${pose.id}`, severity: "error", category: "rig", message: `포즈 ${pose.id}가 안전 검사를 통과하지 못했습니다.`, suggestion: "루트 연결, 영향 가중치, 안전 엔벨로프를 확인한 뒤 새 캘리브레이션 revision을 저장하세요." });
}

function productionAssetIssues(project: PuppetLoomProject, issues: ProjectHealthIssue[]): ProjectCapabilitySummary["missingProductionAssets"] {
  const missing: ProjectCapabilitySummary["missingProductionAssets"] = [];
  if (!project.runtime.features.blink) {
    missing.push("closed-eyes");
    issues.push({ code: "missing-closed-eyes", severity: "warning", category: "assets", message: "프로젝트에 검증된 좌우 눈 감기 소재가 없어 깜빡임을 사용할 수 없습니다.", suggestion: "requests/asset-requests.json의 눈 감기 소재를 완료하고 enhance로 연결하세요." });
  }
  if (!project.runtime.features.mouthMotion) {
    missing.push("mouth-shapes");
    issues.push({ code: "missing-mouth-shapes", severity: "warning", category: "assets", message: "프로젝트에 완전한 입 모양 소재가 없어 실시간 립싱크를 사용할 수 없습니다.", suggestion: "닫힘, 살짝 열림, 열림 소재를 채우세요. 립싱크 2.0 프로젝트는 viseme 소재를 추가로 제공할 수 있습니다." });
  }
  return missing;
}

function healthScore(issues: ProjectHealthIssue[]): number {
  const deduction = issues.reduce((sum, issue) => sum + (issue.severity === "error" ? 25 : issue.severity === "warning" ? 7 : 2), 0);
  return Math.max(0, 100 - deduction);
}

function actionsFor(issues: ProjectHealthIssue[], pendingEvidence: number, draftPresent: boolean): string[] {
  const actions: string[] = [];
  if (issues.some((issue) => issue.severity === "error")) actions.push("파일, 기록, 포즈 오류를 먼저 처리한 뒤 제작을 계속하세요.");
  if (pendingEvidence > 0) actions.push(`${pendingEvidence}개의 검수 대기 revision 증거를 육안으로 확인하거나 거부하세요.`);
  if (draftPresent) actions.push("커밋되지 않은 초안이 있습니다. revision으로 저장하거나 초안을 명시적으로 버리세요.");
  for (const issue of issues) if (issue.suggestion && !actions.includes(issue.suggestion)) actions.push(issue.suggestion);
  if (actions.length === 0) actions.push("프로젝트 파일, 기록, 증거, 런타임 기능이 모두 준비되었습니다.");
  return actions;
}

/** Produces one stable, user-facing health report without modifying the project. */
export async function inspectProjectHealth(projectDirectory: string): Promise<ProjectHealthReport> {
  const root = resolve(projectDirectory);
  const [project, calibration, sessions, draft, verification, performances] = await Promise.all([
    loadProject(root), loadCalibration(root), listCalibrationSessions(root), loadCalibrationDraft(root), verifyProject(root), performanceSummary(root)
  ]);
  const issues: ProjectHealthIssue[] = [];
  pushVerificationIssues(issues, verification);
  const missingProductionAssets = productionAssetIssues(project, issues);
  const unreviewed = sessions.filter((session) => session.evidenceStatus === "unreviewed").length;
  const rejected = sessions.filter((session) => session.evidenceStatus === "rejected").length;
  const accepted = sessions.filter((session) => session.evidenceStatus === "accepted").length;
  if (unreviewed > 0) issues.push({ code: "pending-evidence", severity: "warning", category: "evidence", message: `${unreviewed}개의 revision 증거가 아직 육안 검수되지 않았습니다.`, suggestion: "편집기의 버전 증거 영역에서 항목별로 확인하거나 무효로 표시하세요." });
  if (rejected > 0) issues.push({ code: "rejected-evidence", severity: "info", category: "evidence", message: `${rejected}개의 기록 revision이 무효로 표시되었습니다. 감사 용도로 계속 보관됩니다.` });
  if (draft) issues.push({ code: "uncommitted-draft", severity: "warning", category: "history", message: "아직 커밋되지 않은 캘리브레이션 초안이 있습니다." });
  if (performances.incompleteVideos > 0) issues.push({ code: "incomplete-recording", severity: "warning", category: "performance", message: `${performances.incompleteVideos}개의 비디오 녹화가 아직 마무리되지 않았습니다.`, suggestion: "Take 라이브러리에서 partial 녹화를 확인하고 복원하거나 보관하세요." });
  const recognizedLayers = project.layers.filter((layer) => layer.role !== "unknown").length;
  const availableExpressions = project.model.expressions.filter((expression) => isModelExpressionAvailable(project, expression)).length;
  const availableBehaviors = project.model.behaviors.filter((behavior) => isModelBehaviorAvailable(project, behavior)).length;
  const production = project.production;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectDirectory: root,
    project: project.name,
    revision: calibration.revision,
    valid: verification.valid,
    score: healthScore(issues),
    capabilities: {
      rigLevel: project.rigLevel,
      safetyScale: project.quality.safetyScale,
      layers: project.layers.length,
      recognizedLayers,
      parameters: project.model.parameters.length,
      expressions: { total: project.model.expressions.length, available: availableExpressions },
      behaviors: { total: project.model.behaviors.length, available: availableBehaviors },
      features: { ...project.runtime.features },
      missingProductionAssets,
      production: {
        variantGroups: production?.variants.length ?? 0,
        variantOptions: production?.variants.reduce((sum, group) => sum + group.options.length, 0) ?? 0,
        props: production?.props.length ?? 0,
        presets: production?.presets.length ?? 0,
        motionLimits: project.runtime.constraints?.motionLimits.length ?? 0,
        collisions: project.runtime.constraints?.collisions.length ?? 0
      }
    },
    evidence: { total: sessions.length, accepted, rejected, unreviewed },
    draft: { present: Boolean(draft), ...(draft ? { updatedAt: draft.updatedAt, ...(draft.label ? { label: draft.label } : {}) } : {}) },
    performances,
    issues,
    nextActions: actionsFor(issues, unreviewed, Boolean(draft))
  };
}

const skippedLibraryDirectories = new Set([".git", "node_modules", "dist", "build", "test", "archive"]);

async function findProjectDirectories(root: string, maxDepth: number, maximumProjects: number): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (found.length >= maximumProjects || depth > maxDepth) return;
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    if (entries.some((entry) => entry.isFile() && entry.name === "puppetloom.json")) {
      found.push(directory);
      return;
    }
    for (const entry of entries) {
      if (found.length >= maximumProjects) break;
      if (!entry.isDirectory() || entry.isSymbolicLink() || skippedLibraryDirectories.has(entry.name)) continue;
      await visit(join(directory, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return found;
}

/** Scans a bounded user-selected root and returns health reports for every project found. */
export async function scanProjectLibrary(rootDirectory: string, options: { maxDepth?: number; maximumProjects?: number } = {}): Promise<ProjectLibraryReport> {
  const root = resolve(rootDirectory);
  const maxDepth = Math.max(0, Math.min(8, options.maxDepth ?? 4));
  const maximumProjects = Math.max(1, Math.min(500, options.maximumProjects ?? 200));
  const directories = await findProjectDirectories(root, maxDepth, maximumProjects);
  const projects: ProjectHealthReport[] = [];
  const failures: ProjectLibraryReport["failures"] = [];
  for (let start = 0; start < directories.length; start += 4) {
    const batch = await Promise.all(directories.slice(start, start + 4).map(async (directory) => {
      try { return { report: await inspectProjectHealth(directory) }; }
      catch (cause) { return { failure: { directory, message: cause instanceof Error ? cause.message : String(cause) } }; }
    }));
    for (const item of batch) {
      if ("report" in item && item.report) projects.push(item.report);
      else if ("failure" in item && item.failure) failures.push(item.failure);
    }
  }
  projects.sort((left, right) => left.project.localeCompare(right.project, "zh-CN"));
  const pendingEvidence = projects.reduce((sum, project) => sum + project.evidence.unreviewed, 0);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    projects,
    failures,
    summary: {
      total: projects.length,
      valid: projects.filter((project) => project.valid).length,
      needsAttention: projects.filter((project) => project.issues.some((issue) => issue.severity !== "info")).length + failures.length,
      averageScore: projects.length === 0 ? 0 : Number((projects.reduce((sum, project) => sum + project.score, 0) / projects.length).toFixed(2)),
      missingClosedEyes: projects.filter((project) => project.capabilities.missingProductionAssets.includes("closed-eyes")).length,
      missingMouthShapes: projects.filter((project) => project.capabilities.missingProductionAssets.includes("mouth-shapes")).length,
      pendingEvidence
    }
  };
}
