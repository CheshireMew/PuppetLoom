import { resolve } from "node:path";
import { createProject } from "@puppetloom/core";
import { _electron as electron } from "playwright";
import { executeManagedRun } from "./lib/managed-run.mjs";

await executeManagedRun({ category: "performance", producer: "scripts/run-performance-check.mjs", evidence: { command: "node scripts/run-performance-check.mjs", scope: "23 图层桌面渲染性能检查" }, estimatedBytes: 512 * 1024 ** 2, maximumRelativePathLength: 152, reuse: { applicable: false, reason: "帧时间与运行环境绑定，每次测量都是独立性能证据。" } }, async (artifactRun) => {
const output = artifactRun.path("project");
await createProject({ input: resolve("test/fixtures/performance-23.psd"), output, seed: 42 });

const electronApp = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js"), "--project", output],
  cwd: resolve("."),
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1" }
});

try {
  const viewer = await electronApp.firstWindow();
  await viewer.getByTestId("viewer").waitFor();
  await viewer.waitForFunction(() => document.querySelector("canvas")?.getContext("webgl2") !== null);
  await viewer.waitForTimeout(1200);
  const measurement = await viewer.evaluate(async () => {
    const intervals = [];
    let previous = performance.now();
    for (let frame = 0; frame < 360; frame += 1) {
      const now = await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      if (frame > 30) intervals.push(now - previous);
      previous = now;
    }
    intervals.sort((left, right) => left - right);
    const averageInterval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    const p95 = intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))];
    const buckets = {
      under18: intervals.filter((value) => value < 18).length,
      under26: intervals.filter((value) => value >= 18 && value < 26).length,
      under40: intervals.filter((value) => value >= 26 && value < 40).length,
      over40: intervals.filter((value) => value >= 40).length
    };
    const renderDurations = [];
    if (typeof window.puppetloomRenderTestPose === "function") {
      for (let index = 0; index < 90; index += 1) {
        const started = performance.now();
        window.puppetloomRenderTestPose({ headYaw: index % 2 ? 0.55 : -0.55, headPitch: 0.2 });
        renderDurations.push(performance.now() - started);
      }
      renderDurations.sort((left, right) => left - right);
    }
    return {
      frameCount: intervals.length,
      averageFps: 1000 / averageInterval,
      p95FrameMs: p95,
      webgl2: Boolean(document.querySelector("canvas")?.getContext("webgl2")),
      buckets,
      renderCpuMs: renderDurations.length ? {
        average: renderDurations.reduce((sum, value) => sum + value, 0) / renderDurations.length,
        p95: renderDurations[Math.floor(renderDurations.length * 0.95)]
      } : undefined
    };
  });
  if (!measurement.webgl2 || measurement.averageFps < 57 || measurement.p95FrameMs > 25) throw new Error(`性能未达到稳定 60 FPS 要求：${JSON.stringify(measurement)}`);
  process.stdout.write(`${JSON.stringify({ ok: true, project: output, canvas: "1280x1280", layers: 23, measurement }, null, 2)}\n`);
} finally {
  await electronApp.close();
}
});
