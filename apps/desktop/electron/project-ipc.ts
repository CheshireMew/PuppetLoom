import { createReadStream, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { BrowserWindow, dialog, ipcMain, protocol } from "electron";
import type { PuppetLoomProject } from "@puppetloom/core";
import type { DesktopCreateRequest } from "./global.js";
import { parseByteRange } from "./media-range.js";
import { recentProjectDisplayName, usableRecentProjects } from "./recent-projects.js";
import { runProjectWorker, startProjectWorker, type ProjectWorkerCreateResult, type ProjectWorkerOperation } from "./project-worker-client.js";

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
  private readonly createOperations = new Map<string, ProjectWorkerOperation<ProjectWorkerCreateResult>>();
  private readonly mediaFiles = new Map<string, string>();
  constructor(private readonly applicationProfile: string) {}

  async recentProjects(): Promise<RecentProject[]> {
    try {
      const value = JSON.parse(await readFile(join(this.applicationProfile, "recent-projects.json"), "utf8"));
      return usableRecentProjects(value, process.env.PUPPETLOOM_INCLUDE_TEST_PROJECTS === "1");
    } catch {
      return [];
    }
  }

  async rememberProject(projectDirectory: string, loadedProject?: PuppetLoomProject): Promise<RecentProject[]> {
    const directory = resolve(projectDirectory);
    const project = loadedProject ?? await runProjectWorker<PuppetLoomProject>({ operation: "load-project", directory });
    const current = (await this.recentProjects()).filter((entry) => !samePath(entry.directory, directory));
    const next = [{ directory, name: recentProjectDisplayName(project.name, directory), openedAt: new Date().toISOString() }, ...current].slice(0, 12);
    mkdirSync(this.applicationProfile, { recursive: true });
    await writeFile(join(this.applicationProfile, "recent-projects.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  register(): void {
    protocol.handle("puppetloom-media", async (request) => {
      const token = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
      const target = this.mediaFiles.get(token);
      if (!target) return new Response("Media not found", { status: 404 });
      let size = 0;
      try {
        const details = await stat(target);
        if (!details.isFile()) return new Response("Media not found", { status: 404 });
        size = details.size;
      } catch {
        return new Response("Media not found", { status: 404 });
      }
      const range = parseByteRange(request.headers.get("range"), size);
      if (range === null) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" } });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, size - 1);
      const headers = new Headers({
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-length": String(size === 0 ? 0 : end - start + 1),
        "content-type": "video/webm"
      });
      if (range) headers.set("content-range", `bytes ${start}-${end}/${size}`);
      if (request.method === "HEAD" || size === 0) return new Response(null, { status: range ? 206 : 200, headers });
      const stream = createReadStream(target, { start, end });
      const body = Readable.toWeb(stream) as unknown as ConstructorParameters<typeof Response>[0];
      return new Response(body, { status: range ? 206 : 200, headers });
    });

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
    ipcMain.handle("project:inspect", (_event, input: string, alphaCleanup: DesktopCreateRequest["alphaCleanup"] = "automatic") => {
      return runProjectWorker({ operation: "inspect", input: resolve(input), alphaCleanup });
    });
    ipcMain.handle("project:create", async (event, request: DesktopCreateRequest) => {
      const operationId = request.operationId ?? randomUUID();
      if (this.createOperations.has(operationId)) throw new Error("同一个创建操作已经在运行。");
      const normalizedRequest: DesktopCreateRequest = {
        ...request,
        input: resolve(request.input),
        output: resolve(request.output),
        ...(request.reference ? { reference: resolve(request.reference) } : {})
      };
      const operation = startProjectWorker<ProjectWorkerCreateResult>(
        { operation: "create", request: normalizedRequest },
        (phase) => { if (!event.sender.isDestroyed()) event.sender.send("project:create-progress", { operationId, phase }); }
      );
      this.createOperations.set(operationId, operation);
      try {
        const result = await operation.promise;
        await this.rememberProject(result.outputDirectory, result.project);
        return { outputDirectory: result.outputDirectory, report: result.report, verify: result.verify };
      } finally {
        this.createOperations.delete(operationId);
      }
    });
    ipcMain.handle("project:create-cancel", (_event, operationId: string) => {
      const operation = this.createOperations.get(operationId);
      if (!operation) return false;
      operation.cancel();
      return true;
    });
    ipcMain.handle("project:recent", () => this.recentProjects());
    ipcMain.handle("production:project-health", (_event, directory: string) => runProjectWorker({ operation: "project-health", directory: resolve(directory) }));
    ipcMain.handle("production:project-library", (_event, root: string, maxDepth = 4, maximumProjects = 200) => runProjectWorker({ operation: "project-library", root: resolve(root), maxDepth, maximumProjects }));
    ipcMain.handle("production:source-prepare", (_event, request: { reference: string; output: string; name?: string; provider?: "see-through-official" | "external" }) => runProjectWorker({
      operation: "source-prepare", reference: resolve(request.reference), output: resolve(request.output), ...(request.name ? { name: request.name } : {}), ...(request.provider ? { provider: request.provider } : {})
    }));
    ipcMain.handle("production:source-review", (_event, task: string, psd: string) => runProjectWorker({ operation: "source-review", task: resolve(task), psd: resolve(psd) }));
    ipcMain.handle("production:source-finalize", (_event, task: string, review: number, decision: "ready" | "needs-repair", note: string) => runProjectWorker({ operation: "source-finalize", task: resolve(task), review, decision, note }));
    ipcMain.handle("project:read", async (_event, directory: string, revision?: number) => {
      const projectDirectory = resolve(directory);
      const project = await runProjectWorker<PuppetLoomProject>({ operation: "load-project", directory: projectDirectory, ...(revision === undefined ? {} : { revision }) });
      await this.rememberProject(projectDirectory, project);
      return project;
    });
    ipcMain.handle("project:asset", async (_event, directory: string, assetPath: string) => {
      const root = resolve(directory);
      const target = resolve(root, assetPath);
      if (!isWithin(root, target)) throw new Error("纹理路径超出项目目录。");
      const mime = extname(target).toLowerCase() === ".webp" ? "image/webp" : "image/png";
      return { mime, bytes: new Uint8Array(await readFile(target)) };
    });
    ipcMain.handle("project:media-url", async (_event, directory: string, mediaPath: string) => {
      const root = resolve(directory);
      const performanceRoot = resolve(root, "reports", "performances");
      const target = resolve(root, mediaPath);
      if (!isWithin(root, target) || !isWithin(performanceRoot, target) || extname(target).toLowerCase() !== ".webm") {
        throw new Error("视频路径不属于当前项目的表演录制目录。");
      }
      const details = await stat(target);
      if (!details.isFile()) throw new Error("录制视频不存在。");
      const token = randomUUID();
      this.mediaFiles.set(token, target);
      return `puppetloom-media://local/${encodeURIComponent(token)}`;
    });
    ipcMain.handle("project:media-release", (_event, mediaUrl: string) => {
      try {
        const url = new URL(mediaUrl);
        if (url.protocol !== "puppetloom-media:") return false;
        return this.mediaFiles.delete(decodeURIComponent(url.pathname.replace(/^\//, "")));
      } catch {
        return false;
      }
    });
  }
}
