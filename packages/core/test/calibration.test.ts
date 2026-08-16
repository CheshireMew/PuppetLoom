import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createProject,
  compareProjectRevisions,
  describeProject,
  listCalibrationSessions,
  loadCalibration,
  loadProject,
  restoreCalibrationRevision,
  renderProjectSuite,
  saveCalibrationPatch,
  setCalibrationEvidenceStatus
} from "../src/index.js";

const output = resolve("test/artifacts", `calibration-${process.pid}-${Date.now()}`);
const legacyOutput = resolve("test/artifacts", `calibration-legacy-${process.pid}-${Date.now()}`);

beforeAll(async () => {
  await createProject({ input: resolve("test/fixtures/semantic.psd"), output, seed: 42 });
}, 120_000);

describe("project calibration", () => {
  it("creates an editable calibration document and machine-readable description", async () => {
    const calibration = await loadCalibration(output);
    const description = await describeProject(output);
    expect(calibration).toMatchObject({ version: 1, revision: 0, overrides: {} });
    expect(description).toMatchObject({ version: 2, calibrationRevision: 0, rigLevel: "semantic" });
    expect(description.layers.some((layer) => layer.mesh.pointCount > 0)).toBe(true);
  });

  it("applies sparse point, anchor, mesh and influence overrides without mutating the base file", async () => {
    const before = await loadProject(output);
    const face = before.layers.find((layer) => layer.role === "face")!;
    const original = face.mesh.points[0]!;
    const result = await saveCalibrationPatch(output, {
      label: "校准鼻点与脸部网格",
      overrides: {
        anchors: { nose: { x: before.anchors.nose!.x + 0.001, y: before.anchors.nose!.y } },
        semanticPoints: { nose: { x: before.runtime.semanticCage!.points.nose.position.x + 0.001, y: before.runtime.semanticCage!.points.nose.position.y } },
        layers: {
          [face.id]: {
            meshPointDeltas: { "0": { x: 0.0005, y: 0 } },
            vertexInfluences: { pin: { "0": 0.4 } }
          }
        }
      }
    });
    expect(result.calibration.revision).toBe(1);
    expect(result.project.layers.find((layer) => layer.id === face.id)!.mesh.points[0]!.x).toBeCloseTo(original.x + 0.0005, 7);
    expect(result.project.layers.find((layer) => layer.id === face.id)!.mesh.influences?.pin?.[0]).toBe(0.4);
    expect((await loadProject(output)).anchors.nose!.x).toBeCloseTo(before.anchors.nose!.x + 0.001, 7);
    expect((await stat(result.sessionPath)).isFile()).toBe(true);
    expect(await listCalibrationSessions(output)).toHaveLength(1);
    const accepted = await setCalibrationEvidenceStatus(output, result.session.id, "accepted");
    expect(accepted.evidenceStatus).toBe("accepted");
  });

  it("restores a previous revision as a new auditable revision", async () => {
    const result = await restoreCalibrationRevision(output, 0, "恢复自动绑定");
    expect(result.calibration.revision).toBe(2);
    expect(result.calibration.overrides).toEqual({});
    expect(await listCalibrationSessions(output)).toHaveLength(2);
  });

  it("clears one layer override without discarding unrelated calibration history", async () => {
    const face = (await loadProject(output)).layers.find((layer) => layer.role === "face")!;
    const changed = await saveCalibrationPatch(output, {
      label: "临时调整脸部作用权重",
      overrides: { layers: { [face.id]: { weights: { physics: 0.25 } } } }
    });
    expect(changed.project.layers.find((layer) => layer.id === face.id)!.weights.physics).toBe(0.25);
    const cleared = await saveCalibrationPatch(output, {
      label: "只恢复脸部图层",
      overrides: {},
      clear: { layers: [face.id] }
    });
    expect(cleared.project.layers.find((layer) => layer.id === face.id)!.weights.physics).not.toBe(0.25);
    expect(await listCalibrationSessions(output)).toHaveLength(4);
  });

  it("renders deterministic Agent evidence and revision comparisons", async () => {
    const evidence = resolve(output, "reports", "calibration", "test-suite");
    const suite = await renderProjectSuite(output, evidence, "calibration", 1);
    expect(suite.artifacts.filter((artifact) => artifact.kind === "pose")).toHaveLength(9);
    expect(suite.artifacts.filter((artifact) => artifact.kind === "motion")).toHaveLength(9);
    expect((await stat(resolve(evidence, "pose-sheet.png"))).isFile()).toBe(true);
    const comparison = await compareProjectRevisions(output, 0, 1, resolve(evidence, "comparison"));
    expect((await stat(comparison.comparisonSheet)).isFile()).toBe(true);
    expect((await stat(comparison.differenceImage)).isFile()).toBe(true);
    const comparisonMetadata = await sharp(comparison.comparisonSheet).metadata();
    const differenceMetadata = await sharp(comparison.differenceImage).metadata();
    expect(comparisonMetadata.height).toBeGreaterThan(1_500);
    expect(differenceMetadata.height).toBe(comparisonMetadata.height);
    expect((comparisonMetadata.width ?? 0) / 2).toBe(differenceMetadata.width);
  });

  it("rejects invalid canvas coordinates and unknown vertices", async () => {
    await expect(saveCalibrationPatch(output, {
      overrides: { anchors: { nose: { x: 2, y: 0.5 } } }
    })).rejects.toThrow();
    const face = (await loadProject(output)).layers.find((layer) => layer.role === "face")!;
    await expect(saveCalibrationPatch(output, {
      overrides: { layers: { [face.id]: { meshPointDeltas: { "99999": { x: 0.01, y: 0 } } } } }
    })).rejects.toThrow(/网格顶点/);
  });

  it("can create calibration history when opening a legacy project without calibration folders", async () => {
    await mkdir(legacyOutput, { recursive: true });
    const document = JSON.parse(await readFile(resolve(output, "puppetloom.json"), "utf8")) as Record<string, unknown>;
    document.version = 1;
    await writeFile(resolve(legacyOutput, "puppetloom.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
    const restored = await restoreCalibrationRevision(legacyOutput, 0, "旧项目开始校准");
    expect(restored.calibration.revision).toBe(1);
    expect((await stat(resolve(legacyOutput, "calibration", "current.json"))).isFile()).toBe(true);
    expect((await stat(restored.sessionPath)).isFile()).toBe(true);
  });
});
