import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isModelBehaviorAvailable, isModelExpressionAvailable, parseRuntimeControlRequest, parseRuntimeControlServiceRequest, parseRuntimeInputSession } from "@puppetloom/core/browser";
import type { PuppetLoomProject, RuntimeControlSetRequest, RuntimeInputSession, RuntimeViewerDescriptor } from "@puppetloom/core";
import { editPerformanceTake, exportPortableProject, exportWebRuntime, importPerformanceTake, inspectWindowsEnvironment, listPerformanceTakes, prepareCubismExport, readPerformanceTake } from "@puppetloom/core";
import { pointerTargetFromScreen } from "@puppetloom/renderer";
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, protocol, screen, session, shell } from "electron";
import type { ViewerLaunchOptions, ViewerState, WindowShellAction, WindowShellState } from "./global.js";
import { CalibrationIpcService } from "./calibration-ipc.js";
import { ProjectIpcService } from "./project-ipc.js";
import { PerformanceRecordingService } from "./performance-recording-service.js";
import { RuntimeControlService } from "./runtime-control-service.js";
import { RuntimeLogWriter } from "./runtime-log-writer.js";
import { SpoutOutputService, type SpoutOutputOptions } from "./spout-output-service.js";
import { runProjectWorker } from "./project-worker-client.js";
import { visibleWindowBounds, WindowPreferencesStore, type StoredWindowBounds, type ViewerWindowPreference } from "./window-preferences.js";
import { checkWindowsUpdate, downloadWindowsUpdate, installWindowsUpdate } from "./windows-updater.js";

const electronDirectory = dirname(fileURLToPath(import.meta.url));
const preload = join(electronDirectory, "preload.cjs");
const rendererPage = resolve(electronDirectory, "../renderer/index.html");
const viewerStates = new Map<number, ViewerState>();
const viewerProjects = new Map<number, string>();
const viewerRevisions = new Map<number, number | undefined>();
const viewerProjectSnapshots = new Map<number, PuppetLoomProject>();
const viewerSourceLabels = new Map<number, string>();
const viewerLookOrigins = new Map<number, { x: number; y: number }>();
const viewerAspectRatios = new Map<number, number>();
const viewerWindowDrags = new Map<number, { cursor: { x: number; y: number }; bounds: StoredWindowBounds }>();
const spoutMirrorSources = new Map<number, number>();
let runtimeLogPath: string | undefined;
let runtimeLogWriter: RuntimeLogWriter | undefined;
let runtimeControlService: RuntimeControlService | undefined;
let spoutOutputService: SpoutOutputService | undefined;
let windowPreferences: WindowPreferencesStore;
const performanceRecordingService = new PerformanceRecordingService();
const editorWindows = new Map<number, string>();
const editorCloseReady = new Set<number>();
const RUNTIME_LOG_ROTATE_BYTES = 5 * 1024 ** 2;
const RUNTIME_LOG_MAX_TOTAL_BYTES = Number(process.env.PUPPETLOOM_RUNTIME_LOG_MAX_BYTES ?? 64 * 1024 ** 2);
const CONTROL_WINDOW_WIDTH = 1440;
const CONTROL_WINDOW_HEIGHT = 900;
const CONTROL_WINDOW_MIN_WIDTH = 900;
const CONTROL_WINDOW_MIN_HEIGHT = 640;
const runtimeHotkeys: Record<string, boolean> = {};
const CONTROL_WINDOW_SHELL = { strategy: "integrated", frame: false } as const;
const MEDIAPIPE_WASM_FILES = new Set([
  "vision_wasm_internal.js", "vision_wasm_internal.wasm",
  "vision_wasm_module_internal.js", "vision_wasm_module_internal.wasm",
  "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"
]);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "puppetloom-runtime",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  },
  {
    scheme: "puppetloom-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);

function runtimeAssetLocations(): { wasmBaseUrl: string; faceLandmarkerModelUrl: string; poseLandmarkerModelUrl: string; handLandmarkerModelUrl: string } {
  return {
    wasmBaseUrl: "puppetloom-runtime://mediapipe/wasm",
    faceLandmarkerModelUrl: "puppetloom-runtime://mediapipe/face_landmarker.task",
    poseLandmarkerModelUrl: "puppetloom-runtime://mediapipe/pose_landmarker_lite.task",
    handLandmarkerModelUrl: "puppetloom-runtime://mediapipe/hand_landmarker.task"
  };
}

function registerRuntimeAssetProtocol(): void {
  const bundledDirectory = resolve(electronDirectory, "../runtime-assets/mediapipe");
  const wasmDirectory = app.isPackaged ? join(bundledDirectory, "wasm") : resolve(electronDirectory, "../../../../node_modules/@mediapipe/tasks-vision/wasm");
  const modelDirectory = process.env.PUPPETLOOM_RUNTIME_ASSET_DIRECTORY ?? (app.isPackaged ? bundledDirectory : join("D:\\Tools", "PuppetLoom", "runtime-assets", "mediapipe"));
  protocol.handle("puppetloom-runtime", (request) => {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const requested = parts.at(-1) ?? "";
    let path: string | undefined;
    if (parts[0] === "wasm" && MEDIAPIPE_WASM_FILES.has(requested)) path = join(wasmDirectory, requested);
    if (parts.length === 1 && ["face_landmarker.task", "pose_landmarker_lite.task", "hand_landmarker.task"].includes(requested)) path = join(modelDirectory, requested);
    if (!path || !existsSync(path)) return new Response("Runtime asset not found", { status: 404 });
    const contentType = requested.endsWith(".wasm") ? "application/wasm" : requested.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
    return new Response(readFileSync(path), { status: 200, headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" } });
  });
}

function runtimeLog(event: string, details: Record<string, unknown> = {}): void {
  runtimeLogWriter?.log(event, details);
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

function recordingChunkBytes(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return new Uint8Array(value as ArrayBuffer);
  }
  return undefined;
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase();
}

function saveInputSession(projectDirectory: string, sessionDocument: RuntimeInputSession): string {
  const directory = join(projectDirectory, "reports", "input-sessions");
  mkdirSync(directory, { recursive: true });
  const stamp = sessionDocument.recordedAt.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  let path = join(directory, `${stamp}-${sessionDocument.id.slice(0, 8)}.runtime-input.json`);
  if (existsSync(path)) path = join(directory, `${stamp}-${sessionDocument.id}.runtime-input.json`);
  writeFileSync(path, `${JSON.stringify(sessionDocument, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

function launchFromAdditionalData(value: unknown): { project?: string; edit: boolean; revision?: number } {
  if (!value || typeof value !== "object") return { edit: false };
  const data = value as Record<string, unknown>;
  const project = typeof data.project === "string" && data.project ? resolve(data.project) : undefined;
  const revision = typeof data.revision === "number" && Number.isInteger(data.revision) && data.revision >= 0 ? data.revision : undefined;
  return { ...(project ? { project } : {}), edit: data.edit === true, ...(revision !== undefined ? { revision } : {}) };
}

function ownerWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | undefined {
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

function displayWorkAreas(): StoredWindowBounds[] {
  return screen.getAllDisplays().map((display) => display.workArea);
}

function fitWindowInsideDisplay(window: BrowserWindow, minimumSize: { width: number; height: number }): StoredWindowBounds {
  const current = window.getBounds();
  const fitted = visibleWindowBounds(current, displayWorkAreas(), current, minimumSize);
  if (current.x !== fitted.x || current.y !== fitted.y || current.width !== fitted.width || current.height !== fitted.height) {
    const content = window.getContentBounds();
    window.setContentBounds({
      x: fitted.x + content.x - current.x,
      y: fitted.y + content.y - current.y,
      width: Math.max(1, fitted.width - (current.width - content.width)),
      height: Math.max(1, fitted.height - (current.height - content.height))
    }, false);
  }
  return window.getBounds();
}

function persistControlWindow(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
  windowPreferences.updateControl({
    bounds: window.isMaximized() ? window.getNormalBounds() : window.getBounds(),
    maximized: window.isMaximized()
  });
}

function registerControlWindowShell(window: BrowserWindow): void {
  const publish = () => publishWindowShellState(window);
  let persistenceTimer: NodeJS.Timeout | undefined;
  const schedulePersistence = () => {
    if (persistenceTimer) clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(() => {
      persistenceTimer = undefined;
      persistControlWindow(window);
    }, 350);
  };
  window.webContents.on("did-finish-load", publish);
  window.on("maximize", () => { publish(); persistControlWindow(window); });
  window.on("unmaximize", () => { publish(); schedulePersistence(); });
  window.on("minimize", publish);
  window.on("restore", publish);
  window.on("enter-full-screen", publish);
  window.on("leave-full-screen", publish);
  window.on("focus", publish);
  window.on("blur", publish);
  window.on("resize", () => { publish(); schedulePersistence(); });
  window.on("move", () => { publish(); schedulePersistence(); });
  window.on("close", () => {
    if (persistenceTimer) clearTimeout(persistenceTimer);
    persistControlWindow(window);
  });
}

function stateFor(window: BrowserWindow): ViewerState {
  const existing = viewerStates.get(window.id);
  if (existing) return existing;
  const projectDirectory = viewerProjects.get(window.id);
  const preference = projectDirectory ? windowPreferences.viewer(projectDirectory) : {};
  const state = {
    paused: false,
    alwaysOnTop: preference.alwaysOnTop ?? window.isAlwaysOnTop(),
    clickThrough: false,
    mouseTracking: preference.mouseTracking ?? true,
    scale: preference.scale ?? 1
  };
  viewerStates.set(window.id, state);
  return state;
}

function publishState(window: BrowserWindow, next: ViewerState): ViewerState {
  const previous = viewerStates.get(window.id);
  viewerStates.set(window.id, next);
  const projectDirectory = viewerProjects.get(window.id);
  if (projectDirectory && (!previous
    || previous.alwaysOnTop !== next.alwaysOnTop
    || previous.mouseTracking !== next.mouseTracking
    || previous.scale !== next.scale)) {
    windowPreferences.updateViewer(projectDirectory, {
      alwaysOnTop: next.alwaysOnTop,
      mouseTracking: next.mouseTracking,
      scale: next.scale
    });
  }
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
    if (!current.clickThrough && runtimeHotkeys["CommandOrControl+Shift+P"] === false) {
      runtimeLog("viewer-click-through-refused", { id: window.id, reason: "recovery-hotkey-unavailable" });
      return current;
    }
    window.setIgnoreMouseEvents(!current.clickThrough, { forward: true });
    next = { ...current, clickThrough: !current.clickThrough };
  }
  if (action === "pointer-tracking") {
    next = { ...current, mouseTracking: !current.mouseTracking };
  }
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

function runtimeDescriptor(windowId: number, projectDirectory: string, project: PuppetLoomProject, revision?: number): RuntimeViewerDescriptor {
  return {
    id: windowId,
    projectDirectory,
    projectName: project.name,
    ...(revision === undefined ? {} : { revision }),
    parameters: project.model.parameters.map(({ id, name, min, default: defaultValue, max, semantic }) => ({ id, name, min, default: defaultValue, max, ...(semantic ? { semantic } : {}) })),
    expressions: project.model.expressions.filter((expression) => isModelExpressionAvailable(project, expression)).map(({ id, name }) => ({ id, name })),
    behaviors: project.model.behaviors.filter((behavior) => isModelBehaviorAvailable(project, behavior)).map(({ id, name, duration, loop }) => ({ id, name, duration, loop })),
    ...(project.production ? { production: structuredClone(project.production) } : {})
  };
}

function rememberViewerProject(window: BrowserWindow, projectDirectory: string, project: PuppetLoomProject, revision: number | undefined, sourceLabel: string): void {
  const aspectRatio = project.canvas.width / project.canvas.height;
  viewerProjects.set(window.id, projectDirectory);
  viewerRevisions.set(window.id, revision);
  viewerProjectSnapshots.set(window.id, structuredClone(project));
  viewerSourceLabels.set(window.id, sourceLabel);
  viewerAspectRatios.set(window.id, aspectRatio);
  viewerLookOrigins.set(window.id, project.anchors.nose ?? {
    x: 0.5,
    y: ((project.anchors.headTop?.y ?? 0.04) + (project.anchors.chin?.y ?? 0.36)) * 0.5
  });
  window.setAspectRatio(aspectRatio);
  window.setTitle(project.name);
  runtimeControlService?.registerViewer(runtimeDescriptor(window.id, projectDirectory, project, revision));
}

function registerViewerWindowPersistence(window: BrowserWindow, projectDirectory: string, capture: boolean): void {
  if (capture) return;
  let persistenceTimer: NodeJS.Timeout | undefined;
  const persist = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    windowPreferences.updateViewer(projectDirectory, { bounds: window.getBounds() });
  };
  const schedule = () => {
    if (persistenceTimer) clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(() => {
      persistenceTimer = undefined;
      persist();
    }, 350);
  };
  window.on("move", schedule);
  window.on("resize", schedule);
  window.on("close", () => {
    if (persistenceTimer) clearTimeout(persistenceTimer);
    persist();
  });
}

async function createViewer(projectDirectory: string, revision?: number, capture = false, projectOverride?: PuppetLoomProject, sourceLabel?: string): Promise<BrowserWindow> {
  const resolvedProject = resolve(projectDirectory);
  runtimeLog("viewer-create-request", { project: resolvedProject, revision: revision ?? "current", capture });
  const project = projectOverride ?? await runProjectWorker<PuppetLoomProject>({
    operation: "load-project",
    directory: resolvedProject,
    ...(revision === undefined ? {} : { revision })
  });
  const resolvedSourceLabel = sourceLabel ?? (revision === undefined ? "已保存项目" : `历史 revision ${revision}`);
  for (const [id, directory] of viewerProjects) {
    const existing = BrowserWindow.fromId(id);
    if (existing && samePath(directory, resolvedProject) && viewerRevisions.get(id) === revision) {
      rememberViewerProject(existing, resolvedProject, project, revision, resolvedSourceLabel);
      if (!existing.webContents.isDestroyed()) existing.webContents.send("viewer:project-changed", { project, sourceLabel: resolvedSourceLabel });
      runtimeLog("viewer-project-refreshed", { id, project: resolvedProject, revision: revision ?? "current", sourceLabel: resolvedSourceLabel });
      bringForward(existing);
      return existing;
    }
  }
  runtimeLog("project-loaded", { project: resolvedProject, revision: revision ?? "current", name: project.name, layers: project.layers.length });
  const defaultHeight = 720;
  const defaultWidth = Math.max(300, Math.round(defaultHeight * project.canvas.width / project.canvas.height));
  const aspectRatio = project.canvas.width / project.canvas.height;
  const preference: ViewerWindowPreference = capture ? {} : windowPreferences.viewer(resolvedProject);
  const bounds = visibleWindowBounds(preference.bounds, displayWorkAreas(), { width: defaultWidth, height: defaultHeight }, { width: 220, height: 220 }, aspectRatio);
  const alwaysOnTop = preference.alwaysOnTop ?? true;
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 220,
    minHeight: 220,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: true,
    alwaysOnTop,
    skipTaskbar: capture,
    show: !capture,
    title: project.name,
    // A click-through desktop puppet normally runs without focus. Chromium's
    // default background throttling would otherwise turn a healthy 60 FPS
    // render loop into intermittent 30/15 FPS motion when another app is used.
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  rememberViewerProject(window, resolvedProject, project, revision, resolvedSourceLabel);
  viewerStates.set(window.id, {
    paused: false,
    alwaysOnTop,
    clickThrough: false,
    mouseTracking: preference.mouseTracking ?? true,
    scale: preference.scale ?? 1
  });
  registerViewerWindowPersistence(window, resolvedProject, capture);
  runtimeLog("viewer-window-created", { id: window.id, ...bounds, restored: Boolean(preference.bounds) });
  window.once("ready-to-show", () => runtimeLog("viewer-ready-to-show", { id: window.id }));
  window.webContents.on("did-finish-load", () => {
    // Windows can revise a transparent frameless window while Chromium creates
    // its native surface. Reapply the validated project bounds after loading so
    // the final visible window, rather than only the constructor request, is
    // what the user previously chose.
    if (preference.bounds) window.setBounds(bounds, false);
    runtimeLog("viewer-page-loaded", { id: window.id, ...window.getBounds(), restored: Boolean(preference.bounds) });
    publishState(window, stateFor(window));
  });
  window.webContents.on("render-process-gone", (_event, details) => runtimeLog("renderer-gone", { id: window.id, reason: details.reason, exitCode: details.exitCode }));
  window.on("unresponsive", () => runtimeLog("viewer-unresponsive", { id: window.id }));
  window.once("closed", () => {
    runtimeLog("viewer-closed", { id: window.id });
    performanceRecordingService.interruptViewer(window.id, "角色窗口在录制结束前关闭。" );
    viewerStates.delete(window.id);
    viewerProjects.delete(window.id);
    viewerRevisions.delete(window.id);
    viewerProjectSnapshots.delete(window.id);
    viewerSourceLabels.delete(window.id);
    viewerLookOrigins.delete(window.id);
    viewerAspectRatios.delete(window.id);
    viewerWindowDrags.delete(window.id);
    runtimeControlService?.unregisterViewer(window.id);
    void spoutOutputService?.stop(window.id);
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
    viewerProjectSnapshots.delete(window.id);
    viewerSourceLabels.delete(window.id);
    viewerLookOrigins.delete(window.id);
    viewerAspectRatios.delete(window.id);
    runtimeControlService?.unregisterViewer(window.id);
    window.destroy();
    throw cause;
  }
  return window;
}

function createControlWindow(projectDirectory?: string, editor = false): BrowserWindow {
  const preference = windowPreferences.control();
  const bounds = visibleWindowBounds(
    preference.bounds,
    displayWorkAreas(),
    { width: CONTROL_WINDOW_WIDTH, height: CONTROL_WINDOW_HEIGHT },
    { width: CONTROL_WINDOW_MIN_WIDTH, height: CONTROL_WINDOW_MIN_HEIGHT }
  );
  const window = new BrowserWindow({
    ...bounds,
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
  const actualBounds = fitWindowInsideDisplay(window, { width: CONTROL_WINDOW_MIN_WIDTH, height: CONTROL_WINDOW_MIN_HEIGHT });
  runtimeLog("control-window-created", { id: window.id, requestedBounds: bounds, ...actualBounds, restored: Boolean(preference.bounds), maximized: Boolean(preference.maximized) });
  const query = editor && projectDirectory ? { editor: "1", project: resolve(projectDirectory) } : undefined;
  registerControlWindowShell(window);
  if (preference.maximized) window.maximize();
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
  window.webContents.on("did-finish-load", () => {
    fitWindowInsideDisplay(window, { width: CONTROL_WINDOW_MIN_WIDTH, height: CONTROL_WINDOW_MIN_HEIGHT });
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
runtimeLogWriter = new RuntimeLogWriter({
  path: runtimeLogPath,
  rotateBytes: RUNTIME_LOG_ROTATE_BYTES,
  maximumTotalBytes: RUNTIME_LOG_MAX_TOTAL_BYTES
});
windowPreferences = new WindowPreferencesStore(join(applicationProfile, "viewer-preferences.json"), (cause) => {
  runtimeLog("window-preference-write-failed", { error: errorMessage(cause) });
});
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
  registerRuntimeAssetProtocol();
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === "media" && Boolean(webContents?.getURL().startsWith("file:")));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(permission === "media" && webContents.getURL().startsWith("file:")));
  runtimeControlService = new RuntimeControlService({
    profileDirectory: applicationProfile,
    port: allowMultipleInstances ? 0 : Number(process.env.PUPPETLOOM_CONTROL_PORT ?? 31_987),
    log: runtimeLog,
    onChange: (viewerId, snapshot) => {
      const viewer = BrowserWindow.fromId(viewerId);
      if (viewer && !viewer.isDestroyed() && !viewer.webContents.isDestroyed()) viewer.webContents.send("viewer:runtime-control-changed", snapshot);
      for (const [mirrorId, sourceId] of spoutMirrorSources) {
        if (sourceId !== viewerId) continue;
        const mirror = BrowserWindow.fromId(mirrorId);
        if (mirror && !mirror.isDestroyed() && !mirror.webContents.isDestroyed()) mirror.webContents.send("viewer:runtime-control-changed", { ...snapshot, viewerId: mirrorId });
      }
    },
    onReplayState: (viewerId, state) => {
      const viewer = BrowserWindow.fromId(viewerId);
      if (viewer && !viewer.isDestroyed() && !viewer.webContents.isDestroyed()) viewer.webContents.send("viewer:input-replay-state", state);
    }
  });
  await runtimeControlService.start();
  spoutOutputService = new SpoutOutputService({
    rendererPage,
    preload,
    log: runtimeLog,
    onMirrorCreated: (mirror, sourceViewerId) => {
      const projectDirectory = viewerProjects.get(sourceViewerId);
      const project = viewerProjectSnapshots.get(sourceViewerId);
      if (!projectDirectory || !project) throw new Error("Spout2 来源窗口没有可用项目。");
      viewerProjects.set(mirror.id, projectDirectory);
      viewerRevisions.set(mirror.id, viewerRevisions.get(sourceViewerId));
      viewerProjectSnapshots.set(mirror.id, structuredClone(project));
      viewerSourceLabels.set(mirror.id, "Spout2 共享纹理输出");
      viewerAspectRatios.set(mirror.id, project.canvas.width / project.canvas.height);
      viewerStates.set(mirror.id, { paused: false, alwaysOnTop: false, clickThrough: false, mouseTracking: false, scale: 1 });
      spoutMirrorSources.set(mirror.id, sourceViewerId);
    },
    onMirrorClosed: (mirrorId) => {
      spoutMirrorSources.delete(mirrorId);
      viewerStates.delete(mirrorId);
      viewerProjects.delete(mirrorId);
      viewerRevisions.delete(mirrorId);
      viewerProjectSnapshots.delete(mirrorId);
      viewerSourceLabels.delete(mirrorId);
      viewerLookOrigins.delete(mirrorId);
      viewerAspectRatios.delete(mirrorId);
    }
  });
  const projectIpc = new ProjectIpcService(applicationProfile);
  projectIpc.register();
  const calibrationIpc = new CalibrationIpcService((directory, project) => projectIpc.rememberProject(directory, project));
  calibrationIpc.register();
  ipcMain.handle("window:editor-mode", (event, enabled: boolean, directory?: string) => {
    const window = ownerWindow(event);
    if (!window) return false;
    if (enabled) {
      if (!directory) throw new Error("进入编辑器时必须提供项目目录。" );
      editorWindows.set(window.id, resolve(directory));
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
      window.setMinimumSize(CONTROL_WINDOW_MIN_WIDTH, CONTROL_WINDOW_MIN_HEIGHT);
      const workArea = screen.getDisplayMatching(window.getBounds()).workAreaSize;
      const [width = CONTROL_WINDOW_MIN_WIDTH, height = CONTROL_WINDOW_MIN_HEIGHT] = window.getSize();
      const targetWidth = Math.min(workArea.width, Math.max(width, Math.min(CONTROL_WINDOW_WIDTH, workArea.width)));
      const targetHeight = Math.min(workArea.height, Math.max(height, Math.min(CONTROL_WINDOW_HEIGHT, workArea.height)));
      if (width !== targetWidth || height !== targetHeight) window.setSize(targetWidth, targetHeight, true);
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
  ipcMain.handle("viewer:launch", async (_event, directory: string, options?: ViewerLaunchOptions) => {
    const projectDirectory = resolve(directory);
    const project = options?.project ?? await runProjectWorker<PuppetLoomProject>({ operation: "load-project", directory: projectDirectory });
    await projectIpc.rememberProject(projectDirectory, project);
    const window = await createViewer(projectDirectory, undefined, false, project, options?.sourceLabel);
    return { id: window.id, state: stateFor(window) };
  });
  ipcMain.handle("viewer:project", (event) => {
    const window = ownerWindow(event);
    const project = window ? viewerProjectSnapshots.get(window.id) : undefined;
    if (!window || !project) throw new Error("当前窗口没有可显示的角色项目。");
    return { project, sourceLabel: viewerSourceLabels.get(window.id) ?? "已保存项目" };
  });
  ipcMain.handle("viewer:capabilities", () => ({ hotkeys: { ...runtimeHotkeys } }));
  ipcMain.handle("system:reveal-path", (_event, path: string) => {
    if (!path) return false;
    shell.showItemInFolder(resolve(path));
    return true;
  });
  ipcMain.handle("system:copy-text", (_event, value: string) => {
    clipboard.writeText(value);
    return true;
  });
  ipcMain.handle("system:environment-doctor", () => inspectWindowsEnvironment(resolve(electronDirectory, "../../../.."), app.isPackaged ? { packaged: true, resourcesPath: process.resourcesPath } : {}));
  ipcMain.handle("system:update-check", () => checkWindowsUpdate());
  ipcMain.handle("system:update-download", () => downloadWindowsUpdate());
  ipcMain.handle("system:update-install", (_event, installer: string) => { installWindowsUpdate(installer); return true; });
  ipcMain.handle("system:export-project", async (event, projectDirectory: string, format: "portable" | "web" | "cubism") => {
    const window = ownerWindow(event);
    const project = viewerProjectSnapshots.get(window?.id ?? -1)
      ?? await runProjectWorker<PuppetLoomProject>({ operation: "load-project", directory: resolve(projectDirectory) });
    const selection = window ? await dialog.showOpenDialog(window, { title: "选择导出位置", properties: ["openDirectory", "createDirectory"] }) : await dialog.showOpenDialog({ title: "选择导出位置", properties: ["openDirectory", "createDirectory"] });
    const parent = selection.filePaths[0]; if (selection.canceled || !parent) return undefined;
    const name = project.name.replace(/[<>:"/\\|?*]+/g, "-"); const output = join(parent, `${name}-${format}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    if (format === "portable") return exportPortableProject({ project: resolve(projectDirectory), output });
    if (format === "cubism") return prepareCubismExport(resolve(projectDirectory), output);
    const sdkBundle = app.isPackaged ? resolve(electronDirectory, "../runtime-assets/web/puppetloom-web.js") : resolve(electronDirectory, "../../../../packages/web-runtime/dist/puppetloom-web.js");
    return exportWebRuntime({ project: resolve(projectDirectory), output, sdkBundle });
  });
  ipcMain.handle("viewer:control", (_event, id: number, action: string) => {
    const window = BrowserWindow.fromId(id);
    return window ? controlViewer(window, action) : null;
  });
  ipcMain.handle("viewer:self-control", (event, action: string) => {
    const window = ownerWindow(event);
    return window ? controlViewer(window, action) : null;
  });
  ipcMain.on("viewer:drag", (event, action: "start" | "move" | "end", point?: { x?: unknown; y?: unknown }) => {
    const window = ownerWindow(event);
    if (!window || !viewerProjects.has(window.id)) return;
    if (action === "end") {
      viewerWindowDrags.delete(window.id);
      return;
    }
    const cursor = typeof point?.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)
      ? { x: point.x, y: point.y }
      : screen.getCursorScreenPoint();
    if (action === "start") {
      viewerWindowDrags.set(window.id, { cursor, bounds: window.getBounds() });
      return;
    }
    if (action !== "move") return;
    const drag = viewerWindowDrags.get(window.id);
    if (!drag) return;
    const x = Math.round(drag.bounds.x + cursor.x - drag.cursor.x);
    const y = Math.round(drag.bounds.y + cursor.y - drag.cursor.y);
    const current = window.getBounds();
    if (x !== current.x || y !== current.y) window.setPosition(x, y, false);
  });
  ipcMain.handle("viewer:pointer-target", (event) => {
    const window = ownerWindow(event);
    if (window && spoutMirrorSources.has(window.id)) return { x: 0, y: 0, strength: 0 };
    if (!window || !stateFor(window).mouseTracking) return { x: 0, y: 0, strength: 0 };
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    return pointerTargetFromScreen(cursor, bounds, workArea, viewerLookOrigins.get(window.id));
  });
  ipcMain.handle("viewer:runtime-control", (event) => {
    const window = ownerWindow(event);
    if (!window || !viewerProjects.has(window.id) || !runtimeControlService) throw new Error("当前窗口没有运行时控制状态。" );
    const sourceViewerId = spoutMirrorSources.get(window.id) ?? window.id;
    const snapshot = runtimeControlService.snapshot(sourceViewerId);
    return sourceViewerId === window.id ? snapshot : { ...snapshot, viewerId: window.id };
  });
  ipcMain.handle("viewer:runtime-descriptor", (event) => {
    const window = ownerWindow(event);
    if (!window || !runtimeControlService) throw new Error("当前窗口没有运行时能力描述。" );
    const sourceViewerId = spoutMirrorSources.get(window.id) ?? window.id;
    const descriptor = runtimeControlService.store.inspect().find((viewer) => viewer.id === sourceViewerId);
    return descriptor && sourceViewerId !== window.id ? { ...descriptor, id: window.id } : descriptor;
  });
  ipcMain.handle("runtime:assets", () => runtimeAssetLocations());
  ipcMain.handle("viewer:runtime-set", (event, source: RuntimeControlSetRequest["source"]) => {
    const window = ownerWindow(event);
    if (!window || !viewerProjects.has(window.id) || !runtimeControlService) throw new Error("当前窗口不能接收运行时输入。" );
    return runtimeControlService.applyLocal(parseRuntimeControlRequest({ version: 1, requestId: randomUUID(), op: "set", viewerId: spoutMirrorSources.get(window.id) ?? window.id, source }));
  });
  ipcMain.handle("viewer:runtime-release", (event, sourceId: string) => {
    const window = ownerWindow(event);
    if (!window || !viewerProjects.has(window.id) || !runtimeControlService) return false;
    return runtimeControlService.applyLocal(parseRuntimeControlRequest({ version: 1, requestId: randomUUID(), op: "release", viewerId: spoutMirrorSources.get(window.id) ?? window.id, sourceId }));
  });
  ipcMain.handle("viewer:runtime-trigger", (event, target: { behaviorId?: string; expressionId?: string; durationMs?: number }) => {
    const window = ownerWindow(event);
    if (!window || !viewerProjects.has(window.id) || !runtimeControlService) throw new Error("当前窗口不能触发表情或动作。" );
    return runtimeControlService.applyLocal(parseRuntimeControlRequest({
      version: 1, requestId: randomUUID(), op: "trigger", viewerId: spoutMirrorSources.get(window.id) ?? window.id, sourceId: "viewer-action-panel",
      ...(target.behaviorId ? { behaviorId: target.behaviorId } : {}),
      ...(target.expressionId ? { expressionId: target.expressionId } : {}),
      ...(target.durationMs === undefined ? {} : { durationMs: target.durationMs }),
      priority: 80
    }));
  });
  ipcMain.handle("viewer:spout-output", async (event, action: "status" | "start" | "stop", options?: SpoutOutputOptions) => {
    const window = ownerWindow(event);
    if (!window || spoutMirrorSources.has(window.id) || !spoutOutputService) throw new Error("当前窗口不能管理 Spout2 输出。" );
    if (action === "status") return spoutOutputService.status(window.id);
    if (action === "stop") return spoutOutputService.stop(window.id);
    if (action !== "start") throw new Error(`未知 Spout2 操作：${String(action)}`);
    const projectDirectory = viewerProjects.get(window.id);
    const project = viewerProjectSnapshots.get(window.id);
    if (!projectDirectory || !project) throw new Error("当前窗口没有角色项目。" );
    const revision = viewerRevisions.get(window.id);
    return spoutOutputService.start({ sourceViewerId: window.id, projectDirectory, projectName: project.name, ...(revision === undefined ? {} : { revision }), ...(options ? { options } : {}) });
  });
  ipcMain.handle("viewer:input-recording", (event, action: "start" | "stop") => {
    const window = ownerWindow(event);
    if (!window || !runtimeControlService) throw new Error("当前窗口不能录制运行时输入。" );
    const projectDirectory = viewerProjects.get(window.id);
    if (!projectDirectory) throw new Error("当前窗口没有角色项目。" );
    if (action === "start") return runtimeControlService.applyLocal(parseRuntimeControlServiceRequest({ version: 1, requestId: randomUUID(), op: "record-start", viewerId: window.id }));
    if (action !== "stop") throw new Error(`未知输入录制操作：${String(action)}`);
    const result = runtimeControlService.applyLocal(parseRuntimeControlServiceRequest({ version: 1, requestId: randomUUID(), op: "record-stop", viewerId: window.id })) as { session: RuntimeInputSession };
    const output = saveInputSession(projectDirectory, result.session);
    return { recording: false, output, durationMs: result.session.durationMs, events: result.session.events.length };
  });
  ipcMain.handle("viewer:input-replay", async (event, action: "start" | "stop") => {
    const window = ownerWindow(event);
    if (!window || !runtimeControlService) throw new Error("当前窗口不能回放运行时输入。" );
    const projectDirectory = viewerProjects.get(window.id);
    if (!projectDirectory) throw new Error("当前窗口没有角色项目。" );
    if (action === "stop") return runtimeControlService.applyLocal(parseRuntimeControlServiceRequest({ version: 1, requestId: randomUUID(), op: "replay-stop", viewerId: window.id }));
    if (action !== "start") throw new Error(`未知输入回放操作：${String(action)}`);
    const selection = await dialog.showOpenDialog(window, {
      title: "选择 PuppetLoom 动作数据",
      defaultPath: join(projectDirectory, "reports", "input-sessions"),
      properties: ["openFile"],
      filters: [{ name: "PuppetLoom 动作数据", extensions: ["json"] }]
    });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return { replaying: false, canceled: true };
    const sessionDocument = parseRuntimeInputSession(JSON.parse(readFileSync(path, "utf8")) as unknown);
    const result = runtimeControlService.applyLocal(parseRuntimeControlServiceRequest({
      version: 1, requestId: randomUUID(), op: "replay-start", viewerId: window.id, session: sessionDocument, speed: 1, loop: false
    }));
    return { ...(result as Record<string, unknown>), input: path };
  });
  ipcMain.handle("viewer:take-list", (event) => {
    const window = ownerWindow(event); const projectDirectory = window ? viewerProjects.get(window.id) : undefined;
    if (!projectDirectory) throw new Error("当前窗口没有角色项目。"); return listPerformanceTakes(projectDirectory);
  });
  ipcMain.handle("viewer:take-import", async (event, options?: { name?: string; tags?: string[]; note?: string }) => {
    const window = ownerWindow(event); const projectDirectory = window ? viewerProjects.get(window.id) : undefined;
    if (!window || !projectDirectory) throw new Error("当前窗口没有角色项目。");
    const selection = await dialog.showOpenDialog(window, { title: "导入动作会话为 Take", defaultPath: join(projectDirectory, "reports", "input-sessions"), properties: ["openFile"], filters: [{ name: "PuppetLoom 动作数据", extensions: ["json"] }] });
    const path = selection.filePaths[0]; if (selection.canceled || !path) return undefined;
    return importPerformanceTake(projectDirectory, JSON.parse(readFileSync(path, "utf8")) as unknown, options);
  });
  ipcMain.handle("viewer:take-edit", (event, takeId: string, operations: import("@puppetloom/core").TakeEditOperations) => {
    const window = ownerWindow(event); const projectDirectory = window ? viewerProjects.get(window.id) : undefined;
    if (!projectDirectory) throw new Error("当前窗口没有角色项目。"); return editPerformanceTake(projectDirectory, takeId, operations);
  });
  ipcMain.handle("viewer:take-replay", async (event, takeId: string, speed = 1, loop = false) => {
    const window = ownerWindow(event); const projectDirectory = window ? viewerProjects.get(window.id) : undefined;
    if (!window || !projectDirectory || !runtimeControlService) throw new Error("当前窗口不能回放 Take。");
    const take = await readPerformanceTake(projectDirectory, takeId);
    return runtimeControlService.applyLocal(parseRuntimeControlServiceRequest({ version: 1, requestId: randomUUID(), op: "replay-start", viewerId: window.id, session: take.session, speed, loop }));
  });
  ipcMain.handle("viewer:performance-recording-start", (event, metadata: import("./performance-recording-service.js").PerformanceRecordingMetadata) => {
    const window = ownerWindow(event);
    if (!window) throw new Error("找不到发起录制的角色窗口。" );
    const projectDirectory = viewerProjects.get(window.id);
    const descriptor = runtimeControlService?.store.inspect().find((viewer) => viewer.id === window.id);
    if (!projectDirectory || !descriptor) throw new Error("当前窗口没有可录制的角色项目。" );
    const result = performanceRecordingService.start({
      viewerId: window.id,
      projectDirectory,
      projectName: descriptor.projectName,
      ...(descriptor.revision === undefined ? {} : { revision: descriptor.revision }),
      metadata
    });
    runtimeLog("performance-recording-start", { viewerId: window.id, id: result.id, output: result.output });
    return result;
  });
  ipcMain.on("viewer:performance-recording-open-stream", (event, payload: { id: string }) => {
    const window = ownerWindow(event);
    const port = event.ports[0];
    if (!window || !port) return;
    port.on("message", (message) => {
      const data = message.data as { sequence?: unknown; buffer?: unknown; position?: unknown } | null;
      const sequence = data?.sequence;
      const bytes = recordingChunkBytes(data?.buffer);
      const position = data?.position;
      const validPosition = position === undefined || Number.isSafeInteger(position) && (position as number) >= 0;
      if (!data || !Number.isInteger(sequence) || !bytes || !validPosition) {
        runtimeLog("performance-recording-stream-message-rejected", {
          viewerId: window.id,
          id: payload.id,
          reason: data === null ? "empty-message" : "invalid-envelope",
          envelopeKeys: data && typeof data === "object" ? Object.keys(data) : [],
          bufferType: Object.prototype.toString.call(data?.buffer)
        });
        if (Number.isInteger(sequence)) port.postMessage({ sequence, error: "录制分块格式无效。" });
        return;
      }
      try {
        const result = performanceRecordingService.append(window.id, payload.id, bytes, position as number | undefined);
        port.postMessage({ sequence, result });
      } catch (cause) {
        port.postMessage({ sequence, error: errorMessage(cause) });
      }
    });
    port.start();
  });
  ipcMain.handle("viewer:performance-recording-stop", (event, id: string, durationMs: number, inputSession?: import("./performance-recording-service.js").PerformanceRecordingInputSession) => {
    const window = ownerWindow(event);
    if (!window) throw new Error("找不到录制窗口。" );
    const result = performanceRecordingService.stop(window.id, id, durationMs, inputSession);
    runtimeLog("performance-recording-complete", { viewerId: window.id, id, output: result.output, durationMs, bytes: result.bytes });
    return result;
  });
  ipcMain.handle("viewer:performance-recording-fail", (event, id: string, error: string) => {
    const window = ownerWindow(event);
    if (!window) throw new Error("找不到录制窗口。" );
    performanceRecordingService.fail(window.id, id, error);
    runtimeLog("performance-recording-failed", { viewerId: window.id, id, error });
    return true;
  });

  runtimeHotkeys["CommandOrControl+Shift+P"] = globalShortcut.register("CommandOrControl+Shift+P", () => {
    for (const id of viewerStates.keys()) {
      const window = BrowserWindow.fromId(id);
      if (window && stateFor(window).clickThrough) controlViewer(window, "click-through");
    }
  });
  runtimeLog("runtime-hotkey-register", { accelerator: "CommandOrControl+Shift+P", registered: runtimeHotkeys["CommandOrControl+Shift+P"] });
  for (let index = 0; index < 4; index += 1) {
    const accelerator = `CommandOrControl+Shift+${index + 1}`;
    const registered = globalShortcut.register(accelerator, () => {
      if (!runtimeControlService) return;
      for (const viewer of runtimeControlService.store.inspect()) {
        const expression = viewer.expressions[index];
        if (!expression) continue;
        runtimeControlService.applyLocal(parseRuntimeControlRequest({
          version: 1,
          requestId: randomUUID(),
          op: "trigger",
          viewerId: viewer.id,
          sourceId: `hotkey-expression-${index + 1}`,
          expressionId: expression.id,
          durationMs: 1200,
          priority: 80
        }));
      }
    });
    runtimeHotkeys[accelerator] = registered;
    runtimeLog("runtime-hotkey-register", { accelerator, registered });
  }
  for (let index = 0; index < 4; index += 1) {
    const accelerator = `CommandOrControl+Shift+${index + 5}`;
    const registered = globalShortcut.register(accelerator, () => {
      if (!runtimeControlService) return;
      for (const viewer of runtimeControlService.store.inspect()) {
        const behavior = viewer.behaviors[index];
        if (!behavior) continue;
        runtimeControlService.applyLocal(parseRuntimeControlRequest({
          version: 1,
          requestId: randomUUID(),
          op: "trigger",
          viewerId: viewer.id,
          sourceId: `hotkey-behavior-${index + 1}`,
          behaviorId: behavior.id,
          priority: 80
        }));
      }
    });
    runtimeHotkeys[accelerator] = registered;
    runtimeLog("runtime-hotkey-register", { accelerator, registered });
  }

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

let quitPreparationStarted = false;
let quitPreparationComplete = false;
app.on("before-quit", (event) => {
  if (quitPreparationComplete) return;
  event.preventDefault();
  if (quitPreparationStarted) return;
  quitPreparationStarted = true;
  runtimeLog("app-before-quit");
  performanceRecordingService.interruptAll("PuppetLoom 在录制结束前退出。" );
  void (async () => {
    await spoutOutputService?.stopAll();
    await runtimeControlService?.stop();
    runtimeLog("app-will-quit");
    await runtimeLogWriter?.close();
    quitPreparationComplete = true;
    app.quit();
  })();
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {
  runtimeLog("window-all-closed");
  app.quit();
});
