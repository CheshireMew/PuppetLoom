import { describe, expect, it } from "vitest";
import type { ImportedLayer, ImportedPsd } from "../src/psd.js";
import { applyCoherentPoseField } from "../src/pose-field.js";
import { buildRig } from "../src/rig.js";
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

  it("keeps face-framing front hair attached to both moving face edges", () => {
    const project = rigFixture();
    const field = project.runtime.poseField!;
    const cage = project.runtime.semanticCage!;
    const face = project.layers.find((entry) => entry.role === "face")!;
    const hair = project.layers.find((entry) => entry.role === "frontHair")!;
    const y = cage.points.eyeLeft.position.y + (cage.points.chin.position.y - cage.points.eyeLeft.position.y) * 0.28;
    for (const yaw of [-0.85, 0.85]) {
      for (const side of ["Left", "Right"] as const) {
        const facePoint = { x: cage.points[`face${side}`].position.x, y };
        const direction = side === "Left" ? -1 : 1;
        const hairPoint = { x: facePoint.x + direction * face.bounds.width * 0.035, y };
        const posedFace = applyCoherentPoseField(field, face, facePoint, yaw, 0, cage);
        const posedHair = applyCoherentPoseField(field, hair, hairPoint, yaw, 0, cage);
        const faceShift = posedFace.x - facePoint.x;
        const hairShift = posedHair.x - hairPoint.x;
        expect(Math.abs(faceShift - hairShift)).toBeLessThan(face.bounds.width * 0.01);
      }
    }
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
});
