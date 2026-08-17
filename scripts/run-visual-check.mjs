import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createProject } from "@puppetloom/core";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import { executeManagedRun } from "./lib/managed-run.mjs";

await executeManagedRun({ category: "visual", producer: "scripts/run-visual-check.mjs", estimatedBytes: 512 * 1024 ** 2, reuse: { applicable: false, reason: "截图和 GPU 上下文属性用于证明本轮实际渲染，不跨运行复用。" } }, async (artifactRun) => {
const output = artifactRun.path("project");
const firstPath = artifactRun.path("viewer-a.png");
const secondPath = artifactRun.path("viewer-b.png");
await createProject({ input: resolve("test/fixtures/semantic.psd"), output, seed: 42 });

const electronApp = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js"), "--project", output],
  cwd: resolve("."),
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1" }
});

try {
  const viewer = await electronApp.firstWindow();
  await viewer.getByTestId("viewer").waitFor();
  await viewer.waitForFunction(() => typeof window.puppetloomRenderTestPose === "function", undefined, { timeout: 30_000 });
  const firstVisible = await viewer.evaluate(() => {
    window.puppetloomRenderTestPose?.({ headYaw: -0.65, headPitch: 0.25, breath: 0.02 });
    const canvas = document.querySelector("canvas");
    if (!canvas) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  });
  if (!firstVisible) throw new Error("视觉检查失败：第一个姿态没有渲染出可见像素。" );
  const contextAttributes = await viewer.locator("canvas").evaluate((canvas) => canvas.getContext("webgl2")?.getContextAttributes());
  if (!contextAttributes?.stencil) throw new Error("视觉检查失败：WebGL2 没有启用眼部动态蒙版所需的模板缓冲。" );
  const firstDataUrl = await viewer.locator("canvas").evaluate((canvas) => canvas.toDataURL("image/png"));
  await writeFile(firstPath, Buffer.from(firstDataUrl.split(",")[1], "base64"));
  await viewer.evaluate(() => window.puppetloomRenderTestPose?.({ headYaw: 0.65, headPitch: -0.25, breath: -0.02, blink: 0.8 }));
  const secondDataUrl = await viewer.locator("canvas").evaluate((canvas) => canvas.toDataURL("image/png"));
  await writeFile(secondPath, Buffer.from(secondDataUrl.split(",")[1], "base64"));

  const first = await sharp(firstPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const second = await sharp(secondPath).ensureAlpha().raw().toBuffer();
  let transparent = 0;
  let visible = 0;
  let changed = 0;
  for (let index = 0; index < first.data.length; index += 4) {
    const alpha = first.data[index + 3] ?? 0;
    if (alpha < 4) transparent += 1;
    if (alpha > 80) visible += 1;
    const difference = Math.abs((first.data[index] ?? 0) - (second[index] ?? 0)) + Math.abs((first.data[index + 1] ?? 0) - (second[index + 1] ?? 0)) + Math.abs((first.data[index + 2] ?? 0) - (second[index + 2] ?? 0)) + Math.abs(alpha - (second[index + 3] ?? 0));
    if (difference > 16) changed += 1;
  }
  const pixels = first.info.width * first.info.height;
  const metrics = { transparentRatio: transparent / pixels, visibleRatio: visible / pixels, changedRatio: changed / pixels };
  if (metrics.transparentRatio < 0.2 || metrics.visibleRatio < 0.02 || metrics.changedRatio < 0.0001) throw new Error(`视觉检查失败：${JSON.stringify(metrics)}`);
  process.stdout.write(`${JSON.stringify({ ok: true, firstPath, secondPath, contextAttributes, metrics }, null, 2)}\n`);
} finally {
  await electronApp.close();
}
});
