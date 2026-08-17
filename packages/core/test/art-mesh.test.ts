import { describe, expect, it } from "vitest";
import { buildArtMesh, makeAdaptiveMesh, remeshArtMesh, traceArtMeshSource } from "../src/art-mesh.js";
import { meshGeodesicDistances } from "../src/mesh.js";
import type { PixelBuffer } from "../src/psd.js";

function pixels(width: number, height: number, opaque: (x: number, y: number) => boolean): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = opaque(x, y) ? 255 : 0;
    }
  }
  return { width, height, data };
}

function opaqueAt(buffer: PixelBuffer, u: number, v: number): boolean {
  const x = Math.max(0, Math.min(buffer.width - 1, Math.floor(u * buffer.width)));
  const y = Math.max(0, Math.min(buffer.height - 1, Math.floor(v * buffer.height)));
  return (buffer.data[(y * buffer.width + x) * 4 + 3] ?? 0) >= 8;
}

describe("Alpha-aware ArtMesh", () => {
  it("keeps disconnected painted regions separate and preserves transparent holes", () => {
    const texture = pixels(64, 48, (x, y) => {
      const ring = x >= 3 && x < 29 && y >= 4 && y < 43 && !(x >= 10 && x < 22 && y >= 13 && y < 34);
      const fin = x >= 38 && x < 61 && y >= 8 && y < 41 && x - 38 <= (y - 8) * 0.8;
      return ring || fin;
    });
    const source = traceArtMeshSource(texture, 8, 7);
    expect(source.regions).toHaveLength(2);
    expect(source.regions.reduce((count, region) => count + region.holes.length, 0)).toBe(1);

    const mesh = buildArtMesh({ x: 0.1, y: 0.2, width: 0.7, height: 0.5 }, source);
    expect(mesh.topology).toBe("art");
    expect(mesh.rows).toBeUndefined();
    expect(mesh.cols).toBeUndefined();
    expect(mesh.triangles.length).toBeGreaterThan(0);
    for (let index = 0; index < mesh.triangles.length; index += 3) {
      const uvs = mesh.triangles.slice(index, index + 3).map((vertex) => mesh.uvs[vertex]!);
      const centroid = {
        x: uvs.reduce((sum, point) => sum + point.x, 0) / 3,
        y: uvs.reduce((sum, point) => sum + point.y, 0) / 3
      };
      expect(opaqueAt(texture, centroid.x, centroid.y)).toBe(true);
    }
  });

  it("rebuilds at a new detail while projecting authored weights by UV", () => {
    const texture = pixels(80, 80, (x, y) => {
      const dx = x - 40;
      const dy = y - 40;
      return dx * dx + dy * dy <= 34 * 34;
    });
    const source = traceArtMeshSource(texture, 8, 14);
    const mesh = buildArtMesh({ x: 0, y: 0, width: 1, height: 1 }, source);
    mesh.influences!.pin = mesh.uvs.map((point) => point.x);
    const rebuilt = remeshArtMesh(mesh, { x: 0, y: 0, width: 1, height: 1 }, 8);
    expect(rebuilt.points.length).toBeGreaterThan(mesh.points.length);
    for (let index = 0; index < rebuilt.points.length; index += Math.max(1, Math.floor(rebuilt.points.length / 20))) {
      expect(rebuilt.influences?.pin?.[index]).toBeCloseTo(rebuilt.uvs[index]!.x, 2);
    }
  });

  it("retains a compact regular mesh for fully opaque rectangular artwork", () => {
    const texture = pixels(32, 24, () => true);
    const mesh = makeAdaptiveMesh({
      bounds: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
      pixels: texture,
      detail: 8,
      fallbackRows: 4,
      fallbackCols: 5
    });
    expect(mesh.topology).toBe("grid");
    expect(mesh.points).toHaveLength(20);
  });

  it("keeps soft selection on the selected mesh component", () => {
    const points = [
      { x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0, y: 0.1 },
      { x: 0.11, y: 0 }, { x: 0.21, y: 0 }, { x: 0.21, y: 0.1 }
    ];
    const distances = meshGeodesicDistances(points, [0, 1, 2, 3, 4, 5], 1);
    expect(distances[0]).toBeCloseTo(0.1, 6);
    expect(distances[3]).toBe(Number.POSITIVE_INFINITY);
  });
});
