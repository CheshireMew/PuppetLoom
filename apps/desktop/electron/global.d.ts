import type {
  BuildReport,
  CalibrationDocument,
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

export interface EditorWorkspace {
  projectDirectory: string;
  baseProject: PuppetLoomProject;
  project: PuppetLoomProject;
  calibration: CalibrationDocument;
  sessions: CalibrationSessionDocument[];
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
  readProject(projectDirectory: string): Promise<PuppetLoomProject>;
  readEditorWorkspace(projectDirectory: string): Promise<EditorWorkspace>;
  saveCalibration(projectDirectory: string, patch: CalibrationPatch): Promise<DesktopCalibrationResponse>;
  restoreCalibration(projectDirectory: string, revision: number, label?: string): Promise<DesktopCalibrationResponse>;
  setEvidenceStatus(projectDirectory: string, sessionId: string, status: "accepted" | "rejected" | "unreviewed"): Promise<CalibrationSessionDocument>;
  setEditorMode(enabled: boolean): Promise<boolean>;
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
