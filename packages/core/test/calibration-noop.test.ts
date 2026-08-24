import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { createProject, listCalibrationSessions, loadCalibration, saveCalibrationPatch } from "../src/index.js";

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
});
