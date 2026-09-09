import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { artifactPath } from "./support/artifacts.js";

async function cli(args: string[]) {
  return new Promise<any>((success, reject) => {
    const child = spawn(process.execPath, [resolve("apps/cli/dist/index.js"), ...args, "--json"], { windowsHide: true, cwd: resolve(".") });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => { try { if (code !== 0) throw new Error(stderr || stdout); success(JSON.parse(stdout)); } catch (error) { reject(error); } });
  });
}
describe("asset CLI", () => {
  it("runs reference, registration, assembly preview, apply and restore through the public commands", async () => {
    const root = artifactPath("assets-cli"), project = resolve(root, "project");
    await mkdir(root, { recursive: true });
    await cli(["create", "--input", resolve("test/fixtures/semantic.psd"), "--output", project]);
    const before = await cli(["describe", "--project", project]);
    const layer = before.layers.find((candidate: { role: string }) => candidate.role === "frontHair");
    expect(layer).toBeDefined();
    const reference = await cli(["assets", "reference", "--project", project, "--layer", layer.id]);
    const image = resolve(project, reference.cleanPath), size = await sharp(image).metadata();
    const registration = resolve(root, "registration.json"), assembly = resolve(root, "assembly.json");
    await writeFile(registration, JSON.stringify({ kind: "frame", generatedRect: { x: 0, y: 0, width: size.width, height: size.height }, sourceRect: reference.sourceRect }));
    const registered = await cli(["assets", "register", "--project", project, "--reference", reference.id, "--image", image, "--registration", registration]);
    await writeFile(assembly, JSON.stringify({ baseRevision: before.calibrationRevision, additions: [{ registrationId: registered.id, layerId: "replacement-headwear" }], replaceLayerIds: [layer.id] }));
    const preview = await cli(["assets", "preview", "--project", project, "--assembly", assembly]);
    expect((await cli(["describe", "--project", project])).calibrationRevision).toBe(0);
    const applied = await cli(["assets", "apply", "--project", project, "--plan", preview.id]);
    expect(applied.revision).toBe(1);
    expect(applied.session.afterFingerprint).toBe(preview.afterFingerprint);
    expect((await cli(["describe", "--project", project])).layers.find((candidate: { id: string }) => candidate.id === "replacement-headwear")).toBeDefined();
    await cli(["restore", "--project", project, "--revision", "0", "--base-revision", "1"]);
    expect((await cli(["describe", "--project", project])).layers).toEqual(before.layers);
  });
});
