import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, inspectPsd, loadProject, verifyProject } from "@puppetloom/core";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain } from "electron";
import type { DesktopCreateRequest, ViewerState } from "./global.js";

const electronDirectory = dirname(fileURLToPath(import.meta.url));
const preload = join(electronDirectory, "preload.cjs");
const rendererPage = resolve(electronDirectory, "../renderer/index.html");
const viewerStates = new Map<number, ViewerState>();

function queryProjectArgument(): string | undefined {
  const index = process.argv.indexOf("--project");
  const candidate = index >= 0 ? process.argv[index + 1] : undefined;
  return candidate ? resolve(candidate) : undefined;
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
  const state = { paused: false, alwaysOnTop: true, clickThrough: false, scale: 1 };
  viewerStates.set(window.id, state);
  return state;
}

function publishState(window: BrowserWindow, next: ViewerState): ViewerState {
  viewerStates.set(window.id, next);
  if (!window.isDestroyed()) window.webContents.send("viewer:state", next);
  return next;
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
  const project = await loadProject(projectDirectory);
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
  window.once("closed", () => viewerStates.delete(window.id));
  await window.loadFile(rendererPage, { query: { viewer: "1", project: projectDirectory } });
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

app.whenReady().then(async () => {
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

  globalShortcut.register("CommandOrControl+Shift+P", () => {
    for (const id of viewerStates.keys()) {
      const window = BrowserWindow.fromId(id);
      if (window && stateFor(window).clickThrough) controlViewer(window, "click-through");
    }
  });

  const project = queryProjectArgument();
  if (project) await createViewer(project);
  else createControlWindow();
  const automatedExit = Number(process.env.PUPPETLOOM_E2E_EXIT_AFTER_MS ?? 0);
  if (Number.isFinite(automatedExit) && automatedExit >= 250) setTimeout(() => app.quit(), automatedExit);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
