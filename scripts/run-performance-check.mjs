import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createProject } from "@puppetloom/core";
import { _electron as electron } from "playwright";

const output = resolve("test/artifacts", `performance-project-${process.pid}-${Date.now()}`);
await mkdir(resolve("test/artifacts"), { recursive: true });
await createProject({ input: resolve("test/fixtures/performance-23.psd"), output, seed: 42 });

const electronApp = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js"), "--project", output],
  cwd: resolve("."),
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }
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
    return {
      frameCount: intervals.length,
      averageFps: 1000 / averageInterval,
      p95FrameMs: p95,
      webgl2: Boolean(document.querySelector("canvas")?.getContext("webgl2"))
    };
  });
  if (!measurement.webgl2 || measurement.averageFps < 57 || measurement.p95FrameMs > 25) throw new Error(`性能未达到稳定 60 FPS 要求：${JSON.stringify(measurement)}`);
  process.stdout.write(`${JSON.stringify({ ok: true, project: output, canvas: "1280x1280", layers: 23, measurement }, null, 2)}\n`);
} finally {
  await electronApp.close();
}
