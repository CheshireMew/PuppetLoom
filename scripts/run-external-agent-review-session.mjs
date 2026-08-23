import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { verifyProject } from "../packages/core/dist/index.js";
import { startManagedRun } from "./lib/managed-run.mjs";
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
      if (code !== 0) return rejectRun(new Error(`CLI 失败（${code ?? "unknown"}）：${stderr.trim() || stdout.trim()}`));
      try { resolveRun(JSON.parse(stdout)); }
      catch (cause) { rejectRun(new Error(`CLI 没有返回 JSON：${stdout.slice(0, 1000)}`, { cause })); }
    });
  });
}

const managed = await startManagedRun({
  category: "external-agent-review",
  producer: "scripts/run-external-agent-review-session.mjs",
  evidence: { command: "node scripts/run-external-agent-review-session.mjs", scope: "外部 Agent 准确 revision 复审链" },
  estimatedBytes: 1024 * 1024 ** 2,
  maximumRelativePathLength: 160,
  reuse: { applicable: false, reason: "外部 Agent 必须逐轮查看准确 revision 的新证据；相同输入素材由内容对象库复用。" }
});

let finished = false;
try {
  const projectDirectory = managed.path(`project-${basename(source)}`);
  const cloneReport = await cloneCurrentProjectForTest(source, projectDirectory, { objectRoot: managed.objectDirectory });
  const baselineDirectory = managed.path("baseline");
  const autonomousDirectory = managed.path("baseline-autonomous");
  const secondaryDirectory = managed.path("baseline-secondary");
  const baseline = await runCliJson(["render", "--project", projectDirectory, "--output", baselineDirectory, "--suite", "calibration"]);
  const autonomous = await runCliJson(["record", "--project", projectDirectory, "--output", autonomousDirectory, "--mode", "autonomous", "--revision", "0"]);
  const secondary = await runCliJson(["record", "--project", projectDirectory, "--output", secondaryDirectory, "--mode", "secondary", "--revision", "0"]);
  process.stdout.write(`${JSON.stringify({ event: "baseline-ready", runId: managed.id, projectDirectory, cloneReport, baseline, autonomous, secondary })}\n`);

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.action === "apply") {
      const specificationPath = resolve(String(command.specificationPath));
      await access(specificationPath);
      const plan = await runCliJson(["agent", "plan", "--project", projectDirectory, "--spec", specificationPath]);
      if (!plan.canApply || plan.inputMode !== "structured-specification") {
        process.stdout.write(`${JSON.stringify({ event: "plan-blocked", specificationPath, plan })}\n`);
        continue;
      }
      const result = await runCliJson(["agent", "apply", "--project", projectDirectory, "--spec", specificationPath]);
      process.stdout.write(`${JSON.stringify({ event: "revision-ready", specificationPath, plan, result })}\n`);
      continue;
    }
    if (command.action === "finish") {
      const verification = await verifyProject(projectDirectory);
      if (!verification.valid) throw new Error(`最终项目验证失败：${JSON.stringify(verification)}`);
      await managed.finish("succeeded");
      finished = true;
      process.stdout.write(`${JSON.stringify({ event: "finished", runId: managed.id, projectDirectory, verification, manifestPath: managed.manifestPath })}\n`);
      input.close();
      break;
    }
    throw new Error(`不支持的交互动作：${command.action}`);
  }
  if (!finished) throw new Error("外部 Agent 审查会话在 finish 前结束。" );
} catch (error) {
  if (!finished) await managed.finish("failed", error).catch(() => undefined);
  throw error;
}
