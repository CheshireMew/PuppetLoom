export const PUPPETLOOM_PROJECT_VERSION = 2 as const;

export type RigLevel = "semantic" | "grouped" | "minimal";
export type Side = "left" | "right" | "center";
export type MouthVariant = "closed" | "slight" | "open";

export type SemanticRole =
  | "backHair"
  | "frontHair"
  | "sideHair"
  | "face"
  | "eyeWhite"
  | "iris"
  | "eyelash"
  | "eyeClosed"
  | "eyebrow"
  | "nose"
  | "mouth"
  | "ear"
  | "neck"
  | "topWear"
  | "bottomWear"
  | "arm"
  | "hand"
  | "leg"
  | "foot"
  | "headwear"
  | "tail"
  | "accessory"
  | "unknown";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface MeshBinding {
  rows: number;
  cols: number;
  points: Point[];
  uvs: Point[];
  triangles: number[];
  influences?: MeshInfluences;
}

export type MeshInfluenceChannel = "head" | "body" | "gaze" | "physics" | "pin";

export type MeshInfluences = Partial<Record<MeshInfluenceChannel, number[]>>;

export interface LayerWeights {
  head: number;
  body: number;
  gaze: number;
  physics: number;
}

export interface LayerSecondaryAnchors {
  earHingeLeft?: Point;
  earHingeRight?: Point;
  frontHairRoot?: Point;
  frontHairRootLeft?: Point;
  frontHairRootRight?: Point;
  frontHairTipLeft?: Point;
  frontHairTipRight?: Point;
  ahogeRoot?: Point;
}

export interface LayerBinding {
  id: string;
  sourceName: string;
  sourcePath: string[];
  role: SemanticRole;
  side: Side;
  order: number;
  opacity: number;
  blendMode: string;
  bounds: Rect;
  texture: string;
  pivot: Point;
  secondaryAnchors?: LayerSecondaryAnchors;
  mesh: MeshBinding;
  weights: LayerWeights;
  clipLayerId?: string;
  mouthVariant?: MouthVariant;
  parentGroup: "head" | "body" | "root";
}

export interface AnchorGraph {
  headTop?: Point;
  forehead?: Point;
  eyeLeft?: Point;
  eyeRight?: Point;
  cheekLeft?: Point;
  cheekRight?: Point;
  nose?: Point;
  mouth?: Point;
  chin?: Point;
  neck?: Point;
  shoulderLeft?: Point;
  shoulderRight?: Point;
  bodyCenter?: Point;
}

export type SemanticCagePointSource = "layer-alpha" | "face-alpha" | "head-alpha" | "inferred" | "corrected";

export type SemanticCagePointId =
  | "headTop"
  | "forehead"
  | "skullLeft"
  | "skullRight"
  | "faceLeft"
  | "faceRight"
  | "eyeLeftOuter"
  | "eyeLeft"
  | "eyeLeftInner"
  | "eyeRightInner"
  | "eyeRight"
  | "eyeRightOuter"
  | "nose"
  | "cheekLeft"
  | "cheekRight"
  | "mouthLeft"
  | "mouth"
  | "mouthRight"
  | "jawLeft"
  | "jawRight"
  | "chin"
  | "neckLeft"
  | "neckRight";

export interface SemanticCagePoint {
  position: Point;
  confidence: number;
  source: SemanticCagePointSource;
}

export type SemanticCageTriangle = [SemanticCagePointId, SemanticCagePointId, SemanticCagePointId];

export interface SemanticControlCage {
  kind: "semantic-face-cage-v1";
  coordinateConvention: "screen-space";
  points: Record<SemanticCagePointId, SemanticCagePoint>;
  faceTriangles: SemanticCageTriangle[];
  skullTriangles: SemanticCageTriangle[];
  roleGroups: {
    face: SemanticRole[];
    skull: SemanticRole[];
  };
  validation: {
    status: "passed" | "corrected";
    confidence: number;
    corrections: string[];
    checks: string[];
  };
}

export interface MotionEnvelope {
  headYaw: number;
  headPitch: number;
  headRollDegrees: number;
  bodySway: number;
  bodyRollDegrees: number;
  gazeX: number;
  gazeY: number;
  breath: number;
  globalScale: number;
}

export interface RuntimeFeatures {
  headTurn: boolean;
  bodyFollow: boolean;
  gaze: boolean;
  hairPhysics: boolean;
  blink: boolean;
  mouthMotion: boolean;
}

export interface CoherentPoseField {
  kind: "ellipsoid-v1" | "head-surfaces-v2";
  center: Point;
  radiusX: number;
  radiusY: number;
  skullCenter?: Point;
  skullRadiusX?: number;
  skullRadiusY?: number;
  maxYawRadians: number;
  maxPitchRadians: number;
  perspective: number;
}

export interface MotionTuning {
  amplitude: number;
  response: number;
  stability: number;
}

export interface RuntimeSettings {
  seed: number;
  profile: "calm-v1" | "coherent-v1" | "coherent-v2" | "coherent-v3";
  envelope: MotionEnvelope;
  features: RuntimeFeatures;
  poseField?: CoherentPoseField;
  semanticCage?: SemanticControlCage;
  motionTuning?: MotionTuning;
}

export interface SourceDescriptor {
  originalFileName: string;
  psdSha256: string;
  psdPath: string;
  referencePath?: string;
  referenceSha256?: string;
}

export interface ValidationIssue {
  code:
    | "mesh-inversion"
    | "mesh-stretch"
    | "eye-outside"
    | "face-hair-separation"
    | "neck-separation"
    | "viewport-overflow"
    | "neutral-drift"
    | "missing-semantics";
  severity: "warning" | "error";
  message: string;
  layerId?: string;
}

export interface PoseValidation {
  id: string;
  headYaw: number;
  headPitch: number;
  headRoll: number;
  score: number;
  passed: boolean;
  issues: ValidationIssue[];
}

export interface QualitySummary {
  neutralSimilarity?: number;
  poseValidations: PoseValidation[];
  safetyScale: number;
  issues: ValidationIssue[];
}

export interface PuppetLoomProject {
  version: typeof PUPPETLOOM_PROJECT_VERSION;
  name: string;
  canvas: Size;
  source: SourceDescriptor;
  rigLevel: RigLevel;
  layers: LayerBinding[];
  anchors: AnchorGraph;
  runtime: RuntimeSettings;
  quality: QualitySummary;
  disabledReasons: string[];
}

export interface LayerCalibrationOverride {
  role?: SemanticRole;
  side?: Side;
  parentGroup?: LayerBinding["parentGroup"];
  pivot?: Point;
  secondaryAnchors?: LayerSecondaryAnchors;
  weights?: Partial<LayerWeights>;
  meshPointDeltas?: Record<string, Point>;
  vertexInfluences?: Partial<Record<MeshInfluenceChannel, Record<string, number>>>;
}

export interface CalibrationOverrides {
  anchors?: Partial<AnchorGraph>;
  semanticPoints?: Partial<Record<SemanticCagePointId, Point>>;
  layers?: Record<string, LayerCalibrationOverride>;
  runtime?: {
    envelope?: Partial<MotionEnvelope>;
    motionTuning?: Partial<MotionTuning>;
  };
}

export interface CalibrationDocument {
  version: 1;
  baseProjectSha256: string;
  revision: number;
  updatedAt: string;
  label?: string;
  overrides: CalibrationOverrides;
}

export interface CalibrationPatch {
  label?: string;
  overrides: CalibrationOverrides;
  clear?: {
    anchors?: Array<keyof AnchorGraph>;
    semanticPoints?: SemanticCagePointId[];
    layers?: string[];
    runtime?: Array<"envelope" | "motionTuning">;
  };
}

export interface CalibrationSessionDocument {
  version: 1;
  id: string;
  createdAt: string;
  label: string;
  fromRevision: number;
  toRevision: number;
  beforeFingerprint: string;
  afterFingerprint: string;
  patch: CalibrationPatch;
  beforeOverrides: CalibrationOverrides;
  afterOverrides: CalibrationOverrides;
  evidenceStatus: "unreviewed" | "accepted" | "rejected";
}

export interface CalibrationSaveResult {
  project: PuppetLoomProject;
  calibration: CalibrationDocument;
  session: CalibrationSessionDocument;
  sessionPath: string;
}

export interface ProjectDescription {
  project: string;
  directory: string;
  version: number;
  calibrationRevision: number;
  canvas: Size;
  rigLevel: RigLevel;
  anchors: AnchorGraph;
  semanticPoints: Partial<Record<SemanticCagePointId, SemanticCagePoint>>;
  runtime: RuntimeSettings;
  layers: Array<{
    id: string;
    sourceName: string;
    role: SemanticRole;
    side: Side;
    parentGroup: LayerBinding["parentGroup"];
    bounds: Rect;
    pivot: Point;
    secondaryAnchors?: LayerSecondaryAnchors;
    mesh: { rows: number; cols: number; pointCount: number };
    weights: LayerWeights;
  }>;
}

export type RenderSuiteKind = "calibration" | "poses" | "motion";

export interface RenderArtifact {
  id: string;
  kind: "pose" | "motion" | "sheet" | "difference";
  path: string;
  state?: Partial<MotionState>;
}

export interface RenderSuiteResult {
  project: string;
  revision: number;
  suite: RenderSuiteKind;
  outputDirectory: string;
  artifacts: RenderArtifact[];
}

export interface RevisionComparisonResult {
  project: string;
  fromRevision: number;
  toRevision: number;
  outputDirectory: string;
  before: RenderSuiteResult;
  after: RenderSuiteResult;
  comparisonSheet: string;
  differenceImage: string;
}

export interface AssetRequest {
  id: string;
  kind: "closed-eye" | "mouth-shape";
  side: Side;
  variant?: MouthVariant;
  sourceLayerIds: string[];
  crop: Rect;
  reference?: {
    path: string;
  };
  output: {
    path: string;
    width: number;
    height: number;
    transparent: true;
  };
  prompt: string;
  constraints: string[];
  validation: {
    requireAlpha: true;
    maxOpaqueCoverage: number;
    minOpaqueCoverage: number;
  };
}

export interface AssetRequestDocument {
  version: 1;
  optional: true;
  requests: AssetRequest[];
}

export interface LayerInspection {
  id: string;
  sourceName: string;
  sourcePath: string[];
  role: SemanticRole;
  side: Side;
  bounds: Rect;
  opaquePixels: number;
  visible: boolean;
}

export interface InspectionReport {
  valid: boolean;
  input: string;
  canvas: Size;
  visibleLayerCount: number;
  recognizedLayerCount: number;
  unknownLayerCount: number;
  suggestedRigLevel: RigLevel;
  layers: LayerInspection[];
  warnings: string[];
}

export interface BuildReport {
  version: 1;
  project: string;
  rigLevel: RigLevel;
  layerCount: number;
  recognizedLayerCount: number;
  safetyScale: number;
  enabledFeatures: string[];
  disabledFeatures: string[];
  warnings: string[];
  quality: QualitySummary;
  assetRequestCount: number;
  landmarkCalibration?: SemanticControlCage["validation"] & { pointCount: number };
}

export interface BuildResult {
  project: PuppetLoomProject;
  report: BuildReport;
  assetRequests: AssetRequestDocument;
  outputDirectory: string;
}

export interface InspectOptions {
  input: string;
}

export interface CreateOptions {
  input: string;
  output: string;
  name?: string;
  reference?: string;
  seed?: number;
}

export interface EnhanceOptions {
  project: string;
  assets: string;
}

export interface EnhanceResult {
  accepted: string[];
  rejected: Array<{ requestId: string; reason: string }>;
  project: PuppetLoomProject;
}

export interface VerifyResult {
  valid: boolean;
  project: string;
  rigLevel: RigLevel;
  textureCount: number;
  missingTextures: string[];
  quality: QualitySummary;
  warnings: string[];
}

export interface MotionState {
  headYaw: number;
  headPitch: number;
  headRoll: number;
  bodySway: number;
  bodyPitch: number;
  bodyRoll: number;
  gazeX: number;
  gazeY: number;
  breath: number;
  hairX: number;
  hairY: number;
  ahogeX: number;
  ahogeY: number;
  backHairX: number;
  backHairY: number;
  headwearX: number;
  headwearY: number;
  earX: number;
  earY: number;
  clothX: number;
  clothY: number;
  tailX: number;
  tailY: number;
  accessoryX: number;
  accessoryY: number;
  secondary?: SecondaryMotionState;
  blink: number;
  mouthOpen: number;
}

export interface MotionChainState {
  x: number[];
  y: number[];
}

export interface SecondaryMotionState {
  frontHairLeft: MotionChainState;
  frontHairRight: MotionChainState;
  backHairLeft: MotionChainState;
  backHairRight: MotionChainState;
  ahoge: MotionChainState;
  headwear: MotionChainState;
  topCloth: MotionChainState;
  skirt: MotionChainState;
  tail: MotionChainState;
  accessory: MotionChainState;
}
