import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { neutralMotionState } from "./deform.js";
import { ModelPhysicsController } from "./model.js";
import { loadProjectTextureSources, renderProjectPoseWithSources } from "./offline-render.js";
import { loadCalibration, loadProjectRevision } from "./project.js";
import { safetyPoseState } from "./safety.js";
import type {
  MotionState,
  AuthoringPreview,
  RenderArtifact,
  RenderSuiteKind,
  RenderSuiteResult,
  RevisionComparisonResult
} from "./types.js";

interface Sample {
  id: string;
  label: string;
  kind: "pose" | "motion";
  state: MotionState;
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function state(overrides: Partial<MotionState>): MotionState {
  return { ...neutralMotionState, ...overrides };
}

const poseSamples: Sample[] = [
  { id: "left-up", label: "左转 + 向上看", kind: "pose", state: safetyPoseState(-0.72, -0.58, -0.12) },
  { id: "up", label: "向上看", kind: "pose", state: safetyPoseState(0, -0.78, 0) },
  { id: "right-up", label: "右转 + 向上看", kind: "pose", state: safetyPoseState(0.72, -0.58, 0.12) },
  { id: "left", label: "向左转头", kind: "pose", state: safetyPoseState(-0.9, 0, -0.08) },
  { id: "neutral", label: "中立", kind: "pose", state: { ...neutralMotionState } },
  { id: "right", label: "向右转头", kind: "pose", state: safetyPoseState(0.9, 0, 0.08) },
  { id: "left-down", label: "左转 + 向下看", kind: "pose", state: safetyPoseState(-0.72, 0.58, 0.12) },
  { id: "down", label: "向下看", kind: "pose", state: safetyPoseState(0, 0.78, 0) },
  { id: "right-down", label: "右转 + 向下看", kind: "pose", state: safetyPoseState(0.72, 0.58, -0.12) }
];

const motionSamples: Sample[] = [
  { id: "wind-left", label: "头发向左", kind: "motion", state: state({ hairX: -0.024, backHairX: -0.038, ahogeX: -0.045, clothX: -0.012 }) },
  { id: "ahoge-up", label: "呆毛弹起", kind: "motion", state: state({ ahogeX: 0.035, ahogeY: -0.026 }) },
  { id: "wind-right", label: "头发向右", kind: "motion", state: state({ hairX: 0.024, backHairX: 0.038, ahogeX: 0.045, clothX: 0.012 }) },
  { id: "ear-left", label: "左侧耳翼抬起", kind: "motion", state: state({ earX: -0.006, earY: -0.018 }) },
  { id: "motion-neutral", label: "次级运动中立", kind: "motion", state: state({}) },
  { id: "ear-right", label: "右侧耳翼抬起", kind: "motion", state: state({ earX: 0.006, earY: -0.018 }) },
  { id: "skirt-left-tail-up", label: "裙摆左 / 尾巴上", kind: "motion", state: state({ clothX: -0.02, tailY: -0.055 }) },
  { id: "cloth-breath", label: "衣物与呼吸", kind: "motion", state: state({ breath: 0.65, clothY: 0.01 }) },
  { id: "skirt-right-tail-down", label: "裙摆右 / 尾巴下", kind: "motion", state: state({ clothX: 0.02, tailY: 0.055 }) }
];

function previewState(project: import("./types.js").PuppetLoomProject, preview: AuthoringPreview): MotionState {
  const initial = state({
    ...(preview.parameters ? { parameters: preview.parameters } : {}),
    ...(preview.expressions ? { expressions: preview.expressions } : {}),
    ...(preview.behavior ? { behavior: preview.behavior, timeSeconds: preview.behavior.timeSeconds } : {})
  });
  if (!preview.settleSeconds || preview.settleSeconds <= 0) return initial;
  const controller = new ModelPhysicsController(project);
  let current = initial;
  const frames = Math.max(1, Math.ceil(preview.settleSeconds * 60));
  for (let frame = 0; frame <= frames; frame += 1) current = controller.sample({ ...initial, timeSeconds: frame / 60 }, frame / 60);
  return current;
}

function samplesFor(project: import("./types.js").PuppetLoomProject, suite: RenderSuiteKind, previews: AuthoringPreview[] = []): Sample[] {
  const authoringSamples: Sample[] = previews.map((preview) => ({
    id: `authoring-${preview.id}`,
    label: preview.label,
    kind: "pose",
    state: previewState(project, preview)
  }));
  if (suite === "poses") return poseSamples;
  if (suite === "motion") return motionSamples;
  return [...poseSamples, ...authoringSamples, ...motionSamples];
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function renderSheet(samples: Sample[], imagePaths: string[], output: string, title: string): Promise<void> {
  const columns = 3;
  const cellWidth = 300;
  const cellHeight = 330;
  const rows = Math.ceil(samples.length / columns);
  const overlays: sharp.OverlayOptions[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = column * cellWidth;
    const top = row * cellHeight + 44;
    overlays.push({ input: await readFile(imagePaths[index]!), left, top });
    const label = Buffer.from(`<svg width="${cellWidth}" height="30" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#141b27"/><text x="12" y="20" fill="#edf2fa" font-family="Segoe UI, Microsoft YaHei" font-size="14">${escapeXml(samples[index]!.label)}</text></svg>`);
    overlays.push({ input: label, left, top: top + 300 });
  }
  const heading = Buffer.from(`<svg width="${cellWidth * columns}" height="44" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#0d121b"/><text x="16" y="29" fill="#ffffff" font-family="Segoe UI, Microsoft YaHei" font-size="20" font-weight="700">${title}</text></svg>`);
  overlays.unshift({ input: heading, left: 0, top: 0 });
  await sharp({ create: { width: cellWidth * columns, height: rows * cellHeight + 44, channels: 4, background: { r: 8, g: 12, b: 18, alpha: 1 } } })
    .composite(overlays)
    .png()
    .toFile(output);
}

export async function renderProjectSuite(
  projectDirectory: string,
  outputDirectory: string,
  suite: RenderSuiteKind = "calibration",
  requestedRevision?: number
): Promise<RenderSuiteResult> {
  const root = resolve(projectDirectory);
  const output = resolve(outputDirectory);
  const revision = requestedRevision ?? (await loadCalibration(root)).revision;
  const project = await loadProjectRevision(root, revision);
  return renderProjectSuiteFromProject(root, project, output, suite, revision);
}

export async function renderProjectSuiteFromProject(
  projectDirectory: string,
  project: import("./types.js").PuppetLoomProject,
  outputDirectory: string,
  suite: RenderSuiteKind,
  revision: number,
  previews: AuthoringPreview[] = []
): Promise<RenderSuiteResult> {
  const root = resolve(projectDirectory);
  const output = resolve(outputDirectory);
  const sources = await loadProjectTextureSources(root, project);
  const samples = samplesFor(project, suite, previews);
  const artifacts: RenderArtifact[] = [];
  await mkdir(output, { recursive: true });
  const byKind = new Map<"pose" | "motion", Sample[]>();
  for (const sample of samples) byKind.set(sample.kind, [...(byKind.get(sample.kind) ?? []), sample]);
  for (const [kind, kindSamples] of byKind) {
    const directory = join(output, kind === "pose" ? "poses" : "motion");
    await mkdir(directory, { recursive: true });
    const paths: string[] = [];
    for (const sample of kindSamples) {
      const pixels = renderProjectPoseWithSources(project, sources, sample.state, 300, 300);
      const path = join(directory, `${sample.id}.png`);
      await sharp(Buffer.from(pixels.data), { raw: { width: 300, height: 300, channels: 4 } }).png().toFile(path);
      paths.push(path);
      artifacts.push({ id: sample.id, kind, path, state: sample.state, sha256: await fileSha256(path) });
    }
    const sheet = join(output, `${kind}-sheet.png`);
    await renderSheet(kindSamples, paths, sheet, kind === "pose" ? `姿态校准 · revision ${revision}` : `次级运动校准 · revision ${revision}`);
    artifacts.push({ id: `${kind}-sheet`, kind: "sheet", path: sheet, sha256: await fileSha256(sheet) });
  }
  const result: RenderSuiteResult = { project: project.name, revision, suite, outputDirectory: output, artifacts };
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function absoluteDifference(leftPath: string, rightPath: string, output: string): Promise<void> {
  const left = await sharp(leftPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(rightPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (left.info.width !== right.info.width || left.info.height !== right.info.height || left.info.channels !== right.info.channels) throw new Error("前后图片尺寸不一致，无法比较。" );
  const data = Buffer.alloc(left.data.length);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.abs((left.data[index] ?? 0) - (right.data[index] ?? 0));
  await sharp(data, { raw: { width: left.info.width, height: left.info.height, channels: left.info.channels } }).png().toFile(output);
}

export async function compareProjectRevisions(
  projectDirectory: string,
  fromRevision: number,
  toRevision: number,
  outputDirectory: string,
  previews: AuthoringPreview[] = []
): Promise<RevisionComparisonResult> {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const [beforeProject, afterProject] = await Promise.all([
    loadProjectRevision(projectDirectory, fromRevision),
    loadProjectRevision(projectDirectory, toRevision)
  ]);
  return compareProjectStates(projectDirectory, beforeProject, afterProject, fromRevision, toRevision, output, previews);
}

export async function compareProjectStates(
  projectDirectory: string,
  beforeProject: import("./types.js").PuppetLoomProject,
  afterProject: import("./types.js").PuppetLoomProject,
  fromRevision: number,
  toRevision: number,
  outputDirectory: string,
  previews: AuthoringPreview[] = []
): Promise<RevisionComparisonResult> {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const before = await renderProjectSuiteFromProject(projectDirectory, beforeProject, join(output, "before"), "calibration", fromRevision, previews);
  const after = await renderProjectSuiteFromProject(projectDirectory, afterProject, join(output, "after"), "calibration", toRevision, previews);
  const beforeSheet = before.artifacts.find((artifact) => artifact.id === "pose-sheet")!.path;
  const afterSheet = after.artifacts.find((artifact) => artifact.id === "pose-sheet")!.path;
  const beforeMotionSheet = before.artifacts.find((artifact) => artifact.id === "motion-sheet")!.path;
  const afterMotionSheet = after.artifacts.find((artifact) => artifact.id === "motion-sheet")!.path;
  const [beforeMeta, afterMeta, beforeMotionMeta, afterMotionMeta] = await Promise.all([
    sharp(beforeSheet).metadata(),
    sharp(afterSheet).metadata(),
    sharp(beforeMotionSheet).metadata(),
    sharp(afterMotionSheet).metadata()
  ]);
  const width = Math.max(beforeMeta.width ?? 1, afterMeta.width ?? 1, beforeMotionMeta.width ?? 1, afterMotionMeta.width ?? 1);
  const poseHeight = Math.max(beforeMeta.height ?? 1, afterMeta.height ?? 1);
  const motionHeight = Math.max(beforeMotionMeta.height ?? 1, afterMotionMeta.height ?? 1);
  const height = poseHeight + motionHeight;
  const beforeEvidence = join(output, "before-evidence.png");
  const afterEvidence = join(output, "after-evidence.png");
  await sharp({ create: { width, height, channels: 4, background: { r: 8, g: 12, b: 18, alpha: 1 } } })
    .composite([{ input: beforeSheet, left: 0, top: 0 }, { input: beforeMotionSheet, left: 0, top: poseHeight }])
    .png()
    .toFile(beforeEvidence);
  await sharp({ create: { width, height, channels: 4, background: { r: 8, g: 12, b: 18, alpha: 1 } } })
    .composite([{ input: afterSheet, left: 0, top: 0 }, { input: afterMotionSheet, left: 0, top: poseHeight }])
    .png()
    .toFile(afterEvidence);
  const comparisonSheet = join(output, "before-after.png");
  await sharp({ create: { width: width * 2, height, channels: 4, background: { r: 8, g: 12, b: 18, alpha: 1 } } })
    .composite([{ input: beforeEvidence, left: 0, top: 0 }, { input: afterEvidence, left: width, top: 0 }])
    .png()
    .toFile(comparisonSheet);
  const differenceImage = join(output, "difference.png");
  await absoluteDifference(beforeEvidence, afterEvidence, differenceImage);
  const [beforeEvidenceSha256, afterEvidenceSha256, comparisonSheetSha256, differenceImageSha256] = await Promise.all([
    fileSha256(beforeEvidence), fileSha256(afterEvidence), fileSha256(comparisonSheet), fileSha256(differenceImage)
  ]);
  const result: RevisionComparisonResult = {
    project: before.project,
    fromRevision,
    toRevision,
    outputDirectory: output,
    before,
    after,
    comparisonSheet,
    differenceImage,
    artifactSha256: {
      beforeEvidence: beforeEvidenceSha256,
      afterEvidence: afterEvidenceSha256,
      comparisonSheet: comparisonSheetSha256,
      differenceImage: differenceImageSha256
    }
  };
  await writeFile(join(output, "comparison.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
