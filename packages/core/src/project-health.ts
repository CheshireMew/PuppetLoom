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
  for (const path of report.missingTextures) issues.push({ code: "missing-texture", severity: "error", category: "files", message: `纹理缺失：${path}`, suggestion: "恢复纹理文件，或从仍然匹配的源 PSD 重新创建项目。" });
  for (const item of report.invalidTextures) issues.push({ code: "invalid-texture", severity: "error", category: "files", message: `${item.path}：${item.reason}`, suggestion: "不要手工替换项目纹理；使用补充素材或迁移流程产生新 revision。" });
  for (const message of report.sourceIssues) issues.push({ code: "source-integrity", severity: "error", category: "source", message, suggestion: "恢复原始源文件；源 PSD 确实更新时使用 migrate 创建新项目。" });
  for (const message of report.historyIssues) issues.push({ code: "history-integrity", severity: "error", category: "history", message, suggestion: "停止继续写入并从最后一个可验证 revision 恢复。" });
  for (const message of report.evidenceIssues) issues.push({ code: "evidence-integrity", severity: "error", category: "evidence", message, suggestion: "重新生成对应 revision 的证据，不能用缺失证据的版本作为交付基线。" });
  for (const pose of report.quality.poseValidations.filter((item) => !item.passed)) issues.push({ code: `unsafe-pose:${pose.id}`, severity: "error", category: "rig", message: `姿态 ${pose.id} 未通过安全检查。`, suggestion: "检查根部连接、作用权重与安全包络，再保存新的校准 revision。" });
}

function productionAssetIssues(project: PuppetLoomProject, issues: ProjectHealthIssue[]): ProjectCapabilitySummary["missingProductionAssets"] {
  const missing: ProjectCapabilitySummary["missingProductionAssets"] = [];
  if (!project.runtime.features.blink) {
    missing.push("closed-eyes");
    issues.push({ code: "missing-closed-eyes", severity: "warning", category: "assets", message: "项目缺少通过验证的左右闭眼素材，眨眼不可用。", suggestion: "完成 requests/asset-requests.json 中的闭眼素材并通过 enhance 接入。" });
  }
  if (!project.runtime.features.mouthMotion) {
    missing.push("mouth-shapes");
    issues.push({ code: "missing-mouth-shapes", severity: "warning", category: "assets", message: "项目缺少完整嘴形素材，实时口型不可用。", suggestion: "补齐闭合、微张和张开素材；口型 2.0 项目还可以继续提供视素素材。" });
  }
  return missing;
}

function healthScore(issues: ProjectHealthIssue[]): number {
  const deduction = issues.reduce((sum, issue) => sum + (issue.severity === "error" ? 25 : issue.severity === "warning" ? 7 : 2), 0);
  return Math.max(0, 100 - deduction);
}

function actionsFor(issues: ProjectHealthIssue[], pendingEvidence: number, draftPresent: boolean): string[] {
  const actions: string[] = [];
  if (issues.some((issue) => issue.severity === "error")) actions.push("先处理文件、历史或姿态错误，再继续制作。" );
  if (pendingEvidence > 0) actions.push(`目视检查并确认或拒绝 ${pendingEvidence} 条待验收 revision 证据。`);
  if (draftPresent) actions.push("项目存在未提交草稿：保存为 revision，或明确放弃草稿。" );
  for (const issue of issues) if (issue.suggestion && !actions.includes(issue.suggestion)) actions.push(issue.suggestion);
  if (actions.length === 0) actions.push("项目文件、历史、证据和运行能力均已就绪。" );
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
  if (unreviewed > 0) issues.push({ code: "pending-evidence", severity: "warning", category: "evidence", message: `${unreviewed} 条 revision 证据尚未目视验收。`, suggestion: "在编辑器的版本证据区逐条确认或标记无效。" });
  if (rejected > 0) issues.push({ code: "rejected-evidence", severity: "info", category: "evidence", message: `${rejected} 条历史 revision 已标记无效；它们仍保留用于审计。` });
  if (draft) issues.push({ code: "uncommitted-draft", severity: "warning", category: "history", message: "项目存在尚未提交的校准草稿。" });
  if (performances.incompleteVideos > 0) issues.push({ code: "incomplete-recording", severity: "warning", category: "performance", message: `${performances.incompleteVideos} 个视频录制尚未完成收尾。`, suggestion: "在 Take 库中检查并恢复或归档 partial 录制。" });
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
