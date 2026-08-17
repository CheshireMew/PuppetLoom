import { cp } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { executeManagedRun } from "./lib/managed-run.mjs";

const root = resolve(".");
const source = resolve(process.argv[2] ?? "workspace/blue-whale-maid-r34");
await executeManagedRun({ category: "real-project", producer: "scripts/run-real-project-e2e.mjs", estimatedBytes: 1024 * 1024 ** 2, reuse: { applicable: false, reason: "真实项目副本会被草稿和校准链修改，必须与来源及其它验收运行隔离。" } }, async (artifactRun) => {
const project = artifactRun.path(`project-${basename(source)}`);
const screenshot = artifactRun.path("editor.png");
const applicationProfile = artifactRun.path("user-data");
await cp(source, project, { recursive: true, errorOnExist: true, force: false });

const electronApp = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js"), "--edit", "--project", project],
  cwd: root,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1", PUPPETLOOM_E2E_USER_DATA: applicationProfile }
});

try {
  const editor = await electronApp.firstWindow();
  await editor.getByTestId("editor").waitFor();
  await editor.waitForFunction(() => {
    const canvas = document.querySelector(".editor-canvas");
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  }, undefined, { timeout: 30_000 });

  const baseline = await editor.evaluate((directory) => window.puppetloom.readEditorWorkspace(directory), project);
  if (baseline.project.name !== "source" || baseline.project.layers.length !== 29) {
    throw new Error(`真实项目读取结果不符合 r34：${JSON.stringify({ name: baseline.project.name, layers: baseline.project.layers.length })}`);
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
  const staticMeshPath = await deformedMesh.getAttribute("d");
  await editor.getByRole("button", { name: "自主预览" }).click();
  await editor.waitForFunction((before) => document.querySelector(".mesh-deformed")?.getAttribute("d") !== before, staticMeshPath, { timeout: 10_000 });
  await editor.getByRole("button", { name: "暂停动作" }).click();
  await meshButton.click();
  if (await editor.locator(".editor-overlay").count()) throw new Error("真实项目再次点击网格与权重后没有隐藏网格。" );
  await editor.getByRole("button", { name: "动作", exact: true }).click();
  const frontHairAmplitude = editor.locator('.save-panel .range-row input[type="range"]').nth(6);
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
  await editor.getByText(`已保存 revision ${expectedRevision}，安全系数 1.00。`, { exact: true }).waitFor({ timeout: 30_000 });
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
  const viewerReady = await viewer.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  });
  if (!viewerReady) throw new Error(`真实项目运行窗口没有可见像素：${await viewer.locator(".viewer-error").textContent() ?? "无界面错误"}`);
  const frameSignature = () => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("真实项目运行窗口缺少画布。");
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("真实项目运行窗口缺少 WebGL2 上下文。");
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let hash = 2166136261;
    for (const value of pixels) hash = Math.imul(hash ^ value, 16777619) >>> 0;
    return hash;
  };
  const firstFrame = await viewer.evaluate(frameSignature);
  await viewer.waitForTimeout(1_200);
  const secondFrame = await viewer.evaluate(frameSignature);
  if (firstFrame === secondFrame) throw new Error("真实 r34 角色窗口默认启动后画面没有自主运动。" );
  const pointer = await viewer.evaluate(() => window.puppetloom.pointerTarget());
  if (pointer.strength !== 1) throw new Error(`真实 r34 角色窗口首次启动没有默认开启鼠标跟随：${JSON.stringify(pointer)}`);

  process.stdout.write(`${JSON.stringify({ ok: true, source, projectCopy: project, screenshot, revision: saved.calibration.revision, safetyScale: saved.project.quality.safetyScale }, null, 2)}\n`);
} finally {
  await electronApp.close();
}
});
