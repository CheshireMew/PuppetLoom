import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { loadProject } from "../packages/core/src/project.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactPath } from "./support/artifacts.js";

async function cli(args: string[]) {
  return new Promise<{ code: number | null; output: any; stderr: string }>((success, reject) => {
    const child = spawn(process.execPath, [resolve("apps/cli/dist/index.js"), ...args, "--json"], { cwd: resolve("."), windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => { try { success({ code, output: stdout.trim() ? JSON.parse(stdout) : undefined, stderr }); } catch (error) { reject(error); } });
  });
}

describe("geometry authoring CLI", () => {
  it("previews annotated target points and intermediate poses without writing, then saves the same proposal", async () => {
    const root = artifactPath("shape-guide-cli"); await mkdir(root, { recursive: true });
    const project = resolve(root, "project");
    expect((await cli(["create", "--input", resolve("test/fixtures/semantic.psd"), "--output", project])).code).toBe(0);
    const described = await cli(["describe", "--project", project]);
    const layer = described.output.layers.find((l: { role: string }) => l.role === "face");
    const geometry = await cli(["author", "geometry", "--project", project, "--layer", layer.id]);
    const source = geometry.output.points[0].position;
    const inspect = await cli(["author", "inspect-shape", "--project", project, "--layer", layer.id, "--output", resolve(root, "inspect")]);
    expect(inspect.code, inspect.stderr).toBe(0);
    expect(inspect.output.coordinates.parentTransformsApplied).toBe(false);
    expect((await readFile(inspect.output.sourceView)).length).toBeGreaterThan(100);
    const patch = resolve(root, "shape.json");
    await writeFile(patch, JSON.stringify({ version: 1, baseRevision: 0, previews: [{ id: "shape-0", label: "explicit settled pose", parameters: { "param-head-yaw": 0, "param-head-pitch": 0 }, settleSeconds: 1 }], operations: [
      { op: "upsert-binding", binding: { id: "guided-face", parameterIds: ["param-head-yaw", "param-head-pitch"], target: { kind: "layer", id: layer.id }, keyforms: [-1, 0, 1].flatMap(x => [-1, 0, 1].map(y => ({ values: [x, y] }))) } },
      { op: "transform-keyform", bindingId: "guided-face", values: [1, 1], coordinateSpace: "rest-canvas", selection: { kind: "all" }, transforms: [{ kind: "fit-landmarks", radiusPixels: 70, points: [{ label: "face target", source, target: { x: source.x + .0002, y: source.y } }] }] }
    ] }));
    const before = await readFile(resolve(project, "calibration/current.json"));
    const preview = await cli(["author", "preview", "--project", project, "--patch", patch, "--output", resolve(root, "preview"), "--focus", "headFace", "--size", "300"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.output).toMatchObject({ saved: false, baseRevision: 0, visualReview: "unreviewed" });
    expect(preview.output.overlays).toHaveLength(1);
    expect(new Set(preview.output.samples.map((p: any) => p.id)).size).toBe(preview.output.samples.length);
    expect(preview.output.samples.some((p: any) => p.id !== "shape-0" && p.parameters?.["param-head-yaw"] === 0 && p.parameters?.["param-head-pitch"] === 0 && !p.settleSeconds)).toBe(true);
    expect(preview.output.samples.some((p: any) => p.parameters?.["param-head-yaw"] === .5 && p.parameters?.["param-head-pitch"] === .5)).toBe(true);
    expect(await readFile(resolve(project, "calibration/current.json"))).toEqual(before);
    const applied = await cli(["author", "apply", "--project", project, "--patch", patch]);
    expect(applied.code, applied.stderr).toBe(0); expect(applied.output.revision).toBe(1);
    expect(createHash("sha256").update(JSON.stringify(await loadProject(project))).digest("hex")).toBe(preview.output.proposalFingerprint);
    const stale = await cli(["author", "preview", "--project", project, "--patch", patch, "--output", resolve(root, "stale"), "--size", "300"]);
    expect(stale.code).not.toBe(0);
    const points = await cli(["author", "geometry", "--project", project, "--binding", "guided-face", "--values", "1,1", "--limit", "1"]);
    expect(points.output.points[0].delta.x).toBeCloseTo(.0002, 10);
  }, 120000);
  it("inspects bounded points, commits local keyform geometry with evidence, rejects stale replay, and restores", async () => {
    const root = artifactPath("geometry-cli");
    await mkdir(root, { recursive: true });
    const project = resolve(root, "project");
    const created = await cli(["create", "--input", resolve("test/fixtures/semantic.psd"), "--output", project]);
    expect(created.code, created.stderr).toBe(0);
    const described = await cli(["describe", "--project", project]);
    const layer = described.output.layers.find((candidate: { role: string }) => candidate.role === "face");
    const patch = resolve(root, "patch.json");
    await writeFile(patch, JSON.stringify({ version: 1, baseRevision: 0, operations: [
      { op: "upsert-binding", binding: { id: "geometry-face", parameterIds: ["param-head-yaw"], target: { kind: "layer", id: layer.id }, keyforms: [{ values: [-1] }, { values: [0] }, { values: [1] }] } },
      { op: "transform-keyform", bindingId: "geometry-face", values: [1], coordinateSpace: "rest-canvas", selection: { kind: "indices", indices: [0] }, transforms: [{ kind: "translate", delta: { x: 0.0002, y: 0 } }] }
    ] }));
    const edited = await cli(["author", "apply", "--project", project, "--patch", patch]);
    expect(edited.code, edited.stderr).toBe(0);
    expect(edited.output.revision).toBe(1);
    expect(edited.output.evidence.after.artifacts.some((artifact: { id: string }) => artifact.id.startsWith("authoring-"))).toBe(true);
    const points = await cli(["author", "geometry", "--project", project, "--binding", "geometry-face", "--values", "1", "--revision", "1", "--offset", "0", "--limit", "1"]);
    expect(points.code, points.stderr).toBe(0);
    expect(points.output).toMatchObject({ revision: 1, nativeBezier: false, nextOffset: 1, points: [{ index: 0, delta: { x: expect.closeTo(0.0002, 10), y: 0 } }] });
    expect(points.output.points).toHaveLength(1);
    const neutral = await cli(["author", "geometry", "--project", project, "--binding", "geometry-face", "--values", "0", "--limit", "1"]);
    expect(neutral.output.points[0].delta).toEqual({ x: 0, y: 0 });
    const stale = await cli(["author", "apply", "--project", project, "--patch", patch]);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain("基线");
    const restored = await cli(["restore", "--project", project, "--revision", "0", "--base-revision", "1"]);
    expect(restored.code, restored.stderr).toBe(0);
    expect(restored.output.revision).toBe(2);
    const reopened = await cli(["describe", "--project", project]);
    expect(reopened.output.model).toEqual(described.output.model);
  });
});
