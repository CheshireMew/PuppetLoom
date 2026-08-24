import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  clearCalibrationDraft,
  listCalibrationSessions,
  loadCalibrationWorkspace,
  restoreCalibrationRevision,
  saveCalibrationDraft,
  saveCalibrationPatch,
  setCalibrationEvidenceStatus
} from "@puppetloom/core/desktop";
import type { CalibrationOverrides, CalibrationPatch, MeshBinding, PuppetLoomProject, RevisionComparisonResult } from "@puppetloom/core";
import { ipcMain } from "electron";
import { runProjectWorker } from "./project-worker-client.js";

export class CalibrationIpcService {
  private readonly draftWrites = new Map<string, Promise<unknown>>();

  constructor(private readonly rememberProject: (projectDirectory: string, project: PuppetLoomProject) => Promise<unknown>) {}

  private queueDraftWrite(projectDirectory: string, operation: () => Promise<unknown>): Promise<unknown> {
    const root = resolve(projectDirectory);
    const previous = this.draftWrites.get(root) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.draftWrites.set(root, next);
    const cleanup = () => { if (this.draftWrites.get(root) === next) this.draftWrites.delete(root); };
    void next.then(cleanup, cleanup);
    return next;
  }

  async waitForDraft(projectDirectory: string): Promise<void> {
    await this.draftWrites.get(resolve(projectDirectory))?.catch(() => undefined);
  }

  private async evidence(projectDirectory: string, sessionId: string): Promise<RevisionComparisonResult> {
    const root = resolve(projectDirectory);
    const session = (await listCalibrationSessions(root)).find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`找不到校准会话：${sessionId}`);
    const output = session.evidenceDirectory ? join(root, session.evidenceDirectory) : join(root, "reports", "calibration", session.id, "evidence");
    try {
      return JSON.parse(await readFile(join(output, "comparison.json"), "utf8")) as RevisionComparisonResult;
    } catch {
      const { compareProjectRevisions } = await import("@puppetloom/core");
      return compareProjectRevisions(root, session.fromRevision, session.toRevision, output);
    }
  }

  register(): void {
    ipcMain.handle("editor:read", async (_event, directory: string) => {
      const projectDirectory = resolve(directory);
      const workspace = await runProjectWorker<Awaited<ReturnType<typeof loadCalibrationWorkspace>>>({ operation: "load-workspace", directory: projectDirectory });
      await this.rememberProject(projectDirectory, workspace.project);
      return {
        projectDirectory,
        ...workspace
      };
    });
    ipcMain.handle("editor:generate-art-meshes", async (_event, directory: string, layerIds: string[]) => {
      const projectDirectory = resolve(directory);
      const project = await runProjectWorker<PuppetLoomProject>({ operation: "load-project", directory: projectDirectory });
      if (!Array.isArray(layerIds) || layerIds.length !== 1) throw new Error("每次必须且只能选择一个图层重建网格。");
      const requested = new Set(layerIds);
      const known = new Set(project.layers.map((layer) => layer.id));
      const unknown = [...requested].filter((layerId) => !known.has(layerId));
      if (unknown.length > 0) throw new Error(`找不到要重建网格的图层：${unknown.join("、")}`);
      const {
        artMeshDetailForRole,
        loadProjectTextureSources,
        makeAdaptiveMesh,
        remeshArtMesh,
        reprojectMeshInfluences
      } = await import("@puppetloom/core");
      const sources = await loadProjectTextureSources(projectDirectory, project);
      const replacements: Record<string, MeshBinding> = {};
      for (const layer of project.layers) {
        if (!requested.has(layer.id)) continue;
        const detail = layer.mesh.topology === "art" && layer.mesh.art
          ? layer.mesh.art.detail
          : artMeshDetailForRole(layer.role);
        const pixels = sources.get(layer.id);
        const mesh = pixels ? makeAdaptiveMesh({
            bounds: layer.bounds,
            pixels,
            detail,
            fallbackRows: layer.mesh.rows ?? 8,
            fallbackCols: layer.mesh.cols ?? 8
          }) : layer.mesh.topology === "art" && layer.mesh.art
            ? remeshArtMesh(layer.mesh, layer.bounds, detail)
            : layer.mesh;
        if (mesh.topology !== "art") continue;
        mesh.influences = reprojectMeshInfluences(layer.mesh, mesh);
        replacements[layer.id] = mesh;
      }
      return replacements;
    });
    ipcMain.handle("editor:save-draft", (_event, directory: string, baseRevision: number, overrides: CalibrationOverrides, label?: string) => {
      const projectDirectory = resolve(directory);
      return this.queueDraftWrite(projectDirectory, () => saveCalibrationDraft(projectDirectory, baseRevision, overrides, label));
    });
    ipcMain.handle("editor:discard-draft", async (_event, directory: string) => {
      const projectDirectory = resolve(directory);
      await this.waitForDraft(projectDirectory);
      await clearCalibrationDraft(projectDirectory);
      return true;
    });
    ipcMain.handle("editor:save", async (_event, directory: string, patch: CalibrationPatch) => {
      const projectDirectory = resolve(directory);
      await this.waitForDraft(projectDirectory);
      return saveCalibrationPatch(projectDirectory, patch);
    });
    ipcMain.handle("editor:restore", async (_event, directory: string, revision: number, baseRevision: number, label?: string) => {
      const projectDirectory = resolve(directory);
      await this.waitForDraft(projectDirectory);
      return restoreCalibrationRevision(projectDirectory, revision, baseRevision, label);
    });
    ipcMain.handle("editor:evidence", (_event, directory: string, sessionId: string, status: "accepted" | "rejected" | "unreviewed") => {
      return setCalibrationEvidenceStatus(resolve(directory), sessionId, status);
    });
    ipcMain.handle("editor:comparison", (_event, directory: string, sessionId: string) => this.evidence(resolve(directory), sessionId));
  }
}
