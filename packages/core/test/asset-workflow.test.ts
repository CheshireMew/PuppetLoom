import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { applyAssetAssembly, createProject, loadCalibration, loadProject, migrateProject, planAssetAssembly, prepareAssetReference, registerAssetImage, restoreCalibrationRevision, saveCalibrationPatch } from "../src/index.js";

describe("registered asset workflow", () => {
  it("previews and commits a padded replacement with identical pixels and restores through normal history", async () => {
    const root = artifactPath("asset-workflow"), project = resolve(root, "project");
    await mkdir(root, { recursive: true });
    await createProject({ input: resolve("test/fixtures/semantic.psd"), output: project, seed: 42 });
    const original = await loadProject(project), originalHair = original.layers.find((layer) => layer.role === "frontHair")!;
    await saveCalibrationPatch(project, { baseRevision: 0, overrides: { layers: { [originalHair.id]: {
      meshPointDeltas: Object.fromEntries(originalHair.mesh.points.map((_, i) => [String(i), { x: 0.005, y: 0 }]))
    } } } });
    const before = await loadProject(project), template = before.layers.find((layer) => layer.role === "frontHair")!;
    const baseFile = await readFile(resolve(project, "puppetloom.json"));
    const reference = await prepareAssetReference(project, template.id);
    const source = resolve(project, reference.cleanPath), size = await sharp(source).metadata();
    const image = resolve(root, "padded.png");
    const padded = await sharp(source).extend({ left: 5, right: 5, top: 7, bottom: 7, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    await sharp(padded).resize((size.width! + 10) * 2, (size.height! + 14) * 2, { kernel: "nearest" }).png().toFile(image);
    const registered = await registerAssetImage(project, reference.id, image, { kind: "frame", generatedRect: { x: 10, y: 14, width: size.width! * 2, height: size.height! * 2 }, sourceRect: reference.sourceRect });
    expect(await sharp(resolve(project, registered.texture)).raw().toBuffer()).toEqual(await sharp(source).raw().toBuffer());
    const plan = await planAssetAssembly(project, { baseRevision: 1, additions: [{ registrationId: registered.id, layerId: "replacement-hair" }], replaceLayerIds: [template.id] });
    expect((await loadCalibration(project)).revision).toBe(1);
    expect(plan.evidence.after.artifacts.length).toBeGreaterThan(0);
    const applied = await applyAssetAssembly(project, plan.id);
    expect(applied.calibration.revision).toBe(2);
    const after = await loadProject(project), replacement = after.layers.find((layer) => layer.id === "replacement-hair")!;
    expect(replacement.generatedAsset).toMatchObject({ registrationId: registered.id, templateLayerId: template.id });
    expect(replacement.parentGroup).toBe(template.parentGroup);
    expect(replacement.deformerId).toBe(template.deformerId);
    replacement.mesh.points.forEach((point, index) => {
      expect(point.x - (replacement.bounds.x + replacement.mesh.uvs[index]!.x * replacement.bounds.width)).toBeCloseTo(0.005, 5);
    });
    expect(after.layers.find((layer) => layer.id === template.id)!.visible).toBe(false);
    expect(await readFile(resolve(project, "puppetloom.json"))).toEqual(baseFile);
    const migrated = await migrateProject({ project, input: resolve("test/fixtures/semantic.psd"), output: resolve(root, "migrated") });
    expect(migrated.appliedRevision).toBe(1);
    expect((await loadProject(migrated.outputDirectory)).layers.find((layer) => layer.id === replacement.id)).toEqual(replacement);
    expect(await readFile(resolve(migrated.outputDirectory, registered.originalPath))).toEqual(await readFile(image));
    await expect(applyAssetAssembly(project, plan.id)).rejects.toThrow(/版本/);
    await restoreCalibrationRevision(project, 1, 2, "恢复试装前");
    const restored = await loadProject(project);
    expect(restored.layers).toEqual(before.layers);
    expect(restored.model).toEqual(before.model);
    expect(await readFile(image)).toEqual(await readFile(resolve(project, registered.originalPath)));
  });
});
