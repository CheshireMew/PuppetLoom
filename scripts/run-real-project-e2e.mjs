import { basename, resolve } from "node:path";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import { executeManagedRun } from "./lib/managed-run.mjs";
import { resolveProjectSource } from "./lib/project-source.mjs";
import { cloneCurrentProjectForTest } from "./lib/test-project-clone.mjs";

const root = resolve(".");
const source = await resolveProjectSource(process.argv[2]);

async function visibleVariation(image) {
  const statistics = await sharp(image).stats();
  return statistics.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0);
}
await executeManagedRun({ category: "real-project", producer: "scripts/run-real-project-e2e.mjs", evidence: { command: "node scripts/run-real-project-e2e.mjs [project]", scope: "真实项目桌面用户链" }, estimatedBytes: 512 * 1024 ** 2, maximumRelativePathLength: 168, reuse: { applicable: false, reason: "测试结论仍然独立；来源素材和纹理通过只读硬链接复用，校准与项目清单保持可写副本。" } }, async (artifactRun) => {
const project = artifactRun.path(`project-${basename(source)}`);
const screenshot = artifactRun.path("editor.png");
const neutralActionScreenshot = artifactRun.path("viewer-action-neutral.png");
const leftYawScreenshot = artifactRun.path("viewer-yaw-left.png");
const rightYawScreenshot = artifactRun.path("viewer-yaw-right.png");
const earActionScreenshot = artifactRun.path("viewer-action-ear-flick.png");
const tailActionScreenshot = artifactRun.path("viewer-action-tail-wag.png");
const applicationProfile = artifactRun.path("user-data");
const cloneReport = await cloneCurrentProjectForTest(source, project, { objectRoot: artifactRun.objectDirectory });

const electronApp = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js"), "--edit", "--project", project],
  cwd: root,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1", PUPPETLOOM_INCLUDE_TEST_PROJECTS: "1", PUPPETLOOM_E2E_USER_DATA: applicationProfile }
});

try {
  const editor = await electronApp.firstWindow();
  await editor.getByTestId("editor").waitFor();
  await editor.waitForFunction(() => {
    const canvas = document.querySelector(".editor-canvas");
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0 && canvas.getContext("webgl2") !== null;
  }, undefined, { timeout: 30_000 });
  await editor.waitForTimeout(250);
  const editorCanvas = await editor.locator(".editor-canvas").screenshot();
  if (await visibleVariation(editorCanvas) < 4) throw new Error("真实项目编辑画布没有显示角色纹理。" );

  const baseline = await editor.evaluate((directory) => window.puppetloom.readEditorWorkspace(directory), project);
  if (baseline.project.name !== "source" || baseline.project.layers.length !== 29) {
    throw new Error(`正式模型测试副本读取结果不正确：${JSON.stringify({ name: baseline.project.name, layers: baseline.project.layers.length })}`);
  }
  if (baseline.project.quality.safetyScale !== 1) throw new Error(`真实项目未在满幅安全边界打开：${baseline.project.quality.safetyScale}`);
  const expectedRevision = baseline.calibration.revision + 1;
  const scopedMeshes = await editor.evaluate(
    ({ directory, layerId }) => window.puppetloom.generateArtMeshes(directory, [layerId]),
    { directory: project, layerId: baseline.project.layers[0].id }
  );
  if (Object.keys(scopedMeshes).length !== 1 || !(baseline.project.layers[0].id in scopedMeshes)) {
    throw new Error(`真实项目的逐图层网格生成越过了选中范围：${JSON.stringify(Object.keys(scopedMeshes))}`);
  }

  await editor.getByRole("button", { name: /02 结构与网格/ }).click();
  if (await editor.locator(".editor-overlay").count()) throw new Error("真实项目首次进入结构与网格时编辑标记没有默认隐藏。");
  const frontHair = baseline.project.layers.find((layer) => layer.role === "frontHair");
  if (!frontHair) throw new Error("真实项目缺少前发图层，无法验证动态网格。" );
  await editor.locator(".layer-select").filter({ hasText: frontHair.sourceName }).click();
  const meshButton = editor.getByRole("button", { name: "网格与权重" });
  await meshButton.click();
  const deformedMesh = editor.locator(".mesh-deformed");
  await deformedMesh.waitFor();
  const staticMeshSignature = await deformedMesh.getAttribute("data-mesh-signature");
  await editor.getByRole("button", { name: "自主预览" }).click();
  await editor.waitForFunction((before) => document.querySelector(".mesh-deformed")?.getAttribute("data-mesh-signature") !== before, staticMeshSignature, { timeout: 10_000 });
  await editor.getByRole("button", { name: "暂停动作" }).click();
  await meshButton.click();
  if (await editor.locator(".editor-overlay").count()) throw new Error("真实项目再次点击网格与权重后没有隐藏网格。" );
  await editor.getByRole("button", { name: "动作", exact: true }).click();
  const frontHairAmplitude = editor.getByTestId("secondary-amplitude");
  await frontHairAmplitude.evaluate((element) => {
    const input = element;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "1.02");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await editor.getByPlaceholder("例如：固定耳根并调整右眼外角").fill("真实项目前发响应复验");
  await editor.getByText("草稿已保存", { exact: true }).waitFor({ timeout: 10_000 });

  await editor.getByRole("button", { name: "返回主页" }).click();
  await editor.getByTestId("creator").waitFor();
  await editor.locator(".recent-projects button").filter({ hasText: project }).click();
  await editor.getByTestId("editor").waitFor();
  await editor.getByRole("button", { name: /02 结构与网格/ }).click();
  await editor.getByRole("button", { name: "动作", exact: true }).click();
  await editor.getByText(/已恢复 .*自动保存的草稿/).waitFor();
  await editor.getByRole("button", { name: "保存校准" }).click();
  await editor.getByText(`已保存版本 ${expectedRevision}，安全系数 1.00。`, { exact: true }).waitFor({ timeout: 30_000 });
  await editor.getByTestId("comparison-view").waitFor();
  await editor.getByRole("button", { name: "叠加", exact: true }).click();
  await editor.waitForFunction(() => {
    const images = [...document.querySelectorAll("[data-testid='comparison-view'] img")];
    return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
  });
  await editor.getByText("草稿已保存", { exact: true }).waitFor({ timeout: 10_000 });
  if (await editor.locator(".save-panel .error").count()) throw new Error(await editor.locator(".save-panel .error").innerText());
  const authoringSummary = await editor.locator(".authoring-summary").innerText();
  if (!authoringSummary.includes("绑定系统") || !authoringSummary.includes("参数") || !authoringSummary.includes("行为")) {
    throw new Error(`真实项目没有显示完整绑定系统检查面板：${authoringSummary}`);
  }
  await editor.screenshot({ path: screenshot, fullPage: true });

  const saved = await editor.evaluate((directory) => window.puppetloom.readEditorWorkspace(directory), project);
  if (saved.calibration.revision !== expectedRevision || saved.project.quality.safetyScale !== 1) {
    throw new Error(`真实项目校准没有保持 revision 与满幅安全：${JSON.stringify({ revision: saved.calibration.revision, safetyScale: saved.project.quality.safetyScale })}`);
  }
  if (saved.project.runtime.secondaryMotionTuning?.frontHair?.amplitude !== 1.02) throw new Error("真实项目没有消费已保存的前发响应校准。" );

  const viewerPromise = electronApp.waitForEvent("window");
  await editor.getByRole("button", { name: "运行角色窗口" }).click();
  const viewer = await viewerPromise;
  await viewer.getByTestId("viewer").waitFor();
  await viewer.waitForFunction(() => typeof window.puppetloomRenderTestPose === "function", undefined, { timeout: 30_000 });
  const firstFrame = await viewer.locator("canvas").screenshot();
  if (await visibleVariation(firstFrame) < 4) throw new Error(`真实项目运行窗口没有可见角色：${await viewer.locator(".viewer-error").textContent() ?? "无界面错误"}`);
  await viewer.waitForTimeout(1_200);
  const secondFrame = await viewer.locator("canvas").screenshot();
  if (firstFrame.equals(secondFrame)) throw new Error("正式模型角色窗口默认启动后画面没有自主运动。" );
  const pointer = await viewer.evaluate(() => window.puppetloom.pointerTarget());
  if (pointer.strength !== 1) throw new Error(`正式模型角色窗口首次启动没有默认开启鼠标跟随：${JSON.stringify(pointer)}`);

  await viewer.getByRole("button", { name: "打开表情动作面板" }).click();
  await viewer.getByRole("button", { name: "动作 · 耳朵轻弹" }).waitFor();
  await viewer.getByRole("button", { name: "动作 · 尾巴摇摆" }).waitFor();
  await viewer.getByRole("button", { name: "关闭表情动作面板" }).click();
  const renderPose = async (state, path, label) => {
    const rendered = await viewer.evaluate((next) => window.puppetloomRenderTestPose?.(next) ?? false, state);
    if (!rendered) throw new Error(`正式模型角色窗口不能渲染确定性${label}。`);
    await viewer.waitForTimeout(80);
    const frame = await viewer.locator("canvas").screenshot({ path });
    if (await visibleVariation(frame) < 4) throw new Error(`正式模型的${label}没有可见角色。`);
    return frame;
  };
  const neutralActionFrame = await renderPose({}, neutralActionScreenshot, "中立帧");
  const leftYawFrame = await renderPose({ headYaw: -1, gazeX: -0.29, bodySway: -0.62, bodyRoll: -0.16 }, leftYawScreenshot, "向左极限转头帧");
  const rightYawFrame = await renderPose({ headYaw: 1, gazeX: 0.29, bodySway: 0.62, bodyRoll: 0.16 }, rightYawScreenshot, "向右极限转头帧");
  const earActionFrame = await renderPose({ behavior: { id: "action-ear-flick", timeSeconds: 0.12 } }, earActionScreenshot, "耳朵轻弹帧");
  const tailActionFrame = await renderPose({ behavior: { id: "action-tail-wag", timeSeconds: 0.55 } }, tailActionScreenshot, "尾巴摇摆帧");
  if (neutralActionFrame.equals(leftYawFrame) || neutralActionFrame.equals(rightYawFrame)) throw new Error("正式模型的极限转头帧与中立帧完全相同。" );
  if (neutralActionFrame.equals(earActionFrame)) throw new Error("正式模型的耳朵轻弹动作与中立帧完全相同。" );
  if (neutralActionFrame.equals(tailActionFrame)) throw new Error("正式模型的尾巴摇摆动作与中立帧完全相同。" );

  process.stdout.write(`${JSON.stringify({ ok: true, source, projectCopy: project, screenshot, poseEvidence: { left: leftYawScreenshot, neutral: neutralActionScreenshot, right: rightYawScreenshot }, actionEvidence: { neutral: neutralActionScreenshot, earFlick: earActionScreenshot, tailWag: tailActionScreenshot }, cloneReport, revision: saved.calibration.revision, safetyScale: saved.project.quality.safetyScale }, null, 2)}\n`);
} finally {
  await electronApp.close();
}
});
