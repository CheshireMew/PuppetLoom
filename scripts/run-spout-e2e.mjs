import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createProject } from "@puppetloom/core";
import { listSenders } from "@napolab/texture-bridge-core";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import { executeManagedRun } from "./lib/managed-run.mjs";

await executeManagedRun({ category: "spout-e2e", producer: "scripts/run-spout-e2e.mjs", evidence: { command: "npm run test:spout", scope: "Electron 共享纹理到 Windows Spout2 的真实发送链" }, estimatedBytes: 256 * 1024 ** 2, maximumRelativePathLength: 144, reuse: { applicable: false, reason: "共享纹理句柄、发送器注册和帧计数必须来自同一次运行。" } }, async (artifactRun) => {
  const project = artifactRun.path("project");
  const profile = artifactRun.path("profile");
  const screenshot = artifactRun.path("spout-output.png");
  await createProject({ input: resolve("test/fixtures/semantic.psd"), output: project, seed: 42 });
  const app = await electron.launch({
    args: [resolve("apps/desktop/dist/electron/main.js"), "--project", project],
    cwd: resolve("."),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1", PUPPETLOOM_E2E_USER_DATA: profile }
  });
  try {
    const viewer = await app.firstWindow();
    await viewer.getByTestId("viewer").waitFor();
    await viewer.waitForFunction(() => Boolean(window.puppetloomRenderCurrentFrame), undefined, { timeout: 30_000 });
    const senderName = `PuppetLoom-Spout-E2E-${process.pid}`;
    const started = await viewer.evaluate((name) => window.puppetloom.spoutOutput("start", { name, width: 512, height: 512, fps: 30 }), senderName);
    if (!started.active || !started.supported) throw new Error(`Spout2 没有启动：${JSON.stringify(started)}`);
    let status = await viewer.evaluate(() => window.puppetloom.spoutOutput("status"));
    const frameDeadline = Date.now() + 30_000;
    while ((status.frames ?? 0) < 3 && Date.now() < frameDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      status = await viewer.evaluate(() => window.puppetloom.spoutOutput("status"));
    }
    if (!status.active || !status.frames || status.frames < 3 || status.lastDefect || status.lastError) throw new Error(`Spout2 没有连续发送有效共享纹理：${JSON.stringify(status)}`);
    const registered = listSenders().some((sender) => sender.name === senderName);
    if (!registered) throw new Error(`Spout2 接收端列表没有发送器 ${senderName}：${JSON.stringify(listSenders())}`);
    const outputPage = app.windows().find((page) => page.url().includes("output=spout"));
    if (!outputPage) throw new Error("找不到 Spout2 隐藏输出页面。");
    await outputPage.screenshot({ path: screenshot, omitBackground: true });
    const statistics = await sharp(screenshot).stats();
    const variation = statistics.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0);
    if (variation < 4) throw new Error(`Spout2 输出页面没有可见角色内容：variation=${variation}`);
    const stopped = await viewer.evaluate(() => window.puppetloom.spoutOutput("stop"));
    if (stopped.active) throw new Error(`Spout2 停止后仍报告 active：${JSON.stringify(stopped)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    if (listSenders().some((sender) => sender.name === senderName)) throw new Error("Spout2 停止后发送器仍留在接收端列表。" );
    const report = { ok: true, senderName, status, screenshot, registered };
    await writeFile(artifactRun.path("spout-e2e.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await app.close();
  }
});
