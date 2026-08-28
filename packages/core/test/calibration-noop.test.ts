import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { commitModelAgentProposal, createProject, listCalibrationSessions, loadCalibration, loadProject, planPrimaryPartAgent, saveCalibrationPatch } from "../src/index.js";

const output = artifactPath("calibration-noop-" + process.pid + "-" + Date.now());

beforeAll(async () => {
  await createProject({ input: resolve("test/fixtures/semantic.psd"), output, seed: 42 });
}, 120_000);

describe("calibration no-op guard", () => {
  it("rejects an exact no-op before creating evidence or a revision", async () => {
    await expect(saveCalibrationPatch(output, {
      baseRevision: 0,
      label: "重复恢复自动绑定",
      overrides: {}
    })).rejects.toThrow("当前校准已经是目标状态");
    expect((await loadCalibration(output)).revision).toBe(0);
    expect(await listCalibrationSessions(output)).toEqual([]);
  });

  it("treats an already-satisfied Agent proposal as completed without an empty revision", async () => {
    const project = await loadProject(output);
    const result = await commitModelAgentProposal(output, 0, {
      part: "mouth",
      instruction: "验证已经存在的目标状态",
      label: "Agent · 无差异验证",
      targetLayerIds: [project.layers.find((layer) => layer.role === "mouth")!.id],
      operations: [],
      previews: [],
      overrides: {},
      checks: [{ id: "already-correct", label: "目标状态已经存在", passed: true, details: {} }],
      repairs: []
    });

    expect(result).toMatchObject({ changed: false, revision: 0 });
    expect((await loadCalibration(output)).revision).toBe(0);
    expect(await listCalibrationSessions(output)).toEqual([]);
  });

  it("plans against a pending anatomy snapshot instead of reloading stale layer geometry", async () => {
    const preview = structuredClone(await loadProject(output));
    const mouth = preview.layers.find((layer) => layer.role === "mouth")!;
    mouth.id = "preview-mouth-anatomy";
    const plan = await planPrimaryPartAgent(output, {
      part: "mouth",
      instruction: "检查待提交的角色专属嘴型",
      layerIds: [mouth.id],
      previewProject: preview
    });

    expect(plan.targetLayers.map((layer) => layer.id)).toContain("preview-mouth-anatomy");
  });
});
