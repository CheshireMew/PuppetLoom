import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { _electron as electron } from "playwright";

const root = resolve(".");
const output = resolve("test/artifacts", `electron-e2e-${process.pid}-${Date.now()}`);
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

  const viewerPromise = electronApp.waitForEvent("window");
  const launched = await control.evaluate((projectDirectory) => window.puppetloom.launchViewer(projectDirectory), output);
  const viewer = await viewerPromise;
  await viewer.getByTestId("viewer").waitFor();
  await viewer.locator("canvas").waitFor({ state: "visible" });
  await viewer.waitForFunction(() => document.querySelector("canvas")?.width && document.querySelector("canvas")?.height);

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

  process.stdout.write(`${JSON.stringify({ ok: true, project: output, viewerId: launched.id, nativeState }, null, 2)}\n`);
} finally {
  await electronApp.close();
}
