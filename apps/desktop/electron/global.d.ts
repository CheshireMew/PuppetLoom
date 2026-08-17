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
  RevisionComparisonResult,
  VerifyResult
} from "@puppetloom/core";
import type { PointerLookTarget } from "@puppetloom/renderer";

export interface DesktopCreateRequest {
  input: string;
  output: string;
  reference?: string;
  seed?: number;
  name?: string;
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

export interface PuppetLoomDesktopApi {
  choosePsd(): Promise<string | null>;
  chooseReference(): Promise<string | null>;
  chooseOutput(): Promise<string | null>;
  chooseProject(): Promise<string | null>;
  pathForFile(file: File): string;
  inspect(input: string): Promise<InspectionReport>;
  create(request: DesktopCreateRequest): Promise<DesktopCreateResponse>;
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
  launchViewer(projectDirectory: string): Promise<{ id: number; state: ViewerState }>;
  controlViewer(id: number, action: "pause" | "top" | "click-through" | "pointer-tracking" | "larger" | "smaller" | "close"): Promise<ViewerState | null>;
  viewerAction(action: "pause" | "top" | "click-through" | "pointer-tracking" | "larger" | "smaller" | "close"): Promise<ViewerState | null>;
  pointerTarget(): Promise<PointerLookTarget>;
  onViewerState(listener: (state: ViewerState) => void): () => void;
}

declare global {
  interface Window {
    puppetloom: PuppetLoomDesktopApi;
    puppetloomRenderTestPose?: (state: Partial<MotionState>) => boolean;
  }
}

export {};
