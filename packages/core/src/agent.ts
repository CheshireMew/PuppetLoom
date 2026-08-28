import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyAuthoringOperations, buildAuthoringAudit } from "./authoring.js";
import { renderAgentFocusEvidence, type AgentFocusEvidence } from "./agent-evidence.js";
import { applyCalibrationOverrides } from "./calibration.js";
import { PuppetLoomError } from "./errors.js";
import { loadCalibration, loadProject, saveCalibrationPatch } from "./project.js";
import type {
  AuthoringOperation,
  AuthoringPreview,
  CalibrationOverrides,
  CalibrationSaveResult,
  PuppetLoomProject,
  SemanticRole
} from "./types.js";

export type ModelAgentPart =
  | "headFace"
  | "eyes"
  | "mouth"
  | "frontHair"
  | "backHair"
  | "ahoge"
  | "ears"
  | "headwear"
  | "body"
  | "topCloth"
  | "skirt"
  | "tail"
  | "accessory";

export interface ModelAgentPartDefinition {
  part: ModelAgentPart;
  label: string;
  roles: SemanticRole[];
  kind: "pose" | "expression" | "secondary-motion" | "body-motion";
}

export const modelAgentPartDefinitions: readonly ModelAgentPartDefinition[] = [
  { part: "headFace", label: "头部与脸部", roles: ["face", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth", "neck", "frontHair", "backHair", "sideHair", "headwear", "ear"], kind: "pose" },
  { part: "eyes", label: "眼睛与眨眼", roles: ["eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow"], kind: "expression" },
  { part: "mouth", label: "嘴型", roles: ["mouth"], kind: "expression" },
  { part: "frontHair", label: "前发", roles: ["frontHair"], kind: "secondary-motion" },
  { part: "backHair", label: "后发与侧发", roles: ["backHair", "sideHair"], kind: "secondary-motion" },
  { part: "ahoge", label: "呆毛", roles: ["frontHair"], kind: "secondary-motion" },
  { part: "ears", label: "耳朵", roles: ["ear"], kind: "secondary-motion" },
  { part: "headwear", label: "头饰", roles: ["headwear"], kind: "secondary-motion" },
  { part: "body", label: "身体", roles: ["neck", "arm", "hand", "leg", "foot"], kind: "body-motion" },
  { part: "topCloth", label: "上衣", roles: ["topWear", "arm"], kind: "secondary-motion" },
  { part: "skirt", label: "裙摆与下装", roles: ["bottomWear"], kind: "secondary-motion" },
  { part: "tail", label: "尾巴", roles: ["tail"], kind: "secondary-motion" },
  { part: "accessory", label: "配饰", roles: ["accessory"], kind: "secondary-motion" }
] as const;

export interface ModelAgentCheck {
  id: string;
  label: string;
  passed: boolean;
  details: Record<string, number | string | boolean | number[]>;
}

export interface ModelAgentRepair {
  pass: number;
  action: string;
  reason: string;
  targetLayerIds: string[];
  affectedVertexIndices?: number[];
}

export interface PreparedModelAgentProposal {
  part: ModelAgentPart;
  instruction: string;
  label: string;
  targetLayerIds: string[];
  operations: AuthoringOperation[];
  previews: AuthoringPreview[];
  overrides: CalibrationOverrides;
  checks: ModelAgentCheck[];
  repairs: ModelAgentRepair[];
  reportDetails?: Record<string, unknown>;
}

export interface ModelAgentCapability {
  part: ModelAgentPart;
  label: string;
  kind: ModelAgentPartDefinition["kind"];
  targetLayerIds: string[];
  available: boolean;
  reason?: string;
}

export type CommittedModelAgentProposal =
  | { changed: true; result: CalibrationSaveResult; reportPath: string }
  | { changed: false; project: PuppetLoomProject; revision: number };

export function modelAgentCapabilities(project: PuppetLoomProject): ModelAgentCapability[] {
  return modelAgentPartDefinitions.map((definition) => {
    const targetLayerIds = project.layers.filter((layer) => definition.roles.includes(layer.role)).map((layer) => layer.id);
    const available = targetLayerIds.length > 0;
    return {
      part: definition.part,
      label: definition.label,
      kind: definition.kind,
      targetLayerIds,
      available,
      ...(!available ? { reason: `没有识别到${definition.label}所需图层。` } : {})
    };
  });
}

export function requestedModelAgentParts(project: PuppetLoomProject, requested?: ModelAgentPart | "whole"): ModelAgentPart[] {
  const capabilities = modelAgentCapabilities(project);
  if (requested === "whole") return capabilities.filter((capability) => capability.available).map((capability) => capability.part);
  if (requested) return [requested];
  return capabilities.filter((capability) => capability.available).map((capability) => capability.part);
}

function validateProposal(project: PuppetLoomProject, proposal: PreparedModelAgentProposal): PuppetLoomProject {
  if (proposal.targetLayerIds.length === 0) throw new PuppetLoomError("INVALID_INPUT", `${proposal.part} Agent 没有目标图层。`);
  const known = new Set(project.layers.map((layer) => layer.id));
  const missing = proposal.targetLayerIds.filter((id) => !known.has(id));
  if (missing.length > 0) throw new PuppetLoomError("INVALID_INPUT", `Agent 目标图层不存在：${missing.join("、")}`);
  const failed = proposal.checks.filter((check) => !check.passed);
  if (failed.length > 0) throw new PuppetLoomError("INVALID_INPUT", `Agent 自检未通过：${failed.map((check) => check.label).join("；")}`);
  // Mesh replacement must happen before bindings that reference the replacement's
  // vertex indices. Applying authoring first makes a valid rebuilt ArtMesh look as
  // if its keyforms point outside the legacy grid.
  const prepared = applyCalibrationOverrides(project, proposal.overrides);
  return applyAuthoringOperations(prepared, proposal.operations);
}

async function writeAgentReport(root: string, proposal: PreparedModelAgentProposal, result: CalibrationSaveResult, focusEvidence: AgentFocusEvidence): Promise<string> {
  const directory = join(root, "reports", "agent", result.session.id);
  const reportPath = join(directory, "report.json");
  await mkdir(directory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    version: 1,
    status: "succeeded",
    task: proposal.part,
    instruction: proposal.instruction,
    label: proposal.label,
    project: result.project.name,
    projectDirectory: root,
    fromRevision: result.session.fromRevision,
    toRevision: result.session.toRevision,
    sessionId: result.session.id,
    targetLayerIds: proposal.targetLayerIds,
    checks: proposal.checks,
    repairs: proposal.repairs,
    evidence: {
      comparisonSheet: result.evidence.comparisonSheet,
      differenceImage: result.evidence.differenceImage,
      visualDifference: result.evidence.visualDifference,
      focus: focusEvidence
    },
    ...(proposal.reportDetails ?? {})
  }, null, 2)}\n`, "utf8");
  return reportPath;
}

/** Commits one already-repaired proposal through the shared revision, evidence and report boundary. */
export async function commitModelAgentProposal(projectDirectory: string, baseRevision: number, proposal: PreparedModelAgentProposal): Promise<CommittedModelAgentProposal> {
  const root = resolve(projectDirectory);
  const [project, calibration] = await Promise.all([loadProject(root), loadCalibration(root)]);
  if (calibration.revision !== baseRevision) throw new PuppetLoomError("REVISION_CONFLICT", `Agent 基线已从 ${baseRevision} 更新到 ${calibration.revision}，本次修改没有写入。`);
  const proposed = validateProposal(project, proposal);
  if (JSON.stringify(proposed) === JSON.stringify(project)) {
    return { changed: false, project, revision: baseRevision };
  }
  const overrides: CalibrationOverrides = { ...proposal.overrides, model: proposed.model };
  const authoring = proposal.operations.length > 0
    ? buildAuthoringAudit({ version: 1, baseRevision, label: proposal.label, operations: proposal.operations, previews: proposal.previews }, project, proposed)
    : undefined;
  const result = await saveCalibrationPatch(root, {
    baseRevision,
    label: proposal.label,
    overrides,
    ...(authoring ? { authoring } : {})
  });
  const focusDirectory = join(root, "reports", "agent", result.session.id, "evidence");
  const focusEvidence = await renderAgentFocusEvidence(root, project, proposed, proposal.targetLayerIds, proposal.previews, focusDirectory);
  return { changed: true, result, reportPath: await writeAgentReport(root, proposal, result, focusEvidence) };
}
