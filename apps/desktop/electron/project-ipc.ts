import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createProject, inspectPsd, loadProject, loadProjectRevision, verifyProject } from "@puppetloom/core";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { DesktopCreateRequest } from "./global.js";
import { recentProjectDisplayName, usableRecentProjects } from "./recent-projects.js";

export interface RecentProject {
  directory: string;
  name: string;
  openedAt: string;
}

function ownerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase();
}

function isWithin(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

export class ProjectIpcService {
  private readonly createControllers = new Map<string, AbortController>();
  constructor(private readonly applicationProfile: string) {}

  async recentProjects(): Promise<RecentProject[]> {
    try {
      const value = JSON.parse(await readFile(join(this.applicationProfile, "recent-projects.json"), "utf8"));
      return usableRecentProjects(value, process.env.PUPPETLOOM_INCLUDE_TEST_PROJECTS === "1");
    } catch {
      return [];
    }
  }

  async rememberProject(projectDirectory: string): Promise<RecentProject[]> {
    const directory = resolve(projectDirectory);
    const project = await loadProject(directory);
    const current = (await this.recentProjects()).filter((entry) => !samePath(entry.directory, directory));
    const next = [{ directory, name: recentProjectDisplayName(project.name, directory), openedAt: new Date().toISOString() }, ...current].slice(0, 12);
    mkdirSync(this.applicationProfile, { recursive: true });
    await writeFile(join(this.applicationProfile, "recent-projects.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  register(): void {
    const chooseFile = async (event: Electron.IpcMainInvokeEvent, filters: Electron.FileFilter[]): Promise<string | null> => {
      const owner = ownerWindow(event);
      const options = { properties: ["openFile"] as Array<"openFile">, filters };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    };

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
    ipcMain.handle("project:inspect", (_event, input: string, alphaCleanup: DesktopCreateRequest["alphaCleanup"] = "preserve-all") => inspectPsd(resolve(input), { alphaCleanup }));
    ipcMain.handle("project:create", async (event, request: DesktopCreateRequest) => {
      const operationId = request.operationId ?? randomUUID();
      if (this.createControllers.has(operationId)) throw new Error("同一个创建操作已经在运行。");
      const controller = new AbortController();
      this.createControllers.set(operationId, controller);
      try {
        const result = await createProject({
          input: resolve(request.input),
          output: resolve(request.output),
          seed: request.seed ?? 42,
          alphaCleanup: request.alphaCleanup ?? "preserve-all",
          signal: controller.signal,
          onProgress: (phase) => { if (!event.sender.isDestroyed()) event.sender.send("project:create-progress", { operationId, phase }); },
          ...(request.reference ? { reference: resolve(request.reference) } : {}),
          ...(request.name ? { name: request.name } : {})
        });
        await this.rememberProject(result.outputDirectory);
        return { outputDirectory: result.outputDirectory, report: result.report, verify: await verifyProject(result.outputDirectory) };
      } finally {
        this.createControllers.delete(operationId);
      }
    });
    ipcMain.handle("project:create-cancel", (_event, operationId: string) => {
      const controller = this.createControllers.get(operationId);
      if (!controller) return false;
      controller.abort(new Error("用户已停止创建；最终项目目录没有被发布。"));
      return true;
    });
    ipcMain.handle("project:recent", () => this.recentProjects());
    ipcMain.handle("project:read", async (_event, directory: string, revision?: number) => {
      const projectDirectory = resolve(directory);
      const project = revision === undefined ? await loadProject(projectDirectory) : await loadProjectRevision(projectDirectory, revision);
      await this.rememberProject(projectDirectory);
      return project;
    });
    ipcMain.handle("project:asset", async (_event, directory: string, assetPath: string) => {
      const root = resolve(directory);
      const target = resolve(root, assetPath);
      if (!isWithin(root, target)) throw new Error("纹理路径超出项目目录。");
      const mime = extname(target).toLowerCase() === ".webp" ? "image/webp" : "image/png";
      return { mime, bytes: new Uint8Array(await readFile(target)) };
    });
  }
}
