import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, inspectPsd, loadProject, verifyProject } from "@puppetloom/core";
import { pointerTargetFromScreen } from "@puppetloom/renderer";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen } from "electron";
import type { DesktopCreateRequest, ViewerState } from "./global.js";

const electronDirectory = dirname(fileURLToPath(import.meta.url));
const preload = join(electronDirectory, "preload.cjs");
const rendererPage = resolve(electronDirectory, "../renderer/index.html");
const viewerStates = new Map<number, ViewerState>();
const viewerProjects = new Map<number, string>();
const viewerLookOrigins = new Map<number, { x: number; y: number }>();
let runtimeLogPath: string | undefined;

function runtimeLog(event: string, details: Record<string, unknown> = {}): void {
  if (!runtimeLogPath) return;
  try {
    mkdirSync(dirname(runtimeLogPath), { recursive: true });
    appendFileSync(runtimeLogPath, `${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`, "utf8");
  } catch {
    // Runtime diagnostics must never prevent the viewer from opening.
  }
}

function queryProjectArgument(commandLine = process.argv): string | undefined {
  const index = commandLine.indexOf("--project");
  const candidate = index >= 0 ? commandLine[index + 1] : undefined;
  const cleaned = candidate?.replace(/^"+|"+$/g, "");
  return cleaned ? resolve(cleaned) : undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase();
}

function projectFromAdditionalData(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const project = (value as Record<string, unknown>).project;
  return typeof project === "string" && project ? resolve(project) : undefined;
}

function ownerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

async function chooseFile(event: Electron.IpcMainInvokeEvent, filters: Electron.FileFilter[]): Promise<string | null> {
  const owner = ownerWindow(event);
  const options = { properties: ["openFile"] as Array<"openFile">, filters };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function stateFor(window: BrowserWindow): ViewerState {
  const existing = viewerStates.get(window.id);
  if (existing) return existing;
  const state = { paused: false, alwaysOnTop: true, clickThrough: false, mouseTracking: true, scale: 1 };
  viewerStates.set(window.id, state);
  return state;
}

function publishState(window: BrowserWindow, next: ViewerState): ViewerState {
  viewerStates.set(window.id, next);
  if (!window.isDestroyed()) window.webContents.send("viewer:state", next);
  return next;
}

function bringForward(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const current = stateFor(window);
  if (current.clickThrough) {
    window.setIgnoreMouseEvents(false, { forward: true });
    publishState(window, { ...current, clickThrough: false });
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.moveTop();
  window.focus();
}

function controlViewer(window: BrowserWindow, action: string): ViewerState | null {
  if (window.isDestroyed()) return null;
  const current = stateFor(window);
  let next = current;
  if (action === "pause") next = { ...current, paused: !current.paused };
  if (action === "top") {
    window.setAlwaysOnTop(!current.alwaysOnTop, "floating");
    next = { ...current, alwaysOnTop: !current.alwaysOnTop };
  }
  if (action === "click-through") {
    window.setIgnoreMouseEvents(!current.clickThrough, { forward: true });
    next = { ...current, clickThrough: !current.clickThrough };
  }
  if (action === "pointer-tracking") next = { ...current, mouseTracking: !current.mouseTracking };
  if (action === "larger" || action === "smaller") {
    const factor = action === "larger" ? 1.1 : 1 / 1.1;
    const size = window.getSize();
    const width = size[0] ?? 600;
    const height = size[1] ?? 720;
    const newWidth = Math.max(220, Math.round(width * factor));
    window.setSize(newWidth, Math.max(220, Math.round(height * factor)), true);
    next = { ...current, scale: Math.max(0.35, Math.min(3, current.scale * factor)) };
  }
  if (action === "close") {
    window.close();
    return null;
  }
  return publishState(window, next);
}

async function createViewer(projectDirectory: string): Promise<BrowserWindow> {
  const resolvedProject = resolve(projectDirectory);
  runtimeLog("viewer-create-request", { project: resolvedProject });
  for (const [id, directory] of viewerProjects) {
    const existing = BrowserWindow.fromId(id);
    if (existing && samePath(directory, resolvedProject)) {
      bringForward(existing);
      return existing;
    }
  }
  const project = await loadProject(resolvedProject);
  runtimeLog("project-loaded", { project: resolvedProject, name: project.name, layers: project.layers.length });
  const height = 720;
  const width = Math.max(300, Math.round(height * project.canvas.width / project.canvas.height));
  const window = new BrowserWindow({
    width,
    height,
    minWidth: 220,
    minHeight: 220,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: project.name,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
  });
  window.setAspectRatio(project.canvas.width / project.canvas.height);
  stateFor(window);
  viewerProjects.set(window.id, resolvedProject);
  viewerLookOrigins.set(window.id, project.anchors.nose ?? {
    x: 0.5,
    y: ((project.anchors.headTop?.y ?? 0.04) + (project.anchors.chin?.y ?? 0.36)) * 0.5
  });
  runtimeLog("viewer-window-created", { id: window.id, width, height });
  window.once("ready-to-show", () => runtimeLog("viewer-ready-to-show", { id: window.id }));
  window.webContents.on("did-finish-load", () => runtimeLog("viewer-page-loaded", { id: window.id }));
  window.webContents.on("render-process-gone", (_event, details) => runtimeLog("renderer-gone", { id: window.id, reason: details.reason, exitCode: details.exitCode }));
  window.on("unresponsive", () => runtimeLog("viewer-unresponsive", { id: window.id }));
  window.once("closed", () => {
    runtimeLog("viewer-closed", { id: window.id });
    viewerStates.delete(window.id);
    viewerProjects.delete(window.id);
    viewerLookOrigins.delete(window.id);
  });
  try {
    await window.loadFile(rendererPage, { query: { viewer: "1", project: resolvedProject } });
    runtimeLog("viewer-load-complete", { id: window.id });
  } catch (cause) {
    viewerStates.delete(window.id);
    viewerProjects.delete(window.id);
    viewerLookOrigins.delete(window.id);
    window.destroy();
    throw cause;
  }
  return window;
}

function createControlWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: "#11131a",
    title: "PuppetLoom",
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
  });
  void window.loadFile(rendererPage);
  return window;
}

const initialProject = queryProjectArgument();
runtimeLogPath = initialProject ? join(initialProject, "reports", "runtime.log") : undefined;
const automatedExit = Number(process.env.PUPPETLOOM_E2E_EXIT_AFTER_MS ?? 0);
if (Number.isFinite(automatedExit) && automatedExit > 0) {
  const automatedProfile = process.env.PUPPETLOOM_E2E_USER_DATA
    ? resolve(process.env.PUPPETLOOM_E2E_USER_DATA)
    : join("D:\\Tools", "PuppetLoom", "e2e", `electron-${process.pid}`);
  app.setPath("userData", automatedProfile);
  app.setPath("cache", join(automatedProfile, "cache"));
}
const allowMultipleInstances = process.env.PUPPETLOOM_ALLOW_MULTIPLE === "1" || (Number.isFinite(automatedExit) && automatedExit > 0);
const hasInstanceLock = allowMultipleInstances || app.requestSingleInstanceLock({ project: initialProject ?? "" });
runtimeLog("app-start", { argv: process.argv, initialProject, allowMultipleInstances, hasInstanceLock });

if (!hasInstanceLock) app.quit();

if (hasInstanceLock && !allowMultipleInstances) {
  app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
    const fromData = projectFromAdditionalData(additionalData);
    const project = fromData ?? queryProjectArgument(commandLine);
    void app.whenReady().then(async () => {
      if (project) {
        try {
          await createViewer(project);
        } catch (cause) {
          dialog.showErrorBox("无法启动角色", errorMessage(cause));
        }
        return;
      }
      const control = BrowserWindow.getAllWindows().find((window) => !viewerProjects.has(window.id));
      if (control) bringForward(control);
      else createControlWindow();
    });
  });
}

if (hasInstanceLock) app.whenReady().then(async () => {
  runtimeLog("app-ready");
  ipcMain.handle("dialog:psd", (event) => chooseFile(event, [{ name: "Photoshop document", extensions: ["psd"] }]));
  ipcMain.handle("dialog:reference", (event) => chooseFile(event, [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }]));
  ipcMain.handle("dialog:output", async (event) => {
    const owner = ownerWindow(event);
    const options = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("dialog:project", async (event) => {
    const owner = ownerWindow(event);
    const options = { properties: ["openDirectory"] as Array<"openDirectory"> };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("project:inspect", (_event, input: string) => inspectPsd(resolve(input)));
  ipcMain.handle("project:create", async (_event, request: DesktopCreateRequest) => {
    const result = await createProject({
      input: resolve(request.input),
      output: resolve(request.output),
      seed: request.seed ?? 42,
      ...(request.reference ? { reference: resolve(request.reference) } : {}),
      ...(request.name ? { name: request.name } : {})
    });
    return { outputDirectory: result.outputDirectory, report: result.report, verify: await verifyProject(result.outputDirectory) };
  });
  ipcMain.handle("project:read", (_event, directory: string) => loadProject(resolve(directory)));
  ipcMain.handle("project:asset", async (_event, directory: string, relative: string) => {
    const root = resolve(directory);
    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) throw new Error("纹理路径超出项目目录。" );
    const mime = extname(target).toLowerCase() === ".webp" ? "image/webp" : "image/png";
    return { mime, bytes: new Uint8Array(await readFile(target)) };
  });
  ipcMain.handle("viewer:launch", async (_event, directory: string) => {
    const window = await createViewer(resolve(directory));
    return { id: window.id, state: stateFor(window) };
  });
  ipcMain.handle("viewer:control", (_event, id: number, action: string) => {
    const window = BrowserWindow.fromId(id);
    return window ? controlViewer(window, action) : null;
  });
  ipcMain.handle("viewer:self-control", (event, action: string) => {
    const window = ownerWindow(event);
    return window ? controlViewer(window, action) : null;
  });
  ipcMain.handle("viewer:pointer-target", (event) => {
    const window = ownerWindow(event);
    if (!window || !stateFor(window).mouseTracking) return { x: 0, y: 0, strength: 0 };
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    return pointerTargetFromScreen(cursor, bounds, workArea, viewerLookOrigins.get(window.id));
  });

  globalShortcut.register("CommandOrControl+Shift+P", () => {
    for (const id of viewerStates.keys()) {
      const window = BrowserWindow.fromId(id);
      if (window && stateFor(window).clickThrough) controlViewer(window, "click-through");
    }
  });

  const project = initialProject;
  if (project) {
    try {
      await createViewer(project);
    } catch (cause) {
      dialog.showErrorBox("无法启动角色", errorMessage(cause));
      createControlWindow();
    }
  } else createControlWindow();
  if (Number.isFinite(automatedExit) && automatedExit >= 250) setTimeout(() => app.quit(), automatedExit);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
  });
});

app.on("before-quit", () => runtimeLog("app-before-quit"));
app.on("will-quit", () => {
  runtimeLog("app-will-quit");
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {
  runtimeLog("window-all-closed");
  app.quit();
});
