import { z } from "zod";

const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const rectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() });
const meshSchema = z.object({
  rows: z.number().int().min(2),
  cols: z.number().int().min(2),
  points: z.array(pointSchema),
  uvs: z.array(pointSchema),
  triangles: z.array(z.number().int().nonnegative())
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

export const puppetLoomProjectSchema = z.object({
  version: z.literal(1),
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
      mesh: meshSchema,
      weights: z.object({ head: z.number(), body: z.number(), gaze: z.number(), physics: z.number() }),
      clipLayerId: z.string().optional(),
      mouthVariant: z.enum(["closed", "slight", "open"]).optional(),
      parentGroup: z.enum(["head", "body", "root"])
    })
  ).min(1),
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
      perspective: z.number().min(0).max(0.5)
    }).optional(),
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
    }).optional()
  }),
  quality: z.object({
    neutralSimilarity: z.number().min(-1).max(1).optional(),
    poseValidations: z.array(z.object({ id: z.string(), headYaw: z.number(), headPitch: z.number(), headRoll: z.number(), score: z.number().min(0).max(1), passed: z.boolean(), issues: z.array(z.any()) })),
    safetyScale: z.number().min(0).max(1),
    issues: z.array(z.any())
  }),
  disabledReasons: z.array(z.string())
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
