import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { createProject, verifyProject } from "../src/index.js";

describe("project publication and verification boundary", () => {
  it("builds and verifies in staging before publishing into a pre-existing empty directory", async () => {
    const output = artifactPath(`publish-empty-${process.pid}-${Date.now()}`);
    await mkdir(output, { recursive: true });
    const result = await createProject({ input: resolve("test/fixtures/semantic.psd"), output, seed: 42 });
    expect(result.outputDirectory).toBe(output);
    expect((await verifyProject(output)).valid).toBe(true);
    const document = JSON.parse(await readFile(resolve(output, "puppetloom.json"), "utf8")) as { version: number; model?: { parameters: unknown[]; expressions: unknown[]; physics: unknown[]; behaviors: unknown[] } };
    expect(document.version).toBe(4);
    expect(document.model).toMatchObject({ expressions: [], physics: [], behaviors: [] });
    expect(document.model!.parameters.length).toBeGreaterThan(0);
    const operations = await readdir(resolve(output, "reports", "operations"));
    expect(operations).toHaveLength(1);
    const operationRoot = resolve(output, "reports", "operations", operations[0]!);
    expect(JSON.parse(await readFile(resolve(operationRoot, "operation.json"), "utf8"))).toMatchObject({ status: "succeeded", target: output });
    expect((await stat(resolve(operationRoot, "reserved-output"))).isDirectory()).toBe(true);
  }, 120_000);

  it("does not publish a target when input parsing fails", async () => {
    const output = artifactPath(`publish-failure-${process.pid}-${Date.now()}`);
    await expect(createProject({ input: resolve("test/fixtures/corrupted.psd"), output, seed: 42 })).rejects.toThrow();
    await expect(access(output)).rejects.toThrow();
    const siblings = await readdir(dirname(output));
    expect(siblings.some((name) => name.startsWith(`.${basename(output)}.puppetloom-pending-`))).toBe(false);
  });

  it("detects decodable-boundary, source-hash, and mesh-structure corruption", async () => {
    const textureOutput = artifactPath(`verify-texture-${process.pid}-${Date.now()}`);
    const sourceOutput = artifactPath(`verify-source-${process.pid}-${Date.now()}`);
    const structureOutput = artifactPath(`verify-structure-${process.pid}-${Date.now()}`);
    for (const output of [textureOutput, sourceOutput, structureOutput]) await createProject({ input: resolve("test/fixtures/semantic.psd"), output, seed: 42 });

    const textureDocument = JSON.parse(await readFile(resolve(textureOutput, "puppetloom.json"), "utf8")) as { layers: Array<{ texture: string }> };
    await writeFile(resolve(textureOutput, textureDocument.layers[0]!.texture), Buffer.from("invalid-png"));
    const invalidTexture = await verifyProject(textureOutput);
    expect(invalidTexture.valid).toBe(false);
    expect(invalidTexture.invalidTextures).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "纹理无法解码。" })]));

    await writeFile(resolve(sourceOutput, "source", "source.psd"), Buffer.from("changed-source"));
    expect((await verifyProject(sourceOutput)).sourceIssues).toEqual(["PSD 内容哈希与项目记录不一致。"]);

    const structurePath = resolve(structureOutput, "puppetloom.json");
    const structure = JSON.parse(await readFile(structurePath, "utf8")) as { layers: Array<{ mesh: { triangles: number[] } }> };
    structure.layers[0]!.mesh.triangles[0] = 999_999;
    await writeFile(structurePath, `${JSON.stringify(structure, null, 2)}\n`, "utf8");
    await expect(verifyProject(structureOutput)).rejects.toThrow(/无法读取 PuppetLoom 项目/);
  }, 120_000);
});
