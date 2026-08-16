import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const cliProject = resolve("test/artifacts", `cli-project-${process.pid}-${Date.now()}`);

function cli(args: string[], environment: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve("apps/cli/dist/index.js"), ...args], { cwd: resolve("."), windowsHide: true, env: { ...process.env, ...environment } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe("CLI contract", () => {
  beforeAll(async () => {
    const result = await cli(["create", "--input", "test/fixtures/semantic.psd", "--output", cliProject, "--seed", "42", "--json"]);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  }, 120_000);

  it("returns JSON and exit 0 for a usable PSD", async () => {
    const result = await cli(["inspect", "--input", "test/fixtures/semantic.psd", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, suggestedRigLevel: "semantic" });
  });

  it("uses exit 2 for invalid PSD input", async () => {
    const result = await cli(["inspect", "--input", "test/fixtures/corrupted.psd", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("uses exit 3 for file-system or project errors", async () => {
    const result = await cli(["verify", "--project", "test/fixtures/not-a-project", "--json"]);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, exitCode: 3 });
  });

  it("creates and verifies a project through the public commands", async () => {
    const result = await cli(["verify", "--project", cliProject, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, rigLevel: "semantic" });
  });

  it("describes, calibrates, renders and compares through Agent-facing commands", async () => {
    const described = await cli(["describe", "--project", cliProject, "--json"]);
    expect(described.code).toBe(0);
    const description = JSON.parse(described.stdout) as { calibrationRevision: number; anchors: { nose: { x: number; y: number } } };
    expect(description.calibrationRevision).toBe(0);
    const files = resolve("test/artifacts", `cli-calibration-${process.pid}-${Date.now()}`);
    await mkdir(files, { recursive: true });
    const patch = resolve(files, "patch.json");
    await writeFile(patch, JSON.stringify({
      label: "CLI 鼻点校准",
      overrides: { anchors: { nose: { x: description.anchors.nose.x + 0.001, y: description.anchors.nose.y } } }
    }));
    const calibrated = await cli(["calibrate", "--project", cliProject, "--patch", patch, "--json"]);
    expect(calibrated.code).toBe(0);
    expect(JSON.parse(calibrated.stdout)).toMatchObject({ ok: true, revision: 1 });
    const rendered = await cli(["render", "--project", cliProject, "--suite", "poses", "--output", resolve(files, "render"), "--json"]);
    expect(rendered.code).toBe(0);
    expect((await stat(resolve(files, "render", "pose-sheet.png"))).isFile()).toBe(true);
    const compared = await cli(["compare", "--project", cliProject, "--from", "0", "--to", "1", "--output", resolve(files, "compare"), "--json"]);
    expect(compared.code).toBe(0);
    expect((await stat(resolve(files, "compare", "before-after.png"))).isFile()).toBe(true);
  }, 120_000);

  it("uses exit 2 for malformed calibration JSON", async () => {
    const files = resolve("test/artifacts", `cli-invalid-calibration-${process.pid}-${Date.now()}`);
    await mkdir(files, { recursive: true });
    const patch = resolve(files, "broken.json");
    await writeFile(patch, "{ definitely-not-json");
    const result = await cli(["calibrate", "--project", cliProject, "--patch", patch, "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("treats unavailable optional supplements as non-blocking", async () => {
    const result = await cli(["enhance", "--project", cliProject, "--assets", "test/fixtures/no-supplements", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      accepted: [],
      rejected: [
        { requestId: "closed-eye-left" },
        { requestId: "closed-eye-right" },
        { requestId: "mouth-neutral" },
        { requestId: "mouth-slight" },
        { requestId: "mouth-open-small" }
      ]
    });
  });

  it("opens the transparent player through the play command", async () => {
    const result = await cli(["play", "--project", cliProject], { PUPPETLOOM_E2E_EXIT_AFTER_MS: "900" });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  }, 30_000);

  it("opens the project editor through the edit command", async () => {
    const result = await cli(["edit", "--project", cliProject], { PUPPETLOOM_E2E_EXIT_AFTER_MS: "900", PUPPETLOOM_ALLOW_MULTIPLE: "1" });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  }, 30_000);
});
