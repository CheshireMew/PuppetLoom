import type { BuildReport, InspectionReport, LayerBinding, MotionState, PuppetLoomProject, VerifyResult } from "@puppetloom/core";

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
  scale: number;
}

export interface PuppetLoomDesktopApi {
  choosePsd(): Promise<string | null>;
  chooseReference(): Promise<string | null>;
  chooseOutput(): Promise<string | null>;
  chooseProject(): Promise<string | null>;
  pathForFile(file: File): string;
  inspect(input: string): Promise<InspectionReport>;
  create(request: DesktopCreateRequest): Promise<DesktopCreateResponse>;
  readProject(projectDirectory: string): Promise<PuppetLoomProject>;
  readAsset(projectDirectory: string, layer: LayerBinding): Promise<Blob>;
  launchViewer(projectDirectory: string): Promise<{ id: number; state: ViewerState }>;
  controlViewer(id: number, action: "pause" | "top" | "click-through" | "larger" | "smaller" | "close"): Promise<ViewerState | null>;
  viewerAction(action: "pause" | "top" | "click-through" | "larger" | "smaller" | "close"): Promise<ViewerState | null>;
  onViewerState(listener: (state: ViewerState) => void): () => void;
}

declare global {
  interface Window {
    puppetloom: PuppetLoomDesktopApi;
    puppetloomRenderTestPose?: (state: Partial<MotionState>) => boolean;
  }
}

export {};
