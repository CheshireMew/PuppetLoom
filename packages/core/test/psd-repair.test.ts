import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readPsd } from "ag-psd";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { executePhotoshopPsdRepairOperation, finalizePhotoshopPsdRepairVisualReview } from "../src/psd-repair-operation.js";
import { planPhotoshopPsdRepair, planPhotoshopPsdReview, readPhotoshopPsdRepairRecipe, reviewPhotoshopPsdRepair } from "../src/psd-repair.js";
import { artifactPath } from "../../../test/support/artifacts.js";

function recipe(basePsd: string): Record<string, unknown> {
  return {
    version: 1,
    kind: "puppetloom-photoshop-psd-repair",
    basePsd,
    sources: [],
    operations: [{ op: "set-visibility", layer: "face", visible: true }],
    checks: { requiredLayers: ["face"], opaqueInteriorLayers: [] }
  };
}

describe("Photoshop PSD repair contract", () => {
  it("resolves and hashes a non-overwriting Photoshop repair plan", async () => {
    const directory = artifactPath(`psd-repair-plan-${process.pid}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const recipePath = resolve(directory, "recipe.json");
    const input = resolve("test/fixtures/semantic.psd");
    await writeFile(recipePath, JSON.stringify(recipe(input)));
    const plan = await planPhotoshopPsdRepair({ recipe: recipePath, output: resolve(directory, "output.psd"), workDirectory: resolve(directory, "run") });
    expect(plan).toMatchObject({ mode: "repair", engine: "photoshop-com", recipe: { basePsd: input }, inputManifest: [{ id: "base", path: input }], estimatedBytes: expect.any(Number) });
    expect(plan.inputManifest[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reopens a PSD and writes light, dark, checker and per-layer evidence", async () => {
    const directory = artifactPath(`psd-repair-review-${process.pid}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const input = resolve("test/fixtures/semantic.psd");
    const recipePath = resolve(directory, "recipe.json");
    await writeFile(recipePath, JSON.stringify(recipe(input)));
    const parsed = await readPhotoshopPsdRepairRecipe(recipePath);
    const review = await reviewPhotoshopPsdRepair({ output: input, workDirectory: directory, recipe: parsed });
    expect(review).toMatchObject({ valid: true, requiredLayerChecks: [{ layer: "face", found: true }], requiresVisualReview: true });
    expect(review.artifacts).toMatchObject({
      recomposition: expect.any(String),
      white: expect.any(String),
      dark: expect.any(String),
      checker: expect.any(String),
      layerContactSheet: expect.any(String),
      layerDetailSheet: expect.any(String),
      layerAlphaSheet: expect.any(String)
    });
  });

  it("binds extraction inputs and requires an explicit full-canvas policy for a different resolution", async () => {
    const directory = artifactPath(`psd-repair-canvas-policy-${process.pid}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const input = resolve("test/fixtures/semantic.psd");
    const psd = readPsd(await readFile(input), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true, logMissingFeatures: false });
    const sourceImage = resolve(directory, "source-double-resolution.png");
    const marker = Buffer.from(`<svg width="${psd.width * 2}" height="${psd.height * 2}" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="20" width="20" height="20" fill="#6d4cc7"/></svg>`);
    await sharp({ create: { width: psd.width * 2, height: psd.height * 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite([{ input: marker }]).png().toFile(sourceImage);
    const recipePath = resolve(directory, "fit-recipe.json");
    await writeFile(recipePath, JSON.stringify({
      version: 1,
      kind: "puppetloom-photoshop-psd-repair",
      basePsd: input,
      sources: [],
      operations: [{ op: "extract-white-region", sourceImage, canvasPolicy: "fit-full-canvas", bounds: [0, 0, 30, 30], name: "source-detail" }],
      checks: { requiredLayers: [], opaqueInteriorLayers: [] }
    }));
    const plan = await planPhotoshopPsdRepair({ recipe: recipePath, output: resolve(directory, "fit-output.psd"), workDirectory: resolve(directory, "fit-run") });
    expect(plan.inputManifest.find((entry) => entry.role === "extraction")).toMatchObject({
      path: sourceImage,
      canvasPolicy: "fit-full-canvas",
      canvas: { width: psd.width * 2, height: psd.height * 2 },
      transform: { applied: true, target: { width: psd.width, height: psd.height }, scaleX: 0.5, scaleY: 0.5 }
    });

    const strictRecipePath = resolve(directory, "strict-recipe.json");
    await writeFile(strictRecipePath, JSON.stringify({
      version: 1,
      kind: "puppetloom-photoshop-psd-repair",
      basePsd: input,
      sources: [],
      operations: [{ op: "extract-white-region", sourceImage, bounds: [0, 0, 30, 30], name: "source-detail" }],
      checks: { requiredLayers: [], opaqueInteriorLayers: [] }
    }));
    await expect(planPhotoshopPsdRepair({ recipe: strictRecipePath, output: resolve(directory, "strict-output.psd"), workDirectory: resolve(directory, "strict-run") })).rejects.toThrow(/规范画布.*fit-full-canvas/);
  });

  it("persists an awaiting-review state and only accepts a decision bound to every visual artifact", async () => {
    const directory = artifactPath(`psd-repair-operation-${process.pid}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const input = resolve("test/fixtures/semantic.psd");
    const recipePath = resolve(directory, "recipe.json");
    const workDirectory = resolve(directory, "review-operation");
    await writeFile(recipePath, JSON.stringify(recipe(input)));
    const plan = await planPhotoshopPsdReview({ input, recipe: recipePath, workDirectory });
    const execution = await executePhotoshopPsdRepairOperation(plan);
    expect(execution.result).toMatchObject({ ok: false, completed: false, status: "awaiting-visual-review", stage: "psd-repair-awaiting-visual-review", readyForCreate: false, requiresVisualReview: true, exitCode: 4 });
    expect(JSON.parse(await readFile(resolve(workDirectory, "operation.json"), "utf8"))).toMatchObject({ status: "awaiting-visual-review", progress: { photoshopCompleted: true, automatedReviewCompleted: true } });

    const decisionPath = resolve(workDirectory, "visual-review.json");
    const decision = JSON.parse(await readFile(decisionPath, "utf8")) as { status: string; reviewer: string | null; checks: Array<{ status: string; note: string }> };
    decision.status = "accepted";
    decision.reviewer = "contract test reviewer";
    for (const check of decision.checks) Object.assign(check, { status: "pass", note: "已查看该项绑定证据。" });
    await writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    const finalized = await finalizePhotoshopPsdRepairVisualReview({ workDirectory, decision: decisionPath });
    expect(finalized.result).toMatchObject({ ok: true, completed: true, status: "accepted", readyForCreate: true, visualReviewStatus: "accepted" });
    expect(JSON.parse(await readFile(resolve(workDirectory, "operation.json"), "utf8"))).toMatchObject({ status: "accepted", visualReview: { reviewer: "contract test reviewer" }, recovery: { resumable: false } });
  });

  it("recovers the same failed repair task by archiving a partial PSD and resuming", async () => {
    const directory = artifactPath(`psd-repair-resume-${process.pid}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const input = resolve("test/fixtures/semantic.psd");
    const recipePath = resolve(directory, "recipe.json");
    const output = resolve(directory, "repaired.psd");
    const workDirectory = resolve(directory, "repair-operation");
    await writeFile(recipePath, JSON.stringify(recipe(input)));
    const firstPlan = await planPhotoshopPsdRepair({ recipe: recipePath, output, workDirectory });
    await expect(executePhotoshopPsdRepairOperation(firstPlan, async (_resolvedRecipe, partialOutput) => {
      await writeFile(partialOutput, Buffer.from("partial Photoshop output"));
      throw new Error("controlled Photoshop interruption");
    })).rejects.toThrow(/任务已保留.*operation\.json/);
    expect(JSON.parse(await readFile(resolve(workDirectory, "operation.json"), "utf8"))).toMatchObject({ status: "failed", recovery: { resumable: true } });

    const resumedPlan = await planPhotoshopPsdRepair({ recipe: recipePath, output, workDirectory });
    const resumed = await executePhotoshopPsdRepairOperation(resumedPlan, async (_resolvedRecipe, repairedOutput) => {
      await copyFile(input, repairedOutput);
      return { photoshopVersion: "contract-test" };
    });
    expect(resumed.record).toMatchObject({ status: "awaiting-visual-review", attempts: [{ status: "failed" }, { status: "succeeded", archivedPartialOutput: expect.any(String) }] });
    expect((await stat(resolve(workDirectory, "recovery", "attempt-2-partial-output.psd"))).isFile()).toBe(true);
  });
});
