import type {
  BuildReport,
  CalibrationDocument,
  CalibrationDraftDocument,
  CalibrationPatch,
  CalibrationSaveResult,
  CalibrationSessionDocument,
  InspectionReport,
  LayerBinding,
  MotionState,
  PuppetLoomProject,
  RuntimeControlSnapshot,
  RuntimeControlSetRequest,
  RuntimeViewerDescriptor,
  RevisionComparisonResult,
  VerifyResult
} from "@puppetloom/core";
import type { PointerLookTarget } from "@puppetloom/renderer";

export interface DesktopCreateRequest {
  operationId?: string;
  input: string;
  output: string;
  reference?: string;
  seed?: number;
  name?: string;
  alphaCleanup?: "preserve-all" | "automatic" | "remove-all-tiny";
}

export type DesktopCreatePhase = "importing" | "rigging" | "writing" | "validating" | "publishing";

export interface ViewerLaunchOptions {
  project?: PuppetLoomProject;
  sourceLabel?: string;
}

export interface ViewerCapabilities {
  hotkeys: Record<string, boolean>;
}

export interface DesktopCreateResponse {
  outputDirectory: string;
  report: BuildReport;
  verify: VerifyResult;
}

export interface ViewerState {
  paused: boolean;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  mouseTracking: boolean;
  scale: number;
}

export type WindowShellAction = "minimize" | "toggle-maximize" | "close";

export interface WindowShellState {
  strategy: "integrated";
  frame: false;
  maximized: boolean;
  minimized: boolean;
  fullScreen: boolean;
  focused: boolean;
  resizable: boolean;
  maximizable: boolean;
  minimizable: boolean;
  closable: boolean;
  outerBounds: { x: number; y: number; width: number; height: number };
  contentBounds: { x: number; y: number; width: number; height: number };
}

export interface EditorWorkspace {
  projectDirectory: string;
  baseProject: PuppetLoomProject;
  project: PuppetLoomProject;
  calibration: CalibrationDocument;
  sessions: CalibrationSessionDocument[];
  draft?: CalibrationDraftDocument;
}

export interface DesktopCalibrationResponse extends CalibrationSaveResult {
  evidence: RevisionComparisonResult;
}

export interface RecentProject {
  directory: string;
  name: string;
  openedAt: string;
}

export interface PerformanceRecordingMetadata {
  mimeType: string;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  startedAt: string;
}

export interface PerformanceRecordingResult {
  id: string;
  viewerId: number;
  output: string;
  report: string;
  durationMs: number;
  bytes: number;
  hasAudio: boolean;
}

export interface PuppetLoomDesktopApi {
  choosePsd(): Promise<string | null>;
  chooseReference(): Promise<string | null>;
  chooseOutput(): Promise<string | null>;
  chooseProject(): Promise<string | null>;
  pathForFile(file: File): string;
  inspect(input: string, alphaCleanup?: DesktopCreateRequest["alphaCleanup"]): Promise<InspectionReport>;
  create(request: DesktopCreateRequest): Promise<DesktopCreateResponse>;
  cancelCreate(operationId: string): Promise<boolean>;
  onCreateProgress(listener: (progress: { operationId: string; phase: DesktopCreatePhase }) => void): () => void;
  recentProjects(): Promise<RecentProject[]>;
  readProject(projectDirectory: string, revision?: number): Promise<PuppetLoomProject>;
  readEditorWorkspace(projectDirectory: string): Promise<EditorWorkspace>;
  generateArtMeshes(projectDirectory: string, layerIds: string[]): Promise<Record<string, LayerBinding["mesh"]>>;
  saveCalibrationDraft(projectDirectory: string, baseRevision: number, overrides: CalibrationPatch["overrides"], label?: string): Promise<CalibrationDraftDocument>;
  discardCalibrationDraft(projectDirectory: string): Promise<boolean>;
  saveCalibration(projectDirectory: string, patch: CalibrationPatch): Promise<DesktopCalibrationResponse>;
  restoreCalibration(projectDirectory: string, revision: number, baseRevision: number, label?: string): Promise<DesktopCalibrationResponse>;
  setEvidenceStatus(projectDirectory: string, sessionId: string, status: "accepted" | "rejected" | "unreviewed"): Promise<CalibrationSessionDocument>;
  calibrationEvidence(projectDirectory: string, sessionId: string): Promise<RevisionComparisonResult>;
  setEditorMode(enabled: boolean, projectDirectory?: string): Promise<boolean>;
  windowShellState(): Promise<WindowShellState>;
  windowShellAction(action: WindowShellAction): Promise<WindowShellState | null>;
  onWindowShellState(listener: (state: WindowShellState) => void): () => void;
  confirmEditorClose(): Promise<boolean>;
  onPrepareEditorClose(listener: () => void | Promise<void>): () => void;
  readAsset(projectDirectory: string, layer: LayerBinding): Promise<Blob>;
  readProjectFile(projectDirectory: string, relative: string): Promise<Blob>;
  launchViewer(projectDirectory: string, options?: ViewerLaunchOptions): Promise<{ id: number; state: ViewerState }>;
  viewerProject(): Promise<{ project: PuppetLoomProject; sourceLabel: string }>;
  viewerCapabilities(): Promise<ViewerCapabilities>;
  revealPath(path: string): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
  controlViewer(id: number, action: "pause" | "top" | "click-through" | "pointer-tracking" | "larger" | "smaller" | "close"): Promise<ViewerState | null>;
  viewerAction(action: "pause" | "top" | "click-through" | "pointer-tracking" | "larger" | "smaller" | "close"): Promise<ViewerState | null>;
  pointerTarget(): Promise<PointerLookTarget>;
  runtimeControl(): Promise<RuntimeControlSnapshot>;
  runtimeDescriptor(): Promise<RuntimeViewerDescriptor>;
  runtimeAssets(): Promise<{ wasmBaseUrl: string; faceLandmarkerModelUrl: string }>;
  setRuntimeSource(source: RuntimeControlSetRequest["source"]): Promise<unknown>;
  releaseRuntimeSource(sourceId: string): Promise<unknown>;
  triggerRuntimeTarget(target: { behaviorId?: string; expressionId?: string; durationMs?: number }): Promise<unknown>;
  inputRecording(action: "start" | "stop"): Promise<{ recording: boolean; output?: string; durationMs?: number; events?: number }>;
  inputReplay(action: "start" | "stop"): Promise<{ replaying: boolean; canceled?: boolean; input?: string }>;
  onRuntimeControl(listener: (snapshot: RuntimeControlSnapshot) => void): () => void;
  onViewerProject(listener: (payload: { project: PuppetLoomProject; sourceLabel: string }) => void): () => void;
  onInputReplayState(listener: (state: { replaying: boolean; reason: "started" | "finished" | "stopped" }) => void): () => void;
  startPerformanceRecording(metadata: PerformanceRecordingMetadata): Promise<{ id: string; viewerId: number; output: string; report: string }>;
  appendPerformanceRecording(id: string, bytes: Uint8Array): Promise<{ id: string; bytes: number }>;
  stopPerformanceRecording(id: string, durationMs: number): Promise<PerformanceRecordingResult>;
  failPerformanceRecording(id: string, error: string): Promise<boolean>;
  onViewerState(listener: (state: ViewerState) => void): () => void;
}

declare global {
  interface Window {
    puppetloom: PuppetLoomDesktopApi;
    puppetloomRenderTestPose?: (state: Partial<MotionState>) => boolean;
    puppetloomRenderCurrentFrame?: () => boolean;
  }
}

export {};
