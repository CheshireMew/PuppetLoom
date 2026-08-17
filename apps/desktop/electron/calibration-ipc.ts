import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  clearCalibrationDraft,
  compareProjectRevisions,
  listCalibrationSessions,
  loadBaseProject,
  loadCalibration,
  loadCalibrationDraft,
  loadProject,
  restoreCalibrationRevision,
  saveCalibrationDraft,
  saveCalibrationPatch,
  setCalibrationEvidenceStatus
} from "@puppetloom/core";
import type { CalibrationOverrides, CalibrationPatch, RevisionComparisonResult } from "@puppetloom/core";
import { ipcMain } from "electron";

export class CalibrationIpcService {
  private readonly draftWrites = new Map<string, Promise<unknown>>();

  constructor(private readonly rememberProject: (projectDirectory: string) => Promise<unknown>) {}

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
      return compareProjectRevisions(root, session.fromRevision, session.toRevision, output);
    }
  }

  register(): void {
    ipcMain.handle("editor:read", async (_event, directory: string) => {
      const projectDirectory = resolve(directory);
      await this.rememberProject(projectDirectory);
      return {
        projectDirectory,
        baseProject: await loadBaseProject(projectDirectory),
        project: await loadProject(projectDirectory),
        calibration: await loadCalibration(projectDirectory),
        sessions: await listCalibrationSessions(projectDirectory),
        draft: await loadCalibrationDraft(projectDirectory)
      };
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
