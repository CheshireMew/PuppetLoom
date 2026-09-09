import { describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import * as quality from "../src/mesh-quality.js";
import { makeAdaptiveMesh } from "../src/art-mesh.js";
import { createProject, loadProject } from "../src/index.js";
import { renderProjectDirectoryPosePng } from "../src/offline-render.js";
import { neutralMotionState } from "../src/deform.js";
import { artifactPath } from "../../../test/support/artifacts.js";
import { improveInteriorMeshQuality, triangleQuality } from "../src/mesh-quality.js";

describe("interior mesh quality", () => {
  it("renders curves and holes before and after optimization with identical topology and vertex budgets", async () => {
    const root = artifactPath("mesh-quality-visual");
    await mkdir(root, { recursive: true });
    await createProject({ input: resolve("test/fixtures/semantic.psd"), output: resolve(root, "project"), seed: 42 });
    const project = await loadProject(resolve(root, "project"));
    const textureSize = 128, metrics = [];
    for (const shape of ["curved-strand", "ring"] as const) {
      const data = new Uint8ClampedArray(textureSize * textureSize * 4);
      for (let y = 0; y < textureSize; y++) for (let x = 0; x < textureSize; x++) {
        const r = Math.hypot(x - 64, y - 64);
        const opaque = shape === "ring" ? r < 52 && r > 28 : y > 8 && y < 120 && Math.abs(x - (60 + 18 * Math.sin(y / 30))) < 4 + (120 - y) / 12;
        data.set([80 + x, 70 + y, 190, opaque ? 255 : 0], (y * textureSize + x) * 4);
      }
      const texture = `${shape}.png`;
      await sharp(data, { raw: { width: textureSize, height: textureSize, channels: 4 } }).png().toFile(resolve(root, texture));
      const options = { bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, pixels: { width: textureSize, height: textureSize, data }, detail: 12, fallbackRows: 4, fallbackCols: 4 };
      const bypass = vi.spyOn(quality, "improveInteriorMeshQuality").mockImplementation((points) => points.map((point) => ({ ...point })));
      let before;
      try { before = makeAdaptiveMesh(options); } finally { bypass.mockRestore(); }
      const after = makeAdaptiveMesh(options);
      expect(after.topology).toBe("art");
      expect(after.points.length).toBe(before.points.length);
      expect(after.triangles).toEqual(before.triangles);
      expect(after.art?.regions).toEqual(before.art?.regions);
      const worst = (mesh: typeof after) => Math.min(...Array.from({ length: mesh.triangles.length / 3 }, (_, i) => triangleQuality(...mesh.triangles.slice(i * 3, i * 3 + 3).map((index) => mesh.points[index]!) as [typeof mesh.points[number], typeof mesh.points[number], typeof mesh.points[number]])));
      expect(worst(after)).toBeGreaterThanOrEqual(worst(before) - 0.00001);
      metrics.push({ shape, vertices: after.points.length, triangles: after.triangles.length / 3, beforeWorstQuality: worst(before), afterWorstQuality: worst(after) });
      const frames = [];
      for (const mesh of [before, after]) for (const bend of [0, 1]) {
        const specimen = structuredClone(project), layer = structuredClone(project.layers[0]!);
        Object.assign(layer, { mesh, texture, bounds: options.bounds, role: "accessory", weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "root" });
        delete layer.deformerId; delete layer.hairStrands;
        specimen.layers = [layer]; specimen.model.bindings = []; specimen.model.deformers = [];
        layer.mesh = structuredClone(mesh);
        // Apply the same nonlinear displacement field to both real meshes.
        layer.mesh.points = layer.mesh.points.map((point) => ({ x: point.x + bend * 0.12 * Math.sin(point.y * Math.PI), y: point.y }));
        frames.push(await renderProjectDirectoryPosePng(root, specimen, neutralMotionState, 256, 256));
      }
      await sharp({ create: { width: 512, height: 512, channels: 4, background: "#eeeeee" } }).composite(frames.map((input, i) => ({ input, left: (i % 2) * 256, top: Math.floor(i / 2) * 256 }))).png().toFile(resolve(root, `${shape}-before-after.png`));
    }
    await writeFile(resolve(root, "metrics.json"), JSON.stringify({ layout: "top: before, bottom: after; left: neutral, right: same bend", metrics }, null, 2));
  });
  it("improves a sliver fan without changing vertex budget, boundary or triangle orientation", () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0.1, y: 5 }];
    const triangles = [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4];
    const result = improveInteriorMeshQuality(points, triangles);
    const worst = (vertices: typeof points) => Math.min(...[0, 3, 6, 9].map((i) => triangleQuality(vertices[triangles[i]!]!, vertices[triangles[i + 1]!]!, vertices[triangles[i + 2]!]!)));
    expect(result).toHaveLength(points.length);
    expect(result.slice(0, 4)).toEqual(points.slice(0, 4));
    expect(worst(result)).toBeGreaterThan(worst(points) * 5);
    expect(points[4]).toEqual({ x: 0.1, y: 5 });
    for (let i = 0; i < triangles.length; i += 3) {
      const [a, b, c] = triangles.slice(i, i + 3).map((index) => result[index]!);
      expect((b!.x - a!.x) * (c!.y - a!.y) - (b!.y - a!.y) * (c!.x - a!.x)).toBeGreaterThan(0);
    }
  });
});
