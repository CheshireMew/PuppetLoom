export const PUPPETLOOM_PROJECT_VERSION = 4 as const;

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

export interface ArtMeshRegion {
  /** Outer Alpha contour in texture-local UV coordinates. */
  outer: Point[];
  /** Transparent contours fully enclosed by the outer contour. */
  holes: Point[][];
}

export interface ArtMeshSource {
  textureSize: Size;
  alphaThreshold: number;
  /** Desired interior edge length in source-texture pixels. */
  detail: number;
  regions: ArtMeshRegion[];
}

export interface MeshBinding {
  /** Art meshes follow Alpha contours; grid meshes are legacy or rectangular fallbacks. */
  topology: "art" | "grid";
  rows?: number;
  cols?: number;
  art?: ArtMeshSource;
  points: Point[];
  uvs: Point[];
  triangles: number[];
  influences?: MeshInfluences;
}

export type MeshInfluenceChannel = "face" | "skull" | "head" | "body" | "gaze" | "physics" | "pin";

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
  parentLayerId?: string;
  /** Direct parent in the authored deformer hierarchy. */
  deformerId?: string;
  visible?: boolean;
  locked?: boolean;
}

export type MotionParameterSemantic =
  | "head-yaw"
  | "head-pitch"
  | "head-roll"
  | "body-sway"
  | "body-pitch"
  | "body-roll"
  | "gaze-x"
  | "gaze-y"
  | "breath"
  | "blink"
  | "mouth-open";

export interface ModelParameter {
  id: string;
  name: string;
  group: string;
  kind: "continuous" | "toggle";
  min: number;
  default: number;
  max: number;
  semantic?: MotionParameterSemantic;
  repeat?: boolean;
}

interface DeformerBase {
  id: string;
  name: string;
  parentId?: string;
}

export interface RotationDeformer extends DeformerBase {
  kind: "rotation";
  pivot: Point;
}

export interface WarpDeformer extends DeformerBase {
  kind: "warp";
  bounds: Rect;
  rows: number;
  cols: number;
  controlPoints: Point[];
}

export type ModelDeformer = RotationDeformer | WarpDeformer;

export interface KeyformTransform {
  translation?: Point;
  rotationDegrees?: number;
  scale?: Point;
}

export interface ModelKeyform {
  values: [number] | [number, number];
  /** Sparse layer mesh deltas keyed by zero-based vertex index. */
  meshPointDeltas?: Record<string, Point>;
  /** Sparse warp-deformer control point deltas keyed by zero-based point index. */
  warpPointDeltas?: Record<string, Point>;
  transform?: KeyformTransform;
  opacityMultiplier?: number;
  drawOrderOffset?: number;
}

export interface ModelBinding {
  id: string;
  parameterIds: [string] | [string, string];
  target: { kind: "layer" | "deformer"; id: string };
  keyforms: ModelKeyform[];
}

export interface ModelExpression {
  id: string;
  name: string;
  parameters: Record<string, number>;
}

export interface ModelPhysics {
  id: string;
  name: string;
  inputParameterId: string;
  outputParameterId: string;
  inputScale: number;
  outputScale: number;
  response: number;
  damping: number;
}

export interface BehaviorKeyframe {
  time: number;
  value: number;
  easing?: "linear" | "smoothstep" | "hold";
}

export interface BehaviorTrack {
  target: { kind: "parameter" | "expression"; id: string };
  keyframes: BehaviorKeyframe[];
}

export interface ModelBehavior {
  id: string;
  name: string;
  duration: number;
  loop: boolean;
  autoplay?: boolean;
  tracks: BehaviorTrack[];
}

export interface AuthoringModel {
  parameters: ModelParameter[];
  deformers: ModelDeformer[];
  bindings: ModelBinding[];
  expressions: ModelExpression[];
  physics: ModelPhysics[];
  behaviors: ModelBehavior[];
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
  /** Optional asymmetric pitch limits for materials with different up/down headroom. */
  maxPitchUpRadians?: number;
  maxPitchDownRadians?: number;
  perspective: number;
}

export interface MotionTuning {
  amplitude: number;
  response: number;
  stability: number;
}

export type SecondaryMotionPart =
  | "frontHair"
  | "backHair"
  | "ahoge"
  | "headwear"
  | "ears"
  | "topCloth"
  | "skirt"
  | "tail"
  | "accessory";

export type SecondaryMotionTuning = Partial<Record<SecondaryMotionPart, MotionTuning>>;

export interface RuntimeSettings {
  seed: number;
  profile: "calm-v1" | "coherent-v1" | "coherent-v2" | "coherent-v3";
  envelope: MotionEnvelope;
  features: RuntimeFeatures;
  poseField?: CoherentPoseField;
  semanticCage?: SemanticControlCage;
  motionTuning?: MotionTuning;
  secondaryMotionTuning?: SecondaryMotionTuning;
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
  model: AuthoringModel;
  anchors: AnchorGraph;
  runtime: RuntimeSettings;
  quality: QualitySummary;
  disabledReasons: string[];
}

export interface LayerCalibrationOverride {
  role?: SemanticRole;
  side?: Side;
  parentGroup?: LayerBinding["parentGroup"];
  parentLayerId?: string | null;
  deformerId?: string | null;
  order?: number;
  visible?: boolean;
  locked?: boolean;
  pivot?: Point;
  secondaryAnchors?: LayerSecondaryAnchors;
  weights?: Partial<LayerWeights>;
  /** Complete replacement mesh, used to non-destructively upgrade legacy grids in calibration. */
  mesh?: MeshBinding;
  meshPointDeltas?: Record<string, Point>;
  vertexInfluences?: Partial<Record<MeshInfluenceChannel, Record<string, number>>>;
  meshDetail?: number;
  /** Legacy rectangular-grid control retained for v1-v3 project calibration. */
  meshDensity?: { rows: number; cols: number };
}

export interface CalibrationOverrides {
  model?: AuthoringModel;
  anchors?: Partial<AnchorGraph>;
  semanticPoints?: Partial<Record<SemanticCagePointId, Point>>;
  layers?: Record<string, LayerCalibrationOverride>;
  runtime?: {
    envelope?: Partial<MotionEnvelope>;
    poseField?: Partial<Pick<CoherentPoseField, "maxYawRadians" | "maxPitchRadians" | "maxPitchUpRadians" | "maxPitchDownRadians" | "perspective">>;
    motionTuning?: Partial<MotionTuning>;
    secondaryMotionTuning?: Partial<Record<SecondaryMotionPart, Partial<MotionTuning>>>;
  };
}

export interface CalibrationDocument {
  version: 1 | 2;
  baseProjectSha256: string;
  revision: number;
  updatedAt: string;
  label?: string;
  overrides: CalibrationOverrides;
  /** Reachable history head. Absent only on legacy version-1 projects. */
  headSessionId?: string;
}

export interface CalibrationPatch {
  /** Compare-and-swap precondition supplied by the editor or CLI. */
  baseRevision: number;
  label?: string;
  overrides: CalibrationOverrides;
  authoring?: AuthoringAudit;
  clear?: {
    model?: boolean;
    anchors?: Array<keyof AnchorGraph>;
    semanticPoints?: SemanticCagePointId[];
    layers?: string[];
    runtime?: Array<"envelope" | "poseField" | "motionTuning" | "secondaryMotionTuning">;
  };
}

export type AuthoringOperation =
  | { op: "upsert-parameter"; parameter: ModelParameter }
  | { op: "remove-parameter"; id: string; cascade?: boolean }
  | { op: "upsert-deformer"; deformer: ModelDeformer }
  | { op: "remove-deformer"; id: string; cascade?: boolean }
  | { op: "set-layer-deformer"; layerId: string; deformerId: string | null }
  | { op: "upsert-binding"; binding: ModelBinding }
  | { op: "remove-binding"; id: string }
  | { op: "upsert-expression"; expression: ModelExpression }
  | { op: "remove-expression"; id: string; cascade?: boolean }
  | { op: "upsert-physics"; physics: ModelPhysics }
  | { op: "remove-physics"; id: string }
  | { op: "upsert-behavior"; behavior: ModelBehavior }
  | { op: "remove-behavior"; id: string };

export interface AuthoringPreview {
  id: string;
  label: string;
  parameters?: Record<string, number>;
  expressions?: Record<string, number>;
  behavior?: { id: string; timeSeconds: number };
  /** Simulate authored parameter physics for this many seconds before rendering. */
  settleSeconds?: number;
}

export interface AuthoringAudit {
  version: 1;
  operations: AuthoringOperation[];
  previews: AuthoringPreview[];
}

export interface AuthoringPatch {
  version: 1;
  baseRevision: number;
  label?: string;
  operations: AuthoringOperation[];
  previews?: AuthoringPreview[];
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
  parentSessionId?: string;
  operationId?: string;
  evidenceDirectory?: string;
}

export type DurableOperationStatus = "pending" | "succeeded" | "failed" | "interrupted";

export interface CalibrationOperationDocument {
  version: 1;
  id: string;
  kind: "calibration-commit";
  status: DurableOperationStatus;
  createdAt: string;
  updatedAt: string;
  baseRevision: number;
  targetRevision: number;
  sessionId: string;
  processId: number;
  evidenceDirectory: string;
  sessionPath?: string;
  completedAt?: string;
  error?: string;
}

export interface CalibrationSaveResult {
  project: PuppetLoomProject;
  calibration: CalibrationDocument;
  session: CalibrationSessionDocument;
  sessionPath: string;
  evidence: RevisionComparisonResult;
  operation: CalibrationOperationDocument;
}

export interface CalibrationDraftDocument {
  version: 1;
  baseProjectSha256: string;
  baseRevision: number;
  updatedAt: string;
  label?: string;
  overrides: CalibrationOverrides;
}

export interface LayerAlphaTopology {
  textureSize: Size;
  opaquePixels: number;
  alphaThreshold: number;
  minimumMeaningfulPixels: number;
  componentCount: number;
  ignoredTinyComponentCount: number;
  components: Array<{
    index: number;
    pixelCount: number;
    bounds: Rect;
  }>;
}

export interface DetailedMeshPoint {
  index: number;
  row?: number;
  col?: number;
  basePosition: Point;
  position: Point;
  delta: Point;
  uv: Point;
  influences: Record<MeshInfluenceChannel, number>;
}

export interface DetailedLayerDescription {
  id: string;
  sourceName: string;
  sourcePath: string[];
  role: SemanticRole;
  side: Side;
  opacity: number;
  blendMode: string;
  texture: string;
  parentGroup: LayerBinding["parentGroup"];
  parentLayerId?: string;
  order: number;
  visible: boolean;
  locked: boolean;
  bounds: Rect;
  pivot: Point;
  secondaryAnchors?: LayerSecondaryAnchors;
  weights: LayerWeights;
  clipLayerId?: string;
  mouthVariant?: MouthVariant;
  alphaTopology: LayerAlphaTopology;
  mesh: {
    topology: MeshBinding["topology"];
    rows?: number;
    cols?: number;
    detail?: number;
    regionCount?: number;
    holeCount?: number;
    points: DetailedMeshPoint[];
    triangles: number[];
  };
}

export interface ProjectDescription {
  project: string;
  directory: string;
  version: number;
  calibrationRevision: number;
  baseProjectSha256: string;
  coordinateSystem: {
    unit: "normalized-canvas";
    origin: "top-left";
    xAxis: "right";
    yAxis: "down";
    sideConvention: "anatomical";
    note: string;
  };
  canvas: Size;
  rigLevel: RigLevel;
  anchors: AnchorGraph;
  semanticPoints: Partial<Record<SemanticCagePointId, SemanticCagePoint>>;
  runtime: RuntimeSettings;
  model: AuthoringModel;
  layers: Array<{
    id: string;
    sourceName: string;
    sourcePath: string[];
    role: SemanticRole;
    side: Side;
    opacity: number;
    blendMode: string;
    texture: string;
    parentGroup: LayerBinding["parentGroup"];
    parentLayerId?: string;
    deformerId?: string;
    order: number;
    visible: boolean;
    locked: boolean;
    bounds: Rect;
    pivot: Point;
    secondaryAnchors?: LayerSecondaryAnchors;
    mesh: {
      topology: MeshBinding["topology"];
      rows?: number;
      cols?: number;
      detail?: number;
      regionCount?: number;
      holeCount?: number;
      pointCount: number;
      triangleCount: number;
    };
    weights: LayerWeights;
  }>;
  selectedLayer?: DetailedLayerDescription;
}

export interface MigrationLayerMatch {
  sourceLayerId: string;
  targetLayerId?: string;
  sourcePath: string[];
  status: "exact" | "geometry-changed" | "missing" | "ambiguous";
  migratedFields: string[];
  skippedFields: string[];
}

export interface MigrationOptions {
  project: string;
  input: string;
  output: string;
  reference?: string;
  seed?: number;
  name?: string;
}

export interface MigrationResult {
  sourceProject: string;
  sourceRevision: number;
  outputDirectory: string;
  appliedRevision?: number;
  mapping: MigrationLayerMatch[];
  warnings: string[];
  patchPath: string;
  reportPath: string;
}

export type RenderSuiteKind = "calibration" | "poses" | "motion";

export interface RenderArtifact {
  id: string;
  kind: "pose" | "motion" | "sheet" | "difference";
  path: string;
  state?: Partial<MotionState>;
  sha256: string;
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
  visualDifference: {
    /** Pixels with any channel-level difference. */
    changedPixelRatio: number;
    /** Mean absolute channel difference normalized to the 0..1 range. */
    meanAbsoluteDifference: number;
    /** Pixels whose largest channel difference is greater than 12/255. */
    significantPixelRatio: number;
  };
  artifactSha256: Record<"beforeEvidence" | "afterEvidence" | "comparisonSheet" | "differenceImage", string>;
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
  invalidTextures: Array<{ path: string; reason: string }>;
  sourceIssues: string[];
  historyIssues: string[];
  evidenceIssues: string[];
  quality: QualitySummary;
  warnings: string[];
}

export interface PortableExportOptions {
  project: string;
  output: string;
}

export interface PortableExportManifest {
  version: 1;
  project: string;
  sourceDirectory: string;
  sourceRevision: number;
  exportedAt: string;
  files: string[];
}

export interface PortableExportResult {
  outputDirectory: string;
  manifest: PortableExportManifest;
  verification: VerifyResult;
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
  /** Explicit authored parameter values. These take precedence over semantic motion fields. */
  parameters?: Record<string, number>;
  /** Named expression weights in 0..1. */
  expressions?: Record<string, number>;
  /** One explicitly selected behavior and its local playback time. */
  behavior?: { id: string; timeSeconds: number };
  /** Runtime clock used by autoplay behaviors and model physics. */
  timeSeconds?: number;
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
