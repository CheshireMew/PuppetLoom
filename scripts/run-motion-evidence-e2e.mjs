import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createProject } from "@puppetloom/core";
import { executeManagedRun } from "./lib/managed-run.mjs";

function runCli(arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve("apps/cli/dist/index.js"), ...arguments_], { cwd: resolve("."), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0 ? resolveRun(JSON.parse(stdout)) : rejectRun(new Error(stderr || `CLI 退出 ${code}`)));
  });
}

await executeManagedRun({ category: "motion-evidence", producer: "scripts/run-motion-evidence-e2e.mjs", estimatedBytes: 512 * 1024 ** 2, reuse: { applicable: false, reason: "视频、接触表与时间戳报告是一次独立动态验收结果；固定 PSD 输入复用仓库真源。" } }, async (artifactRun) => {
const root = artifactRun.directory;
const project = resolve(root, "project");
await createProject({ input: resolve("test/fixtures/semantic.psd"), output: project, seed: 42 });

for (const mode of ["autonomous", "secondary"]) {
  const output = resolve(root, mode);
  const report = await runCli([
    "record",
    "--project", project,
    "--output", output,
    "--mode", mode,
    "--revision", "0",
    "--duration", "3",
    "--fps", "4",
    "--json"
  ]);
  if (report.revision !== 0 || report.mode !== mode || report.currentRevisionAtStart !== 0) throw new Error(`${mode} 没有记录准确 revision。`);
  if (!report.motionDetected || report.maximumChangedRatio <= 0) throw new Error(`${mode} 没有检测到动态像素。`);
  if (mode === "secondary" && !report.headAndBodyFrozen) throw new Error("secondary 没有冻结头部和身体。" );
  if (mode === "secondary" && ["headYaw", "headPitch", "headRoll", "bodySway", "bodyPitch", "bodyRoll", "gazeX", "gazeY", "breath", "blink", "mouthOpen"].some((key) => report.extrema[key] !== 0)) {
    throw new Error("secondary 报告中的主运动并未真正归零。" );
  }
  for (const path of [report.outputPath, report.focusPath, report.sheetPath, report.reportPath]) {
    if ((await stat(path)).size <= 0) throw new Error(`动态证据为空：${path}`);
  }
  let refusedOverwrite = false;
  try {
    await runCli([
      "record", "--project", project, "--output", output, "--mode", mode,
      "--revision", "0", "--duration", "3", "--fps", "4", "--json"
    ]);
  } catch (error) {
    refusedOverwrite = String(error).includes("不会覆盖");
  }
  if (!refusedOverwrite) throw new Error(`${mode} 没有拒绝覆盖既有证据。`);
}

const projectDocumentPath = resolve(project, "puppetloom.json");
const nonSquareProject = JSON.parse(await readFile(projectDocumentPath, "utf8"));
nonSquareProject.canvas = { width: 768, height: 512 };
await writeFile(projectDocumentPath, `${JSON.stringify(nonSquareProject, null, 2)}\n`, "utf8");
const nonSquare = await runCli([
  "record", "--project", project, "--output", resolve(root, "non-square"), "--mode", "autonomous",
  "--revision", "0", "--duration", "2", "--fps", "2", "--json"
]);
if (Math.abs(nonSquare.viewportAspectRatio - 1.5) > 0.01) throw new Error("非方形播放器窗口没有保持项目比例。" );
if (nonSquare.renderArea.width !== 640 || nonSquare.renderArea.height >= 640 || nonSquare.renderArea.top <= 0) {
  throw new Error("非方形动态证据没有使用透明留边等比适配。" );
}

process.stdout.write(`${JSON.stringify({ ok: true, root }, null, 2)}\n`);
});
