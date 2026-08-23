import { access, readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { loadCalibration, loadProject, planFrontHairAgent, runFrontHairAgent, verifyProject } from "../packages/core/dist/index.js";
import { executeManagedRun } from "./lib/managed-run.mjs";
import { resolveProjectSource } from "./lib/project-source.mjs";
import { cloneCurrentProjectForTest } from "./lib/test-project-clone.mjs";

const source = await resolveProjectSource(process.argv[2]);

await executeManagedRun({
  category: "model-agent",
  producer: "scripts/run-model-agent-e2e.mjs",
  evidence: { command: "node scripts/run-model-agent-e2e.mjs [project]", scope: "单部位外部 Agent 制作与复审链" },
  estimatedBytes: 512 * 1024 ** 2,
  maximumRelativePathLength: 168,
  reuse: { applicable: false, reason: "Agent 每轮必须重新分析、制作和验证；相同输入素材与证据由内容对象库物理复用。" }
}, async (artifactRun) => {
  const project = artifactRun.path(`project-${basename(source)}`);
  const cloneReport = await cloneCurrentProjectForTest(source, project, { objectRoot: artifactRun.objectDirectory });
  const before = await loadProject(project);
  const beforeCalibration = await loadCalibration(project);
  const frontHair = before.layers.find((layer) => layer.role === "frontHair");
  if (!frontHair) throw new Error("真实项目没有前发图层。" );

  const instruction = "让前发随头部转向自然变形，并增加轻微滞后和回弹";
  const plan = await planFrontHairAgent(project, { instruction, layerId: frontHair.id });
  if (!plan.canApply || !plan.checks.every((check) => check.passed)) throw new Error(`真实前发 Agent 计划未通过：${JSON.stringify(plan.blockers)}`);
  const result = await runFrontHairAgent(project, { instruction, layerId: frontHair.id });
  if (!result.changed || result.toRevision <= beforeCalibration.revision) throw new Error("真实前发 Agent 没有形成新修订。" );
  if (!result.checks.every((check) => check.passed)) throw new Error("真实前发 Agent 保存后仍有失败检查。" );
  await Promise.all([access(result.reportPath), access(result.comparisonSheet), access(result.differenceImage)]);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  if (!Array.isArray(report.repairs) || !Array.isArray(report.checks) || report.targetLayerIds?.[0] !== frontHair.id) {
    throw new Error("真实前发 Agent 报告缺少目标图层、检查或返修记录。" );
  }
  const verification = await verifyProject(project);
  if (!verification.valid) throw new Error(`Agent 修订后的真实项目验证失败：${JSON.stringify(verification)}`);
  const after = await loadProject(project);
  const poseBindingId = `agent-front-hair-pose-${frontHair.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  const authored = after.model.bindings.find((binding) => binding.id === poseBindingId);
  const unifiedPose = Boolean(after.runtime.poseField && after.runtime.semanticCage);
  if (!unifiedPose && authored?.keyforms.length !== 9) throw new Error("没有统一姿态场的项目必须保存九向前发关键形。" );
  if (!result.checks.some((check) => check.id === "pose-deformation" && check.passed)) throw new Error("真实前发 Agent 没有验证九向前发变形。" );
  const evidenceDirectory = result.sessions.at(-1)?.evidenceDirectory;
  if (!evidenceDirectory) throw new Error("真实前发 Agent 没有返回本次修订的证据目录。" );
  const poseFiles = (await readdir(resolve(project, evidenceDirectory, "after", "poses")))
    .filter((name) => name.startsWith("authoring-agent-front-hair-") && name.endsWith(".png"));
  if (poseFiles.length !== 9) throw new Error(`真实前发 Agent 没有保存完整九向证据：${poseFiles.length}/9`);
  if (!after.model.physics.some((physics) => physics.id.includes("agent-front-hair-physics"))) throw new Error("真实前发 Agent 没有保存滞后回弹物理。" );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    source,
    project,
    cloneReport,
    fromRevision: beforeCalibration.revision,
    toRevision: result.toRevision,
    layerId: frontHair.id,
    checks: result.checks.length,
    reportPath: result.reportPath,
    comparisonSheet: result.comparisonSheet,
    differenceImage: result.differenceImage
  }, null, 2)}\n`);
});
