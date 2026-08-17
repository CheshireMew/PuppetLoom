import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { _electron as electron } from "playwright";
import { executeManagedRun } from "./lib/managed-run.mjs";

const root = resolve(".");
await executeManagedRun({ category: "electron-e2e", producer: "scripts/run-electron-e2e.mjs", estimatedBytes: 512 * 1024 ** 2, reuse: { applicable: false, reason: "截图、草稿和窗口状态共同组成一次独立桌面用户链证据。" } }, async (artifactRun) => {
const output = artifactRun.path("project");
const editorScreenshot = artifactRun.path("editor.png");

const electronApp = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js")],
  cwd: root,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1" }
});

try {
  const control = await electronApp.firstWindow();
  await control.getByTestId("creator").waitFor();
  const launcherBrowserWindow = await electronApp.browserWindow(control);
  const launcherWindowSize = await launcherBrowserWindow.evaluate((window) => window.getSize());
  if (launcherWindowSize[0] !== 1440 || launcherWindowSize[1] !== 900) throw new Error(`启动界面不是完整工作区尺寸：${JSON.stringify(launcherWindowSize)}`);
  const emptyRecentCard = await control.getByTestId("recent-projects").boundingBox();
  const initialViewportHeight = await control.evaluate(() => window.innerHeight);
  if (!emptyRecentCard || emptyRecentCard.y < 0 || emptyRecentCard.y + emptyRecentCard.height > initialViewportHeight) throw new Error("空的最近项目卡片没有出现在启动首屏。");
  const createResult = await control.evaluate(async ({ input, outputDirectory }) => {
    return window.puppetloom.create({ input, output: outputDirectory, seed: 42 });
  }, { input: resolve("test/fixtures/semantic.psd"), outputDirectory: output });
  if (!createResult.verify.valid || createResult.report.rigLevel !== "semantic") throw new Error("桌面创建链未返回有效 semantic 项目。" );
  const recent = await control.evaluate(() => window.puppetloom.recentProjects());
  if (!recent.some((entry) => entry.directory.toLocaleLowerCase() === output.toLocaleLowerCase())) throw new Error("创建后的项目没有进入最近项目列表。" );

  const workspace = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  if (workspace.calibration.revision !== 0 || workspace.project.version !== 3) throw new Error(`桌面编辑工作区没有读取 v3 基线：${JSON.stringify(workspace.calibration)}`);
  const face = workspace.project.layers.find((layer) => layer.role === "face");
  if (!face) throw new Error("semantic 测试项目没有脸部图层。" );

  // Fixture setup uses IPC, but the product journey starts from the same persisted recent-project entry a user sees after restart.
  await control.reload();
  await control.getByTestId("creator").waitFor();
  const recentProject = control.locator(".recent-projects button").filter({ hasText: output });
  await recentProject.waitFor();
  const populatedRecentCard = await control.getByTestId("recent-projects").boundingBox();
  const populatedViewportHeight = await control.evaluate(() => window.innerHeight);
  if (!populatedRecentCard || populatedRecentCard.y < 0 || populatedRecentCard.y + populatedRecentCard.height > populatedViewportHeight) throw new Error("有内容的最近项目卡片没有出现在启动首屏。");
  await recentProject.click();
  await control.getByTestId("editor").waitFor();
  const controlWindow = await electronApp.browserWindow(control);
  await control.waitForFunction(() => window.innerWidth >= 1300 && window.innerHeight >= 800);
  const editorWindowSize = await controlWindow.evaluate((window) => window.getSize());
  if (editorWindowSize[0] < 1300 || editorWindowSize[1] < 800) throw new Error(`编辑器窗口没有扩展到可操作尺寸：${JSON.stringify(editorWindowSize)}`);
  if (editorWindowSize[0] !== launcherWindowSize[0] || editorWindowSize[1] !== launcherWindowSize[1]) throw new Error(`启动界面与完整工作区尺寸不一致：${JSON.stringify({ launcherWindowSize, editorWindowSize })}`);
  await control.waitForFunction(() => {
    const canvas = document.querySelector(".editor-canvas");
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width < 2 || canvas.height < 2) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  }, undefined, { timeout: 30_000 });
  const editorStage = control.getByTestId("editor-stage");
  const stageBeforeNavigation = await editorStage.boundingBox();
  if (!stageBeforeNavigation) throw new Error("编辑视图没有可用的画布范围。");
  const expectedAspectRatio = workspace.project.canvas.width / workspace.project.canvas.height;
  if (Math.abs(stageBeforeNavigation.width / stageBeforeNavigation.height - expectedAspectRatio) > 0.01) {
    throw new Error(`编辑画布没有保持项目原始比例：${JSON.stringify({ stageBeforeNavigation, expectedAspectRatio })}`);
  }
  const zoomAnchor = {
    x: stageBeforeNavigation.x + stageBeforeNavigation.width * 0.3,
    y: stageBeforeNavigation.y + stageBeforeNavigation.height * 0.36
  };
  await control.mouse.move(zoomAnchor.x, zoomAnchor.y);
  await control.mouse.wheel(0, -360);
  await control.waitForFunction((width) => document.querySelector("[data-testid='editor-stage']")?.getBoundingClientRect().width > width * 1.2, stageBeforeNavigation.width);
  const stageAfterZoom = await editorStage.boundingBox();
  if (!stageAfterZoom) throw new Error("滚轮缩放后编辑画布消失。");
  const anchoredAfterZoom = {
    x: stageAfterZoom.x + stageAfterZoom.width * 0.3,
    y: stageAfterZoom.y + stageAfterZoom.height * 0.36
  };
  if (Math.hypot(anchoredAfterZoom.x - zoomAnchor.x, anchoredAfterZoom.y - zoomAnchor.y) > 3) {
    throw new Error(`滚轮缩放没有锁定鼠标所指位置：${JSON.stringify({ zoomAnchor, anchoredAfterZoom })}`);
  }
  await control.getByRole("button", { name: "适配" }).click();
  await control.waitForFunction(() => document.querySelector(".viewport-navigation output")?.textContent === "100%");
  const fittedStage = await editorStage.boundingBox();
  if (!fittedStage) throw new Error("适配后编辑画布消失。");
  const panStart = {
    x: fittedStage.x + fittedStage.width * 0.5,
    y: fittedStage.y + fittedStage.height * 0.72
  };
  await control.mouse.move(panStart.x, panStart.y);
  await control.mouse.down();
  await control.mouse.move(panStart.x + 72, panStart.y + 44, { steps: 5 });
  await control.mouse.up();
  await control.waitForFunction((x) => document.querySelector("[data-testid='editor-stage']")?.getBoundingClientRect().x > x + 60, fittedStage.x);
  const pannedStage = await editorStage.boundingBox();
  if (!pannedStage || pannedStage.x - fittedStage.x < 64 || pannedStage.y - fittedStage.y < 36) {
    throw new Error(`直接拖动人物区域没有移动编辑视图：${JSON.stringify({ fittedStage, pannedStage })}`);
  }
  await control.getByRole("button", { name: "适配" }).click();
  await control.waitForFunction((x) => Math.abs((document.querySelector("[data-testid='editor-stage']")?.getBoundingClientRect().x ?? 0) - x) < 2, stageBeforeNavigation.x);
  const lockLayer = control.getByRole("button", { name: `${face.sourceName} 锁定` });
  await lockLayer.click();
  await control.getByRole("button", { name: `${face.sourceName} 解锁` }).click();
  const hideLayer = control.getByRole("button", { name: `${face.sourceName} 隐藏` });
  await hideLayer.click();
  await control.getByRole("button", { name: `${face.sourceName} 显示` }).click();

  await control.getByRole("button", { name: "网格与权重" }).click();
  await control.locator(".mesh-handle").first().waitFor();
  const handles = control.locator(".mesh-handle");
  const vertexIndex = Math.floor(await handles.count() / 2);
  let vertex = await handles.nth(vertexIndex).boundingBox();
  if (!vertex) throw new Error("编辑器没有可拖动的网格顶点。" );
  await control.mouse.click(vertex.x + vertex.width / 2, vertex.y + vertex.height / 2);
  const vertexPosition = control.locator(".vertex-inspector p");
  const beforeKeyboardNudge = await vertexPosition.innerText();
  await handles.nth(vertexIndex).focus();
  await handles.nth(vertexIndex).press("ArrowRight");
  if (await vertexPosition.innerText() === beforeKeyboardNudge) throw new Error("键盘方向键没有微调网格顶点。" );
  const softRadius = control.getByLabel(/软选择半径/);
  await softRadius.waitFor();
  await softRadius.evaluate((element) => {
    const input = element;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "0.2");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  vertex = await handles.nth(vertexIndex).boundingBox();
  if (!vertex) throw new Error("选择软选择半径后网格顶点消失。" );
  await control.mouse.move(vertex.x + vertex.width / 2, vertex.y + vertex.height / 2);
  await control.mouse.down();
  await control.mouse.move(vertex.x + vertex.width / 2 + 3, vertex.y + vertex.height / 2, { steps: 3 });
  await control.mouse.up();

  const secondaryAmplitude = control.locator('.save-panel .range-row input[type="range"]').nth(6);
  await secondaryAmplitude.evaluate((element) => {
    const input = element;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "1.1");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await control.getByPlaceholder("例如：固定耳根并调整右眼外角").fill("软选择网格与前发响应校准");

  const saveButton = control.getByRole("button", { name: "保存校准" });
  await saveButton.waitFor({ state: "attached" });
  await control.getByText("草稿已保存", { exact: true }).waitFor({ timeout: 10_000 });
  const persistedDraft = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  const draftLayer = persistedDraft.draft?.overrides.layers?.[face.id];
  if (!draftLayer || Object.keys(draftLayer.meshPointDeltas ?? {}).length < 2) throw new Error("软选择没有把多个顶点写入自动保存草稿。" );
  if (persistedDraft.draft?.overrides.runtime?.secondaryMotionTuning?.frontHair?.amplitude !== 1.1) throw new Error("分部响应没有写入自动保存草稿。" );
  await control.getByRole("button", { name: "恢复全部自动绑定" }).click();
  await control.getByText(/请先保存或明确放弃当前草稿/).waitFor();
  const afterRefusedRestore = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  if (!afterRefusedRestore.draft) throw new Error("拒绝恢复时草稿被意外清空。" );

  await control.getByRole("button", { name: "返回主页" }).click();
  await control.getByTestId("creator").waitFor();
  await control.locator(".recent-projects button").filter({ hasText: output }).click();
  await control.getByTestId("editor").waitFor();
  await control.getByText(/已恢复 .*自动保存的草稿/).waitFor();
  if (await saveButton.isDisabled()) throw new Error("恢复草稿后保存校准仍不可用。" );

  const restoredSecondaryAmplitude = control.locator('.save-panel .range-row input[type="range"]').nth(6);
  await restoredSecondaryAmplitude.evaluate((element) => {
    const input = element;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "1.11");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const undoButton = control.getByRole("button", { name: "撤销" });
  const redoButton = control.getByRole("button", { name: "重做" });
  if (await undoButton.isDisabled()) throw new Error("修改恢复的草稿后撤销仍不可用。" );
  await undoButton.click();
  if (await redoButton.isDisabled()) throw new Error("撤销后重做仍不可用。" );
  await redoButton.click();
  await saveButton.scrollIntoViewIfNeeded();
  if (await saveButton.isDisabled()) throw new Error("恢复并重做草稿后保存校准仍不可用。" );
  await saveButton.click();
  await control.getByText(/已保存 revision 1/).waitFor({ timeout: 30_000 });
  const calibratedWorkspace = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  if (calibratedWorkspace.calibration.revision !== 1) throw new Error("桌面编辑器没有持久化校准修订。" );
  if (calibratedWorkspace.draft) throw new Error("保存校准后草稿仍被当作未提交内容恢复。" );
  if (Object.keys(calibratedWorkspace.calibration.overrides.layers?.[face.id]?.meshPointDeltas ?? {}).length < 2) throw new Error("校准修订没有保留软选择网格结果。" );
  if (calibratedWorkspace.project.runtime.secondaryMotionTuning?.frontHair?.amplitude !== 1.11) throw new Error("校准修订没有保留独立前发响应。" );

  await control.getByTestId("comparison-view").waitFor();
  for (const label of ["修改前", "修改后", "分割", "叠加", "差异"]) {
    await control.getByRole("button", { name: label, exact: true }).click();
    await control.waitForFunction(() => {
      const images = [...document.querySelectorAll("[data-testid='comparison-view'] img")];
      return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    });
  }
  await control.getByText("草稿已保存", { exact: true }).waitFor({ timeout: 10_000 });
  if (await control.locator(".save-panel .error").count()) throw new Error(`保存完成后编辑器仍显示错误：${await control.locator(".save-panel .error").innerText()}`);
  await control.screenshot({ path: editorScreenshot, fullPage: true });
  await control.locator(".session-panel article").first().getByRole("button", { name: "确认" }).click();
  await control.waitForFunction(async (projectDirectory) => (await window.puppetloom.readEditorWorkspace(projectDirectory)).sessions.at(-1)?.evidenceStatus === "accepted", output);

  const viewerPromise = electronApp.waitForEvent("window");
  await control.getByRole("button", { name: "运行角色窗口" }).click();
  const viewer = await viewerPromise;
  viewer.on("pageerror", (cause) => process.stderr.write(`[viewer pageerror] ${cause.message}\n`));
  viewer.on("console", (message) => { if (message.type() === "error") process.stderr.write(`[viewer console] ${message.text()}\n`); });
  await viewer.getByTestId("viewer").waitFor();
  await viewer.locator("canvas").waitFor({ state: "visible" });
  await viewer.waitForFunction(() => typeof window.puppetloomRenderTestPose === "function", undefined, { timeout: 30_000 });
  const viewerReady = await viewer.evaluate(() => {
    window.puppetloomRenderTestPose?.({});
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  });
  if (!viewerReady) throw new Error(`角色窗口没有渲染可见像素：${await viewer.locator(".viewer-error").textContent() ?? "无界面错误"}`);

  const viewerWindow = await electronApp.browserWindow(viewer);
  const viewerId = await viewerWindow.evaluate((window) => window.id);

  const duplicate = await control.evaluate((projectDirectory) => window.puppetloom.launchViewer(projectDirectory), output);
  if (duplicate.id !== viewerId) throw new Error(`重复打开同一项目创建了多个窗口：${JSON.stringify({ first: viewerId, duplicate: duplicate.id })}`);

  const browserWindow = viewerWindow;
  const nativeState = await browserWindow.evaluate((window) => ({
    top: window.isAlwaysOnTop(),
    resizable: window.isResizable(),
    size: window.getSize(),
    visible: window.isVisible()
  }));
  const aspect = nativeState.size[0] / nativeState.size[1];
  if (!nativeState.top || !nativeState.visible || Math.abs(aspect - 1) > 0.01) throw new Error(`透明窗口状态不符合要求：${JSON.stringify(nativeState)}`);

  const visiblePixelRatio = () => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("角色窗口缺少画布。");
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("角色窗口缺少 WebGL2 上下文。");
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let minimumX = canvas.width;
    let maximumX = -1;
    let minimumY = canvas.height;
    let maximumY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
        minimumX = Math.min(minimumX, x);
        maximumX = Math.max(maximumX, x);
        minimumY = Math.min(minimumY, y);
        maximumY = Math.max(maximumY, y);
      }
    }
    if (maximumX < minimumX || maximumY < minimumY) throw new Error("角色窗口没有可见像素。");
    return (maximumX - minimumX + 1) / (maximumY - minimumY + 1);
  };
  const baselinePixelRatio = await viewer.evaluate(visiblePixelRatio);
  await browserWindow.evaluate((window) => {
    window.setAspectRatio(0);
    window.setSize(900, 600, false);
  });
  await viewer.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width / canvas.height <= 1.45) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  });
  const windowedPixelRatio = await viewer.evaluate(visiblePixelRatio);
  if (Math.abs(windowedPixelRatio / baselinePixelRatio - 1) > 0.06) {
    throw new Error(`窗口比例改变后角色发生拉伸：${JSON.stringify({ baselinePixelRatio, windowedPixelRatio })}`);
  }
  await browserWindow.evaluate((window) => {
    window.setAspectRatio(1);
    window.setContentSize(720, 720, false);
  });
  await viewer.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    return canvas instanceof HTMLCanvasElement && Math.abs(canvas.width / canvas.height - 1) < 0.01;
  });

  const pointer = await viewer.evaluate(() => window.puppetloom.pointerTarget());
  if (![pointer.x, pointer.y, pointer.strength].every(Number.isFinite) || pointer.strength !== 1) throw new Error(`系统鼠标目标无效：${JSON.stringify(pointer)}`);
  const trackingOff = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pointer-tracking"), { id: viewerId });
  if (trackingOff?.mouseTracking) throw new Error("桌面端未能关闭鼠标跟随。" );
  const disabledPointer = await viewer.evaluate(() => window.puppetloom.pointerTarget());
  if (disabledPointer.strength !== 0) throw new Error(`关闭鼠标跟随后仍返回活动目标：${JSON.stringify(disabledPointer)}`);
  const trackingOn = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pointer-tracking"), { id: viewerId });
  if (!trackingOn?.mouseTracking) throw new Error("桌面端未能恢复鼠标跟随。" );

  await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "larger"), { id: viewerId });
  const scaledSize = await browserWindow.evaluate((window) => window.getSize());
  if (scaledSize[0] <= nativeState.size[0] || scaledSize[1] <= nativeState.size[1]) throw new Error(`角色窗口缩放未生效：${JSON.stringify({ before: nativeState.size, after: scaledSize })}`);

  const paused = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pause"), { id: viewerId });
  if (!paused?.paused) throw new Error("桌面端未能暂停角色窗口。" );
  const through = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "click-through"), { id: viewerId });
  if (!through?.clickThrough) throw new Error("桌面端未能启用鼠标穿透。" );
  const restored = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "click-through"), { id: viewerId });
  if (restored?.clickThrough) throw new Error("桌面端未能恢复鼠标交互。" );
  const resumed = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pause"), { id: viewerId });
  if (resumed?.paused) throw new Error("桌面端未能恢复自主运动。" );

  await control.getByPlaceholder("例如：固定耳根并调整右眼外角").fill("直接关窗草稿复验");
  const closeDraftAmplitude = control.locator('.save-panel .range-row input[type="range"]').nth(6);
  await closeDraftAmplitude.evaluate((element) => {
    const input = element;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "1.12");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const controlBrowserWindow = await electronApp.browserWindow(control);
  const controlClosed = control.waitForEvent("close");
  await controlBrowserWindow.evaluate((window) => window.close());
  await controlClosed;
  const closeDraft = JSON.parse(await readFile(resolve(output, "calibration", "draft.json"), "utf8"));
  if (closeDraft.label !== "直接关窗草稿复验" || closeDraft.overrides?.runtime?.secondaryMotionTuning?.frontHair?.amplitude !== 1.12) {
    throw new Error(`直接关窗前没有完整刷新草稿：${JSON.stringify(closeDraft)}`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, project: output, editorScreenshot, viewerId, nativeState }, null, 2)}\n`);
} finally {
  await electronApp.close();
}
});
