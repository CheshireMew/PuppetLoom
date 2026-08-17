import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createProject, inspectPsd, loadProject, loadProjectRevision, verifyProject } from "@puppetloom/core";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { DesktopCreateRequest } from "./global.js";

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
  constructor(private readonly applicationProfile: string) {}

  async recentProjects(): Promise<RecentProject[]> {
    try {
      const value = JSON.parse(await readFile(join(this.applicationProfile, "recent-projects.json"), "utf8"));
      return Array.isArray(value) ? value.filter((entry): entry is RecentProject => entry && typeof entry.directory === "string" && typeof entry.name === "string") : [];
    } catch {
      return [];
    }
  }

  async rememberProject(projectDirectory: string): Promise<RecentProject[]> {
    const directory = resolve(projectDirectory);
    const project = await loadProject(directory);
    const current = (await this.recentProjects()).filter((entry) => !samePath(entry.directory, directory));
    const next = [{ directory, name: project.name, openedAt: new Date().toISOString() }, ...current].slice(0, 12);
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
    ipcMain.handle("project:inspect", (_event, input: string) => inspectPsd(resolve(input)));
    ipcMain.handle("project:create", async (_event, request: DesktopCreateRequest) => {
      const result = await createProject({
        input: resolve(request.input),
        output: resolve(request.output),
        seed: request.seed ?? 42,
        ...(request.reference ? { reference: resolve(request.reference) } : {}),
        ...(request.name ? { name: request.name } : {})
      });
      await this.rememberProject(result.outputDirectory);
      return { outputDirectory: result.outputDirectory, report: result.report, verify: await verifyProject(result.outputDirectory) };
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
