import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PuppetLoomError,
  createProject,
  enhanceProject,
  importPsd,
  inspectPsd,
  loadProject,
  verifyProject
} from "@puppetloom/core";

const fixtures = resolve("test/fixtures");
const runRoot = resolve("test/artifacts", `vitest-${process.pid}-${Date.now()}`);
const semanticOutput = resolve(runRoot, "semantic-a");

beforeAll(async () => {
  await mkdir(runRoot, { recursive: true });
  await createProject({
    input: resolve(fixtures, "semantic.psd"),
    reference: resolve(fixtures, "semantic-reference.png"),
    output: semanticOutput,
    seed: 42
  });
}, 120_000);

describe("PSD inspection and conservative fallback", () => {
  it.each([
    ["semantic.psd", "semantic"],
    ["grouped.psd", "grouped"],
    ["minimal.psd", "minimal"],
    ["missing-face.psd", "grouped"],
    ["unknown-noise.psd", "minimal"]
  ])("selects %s as %s", async (name, rigLevel) => {
    const report = await inspectPsd(resolve(fixtures, name));
    expect(report.valid).toBe(true);
    expect(report.suggestedRigLevel).toBe(rigLevel);
  });

  it("splits merged paired eye layers by image position", async () => {
    const imported = await importPsd(resolve(fixtures, "combined-eyes.psd"));
    for (const role of ["eyeWhite", "iris", "eyelash", "eyebrow"] as const) {
      expect(imported.layers.filter((layer) => layer.role === role).map((layer) => layer.side).sort()).toEqual(["left", "right"]);
    }
  });

  it("applies PSD masks and inherits group opacity while preserving blend mode", async () => {
    const imported = await importPsd(resolve(fixtures, "mask-group-blend.psd"));
    expect(imported.layers).toHaveLength(1);
    const layer = imported.layers[0]!;
    expect(layer.opacity).toBeCloseTo((128 / 255) ** 2, 6);
    expect(layer.blendMode).toBe("multiply");
    expect(layer.bounds.x + layer.bounds.width).toBeLessThanOrEqual(65);
    expect(layer.opaquePixels).toBeGreaterThan(1000);
  });

  it.each(["empty.psd", "corrupted.psd"])("rejects invalid input %s", async (name) => {
    await expect(inspectPsd(resolve(fixtures, name))).rejects.toMatchObject<PuppetLoomError>({ code: "INVALID_INPUT" });
  });
});

describe("project creation", () => {
  it("writes the documented directory and a valid semantic rig", async () => {
    const project = await loadProject(semanticOutput);
    const verification = await verifyProject(semanticOutput);
    expect(project.rigLevel).toBe("semantic");
    expect(project.layers).toHaveLength(19);
    expect(project.runtime.features.mouthMotion).toBe(false);
    expect(project.quality.poseValidations).toHaveLength(13);
    expect(verification.valid).toBe(true);
    for (const relative of [
      "puppetloom.json", "source/source.psd", "source/reference.png", "reports/build-report.json",
      "reports/neutral.png", "reports/pose-sheet.png", "requests/asset-requests.json"
    ]) expect((await stat(resolve(semanticOutput, relative))).isFile()).toBe(true);
  });

  it("keeps neutral recomposition equal to the PSD composite", async () => {
    const reference = await sharp(resolve(fixtures, "semantic-reference.png")).raw().toBuffer();
    const neutral = await sharp(resolve(semanticOutput, "reports/neutral.png")).raw().toBuffer();
    let changed = 0;
    let maximumDifference = 0;
    for (let index = 0; index < reference.length; index += 1) {
      const difference = Math.abs((reference[index] ?? 0) - (neutral[index] ?? 0));
      if (difference > 0) changed += 1;
      maximumDifference = Math.max(maximumDifference, difference);
    }
    expect(maximumDifference).toBeLessThanOrEqual(1);
    expect(changed / reference.length).toBeLessThan(0.00001);
  });

  it("produces real 13-pose visual evidence", async () => {
    const sheet = await sharp(resolve(semanticOutput, "reports/pose-sheet.png")).raw().toBuffer({ resolveWithObject: true });
    expect(sheet.info.width).toBe(960);
    expect(sheet.info.height).toBe(960);
    const neutral = await sharp(resolve(semanticOutput, "reports/pose-sheet.png")).extract({ left: 25, top: 20, width: 190, height: 180 }).raw().toBuffer();
    const yaw = await sharp(resolve(semanticOutput, "reports/pose-sheet.png")).extract({ left: 265, top: 20, width: 190, height: 180 }).raw().toBuffer();
    expect(Buffer.compare(neutral, yaw)).not.toBe(0);
  });

  it("is deterministic for the same input and seed", async () => {
    const second = resolve(runRoot, "semantic-b");
    await createProject({ input: resolve(fixtures, "semantic.psd"), reference: resolve(fixtures, "semantic-reference.png"), output: second, seed: 42 });
    expect(await readFile(resolve(semanticOutput, "puppetloom.json"), "utf8")).toBe(await readFile(resolve(second, "puppetloom.json"), "utf8"));
    expect(await readFile(resolve(semanticOutput, "reports/build-report.json"), "utf8")).toBe(await readFile(resolve(second, "reports/build-report.json"), "utf8"));
  }, 120_000);

  it.each([
    ["grouped.psd", "grouped"],
    ["minimal.psd", "minimal"]
  ])("creates a valid %s fallback", async (fixture, expected) => {
    const output = resolve(runRoot, expected);
    const result = await createProject({ input: resolve(fixtures, fixture), output, seed: 7 });
    expect(result.project.rigLevel).toBe(expected);
    expect((await verifyProject(output)).valid).toBe(true);
  }, 120_000);

  it("refuses to mix a new project into a non-empty directory", async () => {
    await expect(createProject({ input: resolve(fixtures, "minimal.psd"), output: semanticOutput })).rejects.toMatchObject<PuppetLoomError>({ code: "OUTPUT_NOT_EMPTY" });
  });
});

describe("optional enhancement", () => {
  it("describes blink and compact mouth-shape requests without blocking the build", async () => {
    const requests = JSON.parse(await readFile(resolve(semanticOutput, "requests/asset-requests.json"), "utf8")) as { optional: boolean; requests: Array<{ id: string; kind: string; reference: { path: string } }> };
    expect(requests.optional).toBe(true);
    expect(requests.requests.map(({ id }) => id)).toEqual(["closed-eye-left", "closed-eye-right", "mouth-slight", "mouth-open-small"]);
    expect(requests.requests.map(({ kind }) => kind)).toEqual(["closed-eye", "closed-eye", "mouth-shape", "mouth-shape"]);
    for (const request of requests.requests) expect((await stat(resolve(semanticOutput, request.reference.path))).isFile()).toBe(true);
  });

  it("rejects wrong-size supplements and preserves the safe project", async () => {
    const assetDirectory = resolve(runRoot, "bad-supplements");
    await mkdir(assetDirectory, { recursive: true });
    await sharp({ create: { width: 3, height: 3, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(resolve(assetDirectory, "closed-eye-left.png"));
    await sharp({ create: { width: 3, height: 3, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(resolve(assetDirectory, "closed-eye-right.png"));
    await sharp({ create: { width: 3, height: 3, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(resolve(assetDirectory, "mouth-slight.png"));
    await sharp({ create: { width: 3, height: 3, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(resolve(assetDirectory, "mouth-open-small.png"));
    const before = await readFile(resolve(semanticOutput, "puppetloom.json"), "utf8");
    const result = await enhanceProject({ project: semanticOutput, assets: assetDirectory });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(4);
    expect(await readFile(resolve(semanticOutput, "puppetloom.json"), "utf8")).toBe(before);
  });

  it("accepts a complete eye and mouth supplement set", async () => {
    const assetDirectory = resolve(runRoot, "valid-supplements");
    await mkdir(assetDirectory, { recursive: true });
    const document = JSON.parse(await readFile(resolve(semanticOutput, "requests/asset-requests.json"), "utf8")) as { requests: Array<{ id: string; output: { width: number; height: number; path: string } }> };
    for (const request of document.requests) {
      const width = request.output.width;
      const height = request.output.height;
      const mark = Buffer.from(`<svg width="${width}" height="${height}"><rect x="${Math.round(width * 0.3)}" y="${Math.round(height * 0.42)}" width="${Math.max(2, Math.round(width * 0.4))}" height="${Math.max(2, Math.round(height * 0.16))}" rx="2" fill="#442d38"/></svg>`);
      await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: mark }]).png().toFile(resolve(assetDirectory, request.output.path.split("/").at(-1)!));
    }
    const result = await enhanceProject({ project: semanticOutput, assets: assetDirectory });
    expect(result.accepted).toEqual(["closed-eye-left", "closed-eye-right", "mouth-slight", "mouth-open-small"]);
    expect(result.rejected).toEqual([]);
    expect(result.project.runtime.features.blink).toBe(true);
    expect(result.project.layers.filter((layer) => layer.role === "mouth").map((layer) => layer.mouthVariant).sort()).toEqual(["closed", "open", "slight"]);
    expect(JSON.parse(await readFile(resolve(semanticOutput, "reports/build-report.json"), "utf8"))).toMatchObject({ layerCount: 23, enabledFeatures: expect.arrayContaining(["blink"]), disabledFeatures: [] });
    expect((await verifyProject(semanticOutput)).valid).toBe(true);
  });
});
