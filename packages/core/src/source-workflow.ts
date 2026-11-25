import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import sharp from "sharp";
import { PuppetLoomError } from "./errors.js";
import { reviewLayeredPsd, type LayeredPsdReview } from "./psd-repair.js";

export type SourceTaskStatus = "awaiting-decomposition" | "awaiting-visual-review" | "needs-repair" | "ready";

export interface SourcePreparationTask {
  version: 1;
  kind: "puppetloom-source-preparation";
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: SourceTaskStatus;
  reference: { path: string; sha256: string; width: number; height: number };
  decomposition: {
    provider: "see-through-official" | "external";
    officialUrl: string;
    expectedFormat: "layered-psd";
    requirements: string[];
  };
  reviews: Array<{
    index: number;
    createdAt: string;
    candidate: string;
    candidateSha256: string;
    directory: string;
    status: Exclude<SourceTaskStatus, "awaiting-decomposition">;
    blockers: string[];
  }>;
}

export interface PrepareSourceTaskOptions {
  reference: string;
  output: string;
  name?: string;
  provider?: SourcePreparationTask["decomposition"]["provider"];
}

export interface SourceReviewResult {
  task: SourcePreparationTask;
  review: LayeredPsdReview;
  reviewDirectory: string;
  candidate: string;
  blockers: string[];
  nextActions: string[];
}

const seeThroughOfficialUrl = "https://huggingface.co/spaces/shitagi/see-through";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function safeName(input: string): string {
  const cleaned = input.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ");
  return cleaned.slice(0, 80) || "character";
}

function taskMarkdown(task: SourcePreparationTask): string {
  return `# ${task.name} 素材准备任务\n\n状态：${task.status}\n\n## 当前步骤\n\n1. 使用任务目录中的参考图在 See-Through 官方页面完成分层。\n2. 下载保留原始画布坐标、透明通道和图层结构的 PSD。\n3. 运行 PuppetLoom 的 source review，生成重组、背景和逐图层证据。\n4. 对照原画完成目视复核；有问题时按报告修复 PSD，再提交下一版候选。\n\n官方入口：${task.decomposition.officialUrl}\n\n## 素材要求\n\n${task.decomposition.requirements.map((item) => `- ${item}`).join("\n")}\n`;
}

/** Creates a self-contained source-art task without bundling or invoking a decomposition model. */
export async function prepareSourceTask(options: PrepareSourceTaskOptions): Promise<{ directory: string; task: SourcePreparationTask }> {
  const reference = resolve(options.reference);
  const output = resolve(options.output);
  if (!(await exists(reference))) throw new PuppetLoomError("INVALID_INPUT", `原画不存在：${reference}`);
  if (extname(reference).toLowerCase() === ".psd") throw new PuppetLoomError("INVALID_INPUT", "素材准备入口需要单张原画；已有 PSD 请直接使用 source review。" );
  if (await exists(output)) {
    const entries = await readdir(output).catch(() => []);
    if (entries.length > 0) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `素材任务目录不是空目录：${output}`);
  }
  const metadata = await sharp(reference).metadata();
  if (!metadata.width || !metadata.height) throw new PuppetLoomError("INVALID_INPUT", "原画尺寸无效。" );
  await mkdir(output, { recursive: true });
  const extension = extname(reference).toLowerCase() || ".png";
  const referenceRelative = `reference/original${extension}`;
  const copiedReference = join(output, ...referenceRelative.split("/"));
  await mkdir(join(output, "reference"), { recursive: true });
  await copyFile(reference, copiedReference);
  const now = new Date().toISOString();
  const task: SourcePreparationTask = {
    version: 1,
    kind: "puppetloom-source-preparation",
    id: randomUUID(),
    name: safeName(options.name ?? basename(reference, extname(reference))),
    createdAt: now,
    updatedAt: now,
    status: "awaiting-decomposition",
    reference: { path: referenceRelative, sha256: await sha256(copiedReference), width: metadata.width, height: metadata.height },
    decomposition: {
      provider: options.provider ?? "see-through-official",
      officialUrl: seeThroughOfficialUrl,
      expectedFormat: "layered-psd",
      requirements: [
        "PSD 画布尺寸必须与原画一致。",
        "每个可动部位保留独立、可见、带透明通道的图层。",
        "被头发、脸部或服装遮挡的位置需要有足够托底，不能只保留当前可见像素。",
        "不要把左右眼、眉毛、手臂或腿在能够分开的情况下合并。",
        "导出后不得缩放、裁切或改变角色在画布中的位置。"
      ]
    },
    reviews: []
  };
  await atomicJson(join(output, "source-task.json"), task);
  await writeFile(join(output, "INSTRUCTIONS.md"), taskMarkdown(task), "utf8");
  return { directory: output, task };
}

export async function readSourceTask(directory: string): Promise<SourcePreparationTask> {
  const root = resolve(directory);
  let value: unknown;
  try { value = JSON.parse(await readFile(join(root, "source-task.json"), "utf8")) as unknown; }
  catch (cause) { throw new PuppetLoomError("INVALID_INPUT", `无法读取素材准备任务：${root}`, { cause }); }
  const task = value as Partial<SourcePreparationTask>;
  if (task.version !== 1 || task.kind !== "puppetloom-source-preparation" || typeof task.id !== "string" || !task.reference || !Array.isArray(task.reviews)) {
    throw new PuppetLoomError("INVALID_INPUT", "素材准备任务格式无效。" );
  }
  const reference = join(root, ...task.reference.path.split("/"));
  if (!(await exists(reference)) || await sha256(reference) !== task.reference.sha256) throw new PuppetLoomError("INVALID_INPUT", "素材准备任务中的原画缺失或内容已改变。" );
  return task as SourcePreparationTask;
}

function reviewBlockers(review: LayeredPsdReview): string[] {
  const blockers: string[] = [];
  if (!review.valid) blockers.push("PSD 结构检查未通过。" );
  if (review.structuralInspection.suggestedRigLevel === "minimal") blockers.push("当前图层结构只能建立 minimal 绑定。" );
  if (!review.roles.includes("face")) blockers.push("没有识别到脸部图层。" );
  const pairedRoles = ["eyeWhite", "iris"] as const;
  for (const role of pairedRoles) {
    const sides = new Set(review.layers.filter((layer) => layer.role === role).map((layer) => layer.side));
    if (!sides.has("left") || !sides.has("right")) blockers.push(`${role} 没有形成可靠的左右独立图层。`);
  }
  if (review.structuralInspection.unknownLayerCount > Math.max(2, Math.floor(review.layerCount * 0.2))) blockers.push("未识别图层比例过高，需要修正图层命名或结构。" );
  for (const issue of review.structuralInspection.layerOrderIssues) blockers.push(issue.message);
  return [...new Set(blockers)];
}

function reviewActions(blockers: string[]): string[] {
  if (blockers.length > 0) return ["查看 reference-comparison.png、背景证据和 layer-contact-sheet.png。", "根据 blockers 创建 PSD 修复配方并输出新的候选 PSD。", "修复后再次运行 source review；不要覆盖这一版候选和证据。"];
  return ["逐图查看重组、白底、深色、棋盘和图层联系表。", "确认遮挡托底、边缘和原画一致后，把本次 review 标记为 ready。", "使用候选 PSD 创建 PuppetLoom 项目。"];
}

/** Imports one candidate PSD into the task and writes deterministic visual/structural review artifacts. */
export async function reviewSourceCandidate(options: { task: string; psd: string }): Promise<SourceReviewResult> {
  const root = resolve(options.task);
  const input = resolve(options.psd);
  if (extname(input).toLowerCase() !== ".psd" || !(await exists(input))) throw new PuppetLoomError("INVALID_INPUT", `候选 PSD 不存在或扩展名无效：${input}`);
  const task = await readSourceTask(root);
  const index = task.reviews.reduce((maximum, review) => Math.max(maximum, review.index), 0) + 1;
  const label = String(index).padStart(4, "0");
  const reviewDirectory = join(root, "reviews", label);
  if (await exists(reviewDirectory)) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `复核目录已经存在：${reviewDirectory}`);
  await mkdir(reviewDirectory, { recursive: true });
  const candidateRelative = `candidates/${label}.psd`;
  const candidate = join(root, ...candidateRelative.split("/"));
  await mkdir(join(root, "candidates"), { recursive: true });
  await copyFile(input, candidate);
  const reference = join(root, ...task.reference.path.split("/"));
  const review = await reviewLayeredPsd({ input: candidate, reference, outputDirectory: reviewDirectory });
  const blockers = reviewBlockers(review);
  const status: SourcePreparationTask["status"] = blockers.length > 0 ? "needs-repair" : "awaiting-visual-review";
  const createdAt = new Date().toISOString();
  const entry: SourcePreparationTask["reviews"][number] = {
    index,
    createdAt,
    candidate: candidateRelative,
    candidateSha256: await sha256(candidate),
    directory: `reviews/${label}`,
    status,
    blockers
  };
  const updated: SourcePreparationTask = { ...task, updatedAt: createdAt, status, reviews: [...task.reviews, entry] };
  const nextActions = reviewActions(blockers);
  await writeFile(join(reviewDirectory, "review.json"), `${JSON.stringify({ version: 1, taskId: task.id, candidate: candidateRelative, review, blockers, nextActions }, null, 2)}\n`, "utf8");
  await atomicJson(join(root, "source-task.json"), updated);
  await writeFile(join(root, "INSTRUCTIONS.md"), taskMarkdown(updated), "utf8");
  return { task: updated, review, reviewDirectory, candidate, blockers, nextActions };
}

/** Records the human visual decision without discarding prior candidate evidence. */
export async function finalizeSourceReview(options: { task: string; review: number; decision: "ready" | "needs-repair"; note: string }): Promise<SourcePreparationTask> {
  const root = resolve(options.task);
  const task = await readSourceTask(root);
  const target = task.reviews.find((review) => review.index === options.review);
  if (!target) throw new PuppetLoomError("INVALID_INPUT", `找不到素材复核 ${options.review}。`);
  if (!options.note.trim()) throw new PuppetLoomError("INVALID_INPUT", "素材目视结论必须说明看到的结果。" );
  if (options.decision === "ready" && target.blockers.length > 0) throw new PuppetLoomError("INVALID_INPUT", "结构检查仍有阻断项，不能标记为 ready。" );
  const updatedAt = new Date().toISOString();
  const reviews = task.reviews.map((review) => review.index === options.review ? { ...review, status: options.decision } : review);
  const updated: SourcePreparationTask = { ...task, updatedAt, status: options.decision, reviews };
  const directory = join(root, ...target.directory.split("/"));
  await writeFile(join(directory, "visual-decision.json"), `${JSON.stringify({ version: 1, taskId: task.id, review: options.review, decision: options.decision, note: options.note.trim(), decidedAt: updatedAt }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await atomicJson(join(root, "source-task.json"), updated);
  await writeFile(join(root, "INSTRUCTIONS.md"), taskMarkdown(updated), "utf8");
  return updated;
}
