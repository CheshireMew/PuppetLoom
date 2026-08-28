import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { loadCalibration, loadProject, verifyProject } from "../packages/core/dist/index.js";
import { executeManagedRun } from "./lib/managed-run.mjs";
import { resolveProjectSource } from "./lib/project-source.mjs";
import { cloneCurrentProjectForTest } from "./lib/test-project-clone.mjs";

const source = await resolveProjectSource(process.argv[2]);
const cli = resolve("apps/cli/dist/index.js");

async function runCliJson(arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cli, ...arguments_, "--json"], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectRun(new Error(`PuppetLoom CLI 失败（${code ?? "unknown"}）：${stderr.trim() || stdout.trim()}`));
        return;
      }
      try { resolveRun(JSON.parse(stdout)); }
      catch (cause) { rejectRun(new Error(`PuppetLoom CLI 没有返回可供外部 Agent 消费的 JSON：${stdout.slice(0, 1000)}`, { cause })); }
    });
  });
}

await executeManagedRun({
  category: "whole-model-agent",
  producer: "scripts/run-whole-model-agent-e2e.mjs",
  evidence: { command: "node scripts/run-whole-model-agent-e2e.mjs [project]", scope: "整模外部 Agent 制作与复审链" },
  estimatedBytes: 1024 * 1024 ** 2,
  maximumRelativePathLength: 168,
  reuse: { applicable: false, reason: "整模 Agent 每轮都必须重新执行各部位检查；输入素材和相同证据由内容对象库复用。" }
}, async (artifactRun) => {
  const projectDirectory = artifactRun.path(`project-${basename(source)}`);
  const cloneReport = await cloneCurrentProjectForTest(source, projectDirectory, { objectRoot: artifactRun.objectDirectory });
  const before = await loadProject(projectDirectory);
  const beforeCalibration = await loadCalibration(projectDirectory);
  const specification = await runCliJson(["agent", "specification", "--project", projectDirectory, "--scope", "whole"]);
  specification.goal = "外部 Agent 已查看真实模型基线；保持原角色观感，整模采用自然、协调、克制的运动";
  for (const part of specification.parts) part.rationale = [`外部 Agent 已检查基线，${part.part} 使用保守起点，执行后必须继续看局部对比和连续帧。`];
  const pointMap = (layer, value) => Object.fromEntries(layer.mesh.points.map((_, index) => [String(index), value(layer.mesh.points[index], index)]));
  const releaseFor = (layer) => pointMap(layer, (point, index) => layer.mesh.influences?.physicsRelease?.[index]
    ?? Math.min(1, Math.hypot(point.x - layer.pivot.x, point.y - layer.pivot.y) / Math.max(1e-6, Math.hypot(layer.bounds.width, layer.bounds.height) * 0.72)));
  const sensitive = new Set(["frontHair", "backHair", "ears", "headwear", "topCloth", "mouth"]);
  const anatomyLayers = {};
  for (const part of specification.parts.filter((candidate) => sensitive.has(candidate.part))) {
    for (const id of part.layerIds ?? []) {
      const layer = before.layers.find((candidate) => candidate.id === id);
      if (!layer) continue;
      anatomyLayers[id] = part.part === "mouth"
        ? { mesh: layer.mesh }
        : {
            pivot: layer.pivot,
            ...(part.part === "frontHair" || part.part === "backHair"
              ? layer.hairStrands?.length ? { hairStrands: layer.hairStrands } : { vertexInfluences: { physicsRelease: releaseFor(layer) } }
              : { vertexInfluences: { physicsRelease: releaseFor(layer) } }),
            ...(part.part === "headwear" ? { headwearPerspective: layer.headwearPerspective ?? null } : {})
          };
    }
  }
  const cage = before.runtime.semanticCage?.points;
  specification.anatomy = {
    ...(cage ? { semanticPoints: Object.fromEntries(["eyeLeft", "eyeRight", "nose", "mouthLeft", "mouth", "mouthRight", "chin"].map((id) => [id, cage[id].position])) } : {}),
    layers: anatomyLayers
  };
  const specificationPath = artifactRun.path("whole-model-rig-spec.json");
  await writeFile(specificationPath, `${JSON.stringify(specification, null, 2)}\n`, "utf8");
  const plan = await runCliJson(["agent", "plan", "--project", projectDirectory, "--spec", specificationPath]);
  if (plan.inputMode !== "structured-specification") throw new Error("整模测试没有走外部 Agent 的结构化制作规格。" );
  if (!plan.canApply) throw new Error(`整模 Agent 计划未通过：${JSON.stringify(plan.blockers)}`);
  for (const required of ["headFace", "eyes", "mouth", "frontHair", "backHair", "headwear", "body", "topCloth", "skirt", "tail"]) {
    if (plan.parts.find((part) => part.part === required)?.status !== "ready") throw new Error(`真实模型的 ${required} 没有进入可执行状态。`);
  }
  const result = await runCliJson(["agent", "apply", "--project", projectDirectory, "--spec", specificationPath]);
  if (!result.ok || result.status !== "completed") throw new Error(`整模 Agent 没有完成：${JSON.stringify(result.parts.filter((part) => part.status === "blocked"))}`);
  if (!result.verification?.valid || result.blockers.length > 0) throw new Error(`CLI 没有返回通过的整模联合验证：${JSON.stringify({ blockers: result.blockers, verification: result.verification })}`);
  if (result.toRevision <= beforeCalibration.revision) throw new Error("整模 Agent 没有形成可回滚修订。" );
  await access(result.reportPath);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  if (report.parts.filter((part) => part.status === "completed").length < 10) throw new Error("整模报告没有覆盖全部已存在部位。" );
  for (const part of result.parts.filter((candidate) => candidate.status === "completed")) {
    if (!part.reportPath || !part.comparisonSheet) throw new Error(`${part.part} 缺少报告或前后证据。`);
    await Promise.all([access(part.reportPath), access(part.comparisonSheet)]);
    const partReport = JSON.parse(await readFile(part.reportPath, "utf8"));
    if (!partReport.evidence?.focus?.comparisonSheet || !partReport.evidence?.focus?.motionSheet || !partReport.evidence?.focus?.motionManifest) throw new Error(`${part.part} 缺少局部放大或连续运动证据。`);
    await Promise.all([access(partReport.evidence.focus.comparisonSheet), access(partReport.evidence.focus.motionSheet), access(partReport.evidence.focus.motionManifest)]);
  }
  const verification = await verifyProject(projectDirectory);
  if (!verification.valid) throw new Error(`整模 Agent 修订后项目验证失败：${JSON.stringify(verification)}`);
  const after = await loadProject(projectDirectory);
  const unifiedPose = Boolean(after.runtime.poseField && after.runtime.semanticCage);
  const frontHairPose = after.model.bindings.find((binding) => binding.id.startsWith("agent-front-hair-pose-"));
  if (!unifiedPose && frontHairPose?.keyforms.length !== 9) throw new Error("没有统一姿态场的整模项目必须保存前发九向关键形。" );
  if (unifiedPose && !after.model.bindings.some((binding) => binding.id.startsWith("agent-front-hair-lag-"))) throw new Error("统一姿态场项目没有保存前发滞后与回弹绑定。" );
  if (!after.model.expressions.some((expression) => expression.id === "agent-eyes-closed")) throw new Error("闭眼表达未保存。" );
  if (!after.model.expressions.some((expression) => expression.id === "agent-mouth-open")) throw new Error("三态嘴型表达未保存。" );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    source,
    projectDirectory,
    cloneReport,
    fromRevision: beforeCalibration.revision,
    toRevision: result.toRevision,
    completedParts: result.parts.filter((part) => part.status === "completed").map((part) => part.part),
    notPresentParts: result.parts.filter((part) => part.status === "not-present").map((part) => part.part),
    reportPath: result.reportPath,
    specificationPath,
    sourceLayerCount: before.layers.length,
    outputLayerCount: after.layers.length
  }, null, 2)}\n`);
});
