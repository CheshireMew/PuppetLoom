import { describe, expect, it } from "vitest";
import type { ImportedLayer, ImportedPsd } from "../src/psd.js";
import { applyCoherentPoseField } from "../src/pose-field.js";
import { buildRig } from "../src/rig.js";
import { safetyPoseState, validatePose } from "../src/safety.js";
import { buildSemanticControlCage } from "../src/semantic-cage.js";
import type { SemanticRole, Side } from "../src/types.js";

function layer(id: string, role: SemanticRole, side: Side, x: number, y: number, width: number, height: number): ImportedLayer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;
  return {
    id,
    sourceName: id,
    sourcePath: [id],
    role,
    side,
    order: 0,
    opacity: 1,
    blendMode: "normal",
    bounds: { x, y, width, height },
    opaquePixels: width * height,
    pixels: { width, height, data }
  };
}

function fixture(): ImportedPsd {
  return {
    input: "semantic-cage.psd",
    fileName: "semantic-cage.psd",
    canvas: { width: 1000, height: 1000 },
    warnings: [],
    layers: [
      layer("back-hair", "backHair", "center", 290, 70, 420, 540),
      layer("front-hair", "frontHair", "center", 330, 80, 340, 410),
      layer("face", "face", "center", 360, 180, 280, 360),
      layer("eye-screen-left", "eyeWhite", "right", 405, 300, 72, 42),
      layer("eye-screen-right", "eyeWhite", "left", 523, 300, 72, 42),
      layer("iris-screen-left", "iris", "right", 428, 304, 30, 36),
      layer("iris-screen-right", "iris", "left", 546, 304, 30, 36),
      layer("nose-outlier", "nose", "center", 470, 255, 60, 35),
      layer("mouth", "mouth", "center", 462, 425, 76, 24),
      layer("neck", "neck", "center", 455, 525, 90, 130),
      layer("top", "topWear", "center", 320, 620, 360, 240)
    ]
  };
}

function rigFixture() {
  const imported = fixture();
  return buildRig({
    imported,
    name: "semantic-cage",
    seed: 42,
    source: { originalFileName: imported.fileName, psdSha256: "fixture", psdPath: "source/source.psd" }
  });
}

function signedArea(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

describe("automatic semantic control cage", () => {
  it("locates, validates, and repairs a complete face graph without manual points", () => {
    const cage = buildSemanticControlCage(fixture());
    expect(cage).toBeDefined();
    expect(Object.keys(cage!.points)).toHaveLength(23);
    expect(cage!.validation.status).toBe("corrected");
    expect(cage!.validation.corrections.some((message) => message.startsWith("nose:"))).toBe(true);
    expect(cage!.validation.confidence).toBeGreaterThan(0.8);
    expect(cage!.points.faceLeft.position.x).toBeLessThan(cage!.points.eyeLeftOuter.position.x);
    expect(cage!.points.eyeLeftOuter.position.x).toBeLessThan(cage!.points.eyeLeft.position.x);
    expect(cage!.points.eyeLeft.position.x).toBeLessThan(cage!.points.eyeLeftInner.position.x);
    expect(cage!.points.eyeLeftInner.position.x).toBeLessThan(cage!.points.nose.position.x);
    expect(cage!.points.nose.position.x).toBeLessThan(cage!.points.eyeRightInner.position.x);
    expect(cage!.points.eyeRightInner.position.x).toBeLessThan(cage!.points.eyeRight.position.x);
    expect(cage!.points.eyeRight.position.x).toBeLessThan(cage!.points.eyeRightOuter.position.x);
    expect(cage!.points.eyeRightOuter.position.x).toBeLessThan(cage!.points.faceRight.position.x);
    expect(cage!.points.forehead.position.y).toBeLessThan(cage!.points.eyeLeft.position.y);
    expect(cage!.points.eyeLeft.position.y).toBeLessThan(cage!.points.nose.position.y);
    expect(cage!.points.nose.position.y).toBeLessThan(cage!.points.mouth.position.y);
    expect(cage!.points.mouth.position.y).toBeLessThan(cage!.points.chin.position.y);
  });

  it("uses eye corners and mouth corners as actual face-cage vertices", () => {
    const cage = buildSemanticControlCage(fixture())!;
    const used = new Set(cage.faceTriangles.flat());
    for (const id of ["eyeLeftOuter", "eyeLeftInner", "eyeRightInner", "eyeRightOuter", "mouthLeft", "mouthRight"] as const) {
      expect(used.has(id)).toBe(true);
    }
  });

  it("preserves a character's tilted eye line and slanted mouth instead of flattening the face", () => {
    const imported = fixture();
    const screenLeftEye = imported.layers.find((entry) => entry.id === "eye-screen-left")!;
    const screenRightEye = imported.layers.find((entry) => entry.id === "eye-screen-right")!;
    screenLeftEye.bounds.y += 7;
    screenRightEye.bounds.y -= 3;
    const mouth = imported.layers.find((entry) => entry.id === "mouth")!;
    mouth.pixels.data.fill(0);
    let opaque = 0;
    for (let x = 0; x < mouth.pixels.width; x += 1) {
      const centerY = Math.round(mouth.pixels.height * 0.7 - x * 0.12);
      for (let offset = -2; offset <= 2; offset += 1) {
        const y = centerY + offset;
        if (y < 0 || y >= mouth.pixels.height) continue;
        mouth.pixels.data[(y * mouth.pixels.width + x) * 4 + 3] = 255;
        opaque += 1;
      }
    }
    mouth.opaquePixels = opaque;

    const cage = buildSemanticControlCage(imported)!;
    expect(cage.points.eyeLeft.position.y).not.toBe(cage.points.eyeRight.position.y);
    expect(cage.points.mouthLeft.position.y).toBeGreaterThan(cage.points.mouthRight.position.y);
    expect(cage.points.cheekLeft.position.y).not.toBe(cage.points.cheekRight.position.y);
  });

  it("does not invent a face cage when no face pixels exist", () => {
    const imported = fixture();
    imported.layers = imported.layers.filter((entry) => entry.role !== "face");
    expect(buildSemanticControlCage(imported)).toBeUndefined();
  });

  it("promotes complete semantic projects to the coherent-v3 runtime", () => {
    const project = rigFixture();
    expect(project.rigLevel).toBe("semantic");
    expect(project.runtime.profile).toBe("coherent-v3");
    expect(project.runtime.semanticCage?.validation.confidence).toBeGreaterThan(0.8);
  });

  it("lets calibration attenuate face and skull cage influence independently", () => {
    const project = rigFixture();
    const field = project.runtime.poseField!;
    const cage = project.runtime.semanticCage!;
    const face = project.layers.find((entry) => entry.role === "face")!;
    const skull = project.layers.find((entry) => entry.role === "backHair")!;
    const facePoint = { x: face.bounds.x + face.bounds.width * 0.23, y: face.bounds.y + face.bounds.height * 0.61 };
    const skullPoint = { x: skull.bounds.x + skull.bounds.width * 0.19, y: skull.bounds.y + skull.bounds.height * 0.42 };
    const faceFull = applyCoherentPoseField(field, face, facePoint, 0.82, 0.3, cage);
    const faceSurfaceOnly = applyCoherentPoseField(field, face, facePoint, 0.82, 0.3, cage, { face: 0 });
    const skullFull = applyCoherentPoseField(field, skull, skullPoint, 0.82, 0.3, cage);
    const skullSurfaceOnly = applyCoherentPoseField(field, skull, skullPoint, 0.82, 0.3, cage, { skull: 0 });
    expect(Math.hypot(faceFull.x - faceSurfaceOnly.x, faceFull.y - faceSurfaceOnly.y)).toBeGreaterThan(1e-5);
    expect(Math.hypot(skullFull.x - skullSurfaceOnly.x, skullFull.y - skullSurfaceOnly.y)).toBeGreaterThan(1e-5);
  });

  it("pins only the roots of face-framing hair and releases its tips", () => {
    const project = rigFixture();
    const field = project.runtime.poseField!;
    const cage = project.runtime.semanticCage!;
    const face = project.layers.find((entry) => entry.role === "face")!;
    const hair = project.layers.find((entry) => entry.role === "frontHair")!;
    for (const yaw of [-0.85, 0.85]) {
      for (const side of ["Left", "Right"] as const) {
        const root = hair.secondaryAnchors![`frontHairRoot${side}`]!;
        const tip = hair.secondaryAnchors![`frontHairTip${side}`]!;
        const faceRoot = { x: cage.points[`face${side}`].position.x, y: root.y };
        const faceTip = { x: cage.points[`face${side}`].position.x, y: tip.y };
        const posedFaceRoot = applyCoherentPoseField(field, face, faceRoot, yaw, 0, cage);
        const posedRoot = applyCoherentPoseField(field, hair, root, yaw, 0, cage);
        const posedFaceTip = applyCoherentPoseField(field, face, faceTip, yaw, 0, cage);
        const posedTip = applyCoherentPoseField(field, hair, tip, yaw, 0, cage);
        const rootFollowError = Math.abs((posedRoot.x - root.x) - (posedFaceRoot.x - faceRoot.x));
        const tipFollowError = Math.abs((posedTip.x - tip.x) - (posedFaceTip.x - faceTip.x));
        expect(rootFollowError).toBeLessThan(field.radiusX * 0.095);
        expect(tipFollowError).toBeGreaterThan(rootFollowError * 0.98);
      }
    }
  });

  it("uses screen-space near and far sides consistently for eyes and face edges", () => {
    const project = rigFixture();
    const field = project.runtime.poseField!;
    const cage = project.runtime.semanticCage!;
    const screenLeftEye = project.layers.find((entry) => entry.id === "eye-screen-left")!;
    const screenRightEye = project.layers.find((entry) => entry.id === "eye-screen-right")!;
    const face = project.layers.find((entry) => entry.role === "face")!;
    const widthAfter = (target: typeof screenLeftEye, yaw: number) => {
      const y = target.pivot.y;
      const left = applyCoherentPoseField(field, target, { x: target.bounds.x, y }, yaw, 0, cage);
      const right = applyCoherentPoseField(field, target, { x: target.bounds.x + target.bounds.width, y }, yaw, 0, cage);
      return right.x - left.x;
    };

    const rightTurnNearWidth = widthAfter(screenLeftEye, 0.85);
    const rightTurnFarWidth = widthAfter(screenRightEye, 0.85);
    const leftTurnNearWidth = widthAfter(screenRightEye, -0.85);
    const leftTurnFarWidth = widthAfter(screenLeftEye, -0.85);
    expect(rightTurnNearWidth).toBeGreaterThan(rightTurnFarWidth * 1.08);
    expect(leftTurnNearWidth).toBeGreaterThan(leftTurnFarWidth * 1.08);

    const nearEdge = cage.points.faceLeft.position;
    const farEdge = cage.points.faceRight.position;
    const posedNear = applyCoherentPoseField(field, face, nearEdge, 0.85, 0, cage);
    const posedFar = applyCoherentPoseField(field, face, farEdge, 0.85, 0, cage);
    expect(posedFar.x - farEdge.x).toBeLessThan(posedNear.x - nearEdge.x);
  });

  it("expands the jaw plane looking up and foreshortens it looking down", () => {
    const project = rigFixture();
    const field = project.runtime.poseField!;
    const cage = project.runtime.semanticCage!;
    const face = project.layers.find((entry) => entry.role === "face")!;
    const lowerFaceHeight = (pitch: number) => {
      const mouth = applyCoherentPoseField(field, face, cage.points.mouth.position, 0, pitch, cage);
      const chin = applyCoherentPoseField(field, face, cage.points.chin.position, 0, pitch, cage);
      return chin.y - mouth.y;
    };
    expect(lowerFaceHeight(-0.75)).toBeGreaterThan(lowerFaceHeight(0));
    expect(lowerFaceHeight(0.75)).toBeLessThan(lowerFaceHeight(0));
  });

  it("keeps neutral points exact and preserves cage triangle winding at extreme poses", () => {
    const project = rigFixture();
    const field = project.runtime.poseField!;
    const cage = project.runtime.semanticCage!;
    const faceLayer = project.layers.find((entry) => entry.role === "face")!;
    const skullLayer = project.layers.find((entry) => entry.role === "frontHair")!;

    for (const entry of Object.values(cage.points)) {
      expect(applyCoherentPoseField(field, faceLayer, entry.position, 0, 0, cage)).toEqual(entry.position);
    }

    for (const pose of [{ yaw: -0.85, pitch: -0.45 }, { yaw: 0.85, pitch: 0.45 }]) {
      for (const [triangles, layer] of [[cage.faceTriangles, faceLayer], [cage.skullTriangles, skullLayer]] as const) {
        for (const triangle of triangles) {
          const source = triangle.map((id) => cage.points[id].position) as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
          const target = source.map((point) => applyCoherentPoseField(field, layer, point, pose.yaw, pose.pitch, cage)) as typeof source;
          const sourceArea = signedArea(...source);
          const targetArea = signedArea(...target);
          expect(Math.abs(sourceArea)).toBeGreaterThan(1e-7);
          expect(sourceArea * targetArea).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps a narrow face-framing hair mesh usable at the full yaw envelope", () => {
    const imported = fixture();
    const hair = imported.layers.find((entry) => entry.role === "frontHair")!;
    hair.bounds = { x: 432, y: 28, width: 126, height: 203 };
    hair.pixels = {
      width: hair.bounds.width,
      height: hair.bounds.height,
      data: new Uint8ClampedArray(hair.bounds.width * hair.bounds.height * 4).fill(255)
    };
    hair.opaquePixels = hair.bounds.width * hair.bounds.height;
    const project = buildRig({
      imported,
      name: "narrow-front-hair",
      seed: 42,
      source: { originalFileName: imported.fileName, psdSha256: "fixture", psdPath: "source/source.psd" }
    });
    project.runtime.poseField = {
      kind: "head-surfaces-v2",
      center: { x: 0.49375, y: 0.161766 },
      radiusX: 0.048047,
      radiusY: 0.061719,
      skullCenter: { x: 0.49375, y: 0.119016 },
      skullRadiusX: 0.120117,
      skullRadiusY: 0.09089,
      maxYawRadians: 0.3,
      maxPitchRadians: 0.32,
      perspective: 0.1
    };
    const positions = {
      headTop: [0.494922, 0.075], forehead: [0.494922, 0.112391], skullLeft: [0.433594, 0.133992], skullRight: [0.557031, 0.133992],
      faceLeft: [0.448437, 0.155594], faceRight: [0.539844, 0.155594], eyeLeftOuter: [0.457813, 0.166797], eyeLeft: [0.469531, 0.166797],
      eyeLeftInner: [0.48125, 0.166797], eyeRightInner: [0.507031, 0.166797], eyeRight: [0.519141, 0.166797], eyeRightOuter: [0.53125, 0.166797],
      nose: [0.49375, 0.177812], cheekLeft: [0.45625, 0.18363], cheekRight: [0.532031, 0.18363], mouthLeft: [0.488281, 0.194922],
      mouth: [0.494531, 0.194922], mouthRight: [0.500781, 0.194922], jawLeft: [0.469531, 0.20557], jawRight: [0.517969, 0.20557],
      chin: [0.494922, 0.213281], neckLeft: [0.478125, 0.213281], neckRight: [0.513281, 0.213281]
    } as const;
    for (const [id, [x, y]] of Object.entries(positions)) {
      project.runtime.semanticCage!.points[id as keyof typeof project.runtime.semanticCage.points].position = { x, y };
    }
    const projectHair = project.layers.find((entry) => entry.role === "frontHair")!;
    projectHair.pivot = { x: 0.494922, y: 0.134375 };
    projectHair.secondaryAnchors = {
      frontHairRoot: { x: 0.494922, y: 0.134375 },
      frontHairRootLeft: { x: 0.450781, y: 0.135938 },
      frontHairRootRight: { x: 0.539063, y: 0.135938 },
      frontHairTipLeft: { x: 0.450781, y: 0.230469 },
      frontHairTipRight: { x: 0.539063, y: 0.230469 },
      ahogeRoot: { x: 0.494922, y: 0.076563 }
    };

    const validation = validatePose(project, "yaw-right", safetyPoseState(1, 0, 0));
    expect(validation.issues.filter((issue) => issue.layerId === hair.id && issue.code === "mesh-inversion")).toEqual([]);
  });
});
