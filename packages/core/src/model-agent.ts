import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { modelAgentCapabilities, modelAgentPartDefinitions, requestedModelAgentParts, type ModelAgentCheck, type ModelAgentPart, type ModelAgentRepair } from "./agent.js";
import { parseModelAgentSpecification, type ModelAgentPartSpecification, type ModelAgentSpecification, type PrimaryPartSpecification, type SecondaryPartSpecification } from "./agent-spec.js";
import { applyCalibrationOverrides } from "./calibration.js";
import { PuppetLoomError } from "./errors.js";
import { planFrontHairAgent, runFrontHairAgent } from "./front-hair-agent.js";
import { planPrimaryPartAgent, runPrimaryPartAgent, type PrimaryModelAgentPart } from "./primary-part-agent.js";
import { clearCalibrationDraft, loadCalibration, loadCalibrationDraft, loadProject, saveCalibrationPatch } from "./project.js";
import { planSecondaryPartAgent, runSecondaryPartAgent, type SecondaryModelAgentPart } from "./secondary-part-agent.js";
import type { AssetRequest, CalibrationDraftDocument, PuppetLoomProject, VerifyResult } from "./types.js";
import { verifyProject } from "./verify.js";

export type ModelAgentRequestScope = ModelAgentPart | "whole";
export type ModelAgentScope = ModelAgentRequestScope | "selected";
export type ModelAgentPartStatus = "ready" | "completed" | "not-present" | "needs-assets" | "blocked";

export interface ModelAgentOptions {
  instruction?: string;
  scope?: ModelAgentRequestScope;
  specification?: ModelAgentSpecification;
}

export interface ModelAgentPartPlanSummary {
  part: ModelAgentPart;
  label: string;
  status: ModelAgentPartStatus;
  targetLayerIds: string[];
  checks: ModelAgentCheck[];
  repairs: ModelAgentRepair[];
  blockers: string[];
  assetRequests: AssetRequest[];
}

export interface ModelAgentPlan {
  version: 1;
  task: "model-agent";
  project: string;
  projectDirectory: string;
  baseRevision: number;
  instruction: string;
  inputMode: "structured-specification" | "legacy-instruction";
  specification?: ModelAgentSpecification;
  scope: ModelAgentScope;
  requestedParts: ModelAgentPart[];
  draft: { found: boolean; label?: string; willAdopt: boolean; blockers: string[] };
  parts: ModelAgentPartPlanSummary[];
  canApply: boolean;
  blockers: string[];
}

export interface ModelAgentPartRunSummary extends ModelAgentPartPlanSummary {
  fromRevision?: number;
  toRevision?: number;
  reportPath?: string;
  comparisonSheet?: string;
  differenceImage?: string;
  focusComparisonSheet?: string;
  focusMotionSheet?: string;
  focusMotionManifest?: string;
}

export interface ModelAgentRunResult {
  ok: boolean;
  task: "model-agent";
  taskId: string;
  project: string;
  projectDirectory: string;
  instruction: string;
  inputMode: "structured-specification" | "legacy-instruction";
  specification?: ModelAgentSpecification;
  scope: ModelAgentScope;
  fromRevision: number;
  toRevision: number;
  adoptedDraftRevision?: number;
  status: "completed" | "needs-assets" | "blocked";
  blockers: string[];
  parts: ModelAgentPartRunSummary[];
  verification: VerifyResult;
  reportPath: string;
}

const primaryParts = new Set<ModelAgentPart>(["headFace", "eyes", "mouth", "body"]);
const secondaryParts = new Set<ModelAgentPart>(["backHair", "ahoge", "ears", "headwear", "topCloth", "skirt", "tail", "accessory"]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function labelFor(part: ModelAgentPart): string {
  return modelAgentPartDefinitions.find((definition) => definition.part === part)!.label;
}

function partOrder(parts: ModelAgentPart[]): ModelAgentPart[] {
  const requested = new Set(parts);
  return modelAgentPartDefinitions.map((definition) => definition.part).filter((part) => requested.has(part));
}

function wholeDraftAssessment(project: PuppetLoomProject, draft: CalibrationDraftDocument | undefined): ModelAgentPlan["draft"] {
  if (!draft) return { found: false, willAdopt: false, blockers: [] };
  const blockers: string[] = [];
  try {
    applyCalibrationOverrides(project, draft.overrides);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : "草稿无法形成有效模型。");
  }
  return { found: true, ...(draft.label ? { label: draft.label } : {}), willAdopt: blockers.length === 0 && Object.keys(draft.overrides).length > 0, blockers };
}

function withoutDraftBlockers(blockers: string[], draftBlockers: string[] | undefined): string[] {
  const explicit = new Set(draftBlockers ?? []);
  return blockers.filter((blocker) => !explicit.has(blocker) && !blocker.startsWith("草稿"));
}

function rationale(specification: ModelAgentPartSpecification | undefined): string[] {
  return specification?.rationale?.length ? specification.rationale : ["由外部 Agent 提供的结构化制作规格。"];
}

function isPrimarySpecification(specification: ModelAgentPartSpecification | undefined): specification is PrimaryPartSpecification {
  return Boolean(specification && ["headFace", "eyes", "mouth", "body"].includes(specification.part));
}

function isSecondarySpecification(specification: ModelAgentPartSpecification | undefined): specification is SecondaryPartSpecification {
  return Boolean(specification && specification.part !== "frontHair" && !["headFace", "eyes", "mouth", "body"].includes(specification.part));
}

function frontHairOptions(instruction: string, specification: ModelAgentPartSpecification | undefined) {
  if (!specification || specification.part !== "frontHair") return { instruction };
  return {
    instruction,
    ...(specification.layerIds?.[0] ? { layerId: specification.layerIds[0] } : {}),
    intent: { ...specification.intent, explanation: rationale(specification) }
  };
}

function primaryOptions(part: PrimaryModelAgentPart, instruction: string, specification: ModelAgentPartSpecification | undefined) {
  const selected = isPrimarySpecification(specification) ? specification : undefined;
  return {
    part,
    instruction,
    ...(selected?.layerIds ? { layerIds: selected.layerIds } : {}),
    ...(selected ? { intent: { ...selected.intent, explanation: rationale(selected) } } : {})
  };
}

function secondaryOptions(part: SecondaryModelAgentPart, instruction: string, specification: ModelAgentPartSpecification | undefined) {
  const selected = isSecondarySpecification(specification) ? specification : undefined;
  return {
    part,
    instruction,
    ...(selected?.layerIds ? { layerIds: selected.layerIds } : {}),
    ...(selected ? { intent: { ...selected.intent, explanation: rationale(selected) } } : {})
  };
}

async function planOne(root: string, part: ModelAgentPart, instruction: string, specification?: ModelAgentPartSpecification): Promise<ModelAgentPartPlanSummary> {
  const base = { part, label: labelFor(part), targetLayerIds: [] as string[], checks: [] as ModelAgentCheck[], repairs: [] as ModelAgentRepair[], blockers: [] as string[], assetRequests: [] as AssetRequest[] };
  try {
    if (part === "frontHair") {
      const plan = await planFrontHairAgent(root, frontHairOptions(instruction, specification));
      const blockers = withoutDraftBlockers(plan.blockers, undefined);
      return { ...base, targetLayerIds: [plan.layer.id], checks: plan.checks, blockers, status: blockers.length > 0 ? "blocked" : "ready" };
    }
    if (secondaryParts.has(part)) {
      const plan = await planSecondaryPartAgent(root, secondaryOptions(part as SecondaryModelAgentPart, instruction, specification));
      const blockers = withoutDraftBlockers(plan.blockers, plan.draft.blockers);
      return { ...base, targetLayerIds: plan.targetLayers.map((layer) => layer.id), checks: plan.checks, repairs: plan.repairs, blockers, status: blockers.length > 0 ? "blocked" : "ready" };
    }
    const plan = await planPrimaryPartAgent(root, primaryOptions(part as PrimaryModelAgentPart, instruction, specification));
    const blockers = withoutDraftBlockers(plan.blockers, plan.draft.blockers).filter((blocker) => !blocker.startsWith("缺少 "));
    const status: ModelAgentPartStatus = plan.assetRequests.length > 0 ? "needs-assets" : blockers.length > 0 ? "blocked" : "ready";
    return { ...base, targetLayerIds: plan.targetLayers.map((layer) => layer.id), checks: plan.checks, repairs: plan.repairs, blockers, assetRequests: plan.assetRequests, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, status: "blocked", blockers: [message] };
  }
}

/** Plans a structured external-Agent specification, with a fixed legacy fallback, without writing. */
export async function planModelAgent(projectDirectory: string, options: ModelAgentOptions): Promise<ModelAgentPlan> {
  const root = resolve(projectDirectory);
  const [project, calibration, draft] = await Promise.all([loadProject(root), loadCalibration(root), loadCalibrationDraft(root)]);
  const specification = options.specification ? parseModelAgentSpecification(options.specification) : undefined;
  const instruction = specification?.goal ?? (options.instruction?.trim() || "自动完成整个模型并检查自然度");
  const requestScope = options.scope ?? "whole";
  const scope: ModelAgentScope = specification
    ? specification.scope === "whole" ? "whole" : specification.parts.length === 1 ? specification.parts[0]!.part : "selected"
    : requestScope;
  const requested = specification
    ? specification.scope === "whole" ? modelAgentPartDefinitions.map((definition) => definition.part) : specification.parts.map((part) => part.part)
    : requestScope === "whole"
      ? modelAgentPartDefinitions.map((definition) => definition.part)
      : requestedModelAgentParts(project, requestScope);
  const partSpecifications = new Map(specification?.parts.map((part) => [part.part, part]) ?? []);
  const capabilities = new Map(modelAgentCapabilities(project).map((capability) => [capability.part, capability]));
  const parts: ModelAgentPartPlanSummary[] = [];
  for (const part of partOrder(requested)) {
    const capability = capabilities.get(part)!;
    if (!capability.available) {
      parts.push({ part, label: labelFor(part), status: "not-present", targetLayerIds: [], checks: [], repairs: [], blockers: [capability.reason ?? `没有识别到${labelFor(part)}。`], assetRequests: [] });
      continue;
    }
    if (specification && !partSpecifications.has(part)) {
      parts.push({
        part,
        label: labelFor(part),
        status: "blocked",
        targetLayerIds: capability.targetLayerIds,
        checks: [],
        repairs: [],
        blockers: [`整模规格漏掉了项目中实际存在的${labelFor(part)}。请重新查看该部位并填写 intent 与 rationale。`],
        assetRequests: []
      });
      continue;
    }
    parts.push(await planOne(root, part, instruction, partSpecifications.get(part)));
  }
  const draftState = wholeDraftAssessment(project, draft);
  const revisionBlockers = specification && specification.baseRevision !== calibration.revision
    ? [`制作规格基于 revision ${specification.baseRevision}，当前项目已经是 revision ${calibration.revision}。请重新检查画面并生成新规格。`]
    : [];
  const blockers = [...revisionBlockers, ...draftState.blockers, ...parts.filter((part) => part.status === "blocked").flatMap((part) => part.blockers.map((blocker) => `${part.label}：${blocker}`))];
  return {
    version: 1,
    task: "model-agent",
    project: project.name,
    projectDirectory: root,
    baseRevision: calibration.revision,
    instruction,
    inputMode: specification ? "structured-specification" : "legacy-instruction",
    ...(specification ? { specification } : {}),
    scope,
    requestedParts: partOrder(requested),
    draft: draftState,
    parts,
    canApply: blockers.length === 0 && parts.some((part) => part.status === "ready"),
    blockers
  };
}

async function runOne(root: string, part: ModelAgentPart, instruction: string, specification?: ModelAgentPartSpecification): Promise<ModelAgentPartRunSummary> {
  const planned = await planOne(root, part, instruction, specification);
  if (planned.status !== "ready") return planned;
  try {
    const focus = async (reportPath: string): Promise<{ focusComparisonSheet?: string; focusMotionSheet?: string; focusMotionManifest?: string }> => {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as { evidence?: { focus?: { comparisonSheet?: string; motionSheet?: string; motionManifest?: string } } };
      return {
        ...(report.evidence?.focus?.comparisonSheet ? { focusComparisonSheet: report.evidence.focus.comparisonSheet } : {}),
        ...(report.evidence?.focus?.motionSheet ? { focusMotionSheet: report.evidence.focus.motionSheet } : {}),
        ...(report.evidence?.focus?.motionManifest ? { focusMotionManifest: report.evidence.focus.motionManifest } : {})
      };
    };
    if (part === "frontHair") {
      const result = await runFrontHairAgent(root, frontHairOptions(instruction, specification));
      return { ...planned, status: "completed", fromRevision: result.fromRevision, toRevision: result.toRevision, ...(result.reportPath ? { reportPath: result.reportPath, ...(await focus(result.reportPath)) } : {}), ...(result.comparisonSheet ? { comparisonSheet: result.comparisonSheet } : {}), ...(result.differenceImage ? { differenceImage: result.differenceImage } : {}) };
    }
    if (secondaryParts.has(part)) {
      const result = await runSecondaryPartAgent(root, secondaryOptions(part as SecondaryModelAgentPart, instruction, specification));
      return { ...planned, status: "completed", fromRevision: result.fromRevision, toRevision: result.toRevision, reportPath: result.reportPath, comparisonSheet: result.comparisonSheet, differenceImage: result.differenceImage, ...(await focus(result.reportPath)) };
    }
    const result = await runPrimaryPartAgent(root, primaryOptions(part as PrimaryModelAgentPart, instruction, specification));
    return { ...planned, status: "completed", fromRevision: result.fromRevision, toRevision: result.toRevision, reportPath: result.reportPath, comparisonSheet: result.comparisonSheet, differenceImage: result.differenceImage, ...(await focus(result.reportPath)) };
  } catch (error) {
    return { ...planned, status: "blocked", blockers: [error instanceof Error ? error.message : String(error)] };
  }
}

async function writeTaskReport(root: string, result: Omit<ModelAgentRunResult, "reportPath">): Promise<string> {
  const directory = join(root, "reports", "agent-tasks", result.taskId);
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, "report.json");
  await writeFile(reportPath, `${JSON.stringify({ version: 1, ...result }, null, 2)}\n`, "utf8");
  return reportPath;
}

/** Runs every present part in deterministic order. Each part remains an independently reversible revision. */
export async function runModelAgent(projectDirectory: string, options: ModelAgentOptions): Promise<ModelAgentRunResult> {
  const root = resolve(projectDirectory);
  const initial = await planModelAgent(root, options);
  if (initial.blockers.length > 0 || (!initial.canApply && !initial.parts.some((part) => part.status === "needs-assets"))) {
    throw new PuppetLoomError("INVALID_INPUT", `整模 Agent 计划未通过：${initial.blockers.join("；") || "没有可执行的部位。"}`);
  }
  let revision = initial.baseRevision;
  let adoptedDraftRevision: number | undefined;
  const draft = await loadCalibrationDraft(root);
  if (draft && initial.draft.willAdopt) {
    const adoption = await saveCalibrationPatch(root, { baseRevision: revision, label: `Agent · 接管整模草稿 · ${draft.label ?? "未命名草稿"}`, overrides: clone(draft.overrides) });
    revision = adoption.calibration.revision;
    adoptedDraftRevision = revision;
    await clearCalibrationDraft(root);
  }

  const parts: ModelAgentPartRunSummary[] = [];
  const partSpecifications = new Map(initial.specification?.parts.map((part) => [part.part, part]) ?? []);
  for (const planned of initial.parts) {
    if (planned.status === "not-present" || planned.status === "needs-assets") {
      parts.push(planned);
      continue;
    }
    parts.push(await runOne(root, planned.part, initial.instruction, partSpecifications.get(planned.part)));
  }
  const calibration = await loadCalibration(root);
  const verification = await verifyProject(root);
  const status: ModelAgentRunResult["status"] = !verification.valid || parts.some((part) => part.status === "blocked")
    ? "blocked"
    : parts.some((part) => part.status === "needs-assets") ? "needs-assets" : "completed";
  const blockers = [
    ...parts.filter((part) => part.status === "blocked").flatMap((part) => part.blockers.map((blocker) => `${part.label}：${blocker}`)),
    ...(!verification.valid ? verification.warnings.map((warning) => `整模验证：${warning}`) : [])
  ];
  const taskId = randomUUID();
  const baseResult: Omit<ModelAgentRunResult, "reportPath"> = {
    ok: status === "completed",
    task: "model-agent",
    taskId,
    project: initial.project,
    projectDirectory: root,
    instruction: initial.instruction,
    inputMode: initial.inputMode,
    ...(initial.specification ? { specification: initial.specification } : {}),
    scope: initial.scope,
    fromRevision: initial.baseRevision,
    toRevision: calibration.revision,
    ...(adoptedDraftRevision !== undefined ? { adoptedDraftRevision } : {}),
    status,
    blockers,
    parts,
    verification
  };
  return { ...baseResult, reportPath: await writeTaskReport(root, baseResult) };
}
