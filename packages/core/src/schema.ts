import { z } from "zod";

const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const rectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() });
const artMeshRegionSchema = z.object({
  outer: z.array(pointSchema).min(3),
  holes: z.array(z.array(pointSchema).min(3))
});
const artMeshSourceSchema = z.object({
  textureSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  alphaThreshold: z.number().int().min(0).max(255),
  detail: z.number().min(4).max(256),
  regions: z.array(artMeshRegionSchema).min(1)
});
const meshSchema = z.object({
  topology: z.enum(["art", "grid"]).optional(),
  rows: z.number().int().min(2).optional(),
  cols: z.number().int().min(2).optional(),
  art: artMeshSourceSchema.optional(),
  points: z.array(pointSchema),
  uvs: z.array(pointSchema),
  triangles: z.array(z.number().int().nonnegative()),
  influences: z.object({
    face: z.array(z.number().min(0).max(1)).optional(),
    skull: z.array(z.number().min(0).max(1)).optional(),
    head: z.array(z.number().min(0).max(1)).optional(),
    body: z.array(z.number().min(0).max(1)).optional(),
    gaze: z.array(z.number().min(0).max(1)).optional(),
    physics: z.array(z.number().min(0).max(1)).optional(),
    pin: z.array(z.number().min(0).max(1)).optional(),
    headAttachment: z.array(z.number().min(0).max(1)).optional(),
    physicsRelease: z.array(z.number().min(0).max(1)).optional()
  }).optional()
});
const hairStrandSchema = z.object({
  id: z.string().min(1),
  root: pointSchema,
  tip: pointSchema,
  width: z.number().positive().max(1),
  confidence: z.number().min(0).max(1),
  source: z.enum(["alpha-contour", "corrected"]),
  physics: z.object({
    stiffness: z.number().min(1).max(100),
    damping: z.number().min(0).max(40),
    segments: z.number().int().min(2).max(12),
    maxDisplacement: z.number().positive().max(0.5)
  }),
  weights: z.array(z.number().min(0).max(1)),
  release: z.array(z.number().min(0).max(1))
});
const semanticCagePointSchema = z.object({
  position: pointSchema,
  confidence: z.number().min(0).max(1),
  source: z.enum(["layer-alpha", "face-alpha", "head-alpha", "inferred", "corrected"])
});
const semanticCagePointIdSchema = z.enum([
  "headTop", "forehead", "skullLeft", "skullRight", "faceLeft", "faceRight",
  "eyeLeftOuter", "eyeLeft", "eyeLeftInner", "eyeRightInner", "eyeRight", "eyeRightOuter",
  "nose", "cheekLeft", "cheekRight", "mouthLeft", "mouth", "mouthRight",
  "jawLeft", "jawRight", "chin", "neckLeft", "neckRight"
]);
const semanticCagePointsSchema = z.object({
  headTop: semanticCagePointSchema,
  forehead: semanticCagePointSchema,
  skullLeft: semanticCagePointSchema,
  skullRight: semanticCagePointSchema,
  faceLeft: semanticCagePointSchema,
  faceRight: semanticCagePointSchema,
  eyeLeftOuter: semanticCagePointSchema,
  eyeLeft: semanticCagePointSchema,
  eyeLeftInner: semanticCagePointSchema,
  eyeRightInner: semanticCagePointSchema,
  eyeRight: semanticCagePointSchema,
  eyeRightOuter: semanticCagePointSchema,
  nose: semanticCagePointSchema,
  cheekLeft: semanticCagePointSchema,
  cheekRight: semanticCagePointSchema,
  mouthLeft: semanticCagePointSchema,
  mouth: semanticCagePointSchema,
  mouthRight: semanticCagePointSchema,
  jawLeft: semanticCagePointSchema,
  jawRight: semanticCagePointSchema,
  chin: semanticCagePointSchema,
  neckLeft: semanticCagePointSchema,
  neckRight: semanticCagePointSchema
});
const semanticCageTriangleSchema = z.tuple([semanticCagePointIdSchema, semanticCagePointIdSchema, semanticCagePointIdSchema]);
const faceDepthLandmarkSchema = z.enum(["forehead", "noseRoot", "noseTip", "upperLip", "lowerLip", "chin"]);
const faceDepthProfileSchema = z.object({
  kind: z.literal("semantic-depth-v1"),
  points: z.array(z.object({
    id: faceDepthLandmarkSchema,
    position: z.number().min(0).max(1),
    depth: z.number().min(-0.5).max(0.5)
  })).length(6)
}).superRefine((profile, context) => {
  const ids = new Set(profile.points.map((point) => point.id));
  if (ids.size !== profile.points.length) context.addIssue({ code: "custom", path: ["points"], message: "侧脸深度语义点不能重复。" });
  for (let index = 1; index < profile.points.length; index += 1) {
    if (profile.points[index]!.position <= profile.points[index - 1]!.position) {
      context.addIssue({ code: "custom", path: ["points", index, "position"], message: "侧脸深度语义点必须从额头到下巴严格递增。" });
      break;
    }
  }
});
const torsoVolumeLandmarkSchema = z.enum(["upperChest", "chest", "waist", "hip"]);
const torsoVolumeProfileSchema = z.object({
  kind: z.literal("torso-volume-v1"),
  strength: z.number().min(0).max(2),
  points: z.array(z.object({
    id: torsoVolumeLandmarkSchema,
    position: z.number().min(0).max(1),
    depth: z.number().min(-0.5).max(0.5)
  })).length(4)
}).superRefine((profile, context) => {
  if (new Set(profile.points.map((point) => point.id)).size !== profile.points.length) context.addIssue({ code: "custom", path: ["points"], message: "躯干体积语义点不能重复。" });
  for (let index = 1; index < profile.points.length; index += 1) {
    if (profile.points[index]!.position <= profile.points[index - 1]!.position) {
      context.addIssue({ code: "custom", path: ["points", index, "position"], message: "躯干体积语义点必须从肩部到髋部严格递增。" });
      break;
    }
  }
});

const motionParameterSemanticSchema = z.enum([
  "head-yaw", "head-pitch", "head-roll", "body-sway", "body-pitch", "body-roll",
  "gaze-x", "gaze-y", "breath", "blink", "mouth-open", "ear-x", "ear-y", "tail-x", "tail-y"
]);
const sparsePointMapSchema = z.record(z.string().regex(/^\d+$/), pointSchema);
const keyformTransformSchema = z.object({
  translation: pointSchema.optional(),
  rotationDegrees: z.number().finite().optional(),
  scale: z.object({ x: z.number().positive(), y: z.number().positive() }).optional()
});
const modelKeyformSchema = z.object({
  values: z.union([z.tuple([z.number().finite()]), z.tuple([z.number().finite(), z.number().finite()])]),
  meshPointDeltas: sparsePointMapSchema.optional(),
  warpPointDeltas: sparsePointMapSchema.optional(),
  transform: keyformTransformSchema.optional(),
  opacityMultiplier: z.number().min(0).max(4).optional(),
  drawOrderOffset: z.number().min(-10_000).max(10_000).optional()
});
const modelParameterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  group: z.string().min(1),
  kind: z.enum(["continuous", "toggle"]),
  min: z.number().finite(),
  default: z.number().finite(),
  max: z.number().finite(),
  semantic: motionParameterSemanticSchema.optional(),
  repeat: z.boolean().optional()
});
const modelDeformerSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().min(1), name: z.string().min(1), kind: z.literal("rotation"), parentId: z.string().min(1).optional(), pivot: pointSchema }),
  z.object({
    id: z.string().min(1), name: z.string().min(1), kind: z.literal("warp"), parentId: z.string().min(1).optional(),
    bounds: rectSchema, rows: z.number().int().min(2).max(64), cols: z.number().int().min(2).max(64), controlPoints: z.array(pointSchema)
  })
]);
const modelBindingSchema = z.object({
  id: z.string().min(1),
  parameterIds: z.union([z.tuple([z.string().min(1)]), z.tuple([z.string().min(1), z.string().min(1)])]),
  target: z.object({ kind: z.enum(["layer", "deformer"]), id: z.string().min(1) }),
  keyforms: z.array(modelKeyformSchema).min(1)
});
const modelExpressionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parameters: z.record(z.string().min(1), z.number().finite())
});
const modelPhysicsSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  inputParameterId: z.string().min(1),
  outputParameterId: z.string().min(1),
  inputScale: z.number().finite(),
  outputScale: z.number().finite(),
  response: z.number().min(0.1).max(30),
  damping: z.number().min(0).max(2)
});
const behaviorKeyframeSchema = z.object({
  time: z.number().min(0),
  value: z.number().finite(),
  easing: z.enum(["linear", "smoothstep", "hold"]).optional()
});
const modelBehaviorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  duration: z.number().positive().max(3_600),
  loop: z.boolean(),
  autoplay: z.boolean().optional(),
  tracks: z.array(z.object({
    target: z.object({ kind: z.enum(["parameter", "expression"]), id: z.string().min(1) }),
    keyframes: z.array(behaviorKeyframeSchema).min(1)
  })).min(1)
});
export const authoringModelSchema = z.object({
  parameters: z.array(modelParameterSchema),
  deformers: z.array(modelDeformerSchema),
  bindings: z.array(modelBindingSchema),
  expressions: z.array(modelExpressionSchema).default([]),
  physics: z.array(modelPhysicsSchema).default([]),
  behaviors: z.array(modelBehaviorSchema).default([])
});

const authoringOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert-parameter"), parameter: modelParameterSchema }),
  z.object({ op: z.literal("remove-parameter"), id: z.string().min(1), cascade: z.boolean().optional() }),
  z.object({ op: z.literal("upsert-deformer"), deformer: modelDeformerSchema }),
  z.object({ op: z.literal("remove-deformer"), id: z.string().min(1), cascade: z.boolean().optional() }),
  z.object({ op: z.literal("set-layer-deformer"), layerId: z.string().min(1), deformerId: z.string().min(1).nullable() }),
  z.object({ op: z.literal("upsert-binding"), binding: modelBindingSchema }),
  z.object({ op: z.literal("remove-binding"), id: z.string().min(1) }),
  z.object({ op: z.literal("upsert-expression"), expression: modelExpressionSchema }),
  z.object({ op: z.literal("remove-expression"), id: z.string().min(1), cascade: z.boolean().optional() }),
  z.object({ op: z.literal("upsert-physics"), physics: modelPhysicsSchema }),
  z.object({ op: z.literal("remove-physics"), id: z.string().min(1) }),
  z.object({ op: z.literal("upsert-behavior"), behavior: modelBehaviorSchema }),
  z.object({ op: z.literal("remove-behavior"), id: z.string().min(1) })
]);
const authoringPreviewSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  label: z.string().trim().min(1).max(80),
  parameters: z.record(z.string().min(1), z.number().finite()).optional(),
  expressions: z.record(z.string().min(1), z.number().min(0).max(1)).optional(),
  behavior: z.object({ id: z.string().min(1), timeSeconds: z.number().min(0) }).optional(),
  settleSeconds: z.number().min(0).max(10).optional()
}).refine((preview) => preview.parameters || preview.expressions || preview.behavior, { message: "Authoring 预览必须驱动参数、表情或行为。" });
const authoringAuditSchema = z.object({
  version: z.literal(1),
  operations: z.array(authoringOperationSchema).min(1).max(200),
  previews: z.array(authoringPreviewSchema).max(12)
});
export const authoringPatchSchema = z.object({
  version: z.literal(1),
  baseRevision: z.number().int().nonnegative(),
  label: z.string().trim().min(1).max(160).optional(),
  operations: z.array(authoringOperationSchema).min(1).max(200),
  previews: z.array(authoringPreviewSchema).max(12).optional()
});

export const puppetLoomProjectSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  name: z.string().min(1),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  source: z.object({
    originalFileName: z.string().min(1),
    psdSha256: z.string().regex(/^[a-f0-9]{64}$/),
    psdPath: z.string().min(1),
    referencePath: z.string().optional(),
    referenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }),
  rigLevel: z.enum(["semantic", "grouped", "minimal"]),
  layers: z.array(
    z.object({
      id: z.string().min(1),
      sourceName: z.string(),
      sourcePath: z.array(z.string()),
      role: z.enum([
        "backHair", "frontHair", "sideHair", "face", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth", "ear", "neck", "topWear", "bottomWear", "arm", "hand", "leg", "foot", "headwear", "tail", "accessory", "unknown"
      ]),
      side: z.enum(["left", "right", "center"]),
      order: z.number().int(),
      opacity: z.number().min(0).max(1),
      blendMode: z.string(),
      bounds: rectSchema,
      texture: z.string().min(1),
      pivot: pointSchema,
      garmentStructure: z.enum(["soft", "supported"]).optional(),
      garmentFlexibility: z.number().min(0).max(0.5).optional(),
      secondaryAnchors: z.object({
        earHingeLeft: pointSchema.optional(),
        earHingeRight: pointSchema.optional(),
        frontHairRoot: pointSchema.optional(),
        frontHairRootLeft: pointSchema.optional(),
        frontHairRootRight: pointSchema.optional(),
        frontHairTipLeft: pointSchema.optional(),
        frontHairTipRight: pointSchema.optional(),
        ahogeRoot: pointSchema.optional()
      }).optional(),
      hairStrands: z.array(hairStrandSchema).min(2).max(12).optional(),
      mesh: meshSchema,
      weights: z.object({ head: z.number(), body: z.number(), gaze: z.number(), physics: z.number() }),
      clipLayerId: z.string().optional(),
      mouthVariant: z.enum(["closed", "slight", "open"]).optional(),
      parentGroup: z.enum(["head", "body", "root"]),
      parentLayerId: z.string().min(1).optional(),
      deformerId: z.string().min(1).optional(),
      visible: z.boolean().optional(),
      locked: z.boolean().optional()
    })
  ).min(1),
  model: authoringModelSchema.optional(),
  anchors: z.object({
    headTop: pointSchema.optional(), forehead: pointSchema.optional(), eyeLeft: pointSchema.optional(), eyeRight: pointSchema.optional(), cheekLeft: pointSchema.optional(), cheekRight: pointSchema.optional(), nose: pointSchema.optional(), mouth: pointSchema.optional(), chin: pointSchema.optional(), neck: pointSchema.optional(), shoulderLeft: pointSchema.optional(), shoulderRight: pointSchema.optional(), bodyCenter: pointSchema.optional()
  }),
  runtime: z.object({
    seed: z.number().int(),
    profile: z.enum(["calm-v1", "coherent-v1", "coherent-v2", "coherent-v3"]),
    envelope: z.object({
      headYaw: z.number().nonnegative(), headPitch: z.number().nonnegative(), headRollDegrees: z.number().nonnegative(), bodySway: z.number().nonnegative(), bodyRollDegrees: z.number().nonnegative(), gazeX: z.number().nonnegative(), gazeY: z.number().nonnegative(), breath: z.number().nonnegative(), globalScale: z.number().positive()
    }),
    features: z.object({ headTurn: z.boolean(), bodyFollow: z.boolean(), gaze: z.boolean(), hairPhysics: z.boolean(), blink: z.boolean(), mouthMotion: z.boolean() }),
    poseField: z.object({
      kind: z.enum(["ellipsoid-v1", "head-surfaces-v2"]),
      center: pointSchema,
      radiusX: z.number().positive(),
      radiusY: z.number().positive(),
      skullCenter: pointSchema.optional(),
      skullRadiusX: z.number().positive().optional(),
      skullRadiusY: z.number().positive().optional(),
      maxYawRadians: z.number().positive(),
      maxPitchRadians: z.number().positive(),
      maxPitchUpRadians: z.number().positive().optional(),
      maxPitchDownRadians: z.number().positive().optional(),
      perspective: z.number().min(0).max(0.5),
      contourStrength: z.number().min(0.4).max(1.6).optional(),
      depthStrength: z.number().min(0.4).max(1.6).optional(),
      faceDepthProfile: faceDepthProfileSchema.optional()
    }).optional(),
    poseOcclusion: z.object({
      kind: z.literal("semantic-occlusion-v1"),
      fadeStart: z.number().min(0).max(0.95),
      farEyeOpacity: z.number().min(0).max(1),
      farBrowOpacity: z.number().min(0).max(1),
      farEarOpacity: z.number().min(0).max(1),
      farSideHairOpacity: z.number().min(0).max(1),
      sideHairDepthSwap: z.boolean()
    }).optional(),
    torsoVolumeProfile: torsoVolumeProfileSchema.optional(),
    semanticCage: z.object({
      kind: z.literal("semantic-face-cage-v1"),
      coordinateConvention: z.literal("screen-space"),
      points: semanticCagePointsSchema,
      faceTriangles: z.array(semanticCageTriangleSchema),
      skullTriangles: z.array(semanticCageTriangleSchema),
      roleGroups: z.object({
        face: z.array(z.enum(["backHair", "frontHair", "sideHair", "face", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth", "ear", "neck", "topWear", "bottomWear", "arm", "hand", "leg", "foot", "headwear", "tail", "accessory", "unknown"])),
        skull: z.array(z.enum(["backHair", "frontHair", "sideHair", "face", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth", "ear", "neck", "topWear", "bottomWear", "arm", "hand", "leg", "foot", "headwear", "tail", "accessory", "unknown"]))
      }),
      validation: z.object({
        status: z.enum(["passed", "corrected"]),
        confidence: z.number().min(0).max(1),
        corrections: z.array(z.string()),
        checks: z.array(z.string())
      })
    }).optional(),
    motionTuning: z.object({
      amplitude: z.number().min(0).max(1.5),
      response: z.number().min(0).max(1),
      stability: z.number().min(0).max(1)
    }).optional(),
    secondaryMotionTuning: z.partialRecord(
      z.enum(["frontHair", "backHair", "ahoge", "headwear", "ears", "topCloth", "skirt", "tail", "accessory"]),
      z.object({
        amplitude: z.number().min(0).max(1.5),
        response: z.number().min(0).max(1),
        stability: z.number().min(0).max(1)
      })
    ).optional()
  }),
  quality: z.object({
    neutralSimilarity: z.number().min(-1).max(1).optional(),
    poseValidations: z.array(z.object({ id: z.string(), headYaw: z.number(), headPitch: z.number(), headRoll: z.number(), score: z.number().min(0).max(1), passed: z.boolean(), issues: z.array(z.any()) })),
    safetyScale: z.number().min(0).max(1),
    issues: z.array(z.any())
  }),
  disabledReasons: z.array(z.string())
}).superRefine((project, context) => {
  const ids = new Set<string>();
  const hairStrandIds = new Set<string>();
  const relativeAsset = (value: string): boolean => !/^(?:[a-z]:|[/\\])/i.test(value) && !value.split(/[\\/]+/).some((part) => part === "..");
  if (!relativeAsset(project.source.psdPath)) context.addIssue({ code: "custom", path: ["source", "psdPath"], message: "PSD 路径必须位于项目目录内。" });
  if (project.source.referencePath && !relativeAsset(project.source.referencePath)) context.addIssue({ code: "custom", path: ["source", "referencePath"], message: "参考图路径必须位于项目目录内。" });
  for (let layerIndex = 0; layerIndex < project.layers.length; layerIndex += 1) {
    const layer = project.layers[layerIndex]!;
    if (ids.has(layer.id)) context.addIssue({ code: "custom", path: ["layers", layerIndex, "id"], message: `图层 ID 重复：${layer.id}` });
    ids.add(layer.id);
    if (!relativeAsset(layer.texture)) context.addIssue({ code: "custom", path: ["layers", layerIndex, "texture"], message: "纹理路径必须位于项目目录内。" });
    const meshTopology = layer.mesh.topology ?? "grid";
    if (project.version === 4 && !layer.mesh.topology) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "topology"], message: "v4 网格必须声明 topology。" });
    if (meshTopology === "grid") {
      if (layer.mesh.rows === undefined || layer.mesh.cols === undefined) {
        context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh"], message: "规则网格必须包含 rows 和 cols。" });
      } else {
        const expectedPoints = layer.mesh.rows * layer.mesh.cols;
        if (layer.mesh.points.length !== expectedPoints) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "points"], message: `网格点数应为 ${expectedPoints}。` });
      }
      if (layer.mesh.art) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "art"], message: "规则网格不能携带 ArtMesh 轮廓来源。" });
    } else if (!layer.mesh.art) {
      context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "art"], message: "Alpha ArtMesh 必须保存可重建的轮廓来源。" });
    } else {
      if (layer.mesh.rows !== undefined || layer.mesh.cols !== undefined) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh"], message: "Alpha ArtMesh 不使用 rows 或 cols。" });
      const contourPoints = layer.mesh.art.regions.flatMap((region) => [region.outer, ...region.holes]).flat();
      if (contourPoints.some((point) => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
        context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "art", "regions"], message: "ArtMesh 轮廓 UV 必须位于 0..1。" });
      }
    }
    if (layer.mesh.uvs.length !== layer.mesh.points.length) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "uvs"], message: "UV 数量必须与网格点数一致。" });
    if (layer.mesh.uvs.some((uv) => uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1)) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "uvs"], message: "UV 必须位于 0..1。" });
    if (layer.mesh.points.length > 65_535) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "points"], message: "WebGL 索引网格不能超过 65535 个点。" });
    if (layer.mesh.triangles.length % 3 !== 0) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "triangles"], message: "三角形索引数量必须是 3 的倍数。" });
    if (layer.mesh.triangles.some((index) => index >= layer.mesh.points.length || index > 65_535)) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "triangles"], message: "三角形引用了不存在或无法渲染的网格点。" });
    for (let triangleIndex = 0; triangleIndex < layer.mesh.triangles.length; triangleIndex += 3) {
      const indices = layer.mesh.triangles.slice(triangleIndex, triangleIndex + 3);
      if (indices.length === 3 && new Set(indices).size !== 3) {
        context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "triangles", triangleIndex], message: "三角形不能重复引用同一顶点。" });
        break;
      }
    }
    for (const [channel, values] of Object.entries(layer.mesh.influences ?? {})) {
      if (values && values.length !== layer.mesh.points.length) context.addIssue({ code: "custom", path: ["layers", layerIndex, "mesh", "influences", channel], message: "顶点权重数量必须与网格点数一致。" });
    }
    const strandIds = new Set<string>();
    if (layer.hairStrands && !["frontHair", "backHair", "sideHair"].includes(layer.role)) {
      context.addIssue({ code: "custom", path: ["layers", layerIndex, "hairStrands"], message: "只有前发、后发和侧发图层可以包含房束。" });
    }
    for (let strandIndex = 0; strandIndex < (layer.hairStrands?.length ?? 0); strandIndex += 1) {
      const strand = layer.hairStrands![strandIndex]!;
      if (strandIds.has(strand.id)) context.addIssue({ code: "custom", path: ["layers", layerIndex, "hairStrands", strandIndex, "id"], message: "同一图层的房束 ID 不能重复。" });
      if (hairStrandIds.has(strand.id)) context.addIssue({ code: "custom", path: ["layers", layerIndex, "hairStrands", strandIndex, "id"], message: "房束 ID 必须在整个项目中唯一。" });
      strandIds.add(strand.id);
      hairStrandIds.add(strand.id);
      if (strand.weights.length !== layer.mesh.points.length || strand.release.length !== layer.mesh.points.length) {
        context.addIssue({ code: "custom", path: ["layers", layerIndex, "hairStrands", strandIndex], message: "房束权重与释放数组必须对应全部网格顶点。" });
      }
    }
  }
  for (let layerIndex = 0; layerIndex < project.layers.length; layerIndex += 1) {
    const layer = project.layers[layerIndex]!;
    if (layer.clipLayerId && (!ids.has(layer.clipLayerId) || layer.clipLayerId === layer.id)) context.addIssue({ code: "custom", path: ["layers", layerIndex, "clipLayerId"], message: "裁剪图层引用无效。" });
    if (layer.parentLayerId && (!ids.has(layer.parentLayerId) || layer.parentLayerId === layer.id)) context.addIssue({ code: "custom", path: ["layers", layerIndex, "parentLayerId"], message: "父图层引用无效。" });
    const visited = new Set([layer.id]);
    let parentId = layer.parentLayerId;
    while (parentId) {
      if (visited.has(parentId)) {
        context.addIssue({ code: "custom", path: ["layers", layerIndex, "parentLayerId"], message: "父图层关系形成循环。" });
        break;
      }
      visited.add(parentId);
      parentId = project.layers.find((candidate) => candidate.id === parentId)?.parentLayerId;
    }
  }
  if (project.version >= 3 && !project.model) {
    context.addIssue({ code: "custom", path: ["model"], message: "v3 及以上项目必须包含 authoring model。" });
  }
  if (!project.model) return;
  const parameterIds = new Set<string>();
  const semantics = new Set<string>();
  for (let parameterIndex = 0; parameterIndex < project.model.parameters.length; parameterIndex += 1) {
    const parameter = project.model.parameters[parameterIndex]!;
    if (parameterIds.has(parameter.id)) context.addIssue({ code: "custom", path: ["model", "parameters", parameterIndex, "id"], message: `参数 ID 重复：${parameter.id}` });
    parameterIds.add(parameter.id);
    if (!(parameter.min <= parameter.default && parameter.default <= parameter.max) || parameter.min === parameter.max) {
      context.addIssue({ code: "custom", path: ["model", "parameters", parameterIndex], message: "参数必须满足 min < max 且 default 位于范围内。" });
    }
    if (parameter.semantic) {
      if (semantics.has(parameter.semantic)) context.addIssue({ code: "custom", path: ["model", "parameters", parameterIndex, "semantic"], message: `语义参数重复：${parameter.semantic}` });
      semantics.add(parameter.semantic);
    }
  }
  const deformerIds = new Set<string>();
  for (let deformerIndex = 0; deformerIndex < project.model.deformers.length; deformerIndex += 1) {
    const deformer = project.model.deformers[deformerIndex]!;
    if (deformerIds.has(deformer.id)) context.addIssue({ code: "custom", path: ["model", "deformers", deformerIndex, "id"], message: `变形器 ID 重复：${deformer.id}` });
    deformerIds.add(deformer.id);
    if (deformer.kind === "warp" && deformer.controlPoints.length !== deformer.rows * deformer.cols) {
      context.addIssue({ code: "custom", path: ["model", "deformers", deformerIndex, "controlPoints"], message: `网格变形器控制点数应为 ${deformer.rows * deformer.cols}。` });
    }
  }
  for (let deformerIndex = 0; deformerIndex < project.model.deformers.length; deformerIndex += 1) {
    const deformer = project.model.deformers[deformerIndex]!;
    if (deformer.parentId && (!deformerIds.has(deformer.parentId) || deformer.parentId === deformer.id)) {
      context.addIssue({ code: "custom", path: ["model", "deformers", deformerIndex, "parentId"], message: "父变形器引用无效。" });
    }
    const visited = new Set([deformer.id]);
    let parentId = deformer.parentId;
    while (parentId) {
      if (visited.has(parentId)) {
        context.addIssue({ code: "custom", path: ["model", "deformers", deformerIndex, "parentId"], message: "变形器层级形成循环。" });
        break;
      }
      visited.add(parentId);
      parentId = project.model.deformers.find((candidate) => candidate.id === parentId)?.parentId;
    }
  }
  for (let layerIndex = 0; layerIndex < project.layers.length; layerIndex += 1) {
    const deformerId = project.layers[layerIndex]!.deformerId;
    if (deformerId && !deformerIds.has(deformerId)) context.addIssue({ code: "custom", path: ["layers", layerIndex, "deformerId"], message: "图层引用了不存在的变形器。" });
  }
  const bindingIds = new Set<string>();
  for (let bindingIndex = 0; bindingIndex < project.model.bindings.length; bindingIndex += 1) {
    const binding = project.model.bindings[bindingIndex]!;
    if (bindingIds.has(binding.id)) context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "id"], message: `绑定 ID 重复：${binding.id}` });
    bindingIds.add(binding.id);
    if (new Set(binding.parameterIds).size !== binding.parameterIds.length || binding.parameterIds.some((id) => !parameterIds.has(id))) {
      context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "parameterIds"], message: "绑定引用了重复或不存在的参数。" });
    }
    const targetExists = binding.target.kind === "layer" ? ids.has(binding.target.id) : deformerIds.has(binding.target.id);
    if (!targetExists) context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "target"], message: "绑定目标不存在。" });
    const parameterRanges = binding.parameterIds.map((id) => project.model!.parameters.find((parameter) => parameter.id === id));
    const coordinates = new Set<string>();
    for (let keyformIndex = 0; keyformIndex < binding.keyforms.length; keyformIndex += 1) {
      const keyform = binding.keyforms[keyformIndex]!;
      if (keyform.values.length !== binding.parameterIds.length) context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "keyforms", keyformIndex, "values"], message: "关键形态坐标维度必须与绑定参数数量一致。" });
      const coordinate = keyform.values.join("\u0000");
      if (coordinates.has(coordinate)) context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "keyforms", keyformIndex, "values"], message: "关键形态坐标重复。" });
      coordinates.add(coordinate);
      keyform.values.forEach((value, axis) => {
        const parameter = parameterRanges[axis];
        if (parameter && (value < parameter.min || value > parameter.max)) context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "keyforms", keyformIndex, "values", axis], message: "关键形态坐标超出参数范围。" });
      });
      const targetLayer = binding.target.kind === "layer" ? project.layers.find((layer) => layer.id === binding.target.id) : undefined;
      const targetDeformer = binding.target.kind === "deformer" ? project.model.deformers.find((deformer) => deformer.id === binding.target.id) : undefined;
      if (keyform.meshPointDeltas && (!targetLayer || Object.keys(keyform.meshPointDeltas).some((index) => Number(index) >= targetLayer.mesh.points.length))) {
        context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "keyforms", keyformIndex, "meshPointDeltas"], message: "网格点增量只能引用目标图层已有的点。" });
      }
      if (keyform.warpPointDeltas && (targetDeformer?.kind !== "warp" || Object.keys(keyform.warpPointDeltas).some((index) => Number(index) >= targetDeformer.controlPoints.length))) {
        context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "keyforms", keyformIndex, "warpPointDeltas"], message: "控制点增量只能引用目标网格变形器已有的点。" });
      }
      if (binding.target.kind !== "layer" && (keyform.opacityMultiplier !== undefined || keyform.drawOrderOffset !== undefined)) {
        context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "keyforms", keyformIndex], message: "透明度和绘制顺序只适用于图层绑定。" });
      }
    }
    if (binding.parameterIds.length === 2) {
      const xValues = new Set(binding.keyforms.map((keyform) => keyform.values[0]));
      const yValues = new Set(binding.keyforms.map((keyform) => keyform.values[1]));
      if (binding.keyforms.length !== xValues.size * yValues.size) context.addIssue({ code: "custom", path: ["model", "bindings", bindingIndex, "keyforms"], message: "双参数绑定必须提供完整的矩形关键形态网格。" });
    }
  }
  const expressionIds = new Set<string>();
  for (let expressionIndex = 0; expressionIndex < project.model.expressions.length; expressionIndex += 1) {
    const expression = project.model.expressions[expressionIndex]!;
    if (expressionIds.has(expression.id)) context.addIssue({ code: "custom", path: ["model", "expressions", expressionIndex, "id"], message: `表情 ID 重复：${expression.id}` });
    expressionIds.add(expression.id);
    for (const [parameterId, value] of Object.entries(expression.parameters)) {
      const parameter = project.model.parameters.find((candidate) => candidate.id === parameterId);
      if (!parameter || value < parameter.min || value > parameter.max) context.addIssue({ code: "custom", path: ["model", "expressions", expressionIndex, "parameters", parameterId], message: "表情引用了不存在的参数或超出参数范围。" });
    }
  }
  const physicsIds = new Set<string>();
  const physicsOutputs = new Set<string>();
  for (let physicsIndex = 0; physicsIndex < project.model.physics.length; physicsIndex += 1) {
    const physics = project.model.physics[physicsIndex]!;
    if (physicsIds.has(physics.id)) context.addIssue({ code: "custom", path: ["model", "physics", physicsIndex, "id"], message: `物理组 ID 重复：${physics.id}` });
    physicsIds.add(physics.id);
    if (!parameterIds.has(physics.inputParameterId) || !parameterIds.has(physics.outputParameterId) || physics.inputParameterId === physics.outputParameterId) {
      context.addIssue({ code: "custom", path: ["model", "physics", physicsIndex], message: "物理组必须引用两个不同且存在的输入、输出参数。" });
    }
    if (physicsOutputs.has(physics.outputParameterId)) context.addIssue({ code: "custom", path: ["model", "physics", physicsIndex, "outputParameterId"], message: "一个参数只能由一个物理组输出。" });
    physicsOutputs.add(physics.outputParameterId);
    const visited = new Set([physics.inputParameterId]);
    let current = physics.outputParameterId;
    while (current) {
      if (visited.has(current)) {
        context.addIssue({ code: "custom", path: ["model", "physics", physicsIndex], message: "物理参数依赖形成循环。" });
        break;
      }
      visited.add(current);
      current = project.model.physics.find((candidate) => candidate.inputParameterId === current)?.outputParameterId ?? "";
    }
  }
  const behaviorIds = new Set<string>();
  for (let behaviorIndex = 0; behaviorIndex < project.model.behaviors.length; behaviorIndex += 1) {
    const behavior = project.model.behaviors[behaviorIndex]!;
    if (behaviorIds.has(behavior.id)) context.addIssue({ code: "custom", path: ["model", "behaviors", behaviorIndex, "id"], message: `行为 ID 重复：${behavior.id}` });
    behaviorIds.add(behavior.id);
    for (let trackIndex = 0; trackIndex < behavior.tracks.length; trackIndex += 1) {
      const track = behavior.tracks[trackIndex]!;
      const targetExists = track.target.kind === "parameter" ? parameterIds.has(track.target.id) : expressionIds.has(track.target.id);
      if (!targetExists) context.addIssue({ code: "custom", path: ["model", "behaviors", behaviorIndex, "tracks", trackIndex, "target"], message: "行为轨道目标不存在。" });
      let previousTime = -1;
      for (let keyframeIndex = 0; keyframeIndex < track.keyframes.length; keyframeIndex += 1) {
        const keyframe = track.keyframes[keyframeIndex]!;
        if (keyframe.time <= previousTime || keyframe.time > behavior.duration) context.addIssue({ code: "custom", path: ["model", "behaviors", behaviorIndex, "tracks", trackIndex, "keyframes", keyframeIndex, "time"], message: "行为关键帧时间必须严格递增且不超过 duration。" });
        previousTime = keyframe.time;
        const parameter = track.target.kind === "parameter" ? project.model.parameters.find((candidate) => candidate.id === track.target.id) : undefined;
        if ((parameter && (keyframe.value < parameter.min || keyframe.value > parameter.max)) || (track.target.kind === "expression" && (keyframe.value < 0 || keyframe.value > 1))) {
          context.addIssue({ code: "custom", path: ["model", "behaviors", behaviorIndex, "tracks", trackIndex, "keyframes", keyframeIndex, "value"], message: "行为关键帧值超出目标范围。" });
        }
      }
    }
  }
});

const anchorOverrideSchema = z.object({
  headTop: pointSchema.optional(), forehead: pointSchema.optional(), eyeLeft: pointSchema.optional(), eyeRight: pointSchema.optional(), cheekLeft: pointSchema.optional(), cheekRight: pointSchema.optional(), nose: pointSchema.optional(), mouth: pointSchema.optional(), chin: pointSchema.optional(), neck: pointSchema.optional(), shoulderLeft: pointSchema.optional(), shoulderRight: pointSchema.optional(), bodyCenter: pointSchema.optional()
}).partial();

const secondaryAnchorOverrideSchema = z.object({
  earHingeLeft: pointSchema.optional(),
  earHingeRight: pointSchema.optional(),
  frontHairRoot: pointSchema.optional(),
  frontHairRootLeft: pointSchema.optional(),
  frontHairRootRight: pointSchema.optional(),
  frontHairTipLeft: pointSchema.optional(),
  frontHairTipRight: pointSchema.optional(),
  ahogeRoot: pointSchema.optional()
}).partial();

const meshPointDeltasSchema = z.record(z.string().regex(/^\d+$/), z.object({
  x: z.number().min(-0.25).max(0.25),
  y: z.number().min(-0.25).max(0.25)
}));

const vertexInfluencePatchSchema = z.record(z.string().regex(/^\d+$/), z.number().min(0).max(1));

const layerCalibrationOverrideSchema = z.object({
  role: z.enum([
    "backHair", "frontHair", "sideHair", "face", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth", "ear", "neck", "topWear", "bottomWear", "arm", "hand", "leg", "foot", "headwear", "tail", "accessory", "unknown"
  ]).optional(),
  side: z.enum(["left", "right", "center"]).optional(),
  parentGroup: z.enum(["head", "body", "root"]).optional(),
  parentLayerId: z.string().min(1).nullable().optional(),
  deformerId: z.string().min(1).nullable().optional(),
  order: z.number().int().optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  pivot: pointSchema.optional(),
  garmentStructure: z.enum(["soft", "supported"]).optional(),
  garmentFlexibility: z.number().min(0).max(0.5).optional(),
  secondaryAnchors: secondaryAnchorOverrideSchema.optional(),
  hairStrands: z.array(hairStrandSchema).min(2).max(12).optional(),
  weights: z.object({
    head: z.number().min(0).max(1).optional(),
    body: z.number().min(0).max(1).optional(),
    gaze: z.number().min(0).max(1).optional(),
    physics: z.number().min(0).max(1).optional()
  }).partial().optional(),
  mesh: meshSchema.optional(),
  meshPointDeltas: meshPointDeltasSchema.optional(),
  meshDetail: z.number().min(4).max(256).optional(),
  vertexInfluences: z.object({
    face: vertexInfluencePatchSchema.optional(),
    skull: vertexInfluencePatchSchema.optional(),
    head: vertexInfluencePatchSchema.optional(),
    body: vertexInfluencePatchSchema.optional(),
    gaze: vertexInfluencePatchSchema.optional(),
    physics: vertexInfluencePatchSchema.optional(),
    pin: vertexInfluencePatchSchema.optional(),
    headAttachment: vertexInfluencePatchSchema.optional(),
    physicsRelease: vertexInfluencePatchSchema.optional()
  }).partial().optional(),
  meshDensity: z.object({ rows: z.number().int().min(2).max(64), cols: z.number().int().min(2).max(64) }).optional()
}).refine((override) => override.meshDetail === undefined || override.meshDensity === undefined, { message: "不能同时按细节尺度和行列数重建网格。" });

export const calibrationOverridesSchema = z.object({
  model: authoringModelSchema.optional(),
  anchors: anchorOverrideSchema.optional(),
  semanticPoints: z.partialRecord(semanticCagePointIdSchema, pointSchema).optional(),
  layers: z.record(z.string().min(1), layerCalibrationOverrideSchema).optional(),
  runtime: z.object({
    envelope: z.object({
      headYaw: z.number().min(0).max(1).optional(),
      headPitch: z.number().min(0).max(1).optional(),
      headRollDegrees: z.number().min(0).max(45).optional(),
      bodySway: z.number().min(0).max(0.25).optional(),
      bodyRollDegrees: z.number().min(0).max(30).optional(),
      gazeX: z.number().min(0).max(1).optional(),
      gazeY: z.number().min(0).max(1).optional(),
      breath: z.number().min(0).max(0.08).optional(),
      globalScale: z.number().min(0.5).max(1.5).optional()
    }).partial().optional(),
    poseField: z.object({
      maxYawRadians: z.number().min(0.08).max(0.7).optional(),
      maxPitchRadians: z.number().min(0.06).max(0.55).optional(),
      maxPitchUpRadians: z.number().min(0.06).max(0.55).optional(),
      maxPitchDownRadians: z.number().min(0.06).max(0.55).optional(),
      perspective: z.number().min(0).max(0.5).optional(),
      contourStrength: z.number().min(0.4).max(1.6).optional(),
      depthStrength: z.number().min(0.4).max(1.6).optional(),
      faceDepthProfile: faceDepthProfileSchema.optional()
    }).partial().optional(),
    poseOcclusion: z.object({
      fadeStart: z.number().min(0).max(0.95).optional(),
      farEyeOpacity: z.number().min(0).max(1).optional(),
      farBrowOpacity: z.number().min(0).max(1).optional(),
      farEarOpacity: z.number().min(0).max(1).optional(),
      farSideHairOpacity: z.number().min(0).max(1).optional(),
      sideHairDepthSwap: z.boolean().optional()
    }).partial().optional(),
    torsoVolumeProfile: torsoVolumeProfileSchema.optional(),
    motionTuning: z.object({
      amplitude: z.number().min(0).max(1.5).optional(),
      response: z.number().min(0).max(1).optional(),
      stability: z.number().min(0).max(1).optional()
    }).partial().optional(),
    secondaryMotionTuning: z.partialRecord(
      z.enum(["frontHair", "backHair", "ahoge", "headwear", "ears", "topCloth", "skirt", "tail", "accessory"]),
      z.object({
        amplitude: z.number().min(0).max(1.5).optional(),
        response: z.number().min(0).max(1).optional(),
        stability: z.number().min(0).max(1).optional()
      }).partial()
    ).optional()
  }).optional()
});

export const calibrationPatchSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  label: z.string().trim().min(1).max(160).optional(),
  overrides: calibrationOverridesSchema,
  authoring: authoringAuditSchema.optional(),
  clear: z.object({
    model: z.boolean().optional(),
    anchors: z.array(z.enum(["headTop", "forehead", "eyeLeft", "eyeRight", "cheekLeft", "cheekRight", "nose", "mouth", "chin", "neck", "shoulderLeft", "shoulderRight", "bodyCenter"])).optional(),
    semanticPoints: z.array(semanticCagePointIdSchema).optional(),
    layers: z.array(z.string().min(1)).optional(),
    runtime: z.array(z.enum(["envelope", "poseField", "poseOcclusion", "torsoVolumeProfile", "motionTuning", "secondaryMotionTuning"])).optional()
  }).optional()
});

export const calibrationDocumentSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  baseProjectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  label: z.string().trim().min(1).max(160).optional(),
  overrides: calibrationOverridesSchema,
  headSessionId: z.string().min(1).optional()
});

export const calibrationSessionSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  label: z.string().trim().min(1).max(160),
  fromRevision: z.number().int().nonnegative(),
  toRevision: z.number().int().positive(),
  beforeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  afterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  patch: calibrationPatchSchema,
  beforeOverrides: calibrationOverridesSchema,
  afterOverrides: calibrationOverridesSchema,
  evidenceStatus: z.enum(["unreviewed", "accepted", "rejected"]),
  parentSessionId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  evidenceDirectory: z.string().min(1).optional()
});

export const calibrationOperationSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  kind: z.literal("calibration-commit"),
  status: z.enum(["pending", "succeeded", "failed", "interrupted"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  baseRevision: z.number().int().nonnegative(),
  targetRevision: z.number().int().positive(),
  sessionId: z.string().min(1),
  processId: z.number().int().positive(),
  evidenceDirectory: z.string().min(1),
  sessionPath: z.string().min(1).optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional()
});

export const calibrationDraftSchema = z.object({
  version: z.literal(1),
  baseProjectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  baseRevision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  label: z.string().trim().min(1).max(160).optional(),
  overrides: calibrationOverridesSchema
});

export const assetRequestDocumentSchema = z.object({
  version: z.literal(1),
  optional: z.literal(true),
  requests: z.array(z.object({
    id: z.string(),
    kind: z.enum(["closed-eye", "mouth-shape"]),
    side: z.enum(["left", "right", "center"]),
    variant: z.enum(["closed", "slight", "open"]).optional(),
    sourceLayerIds: z.array(z.string()),
    crop: rectSchema,
    reference: z.object({ path: z.string().min(1) }).optional(),
    output: z.object({ path: z.string(), width: z.number().int().positive(), height: z.number().int().positive(), transparent: z.literal(true) }),
    prompt: z.string(),
    constraints: z.array(z.string()),
    validation: z.object({ requireAlpha: z.literal(true), maxOpaqueCoverage: z.number(), minOpaqueCoverage: z.number() })
  }))
});
