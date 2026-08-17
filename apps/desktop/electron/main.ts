import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, loadProjectRevision } from "@puppetloom/core";
import { pointerTargetFromScreen } from "@puppetloom/renderer";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen } from "electron";
import type { ViewerState, WindowShellAction, WindowShellState } from "./global.js";
import { CalibrationIpcService } from "./calibration-ipc.js";
import { ProjectIpcService } from "./project-ipc.js";

const electronDirectory = dirname(fileURLToPath(import.meta.url));
const preload = join(electronDirectory, "preload.cjs");
const rendererPage = resolve(electronDirectory, "../renderer/index.html");
const viewerStates = new Map<number, ViewerState>();
const viewerProjects = new Map<number, string>();
const viewerRevisions = new Map<number, number | undefined>();
const viewerLookOrigins = new Map<number, { x: number; y: number }>();
const viewerAspectRatios = new Map<number, number>();
let runtimeLogPath: string | undefined;
const editorWindows = new Map<number, string>();
const editorCloseReady = new Set<number>();
const RUNTIME_LOG_ROTATE_BYTES = 5 * 1024 ** 2;
const RUNTIME_LOG_MAX_TOTAL_BYTES = Number(process.env.PUPPETLOOM_RUNTIME_LOG_MAX_BYTES ?? 64 * 1024 ** 2);
const CONTROL_WINDOW_WIDTH = 1440;
const CONTROL_WINDOW_HEIGHT = 900;
const CONTROL_WINDOW_MIN_WIDTH = 1100;
const CONTROL_WINDOW_MIN_HEIGHT = 700;
const CONTROL_WINDOW_SHELL = { strategy: "integrated", frame: false } as const;

function runtimeLog(event: string, details: Record<string, unknown> = {}): void {
  if (!runtimeLogPath) return;
  try {
    mkdirSync(dirname(runtimeLogPath), { recursive: true });
    const policyPath = join(dirname(runtimeLogPath), "runtime-log-policy.json");
    if (!existsSync(policyPath)) writeFileSync(policyPath, `${JSON.stringify({
      version: 1,
      owner: "PuppetLoom desktop runtime",
      activeLog: runtimeLogPath,
      rotateBytes: RUNTIME_LOG_ROTATE_BYTES,
      maximumTotalBytes: RUNTIME_LOG_MAX_TOTAL_BYTES,
      cleanup: "report-only"
    }, null, 2)}\n`, "utf8");
    const runtimeLogs = readdirSync(dirname(runtimeLogPath))
      .filter((name) => /^runtime(?:-[\dT.Z-]+-\d+)?\.log$/.test(name))
      .map((name) => join(dirname(runtimeLogPath!), name));
    const totalBytes = runtimeLogs.reduce((sum, path) => sum + statSync(path).size, 0);
    if (totalBytes >= RUNTIME_LOG_MAX_TOTAL_BYTES) return;
    if (existsSync(runtimeLogPath) && statSync(runtimeLogPath).size >= RUNTIME_LOG_ROTATE_BYTES) {
      const archived = join(dirname(runtimeLogPath), `runtime-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}.log`);
      renameSync(runtimeLogPath, archived);
    }
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

function queryEditArgument(commandLine = process.argv): boolean {
  return commandLine.includes("--edit");
}

function queryCaptureArgument(commandLine = process.argv): boolean {
  return commandLine.includes("--capture");
}

function queryRevisionArgument(commandLine = process.argv): number | undefined {
  const index = commandLine.indexOf("--revision");
  if (index < 0) return undefined;
  const revision = Number(commandLine[index + 1]);
  if (!Number.isInteger(revision) || revision < 0) throw new Error("revision 必须是非负整数。" );
  return revision;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase();
}

function launchFromAdditionalData(value: unknown): { project?: string; edit: boolean; revision?: number } {
  if (!value || typeof value !== "object") return { edit: false };
  const data = value as Record<string, unknown>;
  const project = typeof data.project === "string" && data.project ? resolve(data.project) : undefined;
  const revision = typeof data.revision === "number" && Number.isInteger(data.revision) && data.revision >= 0 ? data.revision : undefined;
  return { ...(project ? { project } : {}), edit: data.edit === true, ...(revision !== undefined ? { revision } : {}) };
}

function ownerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

function windowShellState(window: BrowserWindow): WindowShellState {
  return {
    ...CONTROL_WINDOW_SHELL,
    maximized: window.isMaximized(),
    minimized: window.isMinimized(),
    fullScreen: window.isFullScreen(),
    focused: window.isFocused(),
    resizable: window.isResizable(),
    maximizable: window.isMaximizable(),
    minimizable: window.isMinimizable(),
    closable: window.isClosable(),
    outerBounds: window.getBounds(),
    contentBounds: window.getContentBounds()
  };
}

function publishWindowShellState(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send("window:shell-state", windowShellState(window));
}

function registerControlWindowShell(window: BrowserWindow): void {
  const publish = () => publishWindowShellState(window);
  window.webContents.on("did-finish-load", publish);
  window.on("maximize", publish);
  window.on("unmaximize", publish);
  window.on("minimize", publish);
  window.on("restore", publish);
  window.on("enter-full-screen", publish);
  window.on("leave-full-screen", publish);
  window.on("focus", publish);
  window.on("blur", publish);
  window.on("resize", publish);
  window.on("move", publish);
}

function stateFor(window: BrowserWindow): ViewerState {
  const existing = viewerStates.get(window.id);
  if (existing) return existing;
  // A newly opened character should perform on its own. Pointer tracking is
  // opt-in because a stationary pointer used to suppress almost all head
  // motion and made a healthy rig look frozen.
  const state = { paused: false, alwaysOnTop: true, clickThrough: false, mouseTracking: false, scale: 1 };
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
    const aspectRatio = viewerAspectRatios.get(window.id) ?? width / (size[1] ?? 720);
    let newWidth = Math.round(width * factor);
    let newHeight = Math.round(newWidth / aspectRatio);
    if (newWidth < 220) {
      newWidth = 220;
      newHeight = Math.round(newWidth / aspectRatio);
    }
    if (newHeight < 220) {
      newHeight = 220;
      newWidth = Math.round(newHeight * aspectRatio);
    }
    window.setSize(newWidth, newHeight, true);
    next = { ...current, scale: Math.max(0.35, Math.min(3, current.scale * factor)) };
  }
  if (action === "close") {
    window.close();
    return null;
  }
  return publishState(window, next);
}

async function createViewer(projectDirectory: string, revision?: number, capture = false): Promise<BrowserWindow> {
  const resolvedProject = resolve(projectDirectory);
  runtimeLog("viewer-create-request", { project: resolvedProject, revision: revision ?? "current", capture });
  for (const [id, directory] of viewerProjects) {
    const existing = BrowserWindow.fromId(id);
    if (existing && samePath(directory, resolvedProject) && viewerRevisions.get(id) === revision) {
      bringForward(existing);
      return existing;
    }
  }
  const project = revision === undefined ? await loadProject(resolvedProject) : await loadProjectRevision(resolvedProject, revision);
  runtimeLog("project-loaded", { project: resolvedProject, revision: revision ?? "current", name: project.name, layers: project.layers.length });
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
    skipTaskbar: capture,
    show: !capture,
    title: project.name,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
  });
  const aspectRatio = project.canvas.width / project.canvas.height;
  window.setAspectRatio(aspectRatio);
  stateFor(window);
  viewerProjects.set(window.id, resolvedProject);
  viewerRevisions.set(window.id, revision);
  viewerAspectRatios.set(window.id, aspectRatio);
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
    viewerRevisions.delete(window.id);
    viewerLookOrigins.delete(window.id);
    viewerAspectRatios.delete(window.id);
  });
  try {
    await window.loadFile(rendererPage, { query: {
      viewer: "1",
      project: resolvedProject,
      ...(revision !== undefined ? { revision: String(revision) } : {})
    } });
    runtimeLog("viewer-load-complete", { id: window.id });
  } catch (cause) {
    viewerStates.delete(window.id);
    viewerProjects.delete(window.id);
    viewerRevisions.delete(window.id);
    viewerLookOrigins.delete(window.id);
    viewerAspectRatios.delete(window.id);
    window.destroy();
    throw cause;
  }
  return window;
}

function createControlWindow(projectDirectory?: string, editor = false): BrowserWindow {
  const window = new BrowserWindow({
    width: CONTROL_WINDOW_WIDTH,
    height: CONTROL_WINDOW_HEIGHT,
    minWidth: CONTROL_WINDOW_MIN_WIDTH,
    minHeight: CONTROL_WINDOW_MIN_HEIGHT,
    frame: CONTROL_WINDOW_SHELL.frame,
    resizable: true,
    maximizable: true,
    minimizable: true,
    closable: true,
    autoHideMenuBar: true,
    backgroundColor: "#11131a",
    title: editor ? "PuppetLoom 编辑器" : "PuppetLoom",
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
  });
  const query = editor && projectDirectory ? { editor: "1", project: resolve(projectDirectory) } : undefined;
  registerControlWindowShell(window);
  if (editor && projectDirectory) editorWindows.set(window.id, resolve(projectDirectory));
  window.on("close", (event) => {
    if (!editorWindows.has(window.id) || editorCloseReady.has(window.id) || window.webContents.isDestroyed()) return;
    event.preventDefault();
    window.webContents.send("editor:prepare-close");
  });
  window.once("closed", () => {
    editorWindows.delete(window.id);
    editorCloseReady.delete(window.id);
  });
  void window.loadFile(rendererPage, query ? { query } : undefined);
  return window;
}

const initialProject = queryProjectArgument();
const initialEdit = queryEditArgument();
const initialRevision = queryRevisionArgument();
const initialCapture = queryCaptureArgument();
const automatedExit = Number(process.env.PUPPETLOOM_E2E_EXIT_AFTER_MS ?? 0);
const applicationProfile = process.env.PUPPETLOOM_E2E_USER_DATA
  ? resolve(process.env.PUPPETLOOM_E2E_USER_DATA)
  : process.env.PUPPETLOOM_ALLOW_MULTIPLE === "1" || Number.isFinite(automatedExit) && automatedExit > 0
    ? join("D:\\Tools", "PuppetLoom", "e2e", `electron-${process.pid}`)
    : join("D:\\Tools", "PuppetLoom", "user-data");
runtimeLogPath = initialProject ? join(initialProject, "reports", "runtime.log") : join(applicationProfile, "runtime.log");
app.setPath("userData", applicationProfile);
app.setPath("cache", join(applicationProfile, "cache"));
const allowMultipleInstances = process.env.PUPPETLOOM_ALLOW_MULTIPLE === "1" || (Number.isFinite(automatedExit) && automatedExit > 0);
const hasInstanceLock = allowMultipleInstances || app.requestSingleInstanceLock({ project: initialProject ?? "", edit: initialEdit, revision: initialRevision });
runtimeLog("app-start", { argv: process.argv, initialProject, initialEdit, initialRevision, initialCapture, allowMultipleInstances, hasInstanceLock });

if (!hasInstanceLock) app.quit();

if (hasInstanceLock && !allowMultipleInstances) {
  app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
    const fromData = launchFromAdditionalData(additionalData);
    const project = fromData.project ?? queryProjectArgument(commandLine);
    const edit = fromData.edit || queryEditArgument(commandLine);
    const revision = fromData.revision ?? queryRevisionArgument(commandLine);
    void app.whenReady().then(async () => {
      if (project) {
        try {
          if (edit) createControlWindow(project, true);
          else await createViewer(project, revision);
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
  const projectIpc = new ProjectIpcService(applicationProfile);
  projectIpc.register();
  const calibrationIpc = new CalibrationIpcService((directory) => projectIpc.rememberProject(directory));
  calibrationIpc.register();
  ipcMain.handle("window:editor-mode", (event, enabled: boolean, directory?: string) => {
    const window = ownerWindow(event);
    if (!window) return false;
    if (enabled) {
      if (!directory) throw new Error("进入编辑器时必须提供项目目录。" );
      editorWindows.set(window.id, resolve(directory));
      window.setMinimumSize(CONTROL_WINDOW_MIN_WIDTH, CONTROL_WINDOW_MIN_HEIGHT);
      const [width = CONTROL_WINDOW_MIN_WIDTH, height = CONTROL_WINDOW_MIN_HEIGHT] = window.getSize();
      if (width < 1320 || height < 820) window.setSize(Math.max(width, CONTROL_WINDOW_WIDTH), Math.max(height, CONTROL_WINDOW_HEIGHT), true);
      window.setTitle("PuppetLoom 编辑器");
    } else {
      editorWindows.delete(window.id);
      window.setMinimumSize(CONTROL_WINDOW_MIN_WIDTH, CONTROL_WINDOW_MIN_HEIGHT);
      window.setTitle("PuppetLoom");
    }
    publishWindowShellState(window);
    return true;
  });
  ipcMain.handle("window:shell-state", (event) => {
    const window = ownerWindow(event);
    if (!window || viewerProjects.has(window.id)) throw new Error("当前窗口不使用应用标题栏。" );
    return windowShellState(window);
  });
  ipcMain.handle("window:shell-action", (event, action: WindowShellAction) => {
    const window = ownerWindow(event);
    if (!window || viewerProjects.has(window.id)) throw new Error("当前窗口不使用应用标题栏。" );
    if (action === "minimize") window.minimize();
    else if (action === "toggle-maximize") {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    } else if (action === "close") {
      window.close();
      return null;
    } else throw new Error(`未知窗口操作：${String(action)}`);
    publishWindowShellState(window);
    return windowShellState(window);
  });
  ipcMain.handle("editor:confirm-close", async (event) => {
    const window = ownerWindow(event);
    if (!window) return false;
    const directory = editorWindows.get(window.id);
    if (directory) await calibrationIpc.waitForDraft(directory);
    editorCloseReady.add(window.id);
    window.close();
    return true;
  });
  ipcMain.handle("viewer:launch", async (_event, directory: string) => {
    const projectDirectory = resolve(directory);
    await projectIpc.rememberProject(projectDirectory);
    const window = await createViewer(projectDirectory);
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
      if (initialEdit) createControlWindow(project, true);
      else await createViewer(project, initialRevision, initialCapture);
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
