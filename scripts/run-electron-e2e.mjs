import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { _electron as electron } from "playwright";

const root = resolve(".");
const output = resolve("test/artifacts", `electron-e2e-${process.pid}-${Date.now()}`);
const editorScreenshot = resolve("test/artifacts", `editor-e2e-${process.pid}-${Date.now()}.png`);
await mkdir(resolve("test/artifacts"), { recursive: true });

const electronApp = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js")],
  cwd: root,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1" }
});

try {
  const control = await electronApp.firstWindow();
  await control.getByTestId("creator").waitFor();
  const createResult = await control.evaluate(async ({ input, outputDirectory }) => {
    return window.puppetloom.create({ input, output: outputDirectory, seed: 42 });
  }, { input: resolve("test/fixtures/semantic.psd"), outputDirectory: output });
  if (!createResult.verify.valid || createResult.report.rigLevel !== "semantic") throw new Error("桌面创建链未返回有效 semantic 项目。" );
  const recent = await control.evaluate(() => window.puppetloom.recentProjects());
  if (!recent.some((entry) => entry.directory.toLocaleLowerCase() === output.toLocaleLowerCase())) throw new Error("创建后的项目没有进入最近项目列表。" );

  const workspace = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  if (workspace.calibration.revision !== 0 || workspace.project.version !== 2) throw new Error(`桌面编辑工作区没有读取 v2 基线：${JSON.stringify(workspace.calibration)}`);
  await control.evaluate((projectDirectory) => {
    const url = new URL(window.location.href);
    url.searchParams.set("editor", "1");
    url.searchParams.set("project", projectDirectory);
    window.location.href = url.toString();
  }, output);
  await control.getByTestId("editor").waitFor();
  const controlWindow = await electronApp.browserWindow(control);
  await control.waitForFunction(() => window.innerWidth >= 1300 && window.innerHeight >= 800);
  const editorWindowSize = await controlWindow.evaluate((window) => window.getSize());
  if (editorWindowSize[0] < 1300 || editorWindowSize[1] < 800) throw new Error(`编辑器窗口没有扩展到可操作尺寸：${JSON.stringify(editorWindowSize)}`);
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
  await control.screenshot({ path: editorScreenshot });
  await control.getByRole("button", { name: "网格顶点" }).click();
  await control.locator(".mesh-handle").first().waitFor();
  const vertex = await control.locator(".mesh-handle").first().boundingBox();
  if (!vertex) throw new Error("编辑器没有可拖动的网格顶点。" );
  await control.mouse.move(vertex.x + vertex.width / 2, vertex.y + vertex.height / 2);
  await control.mouse.down();
  await control.mouse.move(vertex.x + vertex.width / 2 + 2, vertex.y + vertex.height / 2, { steps: 3 });
  await control.mouse.up();
  const saveButton = control.getByRole("button", { name: "保存校准" });
  await saveButton.waitFor({ state: "attached" });
  const undoButton = control.getByRole("button", { name: "撤销" });
  const redoButton = control.getByRole("button", { name: "重做" });
  if (await undoButton.isDisabled()) throw new Error("拖动网格后撤销仍不可用。" );
  await undoButton.click();
  if (!(await saveButton.isDisabled())) throw new Error("撤销网格修改后仍被标记为待保存。" );
  if (await redoButton.isDisabled()) throw new Error("撤销后重做仍不可用。" );
  await redoButton.click();
  await saveButton.scrollIntoViewIfNeeded();
  if (await saveButton.isDisabled()) throw new Error("拖动网格后保存校准仍不可用。" );
  await saveButton.click();
  await control.getByText(/已保存 revision 1/).waitFor({ timeout: 30_000 });
  const calibratedWorkspace = await control.evaluate((projectDirectory) => window.puppetloom.readEditorWorkspace(projectDirectory), output);
  if (calibratedWorkspace.calibration.revision !== 1) throw new Error("桌面编辑器没有持久化校准修订。" );

  const viewerPromise = electronApp.waitForEvent("window");
  const launched = await control.evaluate((projectDirectory) => window.puppetloom.launchViewer(projectDirectory), output);
  const viewer = await viewerPromise;
  await viewer.getByTestId("viewer").waitFor();
  await viewer.locator("canvas").waitFor({ state: "visible" });
  await viewer.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  }, undefined, { timeout: 30_000 });

  const duplicate = await control.evaluate((projectDirectory) => window.puppetloom.launchViewer(projectDirectory), output);
  if (duplicate.id !== launched.id) throw new Error(`重复打开同一项目创建了多个窗口：${JSON.stringify({ first: launched.id, duplicate: duplicate.id })}`);

  const browserWindow = await electronApp.browserWindow(viewer);
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
  const trackingOff = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pointer-tracking"), { id: launched.id });
  if (trackingOff?.mouseTracking) throw new Error("桌面端未能关闭鼠标跟随。" );
  const disabledPointer = await viewer.evaluate(() => window.puppetloom.pointerTarget());
  if (disabledPointer.strength !== 0) throw new Error(`关闭鼠标跟随后仍返回活动目标：${JSON.stringify(disabledPointer)}`);
  const trackingOn = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pointer-tracking"), { id: launched.id });
  if (!trackingOn?.mouseTracking) throw new Error("桌面端未能恢复鼠标跟随。" );

  await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "larger"), { id: launched.id });
  const scaledSize = await browserWindow.evaluate((window) => window.getSize());
  if (scaledSize[0] <= nativeState.size[0] || scaledSize[1] <= nativeState.size[1]) throw new Error(`角色窗口缩放未生效：${JSON.stringify({ before: nativeState.size, after: scaledSize })}`);

  const paused = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pause"), { id: launched.id });
  if (!paused?.paused) throw new Error("桌面端未能暂停角色窗口。" );
  const through = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "click-through"), { id: launched.id });
  if (!through?.clickThrough) throw new Error("桌面端未能启用鼠标穿透。" );
  const restored = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "click-through"), { id: launched.id });
  if (restored?.clickThrough) throw new Error("桌面端未能恢复鼠标交互。" );
  const resumed = await control.evaluate(({ id }) => window.puppetloom.controlViewer(id, "pause"), { id: launched.id });
  if (resumed?.paused) throw new Error("桌面端未能恢复自主运动。" );

  process.stdout.write(`${JSON.stringify({ ok: true, project: output, editorScreenshot, viewerId: launched.id, nativeState }, null, 2)}\n`);
} finally {
  await electronApp.close();
}
