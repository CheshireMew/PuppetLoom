import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PUPPETLOOM_PROJECT_VERSION } from "@puppetloom/core";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import { executeManagedRun } from "./lib/managed-run.mjs";

const root = resolve(".");

async function visibleVariation(image) {
  const statistics = await sharp(image).stats();
  return statistics.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0);
}

function assertIntegratedShell(state, label) {
  const horizontalNonClient = state.outerBounds.width - state.contentBounds.width;
  const verticalNonClient = state.outerBounds.height - state.contentBounds.height;
  if (state.strategy !== "integrated" || state.frame !== false) throw new Error(`${label} 没有声明一体化无边框外壳：${JSON.stringify(state)}`);
  if (!state.resizable || !state.maximizable || !state.minimizable || !state.closable) throw new Error(`${label} 缺少完整原生窗口能力：${JSON.stringify(state)}`);
  const titlebarRemainder = verticalNonClient - horizontalNonClient;
  if (horizontalNonClient < 0 || verticalNonClient < 0 || horizontalNonClient > 16 || Math.abs(titlebarRemainder) > 2) throw new Error(`${label} 仍存在未解释的原生标题栏或非客户区：${JSON.stringify({ horizontalNonClient, verticalNonClient, titlebarRemainder, state })}`);
}

async function captureNativeWindow(electronApp, browserWindow, path) {
  const windowId = await browserWindow.evaluate((window) => window.id);
  const capture = await electronApp.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, id) => {
    const window = BrowserWindow.fromId(id);
    if (!window) throw new Error(`找不到 BrowserWindow ${id}`);
    const bounds = window.getBounds();
    const contentBounds = window.getContentBounds();
    const scaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
    const sourceId = window.getMediaSourceId();
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: {
        width: Math.max(1, Math.round(bounds.width * scaleFactor)),
        height: Math.max(1, Math.round(bounds.height * scaleFactor))
      },
      fetchWindowIcons: false
    });
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source || source.thumbnail.isEmpty()) throw new Error(`Windows 整窗捕获没有返回目标窗口 ${sourceId}`);
    return {
      dataUrl: source.thumbnail.toDataURL(),
      sourceId,
      bounds,
      contentBounds,
      scaleFactor,
      pixelSize: source.thumbnail.getSize()
    };
  }, windowId);
  const encoded = capture.dataUrl.split(",")[1];
  if (!encoded) throw new Error(`Windows 整窗捕获没有 PNG 数据：${capture.sourceId}`);
  await writeFile(path, Buffer.from(encoded, "base64"));
  const { dataUrl: _dataUrl, ...evidence } = capture;
  return evidence;
}

await executeManagedRun({ category: "electron-e2e", producer: "scripts/run-electron-e2e.mjs", estimatedBytes: 512 * 1024 ** 2, reuse: { applicable: false, reason: "截图、草稿和窗口状态共同组成一次独立桌面用户链证据。" } }, async (artifactRun) => {
const output = artifactRun.path("project");
const launcherContentScreenshot = artifactRun.path("launcher-content.png");
const launcherNativeScreenshot = artifactRun.path("launcher-native.png");
const editorContentScreenshot = artifactRun.path("editor-content.png");
const editorNativeScreenshot = artifactRun.path("editor-native.png");
const artMeshScreenshot = artifactRun.path("editor-art-mesh.png");
const viewerNativeScreenshot = artifactRun.path("viewer-native.png");
const windowShellEvidencePath = artifactRun.path("window-shell-evidence.json");
const applicationProfile = artifactRun.path("user-data");

const electronApp = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js")],
  cwd: root,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1", PUPPETLOOM_INCLUDE_TEST_PROJECTS: "1", PUPPETLOOM_E2E_USER_DATA: applicationProfile }
});

try {
  const control = await electronApp.firstWindow();
  await control.getByTestId("creator").waitFor();
  await control.getByText("自动清理确认噪点", { exact: true }).waitFor();
  if (await control.locator('input[name="preserve-alpha-noise"]').isChecked()) throw new Error("创建页默认开启了保留全部 Alpha 噪点，而不是自动清理确认噪点。" );
  const titlebar = control.getByTestId("window-titlebar");
  await titlebar.waitFor();
  if (await titlebar.getAttribute("data-window-shell") !== "integrated" || await titlebar.getAttribute("data-window-frame") !== "false") throw new Error("启动器没有消费一体化外壳状态。" );
  const windowControlButtons = titlebar.locator(".window-titlebar-controls button");
  if (await windowControlButtons.count() !== 3 || await windowControlButtons.locator("svg").count() !== 3) throw new Error("窗口控制没有统一使用图标。" );
  if ((await windowControlButtons.allInnerTexts()).some((text) => /[—□❐×]/.test(text))) throw new Error("窗口控制仍在使用字符假装图标。" );
  const launcherBrowserWindow = await electronApp.browserWindow(control);
  const launcherWindowSize = await launcherBrowserWindow.evaluate((window) => window.getSize());
  if (launcherWindowSize[0] !== 1440 || launcherWindowSize[1] !== 900) throw new Error(`启动界面不是完整工作区尺寸：${JSON.stringify(launcherWindowSize)}`);
  const launcherShellBefore = await control.evaluate(() => window.puppetloom.windowShellState());
  assertIntegratedShell(launcherShellBefore, "启动器");

  const dragRegion = await control.locator(".window-titlebar-drag").boundingBox();
  if (!dragRegion) throw new Error("启动器缺少可命中的标题栏拖动区。" );
  const dragStart = { x: dragRegion.x + Math.min(240, dragRegion.width * 0.45), y: dragRegion.y + dragRegion.height / 2 };
  await control.mouse.move(dragStart.x, dragStart.y);
  await control.mouse.down();
  await control.mouse.move(dragStart.x + 64, dragStart.y + 42, { steps: 6 });
  await control.mouse.up();
  await control.waitForFunction(async ({ x, y }) => {
    const state = await window.puppetloom.windowShellState();
    return Math.abs(state.outerBounds.x - x) > 24 || Math.abs(state.outerBounds.y - y) > 24;
  }, { x: launcherShellBefore.outerBounds.x, y: launcherShellBefore.outerBounds.y });
  const movedShell = await control.evaluate(() => window.puppetloom.windowShellState());

  await control.getByRole("button", { name: "最大化窗口" }).click();
  await control.waitForFunction(async () => (await window.puppetloom.windowShellState()).maximized);
  const maximizedShell = await control.evaluate(() => window.puppetloom.windowShellState());
  assertIntegratedShell(maximizedShell, "最大化启动器");
  await control.getByRole("button", { name: "还原窗口" }).click();
  await control.waitForFunction(async () => !(await window.puppetloom.windowShellState()).maximized);
  const restoredShell = await control.evaluate(() => window.puppetloom.windowShellState());
  if (Math.abs(restoredShell.outerBounds.x - movedShell.outerBounds.x) > 2 || Math.abs(restoredShell.outerBounds.y - movedShell.outerBounds.y) > 2 || restoredShell.outerBounds.width !== movedShell.outerBounds.width || restoredShell.outerBounds.height !== movedShell.outerBounds.height) {
    throw new Error(`最大化往返没有恢复用户放置的窗口：${JSON.stringify({ movedShell, restoredShell })}`);
  }
  await control.getByRole("button", { name: "最小化窗口" }).click();
  await launcherBrowserWindow.evaluate((window) => {
    if (!window.isMinimized()) throw new Error("最小化按钮没有调用原生窗口 API。" );
    window.restore();
    window.show();
    window.focus();
  });
  await control.waitForFunction(async () => !(await window.puppetloom.windowShellState()).minimized);
  await control.evaluate(() => new Promise((resolvePaint) => {
    requestAnimationFrame(() => requestAnimationFrame(resolvePaint));
  }));
  const launcherNativeEvidence = await captureNativeWindow(electronApp, launcherBrowserWindow, launcherNativeScreenshot);
  await control.screenshot({ path: launcherContentScreenshot });
  const emptyRecentCard = await control.getByTestId("recent-projects").boundingBox();
  const initialViewportHeight = await control.evaluate(() => window.innerHeight);
  if (!emptyRecentCard || emptyRecentCard.y < 0 || emptyRecentCard.y + emptyRecentCard.height > initialViewportHeight) throw new Error("空的最近项目卡片没有出现在启动首屏。");
  const createResult = await control.evaluate(async ({ input, outputDirectory }) => {
    return window.puppetloom.create({ input, output: outputDirectory, seed: 42 });
  }, { input: resolve("test/fixtures/semantic.psd"), outputDirectory: output });
  if (!createResult.verify.valid) throw new Error(`桌面创建链没有返回有效项目：${JSON.stringify(createResult)}`);
  if (createResult.report.importPreflight.cleanupMode !== "automatic") throw new Error(`桌面创建默认没有采用 automatic Alpha 清理：${JSON.stringify(createResult.report.importPreflight)}`);
  const creationRigRegression = createResult.report.rigLevel === "semantic"
    ? undefined
    : `相同 semantic fixture 预期 semantic，实际为 ${createResult.report.rigLevel}`;
  const recent = await control.evaluate(() => window.puppetloom.recentProjects());
  if (!recent.some((entry) => entry.directory.toLocaleLowerCase() === output.toLocaleLowerCase())) throw new Error("创建后的项目没有进入最近项目列表。" );

  const workspace = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  if (workspace.calibration.revision !== 0 || workspace.project.version !== PUPPETLOOM_PROJECT_VERSION) throw new Error(`桌面编辑工作区没有读取当前 v${PUPPETLOOM_PROJECT_VERSION} 基线：${JSON.stringify({ calibration: workspace.calibration, projectVersion: workspace.project.version })}`);
  const face = workspace.project.layers.find((layer) => layer.role === "face");
  const frontHair = workspace.project.layers.find((layer) => layer.role === "frontHair");
  if (!face) throw new Error("semantic 测试项目没有脸部图层。" );
  if (!frontHair || frontHair.mesh.topology !== "art") throw new Error("semantic 测试项目没有生成前发 Alpha ArtMesh。" );

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
  await control.getByText("PuppetLoom · 绑定与校准编辑器", { exact: true }).waitFor();
  const controlWindow = await electronApp.browserWindow(control);
  await control.waitForFunction(async () => {
    const state = await window.puppetloom.windowShellState();
    return !state.minimized && state.contentBounds.width >= 1300 && state.contentBounds.height >= 800;
  });
  const editorWindowSize = await controlWindow.evaluate((window) => window.getSize());
  if (editorWindowSize[0] < 1300 || editorWindowSize[1] < 800) throw new Error(`编辑器窗口没有扩展到可操作尺寸：${JSON.stringify(editorWindowSize)}`);
  if (editorWindowSize[0] !== launcherWindowSize[0] || editorWindowSize[1] !== launcherWindowSize[1]) throw new Error(`启动界面与完整工作区尺寸不一致：${JSON.stringify({ launcherWindowSize, editorWindowSize })}`);
  const editorShell = await control.evaluate(() => window.puppetloom.windowShellState());
  assertIntegratedShell(editorShell, "编辑器");
  await control.waitForFunction(() => {
    const canvas = document.querySelector(".editor-canvas");
    return canvas instanceof HTMLCanvasElement && canvas.width >= 2 && canvas.height >= 2 && canvas.getContext("webgl2") !== null;
  }, undefined, { timeout: 30_000 });
  await control.waitForTimeout(250);
  if (await visibleVariation(await control.locator(".editor-canvas").screenshot()) < 4) throw new Error("编辑画布没有显示角色纹理。" );
  const editorStage = control.getByTestId("editor-stage");
  const viewportButtons = control.locator(".viewport-navigation button");
  if (await viewportButtons.count() !== 3 || await viewportButtons.locator("svg").count() !== 3) throw new Error("视图缩放控制没有统一使用图标。" );
  if ((await viewportButtons.allInnerTexts()).some((text) => text.trim().length > 0)) throw new Error("视图缩放控制仍显示字符按钮。" );
  const undoRedoButtons = control.locator(".editor-history-actions .icon-only");
  if (await undoRedoButtons.count() !== 2 || await undoRedoButtons.locator("svg").count() !== 2) throw new Error("撤销和重做没有使用图标按钮。" );
  const stageBeforeNavigation = await editorStage.boundingBox();
  if (!stageBeforeNavigation) throw new Error("编辑视图没有可用的画布范围。");
  const expectedAspectRatio = workspace.project.canvas.width / workspace.project.canvas.height;
  if (Math.abs(stageBeforeNavigation.width / stageBeforeNavigation.height - expectedAspectRatio) > 0.01) {
    throw new Error(`编辑画布没有保持项目原始比例：${JSON.stringify({ stageBeforeNavigation, expectedAspectRatio })}`);
  }
  await controlWindow.evaluate((window) => window.setSize(940, 700));
  await control.waitForFunction(() => window.innerWidth <= 940 && window.innerHeight <= 700);
  const compactLayout = await control.evaluate(() => {
    const shell = document.querySelector(".editor-shell");
    const workspace = document.querySelector(".editor-workspace");
    const panels = [...document.querySelectorAll(".editor-workspace > *")].map((element) => element.getBoundingClientRect());
    const lastHeaderButton = document.querySelector(".editor-history-actions button:last-child")?.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      shell: shell ? { clientWidth: shell.clientWidth, scrollWidth: shell.scrollWidth } : undefined,
      workspace: workspace?.getBoundingClientRect(),
      panels,
      lastHeaderButton
    };
  });
  if (!compactLayout.shell || compactLayout.shell.scrollWidth > compactLayout.shell.clientWidth || compactLayout.panels.length !== 3 || compactLayout.panels.some((panel) => panel.left < -1 || panel.right > compactLayout.viewport.width + 1) || !compactLayout.lastHeaderButton || compactLayout.lastHeaderButton.right > compactLayout.viewport.width + 1) {
    throw new Error(`紧凑窗口布局发生横向裁切：${JSON.stringify(compactLayout)}`);
  }
  await controlWindow.evaluate((window, size) => window.setSize(size[0], size[1]), editorWindowSize);
  await control.waitForFunction((size) => window.innerWidth === size[0] && window.innerHeight === size[1], editorWindowSize);
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
  await control.waitForFunction(({ x, width }) => {
    if (document.querySelector(".viewport-navigation output")?.textContent !== "100%") return false;
    const rect = document.querySelector("[data-testid='editor-stage']")?.getBoundingClientRect();
    return Boolean(rect && Math.abs(rect.x - x) < 2 && Math.abs(rect.width - width) < 2);
  }, { x: stageBeforeNavigation.x, width: stageBeforeNavigation.width });
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
  const structureWorkspaceButton = control.getByRole("button", { name: /02 结构与网格/ });
  await structureWorkspaceButton.click();
  await control.locator(".layer-list").waitFor();
  if (await control.locator(".editor-overlay").count()) throw new Error("结构与网格工作区首次打开时仍默认遮挡编辑标记。");
  const faceControlButton = control.getByRole("button", { name: "脸部控制点" });
  await faceControlButton.click();
  await control.locator(".editor-overlay").waitFor();
  await faceControlButton.click();
  if (await control.locator(".editor-overlay").count()) throw new Error("再次点击脸部控制点没有隐藏编辑标记。");
  const lockLayer = control.getByRole("button", { name: `${face.sourceName} 锁定` });
  await lockLayer.click();
  await control.getByRole("button", { name: `${face.sourceName} 解锁` }).click();
  const hideLayer = control.getByRole("button", { name: `${face.sourceName} 隐藏` });
  await hideLayer.click();
  await control.getByRole("button", { name: `${face.sourceName} 显示` }).click();
  if (await control.getByRole("button", { name: "突出当前图层" }).count()) throw new Error("已移除的“突出当前图层”仍出现在工具栏。");
  const firstLayerIcons = control.locator(".layer-row").first().locator(".layer-icon");
  if (await firstLayerIcons.count() !== 3 || await firstLayerIcons.locator("svg").count() !== 3) throw new Error("图层行没有显示完整的可见、锁定和单层查看图标。");
  if ((await firstLayerIcons.allInnerTexts()).some((text) => /[显隐编锁]/.test(text))) throw new Error("图层操作仍在使用文字假装图标。");
  await control.getByText("草稿已保存", { exact: true }).waitFor({ timeout: 10_000 });
  await control.waitForTimeout(350);
  const workspaceBeforeSolo = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  const canvasBeforeSolo = await control.locator(".editor-canvas").screenshot();
  const soloLayerButton = control.getByRole("button", { name: `${face.sourceName} 仅显示此图层` });
  await soloLayerButton.click();
  const restoreAllLayersButton = control.getByRole("button", { name: `${face.sourceName} 恢复显示全部图层` });
  await restoreAllLayersButton.waitFor();
  if (await restoreAllLayersButton.getAttribute("aria-pressed") !== "true") throw new Error("单层查看按钮没有显示激活状态。");
  await control.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  const canvasDuringSolo = await control.locator(".editor-canvas").screenshot();
  if (canvasBeforeSolo.equals(canvasDuringSolo)) throw new Error("单层查看没有改变实际渲染内容。");
  await restoreAllLayersButton.click();
  await soloLayerButton.waitFor();
  await control.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  const canvasAfterSolo = await control.locator(".editor-canvas").screenshot();
  if (!canvasBeforeSolo.equals(canvasAfterSolo)) throw new Error("退出单层查看后没有准确恢复原画面。");
  await control.waitForTimeout(350);
  const workspaceAfterSolo = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  if (JSON.stringify(workspaceAfterSolo.draft) !== JSON.stringify(workspaceBeforeSolo.draft)) throw new Error("单层查看被错误写入了项目草稿。");

  await control.getByRole("button", { name: "网格与权重" }).click();
  const orderButtons = control.locator(".order-row button");
  if (await orderButtons.count() !== 2 || await orderButtons.locator("svg").count() !== 2) throw new Error("图层绘制顺序没有使用图标按钮。" );
  await control.locator(".mesh-handle-hit").first().waitFor();
  const handles = control.locator(".mesh-handle-hit");
  const visibleHandles = control.locator(".mesh-handle");
  const meshCursor = await handles.first().evaluate((element) => getComputedStyle(element).cursor);
  if (meshCursor !== "default") throw new Error(`靠近网格节点时仍然不是小箭头指针：${meshCursor}`);
  const initialHandleSize = await visibleHandles.first().boundingBox();
  const meshStage = await editorStage.boundingBox();
  if (!initialHandleSize || !meshStage) throw new Error("无法测量网格节点的屏幕尺寸。");
  const meshLineStyle = await control.locator(".mesh-deformed").evaluate((element) => ({
    strokeWidth: getComputedStyle(element).strokeWidth,
    vectorEffect: getComputedStyle(element).vectorEffect
  }));
  if (meshLineStyle.strokeWidth !== "0.3px" || meshLineStyle.vectorEffect !== "non-scaling-stroke") {
    throw new Error(`网格线没有使用细线与恒定屏幕宽度：${JSON.stringify(meshLineStyle)}`);
  }
  const overlayPointerEvents = await control.locator(".editor-overlay").evaluate((element) => getComputedStyle(element).pointerEvents);
  if (overlayPointerEvents !== "none") throw new Error(`网格覆盖层仍在拦截画布事件：${overlayPointerEvents}`);
  const meshPanStart = await control.evaluate(() => {
    const stage = document.querySelector("[data-testid='editor-stage']");
    if (!(stage instanceof HTMLElement)) return undefined;
    const rect = stage.getBoundingClientRect();
    for (let y = rect.top + 8; y < rect.bottom - 8; y += 8) {
      for (let x = rect.left + 8; x < rect.right - 8; x += 8) {
        const point = { x, y };
        const target = document.elementFromPoint(point.x, point.y);
        if (!(target instanceof Element) || target.closest(".viewport-navigation")) continue;
        const meshHit = target.closest(".mesh-handle-hit");
        if (!meshHit) return point;
        const visiblePoint = meshHit.nextElementSibling;
        if (!(visiblePoint instanceof SVGGraphicsElement)) continue;
        const pointRect = visiblePoint.getBoundingClientRect();
        if (Math.hypot(x - (pointRect.left + pointRect.width / 2), y - (pointRect.top + pointRect.height / 2)) > 5.25) return point;
      }
    }
    return undefined;
  });
  if (!meshPanStart) throw new Error("网格显示时没有可用于平移画布的空白区域。");
  const meshStageBeforePan = await editorStage.boundingBox();
  if (!meshStageBeforePan) throw new Error("网格显示时画布不可见。");
  await control.mouse.move(meshPanStart.x, meshPanStart.y);
  await control.mouse.down();
  await control.mouse.move(meshPanStart.x + 48, meshPanStart.y + 30, { steps: 4 });
  await control.mouse.up();
  await control.waitForFunction((x) => (document.querySelector("[data-testid='editor-stage']")?.getBoundingClientRect().x ?? x) > x + 36, meshStageBeforePan.x);
  await control.getByRole("button", { name: "适配" }).click();
  await control.waitForTimeout(120);
  await control.mouse.move(meshStage.x + meshStage.width * 0.5, meshStage.y + meshStage.height * 0.5);
  await control.mouse.wheel(0, -480);
  await control.waitForFunction(() => document.querySelector(".viewport-navigation output")?.textContent !== "100%");
  await control.waitForTimeout(180);
  const zoomedHandleSize = await visibleHandles.first().boundingBox();
  if (!zoomedHandleSize || Math.max(initialHandleSize.width, zoomedHandleSize.width) > 5
    || Math.abs(zoomedHandleSize.width - initialHandleSize.width) > 0.85) {
    throw new Error(`缩放后网格节点变粗：${JSON.stringify({ initialHandleSize, zoomedHandleSize })}`);
  }
  await control.getByRole("button", { name: "适配" }).click();
  await control.waitForTimeout(180);
  const directDragIndex = Math.min(await handles.count() - 1, Math.floor(await handles.count() / 2) + 1);
  const directDragBefore = await handles.nth(directDragIndex).getAttribute("aria-valuetext");
  const directDragTarget = await visibleHandles.nth(directDragIndex).boundingBox();
  if (!directDragTarget || !directDragBefore) throw new Error("无法验证未选中节点的直接拖动。" );
  await control.mouse.move(directDragTarget.x + directDragTarget.width / 2, directDragTarget.y + directDragTarget.height / 2);
  await control.mouse.down();
  await control.mouse.move(directDragTarget.x + directDragTarget.width / 2 + 4, directDragTarget.y + directDragTarget.height / 2 - 2, { steps: 3 });
  await control.mouse.up();
  const directDragAfter = await handles.nth(directDragIndex).getAttribute("aria-valuetext");
  if (directDragAfter === directDragBefore) throw new Error("未选中的网格节点不能在第一次按下时直接拖动。" );
  const vertexIndex = Math.floor(await handles.count() / 2);
  let vertex = await handles.nth(vertexIndex).boundingBox();
  if (!vertex) throw new Error("编辑器没有可拖动的网格顶点。" );
  await control.mouse.click(vertex.x + vertex.width / 2, vertex.y + vertex.height / 2);
  const vertexPosition = control.locator(".vertex-inspector p");
  const beforeKeyboardNudge = await vertexPosition.innerText();
  await handles.nth(vertexIndex).focus();
  await handles.nth(vertexIndex).press("ArrowRight");
  const afterKeyboardNudge = await vertexPosition.innerText();
  if (afterKeyboardNudge === beforeKeyboardNudge) throw new Error("键盘方向键没有微调网格顶点。" );
  await control.keyboard.press("Control+z");
  await control.waitForFunction((before) => document.querySelector(".vertex-inspector p")?.textContent === before, beforeKeyboardNudge);
  await control.keyboard.press("Control+y");
  await control.waitForFunction((after) => document.querySelector(".vertex-inspector p")?.textContent === after, afterKeyboardNudge);
  const multiIndex = Math.min(await handles.count() - 1, vertexIndex + 3);
  const multiTarget = await visibleHandles.nth(multiIndex).boundingBox();
  if (!multiTarget) throw new Error("无法验证 Shift 多选。" );
  await control.keyboard.down("Shift");
  await control.mouse.click(multiTarget.x + multiTarget.width / 2, multiTarget.y + multiTarget.height / 2);
  await control.keyboard.up("Shift");
  if (await control.locator(".mesh-handle.selected").count() !== 2) throw new Error("Shift+单击没有保留原节点并加入第二个节点。" );
  const selectedVisuals = await control.locator(".mesh-handle.selected").evaluateAll((elements) => elements.map((element) => ({
    fill: getComputedStyle(element).fill,
    strokeWidth: getComputedStyle(element).strokeWidth
  })));
  if (selectedVisuals.some((style) => style.fill !== "rgb(255, 200, 87)" || Number.parseFloat(style.strokeWidth) > 1)) {
    throw new Error(`多选节点没有使用清晰且等大的黄色选中态：${JSON.stringify(selectedVisuals)}`);
  }
  const focusedPointStroke = await control.evaluate(() => {
    const active = document.activeElement;
    const visible = active instanceof SVGElement ? active.nextElementSibling : undefined;
    return visible instanceof SVGElement ? getComputedStyle(visible).strokeWidth : undefined;
  });
  if (focusedPointStroke && Number.parseFloat(focusedPointStroke) > 1) throw new Error(`焦点样式把网格节点异常放大：${focusedPointStroke}`);
  await control.getByText("已选择 2 个点；拖动任意一个黄色节点即可整体移动。单击空白取消选择，Shift+拖动框选更多节点，Shift+单击可增减单点。", { exact: true }).waitFor();
  const primaryBeforeGroupDrag = await handles.nth(vertexIndex).getAttribute("aria-valuetext");
  const secondaryBeforeGroupDrag = await handles.nth(multiIndex).getAttribute("aria-valuetext");
  vertex = await visibleHandles.nth(vertexIndex).boundingBox();
  if (!vertex) throw new Error("多选后主节点消失。" );
  await control.mouse.move(vertex.x + vertex.width / 2, vertex.y + vertex.height / 2);
  await control.mouse.down();
  await control.mouse.move(vertex.x + vertex.width / 2 + 3, vertex.y + vertex.height / 2 - 2, { steps: 3 });
  await control.mouse.up();
  if (await handles.nth(vertexIndex).getAttribute("aria-valuetext") === primaryBeforeGroupDrag
    || await handles.nth(multiIndex).getAttribute("aria-valuetext") === secondaryBeforeGroupDrag) {
    throw new Error("拖动多选节点时没有让两个选中点一起移动。" );
  }
  const blankSelectionPoint = await control.evaluate(() => {
    const stage = document.querySelector("[data-testid='editor-stage']");
    if (!(stage instanceof HTMLElement)) return undefined;
    const rect = stage.getBoundingClientRect();
    const centers = [...document.querySelectorAll(".mesh-handle")].map((element) => {
      const point = element.getBoundingClientRect();
      return { x: point.left + point.width / 2, y: point.top + point.height / 2 };
    });
    for (let y = rect.top + 8; y < rect.bottom - 8; y += 8) {
      for (let x = rect.left + 8; x < rect.right - 8; x += 8) {
        if (document.elementFromPoint(x, y)?.closest(".mesh-selection-move-area")) continue;
        if (centers.every((point) => Math.hypot(x - point.x, y - point.y) > 5.25)) return { x, y };
      }
    }
    return undefined;
  });
  if (!blankSelectionPoint) throw new Error("找不到可验证取消选择的网格空白位置。");
  const blankSelectionEvidence = await control.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return { tag: target?.tagName, className: target?.getAttribute("class") };
  }, blankSelectionPoint);
  await control.mouse.click(blankSelectionPoint.x, blankSelectionPoint.y);
  await control.waitForTimeout(180);
  if (await control.locator(".mesh-handle.selected").count() !== 0) throw new Error(`点击多选区域外的空白没有取消选择：${JSON.stringify({ blankSelectionPoint, blankSelectionEvidence })}`);
  const boxSelection = await visibleHandles.evaluateAll((elements, indices) => {
    const points = indices.map((index) => elements[index]).filter(Boolean).map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    if (points.length < 2) return undefined;
    return {
      start: { x: Math.min(...points.map((point) => point.x)) - 5, y: Math.min(...points.map((point) => point.y)) - 5 },
      end: { x: Math.max(...points.map((point) => point.x)) + 5, y: Math.max(...points.map((point) => point.y)) + 5 }
    };
  }, [vertexIndex, multiIndex]);
  if (!boxSelection) throw new Error("网格顶点不足，无法验证 Shift 框选。");
  await control.keyboard.down("Shift");
  await control.mouse.move(boxSelection.start.x, boxSelection.start.y);
  await control.mouse.down();
  await control.mouse.move(boxSelection.end.x, boxSelection.end.y, { steps: 4 });
  await control.locator(".mesh-selection-box").waitFor();
  await control.mouse.up();
  await control.keyboard.up("Shift");
  if (await control.locator(".mesh-selection-box").count() !== 0) throw new Error("Shift 框选松开后选择矩形没有消失。");
  if (await control.locator(".mesh-handle.selected").count() < 2) throw new Error("Shift 拖动框选没有选中框内的多个节点。");
  const selectedBoxIndices = await visibleHandles.evaluateAll((elements) => elements.flatMap((element, index) => element.classList.contains("selected") ? [index] : []));
  const selectedBoxBefore = await Promise.all(selectedBoxIndices.map((index) => handles.nth(index).getAttribute("aria-valuetext")));
  const selectedMoveArea = await control.locator(".mesh-selection-move-area").boundingBox();
  const stageBeforeSelectionAreaDrag = await editorStage.boundingBox();
  if (!selectedMoveArea || !stageBeforeSelectionAreaDrag) throw new Error("多选后没有形成整体移动区域。");
  const selectionAreaCenter = {
    x: selectedMoveArea.x + selectedMoveArea.width / 2,
    y: selectedMoveArea.y + selectedMoveArea.height / 2
  };
  await control.mouse.move(selectionAreaCenter.x, selectionAreaCenter.y);
  await control.mouse.down();
  await control.mouse.move(selectionAreaCenter.x + 4, selectionAreaCenter.y - 3, { steps: 3 });
  await control.mouse.up();
  const selectedBoxAfter = await Promise.all(selectedBoxIndices.map((index) => handles.nth(index).getAttribute("aria-valuetext")));
  if (!selectedBoxAfter.some((value, index) => value !== selectedBoxBefore[index])) throw new Error("在多选区域内部拖动没有移动选中的节点。");
  const stageAfterSelectionAreaDrag = await editorStage.boundingBox();
  if (!stageAfterSelectionAreaDrag || Math.hypot(stageAfterSelectionAreaDrag.x - stageBeforeSelectionAreaDrag.x, stageAfterSelectionAreaDrag.y - stageBeforeSelectionAreaDrag.y) > 1) {
    throw new Error("在多选区域内部拖动时错误地移动了画布。");
  }
  await control.mouse.click(blankSelectionPoint.x, blankSelectionPoint.y);
  await control.waitForFunction(() => document.querySelectorAll(".mesh-handle.selected").length === 0);
  vertex = await visibleHandles.nth(vertexIndex).boundingBox();
  if (!vertex) throw new Error("取消框选后网格顶点消失。");
  await control.mouse.click(vertex.x + vertex.width / 2, vertex.y + vertex.height / 2);
  await control.getByRole("checkbox", { name: "带动相邻顶点（软选择）" }).check();
  const softRadius = control.getByLabel(/影响半径/);
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

  await control.locator(".pose-tabs").getByRole("button", { name: /右转/ }).click();
  vertex = await handles.nth(vertexIndex).boundingBox();
  if (!vertex) throw new Error("切换右转姿态后网格顶点消失。" );
  await control.mouse.move(vertex.x + vertex.width / 2, vertex.y + vertex.height / 2);
  await control.mouse.down();
  await control.mouse.move(vertex.x + vertex.width / 2 + 2, vertex.y + vertex.height / 2 - 1, { steps: 2 });
  await control.mouse.up();
  await control.locator(".pose-tabs").getByRole("button", { name: /中立/ }).click();

  await control.getByRole("button", { name: "动作", exact: true }).click();
  const secondaryAmplitude = control.getByTestId("secondary-amplitude");
  await secondaryAmplitude.evaluate((element) => {
    const input = element;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "1.1");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const calibrationLabel = control.getByPlaceholder("例如：固定耳根并调整右眼外角");
  await calibrationLabel.scrollIntoViewIfNeeded();
  await calibrationLabel.fill("软选择网格与前发响应校准");

  const saveButton = control.getByRole("button", { name: "保存校准" });
  await saveButton.waitFor({ state: "attached" });
  await control.getByText("草稿已保存", { exact: true }).waitFor({ timeout: 10_000 });
  const persistedDraft = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  const draftLayer = persistedDraft.draft?.overrides.layers?.[face.id];
  if (!draftLayer || Object.keys(draftLayer.meshPointDeltas ?? {}).length < 2) throw new Error("软选择没有把多个顶点写入自动保存草稿。" );
  const correction = persistedDraft.draft?.overrides.model?.bindings.find((binding) => binding.id === `pose-correction:${face.id}`);
  const rightKeyform = correction?.keyforms.find((keyform) => keyform.values[0] === 1 && (keyform.values[1] ?? 0) === 0);
  if (!rightKeyform || Object.keys(rightKeyform.meshPointDeltas ?? {}).length < 1) throw new Error("右转姿态的网格微调没有写入独立关键形。" );
  if (persistedDraft.draft?.overrides.runtime?.secondaryMotionTuning?.frontHair?.amplitude !== 1.1) throw new Error("分部响应没有写入自动保存草稿。" );
  await control.getByRole("button", { name: "恢复全部自动绑定" }).click();
  await control.getByText(/请先保存或明确放弃当前草稿/).waitFor();
  const afterRefusedRestore = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  if (!afterRefusedRestore.draft) throw new Error("拒绝恢复时草稿被意外清空。" );

  await control.getByRole("button", { name: "返回主页" }).click();
  await control.getByTestId("creator").waitFor();
  await control.locator(".recent-projects button").filter({ hasText: output }).click();
  await control.getByTestId("editor").waitFor();
  await structureWorkspaceButton.click();
  await control.locator(".layer-list").waitFor();
  await control.getByRole("button", { name: "动作", exact: true }).click();
  await control.getByText(/已恢复 .*自动保存的草稿/).waitFor();
  if (await saveButton.isDisabled()) throw new Error("恢复草稿后保存校准仍不可用。" );

  const restoredSecondaryAmplitude = control.getByTestId("secondary-amplitude");
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
  await control.getByText(/已保存版本 1/).waitFor({ timeout: 30_000 });
  const calibratedWorkspace = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  if (calibratedWorkspace.calibration.revision !== 1) throw new Error("桌面编辑器没有持久化校准修订。" );
  if (calibratedWorkspace.draft) throw new Error("保存校准后草稿仍被当作未提交内容恢复。" );
  if (Object.keys(calibratedWorkspace.calibration.overrides.layers?.[face.id]?.meshPointDeltas ?? {}).length < 2) throw new Error("校准修订没有保留软选择网格结果。" );
  const savedCorrection = calibratedWorkspace.project.model.bindings.find((binding) => binding.id === `pose-correction:${face.id}`);
  const savedRightKeyform = savedCorrection?.keyforms.find((keyform) => keyform.values[0] === 1 && (keyform.values[1] ?? 0) === 0);
  if (!savedRightKeyform || Object.keys(savedRightKeyform.meshPointDeltas ?? {}).length < 1) throw new Error("保存校准后右转关键形丢失。" );
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
  await control.evaluate(() => new Promise((resolvePaint) => {
    requestAnimationFrame(() => requestAnimationFrame(resolvePaint));
  }));
  const editorNativeEvidence = await captureNativeWindow(electronApp, controlWindow, editorNativeScreenshot);
  await control.screenshot({ path: editorContentScreenshot, fullPage: true });
  await control.getByRole("button", { name: "关闭版本对比" }).click();
  await control.getByTestId("comparison-view").waitFor({ state: "detached" });
  await control.locator(".layer-select").filter({ hasText: frontHair.sourceName }).click();
  await control.getByRole("button", { name: "网格与权重" }).click();
  const artMeshHandles = control.locator(".mesh-handle");
  await artMeshHandles.first().waitFor();
  const artMeshHandleCount = await artMeshHandles.count();
  if (artMeshHandleCount < 12) throw new Error(`前发 ArtMesh 的轮廓密度不足以进行局部编辑：${artMeshHandleCount} 个顶点。`);
  await control.screenshot({ path: artMeshScreenshot });
  await control.getByRole("button", { name: "版本", exact: true }).click();
  await control.locator(".session-panel article").first().getByRole("button", { name: "确认" }).click();
  await control.waitForFunction(async (projectDirectory) => (await window.puppetloom.readEditorWorkspace(projectDirectory)).sessions.at(-1)?.evidenceStatus === "accepted", output);

  const viewerPromise = electronApp.waitForEvent("window");
  await control.getByRole("button", { name: "运行角色窗口" }).click();
  const viewer = await viewerPromise;
  viewer.on("pageerror", (cause) => process.stderr.write(`[viewer pageerror] ${cause.message}\n`));
  viewer.on("console", (message) => { if (message.type() === "error") process.stderr.write(`[viewer console] ${message.text()}\n`); });
  await viewer.getByTestId("viewer").waitFor();
  await viewer.locator("canvas").waitFor({ state: "visible" });
  const viewerControlButtons = viewer.locator(".viewer-controls button");
  if (await viewerControlButtons.count() !== 13 || await viewerControlButtons.locator("svg").count() !== 13) throw new Error("角色窗口控制栏没有完整使用图标。" );
  if ((await viewerControlButtons.allInnerTexts()).some((text) => text.trim().length > 0)) throw new Error("角色窗口控制栏仍包含拥挤的文字按钮。" );
  await viewer.waitForFunction(() => typeof window.puppetloomRenderCurrentFrame === "function", undefined, { timeout: 30_000 });
  const viewerReady = await viewer.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    if (!window.puppetloomRenderCurrentFrame?.()) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  });
  if (!viewerReady) throw new Error(`角色窗口没有渲染可见像素：${await viewer.locator(".viewer-error").textContent() ?? "无界面错误"}`);

  const firstLiveFrame = await viewer.locator("canvas").screenshot();
  await viewer.waitForTimeout(1_200);
  const secondLiveFrame = await viewer.locator("canvas").screenshot();
  if (firstLiveFrame.equals(secondLiveFrame)) throw new Error("角色窗口默认启动后画面没有自主运动。" );

  await viewer.getByRole("button", { name: "打开表情动作面板" }).click();
  await viewer.getByRole("complementary", { name: "表情与动作" }).waitFor();
  const viewerCapabilities = await viewer.evaluate(() => window.puppetloom.viewerCapabilities());
  if (Object.entries(viewerCapabilities.hotkeys).some(([key, available]) => key !== "CommandOrControl+Shift+P" && !available)) await viewer.getByText(/部分系统快捷键已被其它软件占用/).waitFor();
  await viewer.getByRole("button", { name: "关闭表情动作面板" }).click();

  await viewer.getByRole("button", { name: "录制驱动输入" }).click();
  await viewer.getByText("正在录制驱动输入", { exact: true }).waitFor();
  await viewer.evaluate(() => window.puppetloom.setRuntimeSource({ id: "e2e-control", priority: 90, ttlMs: 500, motion: { headYaw: 0.65, gazeX: 0.8 } }));
  await viewer.waitForTimeout(250);
  await viewer.getByRole("button", { name: "停止并保存输入录制" }).click();
  await viewer.getByText(/输入会话已保存/).waitFor();
  const inputSessionDirectory = resolve(output, "reports", "input-sessions");
  const inputSessions = (await readdir(inputSessionDirectory)).filter((name) => name.endsWith(".runtime-input.json"));
  if (inputSessions.length !== 1) throw new Error(`驱动输入没有保存为唯一会话：${JSON.stringify(inputSessions)}`);
  const inputSession = JSON.parse(await readFile(resolve(inputSessionDirectory, inputSessions[0]), "utf8"));
  if (inputSession.events.length < 1 || !inputSession.events.some((event) => event.source?.id === "e2e-control")) throw new Error(`驱动输入会话缺少外部控制事件：${JSON.stringify(inputSession)}`);

  await viewer.getByRole("button", { name: "录制 WebM 表演" }).click();
  await viewer.getByRole("complementary", { name: "WebM 录制设置" }).waitFor();
  await viewer.getByLabel("录制背景").selectOption("green");
  await viewer.getByLabel("录制宽度").fill("960");
  await viewer.getByLabel("录制高度").fill("540");
  await viewer.getByLabel("录制帧率").selectOption("24");
  await viewer.getByLabel("录制时长秒数").fill("0");
  await viewer.getByRole("button", { name: "开始录制表演" }).click();
  await viewer.getByText("正在录制 WebM 表演与同步输入", { exact: true }).waitFor();
  await viewer.evaluate(() => window.puppetloom.setRuntimeSource({ id: "e2e-performance-control", priority: 91, ttlMs: 800, motion: { headPitch: 0.5, bodySway: -0.35 } }));
  await viewer.waitForTimeout(2_200);
  await viewer.getByRole("button", { name: "停止并保存 WebM 表演" }).click();
  await viewer.getByText(/WebM 表演与同步输入已保存/).waitFor({ timeout: 15_000 });
  await viewer.getByLabel("WebM 录制预览视频").waitFor();
  const performanceDirectory = resolve(output, "reports", "performances");
  const performanceFiles = await readdir(performanceDirectory);
  const webmName = performanceFiles.find((name) => name.endsWith(".webm") && !name.endsWith(".partial.webm"));
  const reportName = performanceFiles.find((name) => name.endsWith(".performance.json"));
  if (!webmName || !reportName || performanceFiles.some((name) => name.endsWith(".partial.webm"))) throw new Error(`WebM 表演没有形成完整文件和报告：${JSON.stringify(performanceFiles)}`);
  const performanceReport = JSON.parse(await readFile(resolve(performanceDirectory, reportName), "utf8"));
  const webmHeader = await readFile(resolve(performanceDirectory, webmName));
  if (performanceReport.status !== "completed" || performanceReport.media?.bytes < 1 || (await stat(resolve(performanceDirectory, webmName))).size !== performanceReport.media.bytes) throw new Error(`WebM 报告与视频不一致：${JSON.stringify(performanceReport)}`);
  if (performanceReport.media?.fps !== 24 || performanceReport.media?.width !== 960 || performanceReport.media?.height !== 540 || performanceReport.media?.background?.mode !== "solid" || performanceReport.media?.background?.color !== "#00ff00") throw new Error(`WebM 没有采用界面选择的录制参数：${JSON.stringify(performanceReport.media)}`);
  if (!performanceReport.inputSession?.output || performanceReport.inputSession.events < 1) throw new Error(`WebM 报告缺少同步输入会话：${JSON.stringify(performanceReport)}`);
  const performanceInput = JSON.parse(await readFile(performanceReport.inputSession.output, "utf8"));
  if (!performanceInput.events.some((event) => event.source?.id === "e2e-performance-control")) throw new Error(`同步输入会话缺少录制期间的控制事件：${JSON.stringify(performanceInput)}`);
  if (!webmHeader.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw new Error("录制结果没有 WebM EBML 文件头。" );

  const filesBeforeTimedRecording = new Set(await readdir(performanceDirectory));
  await viewer.getByRole("button", { name: "录制 WebM 表演" }).click();
  await viewer.getByRole("complementary", { name: "WebM 录制设置" }).waitFor();
  await viewer.getByLabel("录制时长秒数").fill("1");
  await viewer.getByRole("button", { name: "开始录制表演" }).click();
  await viewer.getByText("正在录制 WebM 表演与同步输入", { exact: true }).waitFor();
  await viewer.evaluate(() => window.puppetloom.setRuntimeSource({ id: "e2e-timed-performance-control", priority: 92, ttlMs: 800, motion: { bodyPitch: 0.4 } }));
  await viewer.getByText(/WebM 表演与同步输入已保存/).waitFor({ timeout: 15_000 });
  const timedFiles = (await readdir(performanceDirectory)).filter((name) => !filesBeforeTimedRecording.has(name));
  const timedWebmName = timedFiles.find((name) => name.endsWith(".webm") && !name.endsWith(".partial.webm"));
  const timedReportName = timedFiles.find((name) => name.endsWith(".performance.json"));
  if (!timedWebmName || !timedReportName || timedFiles.some((name) => name.endsWith(".partial.webm"))) throw new Error(`定时录制没有自动形成完整文件和报告：${JSON.stringify(timedFiles)}`);
  const timedReport = JSON.parse(await readFile(resolve(performanceDirectory, timedReportName), "utf8"));
  if (timedReport.status !== "completed" || timedReport.media?.targetDurationMs !== 1_000 || timedReport.durationMs < 750 || timedReport.durationMs > 2_500) throw new Error(`定时录制没有按 1 秒自动停止：${JSON.stringify(timedReport)}`);
  if (!timedReport.inputSession?.output || timedReport.inputSession.events < 1) throw new Error(`定时录制没有关联自己的输入会话：${JSON.stringify(timedReport)}`);
  const timedInput = JSON.parse(await readFile(timedReport.inputSession.output, "utf8"));
  if (!timedInput.events.some((event) => event.source?.id === "e2e-timed-performance-control")) throw new Error(`定时录制的同步输入缺少录制期间事件：${JSON.stringify(timedInput)}`);
  const timedWebmHeader = await readFile(resolve(performanceDirectory, timedWebmName));
  if (!timedWebmHeader.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw new Error("定时录制结果没有 WebM EBML 文件头。" );

  const viewerWindow = await electronApp.browserWindow(viewer);
  const viewerId = await viewerWindow.evaluate((window) => window.id);

  const duplicate = await control.evaluate((projectDirectory) => window.puppetloom.launchViewer(projectDirectory), output);
  if (duplicate.id !== viewerId) throw new Error(`重复打开同一项目创建了多个窗口：${JSON.stringify({ first: viewerId, duplicate: duplicate.id })}`);
  const refreshed = await control.evaluate(async (projectDirectory) => {
    const project = await window.puppetloom.readProject(projectDirectory);
    return window.puppetloom.launchViewer(projectDirectory, { project: { ...project, name: `${project.name} · 草稿热更新` }, sourceLabel: "未保存草稿预览" });
  }, output);
  if (refreshed.id !== viewerId) throw new Error("草稿预览没有复用并更新现有角色窗口。" );
  await viewer.getByText("未保存草稿预览", { exact: true }).waitFor();
  await viewer.getByText(/草稿热更新/, { exact: false }).waitFor();
  const restoredViewer = await control.evaluate((projectDirectory) => window.puppetloom.launchViewer(projectDirectory), output);
  if (restoredViewer.id !== viewerId) throw new Error("恢复已保存预览时创建了重复角色窗口。" );
  await viewer.getByText("已保存项目", { exact: true }).waitFor();

  const browserWindow = viewerWindow;
  await browserWindow.evaluate((window) => window.setSize(300, 300));
  await viewer.waitForFunction(() => window.innerWidth <= 300 && window.innerHeight <= 300);
  await viewer.hover(".viewer");
  const compactViewerControls = await viewer.locator(".viewer-controls button").evaluateAll((buttons) => ({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    boxes: buttons.map((button) => button.getBoundingClientRect())
  }));
  if (compactViewerControls.boxes.some((box) => box.left < -1 || box.right > compactViewerControls.viewport.width + 1 || box.top < -1 || box.bottom > compactViewerControls.viewport.height + 1)) throw new Error(`紧凑角色窗口控制发生裁切：${JSON.stringify(compactViewerControls)}`);
  await browserWindow.evaluate((window) => window.setSize(720, 720));
  await viewer.waitForFunction(() => window.innerWidth === 720 && window.innerHeight === 720);
  const nativeState = await browserWindow.evaluate((window) => ({
    top: window.isAlwaysOnTop(),
    resizable: window.isResizable(),
    size: window.getSize(),
    visible: window.isVisible(),
    outerBounds: window.getBounds(),
    contentBounds: window.getContentBounds()
  }));
  const aspect = nativeState.size[0] / nativeState.size[1];
  if (!nativeState.top || !nativeState.visible || Math.abs(aspect - 1) > 0.01) throw new Error(`透明窗口状态不符合要求：${JSON.stringify(nativeState)}`);
  const viewerNativeEvidence = await captureNativeWindow(electronApp, browserWindow, viewerNativeScreenshot);

  const visiblePixelRatio = () => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("角色窗口缺少画布。");
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("角色窗口缺少 WebGL2 上下文。");
    if (!window.puppetloomRenderCurrentFrame?.()) throw new Error("角色窗口不能刷新当前帧。");
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
    return canvas instanceof HTMLCanvasElement && canvas.width / canvas.height > 1.45;
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
  if (![pointer.x, pointer.y, pointer.strength].every(Number.isFinite) || pointer.strength !== 1) throw new Error(`角色窗口首次启动没有默认开启鼠标跟随：${JSON.stringify(pointer)}`);
  const trackingOff = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pointer-tracking"), { id: viewerId });
  if (trackingOff?.mouseTracking) throw new Error("桌面端未能恢复自主观察。" );
  const disabledPointer = await viewer.evaluate(() => window.puppetloom.pointerTarget());
  if (disabledPointer.strength !== 0) throw new Error(`恢复自主观察后仍返回活动目标：${JSON.stringify(disabledPointer)}`);
  const savedViewerPreference = JSON.parse(await readFile(resolve(applicationProfile, "viewer-preferences.json"), "utf8"));
  if (savedViewerPreference.version !== 1 || savedViewerPreference.mouseTracking !== false) {
    throw new Error(`鼠标跟随选择没有写入用户配置：${JSON.stringify(savedViewerPreference)}`);
  }

  await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "larger"), { id: viewerId });
  const scaledSize = await browserWindow.evaluate((window) => window.getSize());
  if (scaledSize[0] <= nativeState.size[0] || scaledSize[1] <= nativeState.size[1]) throw new Error(`角色窗口缩放未生效：${JSON.stringify({ before: nativeState.size, after: scaledSize })}`);

  const paused = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pause"), { id: viewerId });
  if (!paused?.paused) throw new Error("桌面端未能暂停角色窗口。" );
  const through = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "click-through"), { id: viewerId });
  if (viewerCapabilities.hotkeys["CommandOrControl+Shift+P"] === false) {
    if (through?.clickThrough) throw new Error("恢复快捷键不可用时仍允许进入鼠标穿透。" );
  } else {
    if (!through?.clickThrough) throw new Error("桌面端未能启用鼠标穿透。" );
    const restored = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "click-through"), { id: viewerId });
    if (restored?.clickThrough) throw new Error("桌面端未能恢复鼠标交互。" );
  }
  const resumed = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pause"), { id: viewerId });
  if (resumed?.paused) throw new Error("桌面端未能恢复自主运动。" );

  const viewerClosed = viewer.waitForEvent("close");
  await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "close"), { id: viewerId });
  await viewerClosed;
  const rememberedViewerPromise = electronApp.waitForEvent("window");
  const rememberedLaunchPromise = control.evaluate((projectDirectory) => window.puppetloom.launchViewer(projectDirectory), output);
  const rememberedViewer = await rememberedViewerPromise;
  const rememberedLaunch = await rememberedLaunchPromise;
  await rememberedViewer.getByTestId("viewer").waitFor();
  if (rememberedLaunch.state.mouseTracking) throw new Error(`重新打开角色窗口后没有沿用自主观察：${JSON.stringify(rememberedLaunch.state)}`);
  const rememberedPointer = await rememberedViewer.evaluate(() => window.puppetloom.pointerTarget());
  if (rememberedPointer.strength !== 0) throw new Error(`重新打开角色窗口后鼠标跟随选择没有生效：${JSON.stringify(rememberedPointer)}`);

  await control.getByRole("button", { name: "动作", exact: true }).click();
  await calibrationLabel.scrollIntoViewIfNeeded();
  await calibrationLabel.fill("直接关窗草稿复验");
  const closeDraftAmplitude = control.getByTestId("secondary-amplitude");
  await closeDraftAmplitude.evaluate((element) => {
    const input = element;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "1.12");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const controlClosed = control.waitForEvent("close");
  await control.getByRole("button", { name: "关闭窗口" }).click();
  await controlClosed;
  const closeDraft = JSON.parse(await readFile(resolve(output, "calibration", "draft.json"), "utf8"));
  if (closeDraft.label !== "直接关窗草稿复验" || closeDraft.overrides?.runtime?.secondaryMotionTuning?.frontHair?.amplitude !== 1.12) {
    throw new Error(`直接关窗前没有完整刷新草稿：${JSON.stringify(closeDraft)}`);
  }

  const result = {
    ok: true,
    project: output,
    evidence: {
      launcher: { contentOnly: launcherContentScreenshot, nativeWindow: launcherNativeScreenshot, shell: restoredShell, capture: launcherNativeEvidence },
      editor: { contentOnly: editorContentScreenshot, artMesh: artMeshScreenshot, nativeWindow: editorNativeScreenshot, shell: editorShell, capture: editorNativeEvidence },
      viewer: { nativeWindow: viewerNativeScreenshot, state: nativeState, capture: viewerNativeEvidence }
    },
    viewerId
  };
  await writeFile(windowShellEvidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  if (creationRigRegression) throw new Error(`窗口与编辑器用户链已完成，但保留独立 core 回归：${creationRigRegression}；窗口证据：${windowShellEvidencePath}`);

  process.stdout.write(`${JSON.stringify({ ...result, windowShellEvidence: windowShellEvidencePath }, null, 2)}\n`);
} finally {
  await electronApp.close();
}
});
