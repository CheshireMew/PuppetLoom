export const PUPPETLOOM_PROJECT_VERSION = 1 as const;

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
}

export interface LayerWeights {
  head: number;
  body: number;
  gaze: number;
  physics: number;
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
    profile: "calm-v1" | "coherent-v1" | "coherent-v2";
  envelope: MotionEnvelope;
  features: RuntimeFeatures;
  poseField?: CoherentPoseField;
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
  earX: number;
  earY: number;
  clothX: number;
  clothY: number;
  tailX: number;
  tailY: number;
  accessoryX: number;
  accessoryY: number;
  blink: number;
  mouthOpen: number;
}
