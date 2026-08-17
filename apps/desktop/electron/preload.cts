const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("puppetloom", {
  choosePsd: () => ipcRenderer.invoke("dialog:psd"),
  chooseReference: () => ipcRenderer.invoke("dialog:reference"),
  chooseOutput: () => ipcRenderer.invoke("dialog:output"),
  chooseProject: () => ipcRenderer.invoke("dialog:project"),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  inspect: (input: string) => ipcRenderer.invoke("project:inspect", input),
  create: (request: unknown) => ipcRenderer.invoke("project:create", request),
  recentProjects: () => ipcRenderer.invoke("project:recent"),
  readProject: (projectDirectory: string, revision?: number) => ipcRenderer.invoke("project:read", projectDirectory, revision),
  readEditorWorkspace: (projectDirectory: string) => ipcRenderer.invoke("editor:read", projectDirectory),
  generateArtMeshes: (projectDirectory: string) => ipcRenderer.invoke("editor:generate-art-meshes", projectDirectory),
  saveCalibrationDraft: (projectDirectory: string, baseRevision: number, overrides: unknown, label?: string) => ipcRenderer.invoke("editor:save-draft", projectDirectory, baseRevision, overrides, label),
  discardCalibrationDraft: (projectDirectory: string) => ipcRenderer.invoke("editor:discard-draft", projectDirectory),
  saveCalibration: (projectDirectory: string, patch: unknown) => ipcRenderer.invoke("editor:save", projectDirectory, patch),
  restoreCalibration: (projectDirectory: string, revision: number, baseRevision: number, label?: string) => ipcRenderer.invoke("editor:restore", projectDirectory, revision, baseRevision, label),
  setEvidenceStatus: (projectDirectory: string, sessionId: string, status: string) => ipcRenderer.invoke("editor:evidence", projectDirectory, sessionId, status),
  calibrationEvidence: (projectDirectory: string, sessionId: string) => ipcRenderer.invoke("editor:comparison", projectDirectory, sessionId),
  setEditorMode: (enabled: boolean, projectDirectory?: string) => ipcRenderer.invoke("window:editor-mode", enabled, projectDirectory),
  windowShellState: () => ipcRenderer.invoke("window:shell-state"),
  windowShellAction: (action: string) => ipcRenderer.invoke("window:shell-action", action),
  onWindowShellState: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("window:shell-state", handler);
    return () => ipcRenderer.removeListener("window:shell-state", handler);
  },
  confirmEditorClose: () => ipcRenderer.invoke("editor:confirm-close"),
  onPrepareEditorClose: (listener: () => void | Promise<void>) => {
    const handler = () => { void listener(); };
    ipcRenderer.on("editor:prepare-close", handler);
    return () => ipcRenderer.removeListener("editor:prepare-close", handler);
  },
  readAsset: async (projectDirectory: string, layer: { texture: string }) => {
    const result = (await ipcRenderer.invoke("project:asset", projectDirectory, layer.texture)) as { mime: string; bytes: Uint8Array };
    return new Blob([result.bytes], { type: result.mime });
  },
  readProjectFile: async (projectDirectory: string, relative: string) => {
    const result = (await ipcRenderer.invoke("project:asset", projectDirectory, relative)) as { mime: string; bytes: Uint8Array };
    return new Blob([result.bytes], { type: result.mime });
  },
  launchViewer: (projectDirectory: string) => ipcRenderer.invoke("viewer:launch", projectDirectory),
  controlViewer: (id: number, action: string) => ipcRenderer.invoke("viewer:control", id, action),
  viewerAction: (action: string) => ipcRenderer.invoke("viewer:self-control", action),
  pointerTarget: () => ipcRenderer.invoke("viewer:pointer-target"),
  onViewerState: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("viewer:state", handler);
    return () => ipcRenderer.removeListener("viewer:state", handler);
  }
});
