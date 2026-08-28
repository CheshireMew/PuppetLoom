import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createProject } from "@puppetloom/core";
import { executeManagedRun } from "./lib/managed-run.mjs";
import { measureProjectPerformance } from "./lib/render-performance.mjs";

await executeManagedRun({ category: "performance", producer: "scripts/run-performance-check.mjs", evidence: { command: "node scripts/run-performance-check.mjs", scope: "23 图层桌面渲染性能检查" }, estimatedBytes: 512 * 1024 ** 2, maximumRelativePathLength: 152, reuse: { applicable: false, reason: "帧时间与运行环境绑定，每次测量都是独立性能证据。" } }, async (artifactRun) => {
const output = artifactRun.path("project");
await createProject({ input: resolve("test/fixtures/performance-23.psd"), output, seed: 42 });
const measurement = await measureProjectPerformance({ projectDirectory: output, trials: 3 });
const report = artifactRun.path("performance.json");
await writeFile(report, `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
if (!measurement.valid) throw new Error(`性能未达到稳定 60 FPS 要求：${JSON.stringify(measurement)}`);
process.stdout.write(`${JSON.stringify({ ok: true, project: output, report, measurement }, null, 2)}\n`);
});
