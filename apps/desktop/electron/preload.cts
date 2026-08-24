const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");

interface RecordingMessagePort {
  onmessage: ((message: Electron.MessageEvent) => void) | null;
  start(): void;
  close(): void;
  postMessage(message: unknown): void;
}

interface RecordingPortState {
  port: RecordingMessagePort;
  pending: Map<number, { resolve: (result: { id: string; bytes: number }) => void; reject: (cause: Error) => void }>;
}

const recordingPorts = new Map<string, RecordingPortState>();
let recordingChunkSequence = 0;
let editorCloseListener: (() => void | Promise<void>) | undefined;
let editorClosePending = false;
let editorCloseInFlight = false;

function deliverEditorCloseRequest(): void {
  if (!editorClosePending || !editorCloseListener || editorCloseInFlight) return;
  editorClosePending = false;
  editorCloseInFlight = true;
  Promise.resolve()
    .then(() => editorCloseListener?.())
    .catch(() => undefined)
    .finally(() => {
      editorCloseInFlight = false;
      deliverEditorCloseRequest();
    });
}

// The editor UI is lazy-loaded. Buffer close requests in preload so an app
// quit during startup cannot lose the event before React registers its saver.
ipcRenderer.on("editor:prepare-close", () => {
  editorClosePending = true;
  deliverEditorCloseRequest();
});

function openPerformanceRecordingStream(id: string): void {
  const Channel = (globalThis as unknown as { window: { MessageChannel: new () => { port1: RecordingMessagePort; port2: RecordingMessagePort } } }).window.MessageChannel;
  const channel = new Channel();
  const port = channel.port1;
  const state: RecordingPortState = { port, pending: new Map() };
  recordingPorts.set(id, state);
  port.onmessage = (message: Electron.MessageEvent) => {
    const data = message.data as { sequence: number; result?: { id: string; bytes: number }; error?: string };
    const pending = state.pending.get(data.sequence);
    if (!pending) return;
    state.pending.delete(data.sequence);
    if (data.result) pending.resolve(data.result);
    else pending.reject(new Error(data.error || "主进程没有确认录制分块。"));
  };
  port.start();
  ipcRenderer.postMessage("viewer:performance-recording-open-stream", { id }, [channel.port2 as unknown as import("node:worker_threads").MessagePort]);
}

function closePerformanceRecordingStream(id: string): void {
  const state = recordingPorts.get(id);
  if (!state) return;
  recordingPorts.delete(id);
  state.port.close();
  for (const pending of state.pending.values()) pending.reject(new Error("录制数据流已经关闭。"));
  state.pending.clear();
}

function appendPerformanceRecording(id: string, bytes: Uint8Array, position?: number): Promise<{ id: string; bytes: number }> {
  const state = recordingPorts.get(id);
  if (!state) return Promise.reject(new Error("录制数据流尚未建立。"));
  const sequence = recordingChunkSequence + 1;
  recordingChunkSequence = sequence;
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.slice().buffer;
  const promise = new Promise<{ id: string; bytes: number }>((resolve, reject) => {
    state.pending.set(sequence, { resolve, reject });
  });
  state.port.postMessage({ sequence, buffer, ...(position === undefined ? {} : { position }) });
  return promise;
}

contextBridge.exposeInMainWorld("puppetloom", {
  choosePsd: () => ipcRenderer.invoke("dialog:psd"),
  chooseReference: () => ipcRenderer.invoke("dialog:reference"),
  chooseOutput: () => ipcRenderer.invoke("dialog:output"),
  chooseProject: () => ipcRenderer.invoke("dialog:project"),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  inspect: (input: string, alphaCleanup?: string) => ipcRenderer.invoke("project:inspect", input, alphaCleanup),
  create: (request: unknown) => ipcRenderer.invoke("project:create", request),
  cancelCreate: (operationId: string) => ipcRenderer.invoke("project:create-cancel", operationId),
  onCreateProgress: (listener: (progress: unknown) => void) => {
    const handler = (_event: unknown, progress: unknown) => listener(progress);
    ipcRenderer.on("project:create-progress", handler);
    return () => ipcRenderer.removeListener("project:create-progress", handler);
  },
  recentProjects: () => ipcRenderer.invoke("project:recent"),
  readProject: (projectDirectory: string, revision?: number) => ipcRenderer.invoke("project:read", projectDirectory, revision),
  readEditorWorkspace: (projectDirectory: string) => ipcRenderer.invoke("editor:read", projectDirectory),
  generateArtMeshes: (projectDirectory: string, layerIds: string[]) => ipcRenderer.invoke("editor:generate-art-meshes", projectDirectory, layerIds),
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
    editorCloseListener = listener;
    deliverEditorCloseRequest();
    return () => {
      if (editorCloseListener === listener) editorCloseListener = undefined;
    };
  },
  readAsset: async (projectDirectory: string, layer: { texture: string }) => {
    const result = (await ipcRenderer.invoke("project:asset", projectDirectory, layer.texture)) as { mime: string; bytes: Uint8Array };
    return new Blob([result.bytes], { type: result.mime });
  },
  readProjectFile: async (projectDirectory: string, relative: string) => {
    const result = (await ipcRenderer.invoke("project:asset", projectDirectory, relative)) as { mime: string; bytes: Uint8Array };
    return new Blob([result.bytes], { type: result.mime });
  },
  projectMediaUrl: (projectDirectory: string, relative: string) => ipcRenderer.invoke("project:media-url", projectDirectory, relative),
  releaseProjectMedia: (mediaUrl: string) => ipcRenderer.invoke("project:media-release", mediaUrl),
  launchViewer: (projectDirectory: string, options?: unknown) => ipcRenderer.invoke("viewer:launch", projectDirectory, options),
  viewerProject: () => ipcRenderer.invoke("viewer:project"),
  viewerCapabilities: () => ipcRenderer.invoke("viewer:capabilities"),
  revealPath: (path: string) => ipcRenderer.invoke("system:reveal-path", path),
  copyText: (text: string) => ipcRenderer.invoke("system:copy-text", text),
  controlViewer: (id: number, action: string) => ipcRenderer.invoke("viewer:control", id, action),
  viewerAction: (action: string) => ipcRenderer.invoke("viewer:self-control", action),
  viewerDrag: (action: "start" | "move" | "end", point?: { x: number; y: number }) => ipcRenderer.send("viewer:drag", action, point),
  pointerTarget: () => ipcRenderer.invoke("viewer:pointer-target"),
  runtimeControl: () => ipcRenderer.invoke("viewer:runtime-control"),
  runtimeDescriptor: () => ipcRenderer.invoke("viewer:runtime-descriptor"),
  runtimeAssets: () => ipcRenderer.invoke("runtime:assets"),
  setRuntimeSource: (source: unknown) => ipcRenderer.invoke("viewer:runtime-set", source),
  releaseRuntimeSource: (sourceId: string) => ipcRenderer.invoke("viewer:runtime-release", sourceId),
  triggerRuntimeTarget: (target: unknown) => ipcRenderer.invoke("viewer:runtime-trigger", target),
  inputRecording: (action: "start" | "stop") => ipcRenderer.invoke("viewer:input-recording", action),
  inputReplay: (action: "start" | "stop") => ipcRenderer.invoke("viewer:input-replay", action),
  onRuntimeControl: (listener: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on("viewer:runtime-control-changed", handler);
    return () => ipcRenderer.removeListener("viewer:runtime-control-changed", handler);
  },
  onViewerProject: (listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("viewer:project-changed", handler);
    return () => ipcRenderer.removeListener("viewer:project-changed", handler);
  },
  onInputReplayState: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("viewer:input-replay-state", handler);
    return () => ipcRenderer.removeListener("viewer:input-replay-state", handler);
  },
  startPerformanceRecording: async (metadata: unknown) => {
    const session = await ipcRenderer.invoke("viewer:performance-recording-start", metadata) as { id: string };
    openPerformanceRecordingStream(session.id);
    return session;
  },
  appendPerformanceRecording,
  stopPerformanceRecording: async (id: string, durationMs: number, inputSession?: unknown) => {
    try { return await ipcRenderer.invoke("viewer:performance-recording-stop", id, durationMs, inputSession); }
    finally { closePerformanceRecordingStream(id); }
  },
  failPerformanceRecording: async (id: string, error: string) => {
    try { return await ipcRenderer.invoke("viewer:performance-recording-fail", id, error); }
    finally { closePerformanceRecordingStream(id); }
  },
  onViewerState: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("viewer:state", handler);
    return () => ipcRenderer.removeListener("viewer:state", handler);
  }
});
