import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { artifactPath } from "../../../test/support/artifacts.js";
import { createProject } from "../src/project.js";
import { inspectProjectHealth, scanProjectLibrary } from "../src/project-health.js";

describe("project production health", () => {
  it("reports verified capability gaps and finds the project through a bounded library scan", async () => {
    const library = artifactPath(`project-health-${process.pid}-${Date.now()}`);
    const projectDirectory = `${library}/characters/semantic`;
    await createProject({ input: "test/fixtures/semantic.psd", output: projectDirectory, seed: 42 });

    const health = await inspectProjectHealth(projectDirectory);
    expect(health).toMatchObject({ version: 1, valid: true, revision: 0, capabilities: { rigLevel: "semantic", layers: 19 } });
    expect(health.capabilities.missingProductionAssets).toEqual(["closed-eyes", "mouth-shapes"]);
    expect(health.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["missing-closed-eyes", "missing-mouth-shapes"]));

    const report = await scanProjectLibrary(library, { maxDepth: 3, maximumProjects: 10 });
    expect(report.failures).toEqual([]);
    expect(report.summary).toMatchObject({ total: 1, valid: 1, missingClosedEyes: 1, missingMouthShapes: 1 });
    expect(report.projects[0]!.projectDirectory).toBe(resolve(projectDirectory));
  });
});
