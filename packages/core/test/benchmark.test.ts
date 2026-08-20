import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { parseCharacterBenchmarkManifest, runCharacterBenchmarks } from "../src/benchmark.js";
import { createProject } from "../src/project.js";
import { artifactPath } from "../../../test/support/artifacts.js";

describe("real character benchmark manifest", () => {
  it("accepts an empty material-ready corpus and reports that samples are still pending", async () => {
    const report = await runCharacterBenchmarks("benchmarks/real-characters/corpus.json");
    expect(report.passed).toBe(true);
    expect(report.readyForMaterials).toBe(true);
    expect(report.summary).toEqual({ declared: 0, executed: 0, passed: 0, failed: 0 });
  });

  it("requires unique IDs and explicit material usage", () => {
    const entry = { id: "character-a", label: "A", project: "A", materialUse: "local-benchmark-only", tags: [], expected: {} };
    expect(() => parseCharacterBenchmarkManifest({ version: 1, name: "test", characters: [entry, entry] })).toThrow(/重复/);
    expect(() => parseCharacterBenchmarkManifest({ version: 1, name: "test", characters: [{ ...entry, id: "character-b", materialUse: undefined }] })).toThrow(/素材用途/);
  });

  it("rejects unsupported expectation fields instead of silently ignoring them", () => {
    expect(() => parseCharacterBenchmarkManifest({
      version: 1,
      name: "test",
      characters: [{ id: "character-a", label: "A", project: "A", materialUse: "redistributable", tags: [], expected: { magicScore: 1 } }]
    })).toThrow(/未知字段/);
  });

  it("keeps count thresholds aligned with the integer JSON schema", () => {
    expect(() => parseCharacterBenchmarkManifest({
      version: 1,
      name: "test",
      characters: [{ id: "character-a", label: "A", project: "A", materialUse: "redistributable", tags: [], expected: { minLayerCount: 3.5 } }]
    })).toThrow(/整数/);
  });

  it("runs declared project checks and pins the effective revision and fingerprint", async () => {
    const projectDirectory = artifactPath(`character-benchmark-${process.pid}-${Date.now()}`);
    await createProject({ input: "test/fixtures/semantic.psd", output: projectDirectory, seed: 42 });
    const manifest = `${projectDirectory}/benchmark.json`;
    await writeFile(manifest, JSON.stringify({
      version: 1,
      name: "fixture corpus",
      characters: [{
        id: "semantic-fixture", label: "Semantic", project: ".", revision: 0,
        materialUse: "redistributable", tags: ["fixture"],
        expected: { allowedRigLevels: ["semantic"], minLayerCount: 10, requiredRoles: ["face", "frontHair", "mouth"], minPoseValidationCount: 13, requirePoseField: true }
      }]
    }));
    const report = await runCharacterBenchmarks(manifest);
    expect(report.readyForMaterials).toBe(false);
    expect(report.summary).toEqual({ declared: 1, executed: 1, passed: 1, failed: 0 });
    expect(report.results[0]).toMatchObject({ id: "semantic-fixture", revision: 0, passed: true });
    expect(report.results[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
