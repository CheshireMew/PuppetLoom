import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readPsd, writePsdBuffer, type Layer } from "ag-psd";
import { describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { createProject, loadBaseProject, loadProject, migrateProject, saveAuthoringPatch, saveCalibrationPatch } from "../src/index.js";

describe("source artwork migration", () => {
  it("preserves edited geometry and parameter animation across native-ID rename and recolor", async () => {
    const root = artifactPath("source-migration");
    await mkdir(root, { recursive: true });
    const psd = readPsd(await readFile(resolve("test/fixtures/semantic.psd")), { useImageData: true });
    const leaves: Layer[] = [];
    let id = 100;
    const walk = (layers: Layer[]) => { for (const layer of layers) { layer.id = id++; if (layer.children) walk(layer.children); else leaves.push(layer); } };
    walk(psd.children ?? []);
    const original = resolve(root, "original.psd"), updated = resolve(root, "updated.psd");
    await writeFile(original, writePsdBuffer(psd));
    const project = resolve(root, "old");
    await createProject({ input: original, output: project, seed: 42 });
    const base = await loadBaseProject(project);
    const face = base.layers.find((layer) => layer.role === "face")!;
    expect(face.sourceLayerId).toMatch(/^psd:\d+$/);
    const source = leaves.find((layer) => `psd:${layer.id}` === face.sourceLayerId)!;
    source.name = `${source.name} renamed`;
    const pixels = source.imageData!.data;
    for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset + 3]! > 0) pixels[offset] = Math.max(0, pixels[offset]! - 10);
    await writeFile(updated, writePsdBuffer(psd));
    await saveAuthoringPatch(project, { version: 1, baseRevision: 0, operations: [{ op: "upsert-binding", binding: { id: "preserved-turn", parameterIds: ["param-head-yaw"], target: { kind: "layer", id: face.id }, keyforms: [{ values: [-1] }, { values: [0] }, { values: [1], meshPointDeltas: { "0": { x: 0.0001, y: 0 } } }] } }] });
    await saveCalibrationPatch(project, { baseRevision: 1, overrides: { layers: { [face.id]: { pivot: { x: face.pivot.x + 0.0001, y: face.pivot.y } } } } });
    const originalState = await readFile(resolve(project, "calibration/current.json"), "utf8");
    const result = await migrateProject({ project, input: updated, output: resolve(root, "new") });
    const match = result.mapping.find((entry) => entry.sourceLayerId === face.id)!;
    expect(match).toMatchObject({ status: "texture-changed", matchedBy: "source-id", renamed: true, migratedFields: expect.arrayContaining(["pivot"]) });
    expect(result.skippedBindingIds).toEqual([]);
    expect(result.appliedRevision).toBe(1);
    const current = await loadProject(result.outputDirectory);
    expect(current.model.bindings.find((binding) => binding.id === "preserved-turn")).toMatchObject({ target: { id: match.targetLayerId }, keyforms: expect.arrayContaining([{ values: [1], meshPointDeltas: { "0": { x: 0.0001, y: 0 } } }]) });
    expect(current.layers.find((layer) => layer.id === match.targetLayerId)!.pivot).toEqual({ x: face.pivot.x + 0.0001, y: face.pivot.y });
    expect(await readFile(resolve(project, "calibration/current.json"), "utf8")).toBe(originalState);
    const other = leaves.find((layer) => layer.id !== source.id && layer.imageData)!;
    const ambiguousPsd = resolve(root, "duplicate-ids.psd");
    // The writer repairs duplicate IDs, so inject the duplicate into an otherwise
    // valid serialized PSD to exercise the reader's real ambiguity boundary.
    const duplicateBytes = Buffer.from(await readFile(updated));
    const signature = Buffer.from("8BIMlyid");
    let replaced = false;
    for (let offset = duplicateBytes.indexOf(signature); offset >= 0; offset = duplicateBytes.indexOf(signature, offset + signature.length)) {
      if (duplicateBytes.readUInt32BE(offset + 8) === 4 && duplicateBytes.readUInt32BE(offset + 12) === other.id) {
        duplicateBytes.writeUInt32BE(source.id!, offset + 12); replaced = true; break;
      }
    }
    expect(replaced).toBe(true);
    await writeFile(ambiguousPsd, duplicateBytes);
    const ambiguous = await migrateProject({ project, input: ambiguousPsd, output: resolve(root, "ambiguous") });
    expect(ambiguous.mapping.find((entry) => entry.sourceLayerId === face.id)).toMatchObject({ status: "ambiguous", skippedFields: expect.arrayContaining(["pivot"]) });
    expect(ambiguous.skippedBindingIds).toContain("preserved-turn");
    const explicit = await migrateProject({ project, input: ambiguousPsd, output: resolve(root, "explicit"), layerMapping: { [face.id]: match.targetLayerId! } });
    expect(explicit.mapping.find((entry) => entry.sourceLayerId === face.id)).toMatchObject({ status: "texture-changed", matchedBy: "explicit", targetLayerId: match.targetLayerId });
    expect(explicit.skippedBindingIds).not.toContain("preserved-turn");
  });
});
