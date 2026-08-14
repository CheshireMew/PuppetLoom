const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("puppetloom", {
  choosePsd: () => ipcRenderer.invoke("dialog:psd"),
  chooseReference: () => ipcRenderer.invoke("dialog:reference"),
  chooseOutput: () => ipcRenderer.invoke("dialog:output"),
  chooseProject: () => ipcRenderer.invoke("dialog:project"),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  inspect: (input: string) => ipcRenderer.invoke("project:inspect", input),
  create: (request: unknown) => ipcRenderer.invoke("project:create", request),
  readProject: (projectDirectory: string) => ipcRenderer.invoke("project:read", projectDirectory),
  readAsset: async (projectDirectory: string, layer: { texture: string }) => {
    const result = (await ipcRenderer.invoke("project:asset", projectDirectory, layer.texture)) as { mime: string; bytes: Uint8Array };
    return new Blob([result.bytes], { type: result.mime });
  },
  launchViewer: (projectDirectory: string) => ipcRenderer.invoke("viewer:launch", projectDirectory),
  controlViewer: (id: number, action: string) => ipcRenderer.invoke("viewer:control", id, action),
  viewerAction: (action: string) => ipcRenderer.invoke("viewer:self-control", action),
  onViewerState: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("viewer:state", handler);
    return () => ipcRenderer.removeListener("viewer:state", handler);
  }
});
