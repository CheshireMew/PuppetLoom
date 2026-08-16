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
  readProject: (projectDirectory: string) => ipcRenderer.invoke("project:read", projectDirectory),
  readEditorWorkspace: (projectDirectory: string) => ipcRenderer.invoke("editor:read", projectDirectory),
  saveCalibration: (projectDirectory: string, patch: unknown) => ipcRenderer.invoke("editor:save", projectDirectory, patch),
  restoreCalibration: (projectDirectory: string, revision: number, label?: string) => ipcRenderer.invoke("editor:restore", projectDirectory, revision, label),
  setEvidenceStatus: (projectDirectory: string, sessionId: string, status: string) => ipcRenderer.invoke("editor:evidence", projectDirectory, sessionId, status),
  setEditorMode: (enabled: boolean) => ipcRenderer.invoke("window:editor-mode", enabled),
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
