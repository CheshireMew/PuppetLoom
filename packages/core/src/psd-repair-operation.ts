import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { PuppetLoomError } from "./errors.js";
import { reviewPhotoshopPsdRepair, type PhotoshopPsdRepairPlan, type PsdRepairReview } from "./psd-repair.js";

const DEFAULT_MAXIMUM_BYTES = 4 * 1024 ** 3;
const DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 ** 3;
const DEFAULT_MAXIMUM_PATH_LENGTH = 240;
const REQUIRED_VISUAL_CHECKS = [
  "face-and-eyes",
  "hair-and-headwear",
  "clothing-and-limbs",
  "layer-order-and-occlusion",
  "background-and-alpha",
  "overall-recomposition"
] as const;

export type PsdRepairOperationStatus = "pending" | "running" | "awaiting-visual-review" | "accepted" | "accepted-with-repairs" | "rejected" | "failed" | "interrupted";

interface PsdRepairAttempt {
  number: number;
  startedAt: string;
  completedAt?: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  stage: string;
  error?: string;
  archivedPartialOutput?: string;
}

interface FileIdentity {
  path: string;
  sha256: string;
}

export interface PsdRepairOperationRecord {
  protocol: "puppetloom-psd-repair-operation";
  version: 1;
  id: string;
  mode: "repair" | "review";
  status: PsdRepairOperationStatus;
  stage: string;
  createdAt: string;
  updatedAt: string;
  processId: number | null;
  planFingerprint: string;
  plan: {
    engine: PhotoshopPsdRepairPlan["engine"];
    recipePath: string;
    output: string;
    workDirectory: string;
    inputManifest: PhotoshopPsdRepairPlan["inputManifest"];
  };
  preflight: {
    estimatedBytes: number;
    maximumBytes: number;
    minimumFreeBytes: number;
    freeBytes: number;
    maximumPathLength: number;
    longestDeclaredPathLength: number;
  };
  progress: {
    photoshopCompleted: boolean;
    automatedReviewCompleted: boolean;
    output?: FileIdentity;
  };
  attempts: PsdRepairAttempt[];
  photoshop?: unknown;
  automatedReview?: {
    valid: boolean;
    reviewPath: string;
    visualReviewPath: string;
    evidence: Record<string, FileIdentity>;
  };
  visualReview?: {
    status: "accepted" | "accepted-with-repairs" | "rejected";
    reviewer: string;
    reviewedAt: string;
    decisionPath: string;
    blockingIssues: unknown[];
    repairPlan: unknown[];
  };
  error?: string;
  recovery: {
    resumable: boolean;
    command: string;
    note: string;
  };
}

export interface PsdRepairOperationExecution {
  record: PsdRepairOperationRecord;
  result: Record<string, unknown>;
  review?: PsdRepairReview;
}

const visualDecisionSchema = z.object({
  version: z.literal(1),
  kind: z.literal("puppetloom-psd-repair-visual-review"),
  operationId: z.string().uuid(),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["accepted", "accepted-with-repairs", "rejected"]),
  reviewer: z.string().trim().min(1),
  reviewedAt: z.string().trim().min(1).nullable().optional(),
  checks: z.array(z.object({
    id: z.enum(REQUIRED_VISUAL_CHECKS),
    status: z.enum(["pass", "repair", "fail", "not-applicable"]),
    note: z.string().trim().min(1)
  }).strict()).length(REQUIRED_VISUAL_CHECKS.length),
  blockingIssues: z.array(z.unknown()),
  repairPlan: z.array(z.unknown()),
  evidence: z.record(z.string(), z.object({ path: z.string().trim().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
}).strict();

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  const selected = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须是正整数。`);
  return selected;
}

function planFingerprint(plan: PhotoshopPsdRepairPlan): string {
  return createHash("sha256").update(JSON.stringify({
    mode: plan.mode,
    engine: plan.engine,
    recipePath: plan.recipe.recipePath,
    output: plan.output,
    workDirectory: plan.workDirectory,
    inputManifest: plan.inputManifest.slice().sort((first, second) => first.id.localeCompare(second.id))
  })).digest("hex");
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let current = resolve(path);
  while (!(await exists(current))) {
    const parent = dirname(current);
    if (parent === current) throw new PuppetLoomError("IO_ERROR", `找不到可用的 PSD 修复存储根：${path}`);
    current = parent;
  }
  return current;
}

async function preflight(plan: PhotoshopPsdRepairPlan): Promise<PsdRepairOperationRecord["preflight"]> {
  const maximumBytes = positiveInteger(process.env.PUPPETLOOM_PSD_REPAIR_MAX_BYTES, DEFAULT_MAXIMUM_BYTES, "PUPPETLOOM_PSD_REPAIR_MAX_BYTES");
  const minimumFreeBytes = positiveInteger(process.env.PUPPETLOOM_PSD_REPAIR_MIN_FREE_BYTES, DEFAULT_MINIMUM_FREE_BYTES, "PUPPETLOOM_PSD_REPAIR_MIN_FREE_BYTES");
  const maximumPathLength = positiveInteger(process.env.PUPPETLOOM_PSD_REPAIR_MAX_PATH_LENGTH, DEFAULT_MAXIMUM_PATH_LENGTH, "PUPPETLOOM_PSD_REPAIR_MAX_PATH_LENGTH");
  const declaredPaths = [
    plan.output,
    plan.recipe.recipePath,
    ...plan.inputManifest.map((item) => item.path),
    join(plan.workDirectory, "operation.json"),
    join(plan.workDirectory, "automated-review.json"),
    join(plan.workDirectory, "visual-review.json"),
    join(plan.workDirectory, "recovery", "attempt-9999-partial-output.psd")
  ];
  const longestDeclaredPathLength = Math.max(...declaredPaths.map((path) => resolve(path).length));
  if (longestDeclaredPathLength > maximumPathLength) {
    throw new PuppetLoomError("INVALID_INPUT", `PSD 修复路径预算不足：最长路径 ${longestDeclaredPathLength} > 上限 ${maximumPathLength}；尚未创建任务目录。`);
  }
  if (plan.estimatedBytes > maximumBytes) {
    throw new PuppetLoomError("INVALID_INPUT", `PSD 修复预算不足：预计 ${plan.estimatedBytes} > 上限 ${maximumBytes} 字节；尚未创建任务目录。`);
  }
  const storageRoots = [...new Set([await nearestExistingDirectory(plan.workDirectory), await nearestExistingDirectory(dirname(plan.output))])];
  const freeBytes = Math.min(...(await Promise.all(storageRoots.map(async (root) => {
    const filesystem = await statfs(root);
    return Number(filesystem.bavail) * Number(filesystem.bsize);
  }))));
  if (freeBytes - plan.estimatedBytes < minimumFreeBytes) {
    throw new PuppetLoomError("IO_ERROR", `PSD 修复磁盘余量不足：预计写入后低于 ${minimumFreeBytes} 字节；尚未创建任务目录。`);
  }
  return { estimatedBytes: plan.estimatedBytes, maximumBytes, minimumFreeBytes, freeBytes, maximumPathLength, longestDeclaredPathLength };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function initialJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processIsAlive(processId: number | null): boolean {
  if (!processId) return false;
  try { process.kill(processId, 0); return true; }
  catch { return false; }
}

function operationPath(plan: PhotoshopPsdRepairPlan): string {
  return join(plan.workDirectory, "operation.json");
}

function validateRecord(value: unknown, path: string): PsdRepairOperationRecord {
  const record = value as Partial<PsdRepairOperationRecord>;
  if (record?.protocol !== "puppetloom-psd-repair-operation" || record.version !== 1 || !record.id || !record.planFingerprint) {
    throw new PuppetLoomError("INVALID_INPUT", `PSD 修复任务清单无效：${path}`);
  }
  return record as PsdRepairOperationRecord;
}

async function readRecord(path: string): Promise<PsdRepairOperationRecord> {
  try { return validateRecord(JSON.parse(await readFile(path, "utf8")), path); }
  catch (error) {
    if (error instanceof PuppetLoomError) throw error;
    throw new PuppetLoomError("INVALID_INPUT", `无法读取 PSD 修复任务清单：${path}`, { cause: error });
  }
}

function resumeCommand(plan: PhotoshopPsdRepairPlan): string {
  return plan.mode === "repair"
    ? `puppetloom psd repair --recipe "${plan.recipe.recipePath}" --output "${plan.output}" --workdir "${plan.workDirectory}"`
    : `puppetloom psd review --input "${plan.output}" --recipe "${plan.recipe.recipePath}" --workdir "${plan.workDirectory}"`;
}

async function createRecord(plan: PhotoshopPsdRepairPlan): Promise<PsdRepairOperationRecord> {
  const checked = await preflight(plan);
  await mkdir(plan.workDirectory, { recursive: true });
  const now = new Date().toISOString();
  const output = plan.mode === "review" ? plan.inputManifest.find((item) => resolve(item.path).toLowerCase() === resolve(plan.output).toLowerCase()) : undefined;
  const record: PsdRepairOperationRecord = {
    protocol: "puppetloom-psd-repair-operation",
    version: 1,
    id: randomUUID(),
    mode: plan.mode,
    status: "pending",
    stage: "prepared",
    createdAt: now,
    updatedAt: now,
    processId: null,
    planFingerprint: planFingerprint(plan),
    plan: { engine: plan.engine, recipePath: plan.recipe.recipePath, output: plan.output, workDirectory: plan.workDirectory, inputManifest: plan.inputManifest },
    preflight: checked,
    progress: { photoshopCompleted: plan.mode === "review", automatedReviewCompleted: false, ...(output ? { output: { path: output.path, sha256: output.sha256 } } : {}) },
    attempts: [],
    recovery: { resumable: true, command: resumeCommand(plan), note: "使用完全相同的命令恢复；任务会保留旧产物并从最后一个已确认阶段继续。" }
  };
  await initialJson(operationPath(plan), record);
  return record;
}

async function openOperation(plan: PhotoshopPsdRepairPlan): Promise<PsdRepairOperationRecord> {
  const path = operationPath(plan);
  if (!(await exists(path))) return createRecord(plan);
  const record = await readRecord(path);
  if (record.planFingerprint !== planFingerprint(plan)) {
    throw new PuppetLoomError("REVISION_CONFLICT", `PSD 修复任务的配方、输入哈希、输出或目录已经改变，不能在原任务上继续：${path}`);
  }
  if (record.status === "running") {
    if (processIsAlive(record.processId)) throw new PuppetLoomError("OPERATION_BUSY", `PSD 修复任务仍由进程 ${record.processId} 执行：${path}`);
    const now = new Date().toISOString();
    const attempt = record.attempts.at(-1);
    if (attempt?.status === "running") Object.assign(attempt, { status: "interrupted", completedAt: now, error: "所有者进程已结束。" });
    Object.assign(record, { status: "interrupted", stage: "interrupted", updatedAt: now, processId: null, error: "所有者进程已结束；任务可用原命令恢复。" });
    await atomicJson(path, record);
  }
  return record;
}

async function saveRecord(plan: PhotoshopPsdRepairPlan, record: PsdRepairOperationRecord): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await atomicJson(operationPath(plan), record);
}

async function archivePartialOutput(plan: PhotoshopPsdRepairPlan, attempt: PsdRepairAttempt): Promise<void> {
  if (!(await exists(plan.output)) || plan.mode !== "repair") return;
  const recoveryDirectory = join(plan.workDirectory, "recovery");
  await mkdir(recoveryDirectory, { recursive: true });
  const archived = join(recoveryDirectory, `attempt-${attempt.number}-partial-output.psd`);
  if (await exists(archived)) throw new PuppetLoomError("REVISION_CONFLICT", `恢复归档已经存在，拒绝覆盖：${archived}`);
  await rename(plan.output, archived);
  attempt.archivedPartialOutput = archived;
}

async function writePlanFiles(plan: PhotoshopPsdRepairPlan): Promise<void> {
  await atomicJson(join(plan.workDirectory, "resolved-recipe.json"), plan.recipe);
  await atomicJson(join(plan.workDirectory, "input-manifest.json"), plan.inputManifest);
}

async function evidenceFiles(review: PsdRepairReview): Promise<Record<string, FileIdentity>> {
  const result: Record<string, FileIdentity> = {};
  for (const [name, path] of Object.entries(review.artifacts)) result[name] = { path, sha256: await sha256(path) };
  return result;
}

function publicResult(record: PsdRepairOperationRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const readyForCreate = record.status === "accepted" || record.status === "accepted-with-repairs";
  const completed = ["accepted", "accepted-with-repairs", "rejected"].includes(record.status);
  return {
    ok: readyForCreate,
    completed,
    status: record.status,
    stage: record.stage,
    operationId: record.id,
    operation: join(record.plan.workDirectory, "operation.json"),
    output: record.plan.output,
    workDirectory: record.plan.workDirectory,
    readyForCreate,
    recovery: record.recovery,
    ...(record.automatedReview ? { automatedReview: record.automatedReview.reviewPath, visualReview: record.automatedReview.visualReviewPath } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...extra
  };
}

async function writeResult(record: PsdRepairOperationRecord, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = publicResult(record, extra);
  await atomicJson(join(record.plan.workDirectory, "result.json"), result);
  return result;
}

export async function executePhotoshopPsdRepairOperation(
  plan: PhotoshopPsdRepairPlan,
  executePhotoshop?: (resolvedRecipePath: string, output: string) => Promise<unknown>
): Promise<PsdRepairOperationExecution> {
  const record = await openOperation(plan);
  if (["awaiting-visual-review", "accepted", "accepted-with-repairs", "rejected"].includes(record.status)) {
    return { record, result: publicResult(record) };
  }
  if (plan.mode === "repair" && !executePhotoshop) throw new PuppetLoomError("INVALID_INPUT", "PSD repair 模式必须提供 Photoshop 执行器。" );

  const now = new Date().toISOString();
  const attempt: PsdRepairAttempt = { number: record.attempts.length + 1, startedAt: now, status: "running", stage: "preparing" };
  record.attempts.push(attempt);
  Object.assign(record, { status: "running", stage: "preparing", processId: process.pid, error: undefined });
  await saveRecord(plan, record);

  try {
    await writePlanFiles(plan);
    if (plan.mode === "repair") {
      const recordedOutput = record.progress.output;
      const outputStillMatches = recordedOutput && await exists(plan.output) && await sha256(plan.output) === recordedOutput.sha256;
      if (!outputStillMatches) {
        await archivePartialOutput(plan, attempt);
        attempt.stage = "photoshop";
        record.stage = "photoshop";
        record.progress.photoshopCompleted = false;
        delete record.progress.output;
        await saveRecord(plan, record);
        record.photoshop = await executePhotoshop!(join(plan.workDirectory, "resolved-recipe.json"), plan.output);
        if (!(await exists(plan.output))) throw new PuppetLoomError("IO_ERROR", `Photoshop 没有生成声明的 PSD：${plan.output}`);
        record.progress.output = { path: plan.output, sha256: await sha256(plan.output) };
        record.progress.photoshopCompleted = true;
        await saveRecord(plan, record);
      }
    } else {
      const currentHash = await sha256(plan.output);
      if (currentHash !== record.progress.output?.sha256) throw new PuppetLoomError("REVISION_CONFLICT", `待复核 PSD 已在任务创建后改变：${plan.output}`);
    }

    attempt.stage = "automated-review";
    record.stage = "automated-review";
    await saveRecord(plan, record);
    const review = await reviewPhotoshopPsdRepair({ output: plan.output, workDirectory: plan.workDirectory, recipe: plan.recipe });
    const reviewPath = join(plan.workDirectory, "automated-review.json");
    await atomicJson(reviewPath, review);
    const evidence = await evidenceFiles(review);
    const visualReviewPath = join(plan.workDirectory, "visual-review.json");
    await atomicJson(visualReviewPath, {
      version: 1,
      kind: "puppetloom-psd-repair-visual-review",
      operationId: record.id,
      outputSha256: record.progress.output!.sha256,
      status: "pending",
      reviewer: null,
      reviewedAt: null,
      checks: REQUIRED_VISUAL_CHECKS.map((id) => ({ id, status: "pending", note: "" })),
      blockingIssues: [],
      repairPlan: [],
      evidence
    });
    record.progress.automatedReviewCompleted = true;
    record.automatedReview = { valid: review.valid, reviewPath, visualReviewPath, evidence };
    attempt.completedAt = new Date().toISOString();
    record.processId = null;
    if (!review.valid) {
      attempt.status = "failed";
      record.status = "failed";
      record.stage = "automated-review-failed";
      record.error = "自动结构或 Alpha 检查未通过；不能进入人工接受终态。";
      await saveRecord(plan, record);
      return { record, review, result: await writeResult(record, { structuralValid: false, requiresVisualReview: true }) };
    }
    attempt.status = "succeeded";
    record.status = "awaiting-visual-review";
    record.stage = "psd-repair-awaiting-visual-review";
    await saveRecord(plan, record);
    return { record, review, result: await writeResult(record, { structuralValid: true, requiresVisualReview: true, exitCode: 4 }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date().toISOString();
    Object.assign(attempt, { status: "failed", completedAt: failedAt, error: message });
    Object.assign(record, { status: "failed", stage: `${attempt.stage}-failed`, updatedAt: failedAt, processId: null, error: message });
    await saveRecord(plan, record).catch(() => undefined);
    await writeResult(record, { exitCode: 3 }).catch(() => undefined);
    throw new PuppetLoomError("IO_ERROR", `${message}。任务已保留，可用原命令恢复：${operationPath(plan)}`, { cause: error });
  }
}

function validateDecision(record: PsdRepairOperationRecord, decision: z.infer<typeof visualDecisionSchema>): void {
  if (decision.operationId !== record.id) throw new PuppetLoomError("REVISION_CONFLICT", "视觉结论不属于当前 PSD 修复任务。" );
  if (decision.outputSha256 !== record.progress.output?.sha256) throw new PuppetLoomError("REVISION_CONFLICT", "视觉结论绑定的 PSD 哈希与当前任务不一致。" );
  const checkIds = new Set(decision.checks.map((check) => check.id));
  if (checkIds.size !== REQUIRED_VISUAL_CHECKS.length || REQUIRED_VISUAL_CHECKS.some((id) => !checkIds.has(id))) throw new PuppetLoomError("INVALID_INPUT", "视觉结论没有逐项覆盖全部必看项目。" );
  const values = decision.checks.map((check) => check.status);
  if (decision.status === "accepted" && (values.includes("repair") || values.includes("fail") || decision.repairPlan.length || decision.blockingIssues.length)) {
    throw new PuppetLoomError("INVALID_INPUT", "accepted 不能包含 repair/fail、修复计划或阻断项。" );
  }
  if (decision.status === "accepted-with-repairs" && (!values.includes("repair") || values.includes("fail") || !decision.repairPlan.length || decision.blockingIssues.length)) {
    throw new PuppetLoomError("INVALID_INPUT", "accepted-with-repairs 必须包含 repair 检查和非空 repairPlan，且不能包含 fail 或阻断项。" );
  }
  if (decision.status === "rejected" && (!values.includes("fail") || !decision.blockingIssues.length)) {
    throw new PuppetLoomError("INVALID_INPUT", "rejected 必须包含 fail 检查和至少一个阻断项。" );
  }
}

export async function finalizePhotoshopPsdRepairVisualReview(options: { workDirectory: string; decision: string }): Promise<PsdRepairOperationExecution> {
  const workDirectory = resolve(options.workDirectory);
  const operation = join(workDirectory, "operation.json");
  const record = await readRecord(operation);
  let rawDecision: unknown;
  try { rawDecision = JSON.parse(await readFile(resolve(options.decision), "utf8")); }
  catch (error) { throw new PuppetLoomError("INVALID_INPUT", `无法读取 PSD 视觉结论：${resolve(options.decision)}`, { cause: error }); }
  const parsed = visualDecisionSchema.safeParse(rawDecision);
  if (!parsed.success) throw new PuppetLoomError("INVALID_INPUT", `PSD 视觉结论无效：${z.prettifyError(parsed.error)}`);
  validateDecision(record, parsed.data);
  if (["accepted", "accepted-with-repairs", "rejected"].includes(record.status)) {
    if (record.status !== parsed.data.status) throw new PuppetLoomError("REVISION_CONFLICT", `PSD 修复任务已经以 ${record.status} 结束，不能改写为 ${parsed.data.status}。`);
    return { record, result: publicResult(record) };
  }
  if (record.status !== "awaiting-visual-review" || !record.automatedReview?.valid) {
    throw new PuppetLoomError("INVALID_INPUT", `PSD 修复任务当前不能接受视觉结论：${record.status}`);
  }
  if (!(await exists(record.plan.output)) || await sha256(record.plan.output) !== record.progress.output?.sha256) {
    throw new PuppetLoomError("REVISION_CONFLICT", "PSD 输出在自动复核后已经改变，必须重新执行任务。" );
  }
  for (const [name, identity] of Object.entries(record.automatedReview.evidence)) {
    const declared = parsed.data.evidence[name];
    if (!declared || resolve(declared.path) !== resolve(identity.path) || declared.sha256 !== identity.sha256 || !(await exists(identity.path)) || await sha256(identity.path) !== identity.sha256) {
      throw new PuppetLoomError("REVISION_CONFLICT", `视觉证据已经改变或结论未绑定该证据：${name}`);
    }
  }
  const reviewedAt = parsed.data.reviewedAt ?? new Date().toISOString();
  const finalizedDecision = { ...parsed.data, reviewedAt, acceptedForNextStage: parsed.data.status !== "rejected" };
  const decisionPath = resolve(options.decision);
  await atomicJson(decisionPath, finalizedDecision);
  record.status = parsed.data.status;
  record.stage = "psd-repair-visual-review-finalized";
  record.processId = null;
  delete record.error;
  record.visualReview = {
    status: parsed.data.status,
    reviewer: parsed.data.reviewer,
    reviewedAt,
    decisionPath,
    blockingIssues: parsed.data.blockingIssues,
    repairPlan: parsed.data.repairPlan
  };
  record.recovery = {
    resumable: false,
    command: "",
    note: parsed.data.status === "rejected" ? "任务已拒绝；保留全部输入、输出与证据供下一轮使用。" : "任务已由视觉结论终结。"
  };
  await atomicJson(operation, record);
  const result = await writeResult(record, {
    visualReviewStatus: parsed.data.status,
    reviewer: parsed.data.reviewer,
    reviewedAt,
    blockingIssues: parsed.data.blockingIssues,
    repairPlan: parsed.data.repairPlan,
    ...(parsed.data.status === "rejected" ? { exitCode: 4 } : {})
  });
  return { record, result };
}
