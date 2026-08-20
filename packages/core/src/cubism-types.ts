import type { MotionParameterSemantic } from "./types.js";

export const CUBISM_BRIDGE_VERSION = 1 as const;
export const CUBISM_EDITOR_API_VERSION = "1.1.0" as const;

export type CubismCompatibilitySeverity = "blocking" | "warning" | "info";

export interface CubismCompatibilityIssue {
  code: string;
  severity: CubismCompatibilitySeverity;
  message: string;
  target?: string;
}

export interface CubismParameterMapping {
  sourceId: string;
  sourceName: string;
  sourceGroup: string;
  sourceRange: { min: number; default: number; max: number };
  semantic?: MotionParameterSemantic;
  targetIds: string[];
  targetRange: { min: number; default: number; max: number };
  /** target = clamp(source * scale + offset, target min, target max) */
  scale: number;
  offset: number;
  standard: boolean;
}

export interface CubismCompatibilityCoverage {
  sourceParameters: number;
  targetParameters: number;
  totalBindings: number;
  fullyWritableBindings: number;
  partiallyWritableBindings: number;
  blockedBindings: number;
  expressions: number;
  motions: number;
  physicsSettings: number;
}

export interface CubismExportPlan {
  version: typeof CUBISM_BRIDGE_VERSION;
  project: string;
  sourceRevision: number;
  editorApiVersion: typeof CUBISM_EDITOR_API_VERSION;
  requiresCubismEditor: true;
  requiresEditorMocExport: true;
  strictReady: boolean;
  partialSyncAvailable: boolean;
  mappings: CubismParameterMapping[];
  coverage: CubismCompatibilityCoverage;
  issues: CubismCompatibilityIssue[];
}

export interface CubismExpressionJson {
  Type: "Live2D Expression";
  FadeInTime: number;
  FadeOutTime: number;
  Parameters: Array<{ Id: string; Value: number; Blend: "Add" }>;
}

export interface CubismMotionCurve {
  Target: "Parameter";
  Id: string;
  Segments: number[];
  FadeInTime: number;
  FadeOutTime: number;
}

export interface CubismMotionJson {
  Version: 3;
  Meta: {
    Duration: number;
    Fps: number;
    Loop: boolean;
    AreBeziersRestricted: boolean;
    CurveCount: number;
    TotalSegmentCount: number;
    TotalPointCount: number;
    UserDataCount: 0;
    TotalUserDataSize: 0;
  };
  Curves: CubismMotionCurve[];
  UserData: [];
}

export interface CubismPhysicsJson {
  Version: 3;
  Meta: Record<string, unknown>;
  PhysicsSettings: Array<Record<string, unknown>>;
}

export interface CubismDisplayInfoJson {
  Version: 3;
  Parameters: Array<{ Id: string; GroupId: string; Name: string }>;
  ParameterGroups: Array<{ Id: string; GroupId: string; Name: string }>;
  Parts: Array<{ Id: string; Name: string }>;
}

export interface CubismGeneratedSidecars {
  expressions: Array<{ id: string; name: string; file: string; document: CubismExpressionJson }>;
  motions: Array<{ id: string; name: string; file: string; document: CubismMotionJson }>;
  physics?: { file: string; document: CubismPhysicsJson };
  displayInfo: { file: string; document: CubismDisplayInfoJson };
  issues: CubismCompatibilityIssue[];
}

export interface CubismModel3Json {
  Version: 3;
  FileReferences: {
    Moc: string;
    Textures: string[];
    Physics?: string;
    Pose?: string;
    DisplayInfo?: string;
    Expressions?: Array<{ Name: string; File: string }>;
    Motions?: Record<string, Array<Record<string, unknown>>>;
    UserData?: string;
  };
  Groups?: Array<{ Target: "Parameter"; Name: "EyeBlink" | "LipSync"; Ids: string[] }>;
  HitAreas?: Array<{ Id: string; Name: string }>;
  [key: string]: unknown;
}

export interface CubismVerificationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface CubismVerificationResult {
  valid: boolean;
  model: string;
  moc: string;
  textures: string[];
  referencedFiles: string[];
  issues: CubismVerificationIssue[];
}

export interface CubismPrepareResult {
  outputDirectory: string;
  plan: CubismExportPlan;
  handoff: CubismHandoffManifest;
  files: string[];
}

export interface CubismHandoffManifest {
  version: 1;
  kind: "puppetloom-cubism-handoff";
  createdAt: string;
  source: {
    projectDirectory: string;
    projectName: string;
    revision: number;
    fingerprint: string;
    psd: string;
  };
  readiness: {
    strictAutomaticSync: boolean;
    partialSyncAvailable: boolean;
    officialMoc3Present: false;
    readyForRuntimeDelivery: false;
  };
  blockedAutomation: CubismCompatibilityIssue[];
  generatedSidecars: string[];
  editorSteps: Array<{ id: string; owner: "PuppetLoom" | "Cubism Editor" | "operator"; required: boolean; instruction: string }>;
  finalCommands: string[];
}

export interface CubismFinalizeOptions {
  project: string;
  editorModel: string;
  output: string;
}

export interface CubismFinalizeResult {
  outputDirectory: string;
  modelPath: string;
  plan: CubismExportPlan;
  verification: CubismVerificationResult;
  files: string[];
}

export interface CubismEditorParameter {
  Id: string;
  Name: string;
  Min: number;
  Default: number;
  Max: number;
  GroupUID?: string;
  Type?: number;
  Keyform?: Array<{ Value: number }>;
}

export interface CubismEditorObject {
  Id: string;
  Name: string;
  Type: string;
  ParentId?: string;
}

export interface CubismEditorInspection {
  url: string;
  connected: boolean;
  approved: boolean;
  editApproved: boolean;
  editApiAvailable: boolean;
  apiVersion: string;
  modelUid?: string;
  editMode?: string;
  parameters: CubismEditorParameter[];
  objects: CubismEditorObject[];
  warnings: string[];
}

export interface CubismBridgeOperation {
  method: string;
  data: Record<string, unknown>;
  description: string;
}

export interface CubismEditorSyncResult {
  plan: CubismExportPlan;
  inspection: CubismEditorInspection;
  partial: boolean;
  appliedOperations: number;
  skippedOperations: number;
  warnings: string[];
}

export type CubismEditorValidationStage = "pre-sync" | "post-sync";

export interface CubismEditorValidationIssue {
  code: string;
  severity: CubismCompatibilitySeverity;
  message: string;
  target?: string;
}

export interface CubismEditorValidationResult {
  project: string;
  revision: number;
  stage: CubismEditorValidationStage;
  inspection: CubismEditorInspection;
  plan: CubismExportPlan;
  layerCoverage: { total: number; matched: number; missing: Array<{ layerId: string; sourceName: string }> };
  parameterCoverage: { total: number; matched: number; missing: string[]; rangeConflicts: string[] };
  readyForPartialSync: boolean;
  readyForStrictSync: boolean;
  readyForOfficialExportReview: boolean;
  manualGeometryReviewRequired: string[];
  issues: CubismEditorValidationIssue[];
}

export type CubismPreviewPose = "neutral" | "left" | "right" | "up" | "down" | "blink" | "mouth";

export interface CubismEditorPreviewResult {
  project: string;
  pose: CubismPreviewPose;
  inspection: CubismEditorInspection;
  parameters: Array<{ Id: string; Value: number }>;
}
