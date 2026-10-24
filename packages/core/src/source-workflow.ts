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
  return `# ${task.name} 소재 준비 작업\n\n상태: ${task.status}\n\n## 현재 단계\n\n1. 작업 폴더의 참고 이미지로 See-Through 공식 페이지에서 레이어를 분리하세요.\n2. 원본 캔버스 좌표, 투명 채널, 레이어 구조를 유지한 PSD를 다운로드하세요.\n3. PuppetLoom source review를 실행해 재합성·배경·레이어별 증거를 만드세요.\n4. 원화와 대조해 눈으로 검수하고, 문제가 있으면 보고서로 PSD를 고친 뒤 다음 후보를 제출하세요.\n\n공식 입구: ${task.decomposition.officialUrl}\n\n## 소재 요구사항\n\n${task.decomposition.requirements.map((item) => `- ${item}`).join("\n")}\n`;
}

/** Creates a self-contained source-art task without bundling or invoking a decomposition model. */
export async function prepareSourceTask(options: PrepareSourceTaskOptions): Promise<{ directory: string; task: SourcePreparationTask }> {
  const reference = resolve(options.reference);
  const output = resolve(options.output);
  if (!(await exists(reference))) throw new PuppetLoomError("INVALID_INPUT", `원화가 없습니다: ${reference}`);
  if (extname(reference).toLowerCase() === ".psd") throw new PuppetLoomError("INVALID_INPUT", "소재 준비 입구는 단일 원화가 필요합니다. 이미 PSD가 있으면 source review를 바로 쓰세요.");
  if (await exists(output)) {
    const entries = await readdir(output).catch(() => []);
    if (entries.length > 0) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `소재 작업 폴더가 비어 있지 않습니다: ${output}`);
  }
  const metadata = await sharp(reference).metadata();
  if (!metadata.width || !metadata.height) throw new PuppetLoomError("INVALID_INPUT", "원화 크기가 유효하지 않습니다.");
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
        "PSD 캔버스 크기는 원화와 같아야 합니다.",
        "움직이는 부위마다 독립적이고 보이며 투명 채널이 있는 레이어를 유지하세요.",
        "머리카락·얼굴·옷에 가려진 부분에도 충분한 속살이 있어야 하며, 지금 보이는 픽셀만 남기면 안 됩니다.",
        "나눌 수 있는 좌우 눈, 눈썹, 팔, 다리는 합치지 마세요.",
        "내보낸 뒤 크기 조절, 자르기, 캔버스 속 캐릭터 위치 변경을 하지 마세요."
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
  catch (cause) { throw new PuppetLoomError("INVALID_INPUT", `소재 준비 작업을 읽을 수 없습니다: ${root}`, { cause }); }
  const task = value as Partial<SourcePreparationTask>;
  if (task.version !== 1 || task.kind !== "puppetloom-source-preparation" || typeof task.id !== "string" || !task.reference || !Array.isArray(task.reviews)) {
    throw new PuppetLoomError("INVALID_INPUT", "소재 준비 작업 형식이 유효하지 않습니다.");
  }
  const reference = join(root, ...task.reference.path.split("/"));
  if (!(await exists(reference)) || await sha256(reference) !== task.reference.sha256) throw new PuppetLoomError("INVALID_INPUT", "소재 준비 작업의 원화가 없거나 내용이 바뀌었습니다.");
  return task as SourcePreparationTask;
}

function reviewBlockers(review: LayeredPsdReview): string[] {
  const blockers: string[] = [];
  if (!review.valid) blockers.push("PSD 구조 검사를 통과하지 못했습니다.");
  if (review.structuralInspection.suggestedRigLevel === "minimal") blockers.push("현재 레이어 구조로는 minimal 바인딩만 만들 수 있습니다.");
  if (!review.roles.includes("face")) blockers.push("얼굴 레이어를 인식하지 못했습니다.");
  const pairedRoles = ["eyeWhite", "iris"] as const;
  for (const role of pairedRoles) {
    const sides = new Set(review.layers.filter((layer) => layer.role === role).map((layer) => layer.side));
    if (!sides.has("left") || !sides.has("right")) blockers.push(`${role}에 믿을 수 있는 좌우 독립 레이어가 없습니다.`);
  }
  if (review.structuralInspection.unknownLayerCount > Math.max(2, Math.floor(review.layerCount * 0.2))) blockers.push("인식되지 않은 레이어 비율이 높아 레이어 이름이나 구조를 고쳐야 합니다.");
  for (const issue of review.structuralInspection.layerOrderIssues) blockers.push(issue.message);
  return [...new Set(blockers)];
}

function reviewActions(blockers: string[]): string[] {
  if (blockers.length > 0) return ["reference-comparison.png, 배경 증거, layer-contact-sheet.png를 확인하세요.", "blockers를 바탕으로 PSD 수정 처방을 만들고 새 후보 PSD를 내보내세요.", "고친 뒤 source review를 다시 실행하세요. 이 버전 후보와 증거는 덮어쓰지 마세요."];
  return ["재합성, 흰 배경, 어두운 배경, 체커보드, 레이어 연락표를 하나씩 보세요.", "가림 속살, 가장자리, 원화가 일치하면 이 review를 ready로 표시하세요.", "후보 PSD로 PuppetLoom 프로젝트를 만드세요."];
}

/** Imports one candidate PSD into the task and writes deterministic visual/structural review artifacts. */
export async function reviewSourceCandidate(options: { task: string; psd: string }): Promise<SourceReviewResult> {
  const root = resolve(options.task);
  const input = resolve(options.psd);
  if (extname(input).toLowerCase() !== ".psd" || !(await exists(input))) throw new PuppetLoomError("INVALID_INPUT", `후보 PSD가 없거나 확장자가 잘못되었습니다: ${input}`);
  const task = await readSourceTask(root);
  const index = task.reviews.reduce((maximum, review) => Math.max(maximum, review.index), 0) + 1;
  const label = String(index).padStart(4, "0");
  const reviewDirectory = join(root, "reviews", label);
  if (await exists(reviewDirectory)) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `검수 폴더가 이미 있습니다: ${reviewDirectory}`);
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
  if (!target) throw new PuppetLoomError("INVALID_INPUT", `소재 검수 ${options.review}을(를) 찾을 수 없습니다.`);
  if (!options.note.trim()) throw new PuppetLoomError("INVALID_INPUT", "소재 육안 결론에는 본 결과를 적어야 합니다.");
  if (options.decision === "ready" && target.blockers.length > 0) throw new PuppetLoomError("INVALID_INPUT", "구조 검사에 차단 항목이 남아 ready로 표시할 수 없습니다.");
  const updatedAt = new Date().toISOString();
  const reviews = task.reviews.map((review) => review.index === options.review ? { ...review, status: options.decision } : review);
  const updated: SourcePreparationTask = { ...task, updatedAt, status: options.decision, reviews };
  const directory = join(root, ...target.directory.split("/"));
  await writeFile(join(directory, "visual-decision.json"), `${JSON.stringify({ version: 1, taskId: task.id, review: options.review, decision: options.decision, note: options.note.trim(), decidedAt: updatedAt }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await atomicJson(join(root, "source-task.json"), updated);
  await writeFile(join(root, "INSTRUCTIONS.md"), taskMarkdown(updated), "utf8");
  return updated;
}
