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

function longestBoundaryEdgePixels(mesh: ReturnType<typeof buildArtMesh>, texture: PixelBuffer): number {
  const edgeCounts = new Map<string, { from: number; to: number; count: number }>();
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const triangle = mesh.triangles.slice(index, index + 3);
    for (const [from, to] of [[triangle[0]!, triangle[1]!], [triangle[1]!, triangle[2]!], [triangle[2]!, triangle[0]!]]) {
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      const edge = edgeCounts.get(key);
      if (edge) edge.count += 1;
      else edgeCounts.set(key, { from, to, count: 1 });
    }
  }
  return Math.max(...[...edgeCounts.values()].filter(({ count }) => count === 1).map(({ from, to }) => {
    const a = mesh.uvs[from]!;
    const b = mesh.uvs[to]!;
    return Math.hypot((b.x - a.x) * texture.width, (b.y - a.y) * texture.height);
  }));
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

  it("drops detached alpha specks instead of turning them into stray mesh clusters", () => {
    const texture = pixels(96, 96, (x, y) => {
      const main = x >= 18 && x < 78 && y >= 12 && y < 88;
      const twoPixelSpeck = x >= 84 && x < 86 && y >= 20 && y < 22;
      const narrowPaintedStrand = x >= 7 && x < 10 && y >= 24 && y < 58;
      return main || twoPixelSpeck || narrowPaintedStrand;
    });
    const source = traceArtMeshSource(texture, 8, 12);
    expect(source.regions).toHaveLength(2);

    const mesh = buildArtMesh({ x: 0, y: 0, width: 1, height: 1 }, source);
    expect(mesh.points.some((point) => point.x > 0.86 && point.y < 0.3)).toBe(false);
    expect(mesh.points.some((point) => point.x < 0.12 && point.y > 0.2 && point.y < 0.65)).toBe(true);
  });

  it("also removes legacy speck regions when remeshing a stored ArtMesh source", () => {
    const source = traceArtMeshSource(pixels(96, 96, (x, y) => x >= 16 && x < 80 && y >= 12 && y < 90), 8, 12);
    source.regions.push({
      outer: [{ x: 0.9, y: 0.1 }, { x: 0.94, y: 0.1 }, { x: 0.94, y: 0.12 }, { x: 0.9, y: 0.12 }],
      holes: []
    });
    const legacy = buildArtMesh({ x: 0, y: 0, width: 1, height: 1 }, { ...source, detail: 4 }, 4);
    legacy.art = source;
    const rebuilt = remeshArtMesh(legacy, { x: 0, y: 0, width: 1, height: 1 }, 12);
    expect(rebuilt.art?.regions).toHaveLength(1);
    expect(rebuilt.points.some((point) => point.x > 0.88 && point.y < 0.15)).toBe(false);
  });

  it("keeps contour vertices evenly spaced at the selected deformation detail", () => {
    const texture = pixels(160, 160, (x, y) => {
      const dx = x - 80;
      const dy = y - 80;
      const radius = 57 + Math.sin(Math.atan2(dy, dx) * 18) * 2.4;
      return dx * dx + dy * dy <= radius * radius;
    });
    const detail = 12;
    const mesh = buildArtMesh({ x: 0, y: 0, width: 1, height: 1 }, traceArtMeshSource(texture, 8, detail));
    const nearest = mesh.uvs.map((point, index) => Math.min(...mesh.uvs.map((candidate, candidateIndex) => candidateIndex === index
      ? Number.POSITIVE_INFINITY
      : Math.hypot((candidate.x - point.x) * texture.width, (candidate.y - point.y) * texture.height))));
    expect(nearest.filter((distance) => distance < detail * 0.25).length).toBeLessThanOrEqual(2);
  });

  it("does not collapse a long smooth silhouette arc into one undeformable boundary edge", () => {
    const texture = pixels(161, 260, (x, y) => {
      const dx = (x - 80) / 73;
      const dy = (y - 132) / 120;
      return dx * dx + dy * dy <= 1;
    });
    const detail = 12;
    const mesh = buildArtMesh({ x: 0, y: 0, width: 1, height: 1 }, traceArtMeshSource(texture, 8, detail));
    expect(longestBoundaryEdgePixels(mesh, texture)).toBeLessThanOrEqual(detail * 2.05);

    const clippedTexture = pixels(161, 260, (x, y) => {
      const dx = (x - 105) / 75;
      const dy = (y - 132) / 112;
      return dx * dx + dy * dy <= 1;
    });
    const clippedMesh = buildArtMesh({ x: 0, y: 0, width: 1, height: 1 }, traceArtMeshSource(clippedTexture, 8, detail));
    expect(longestBoundaryEdgePixels(clippedMesh, clippedTexture)).toBeLessThanOrEqual(detail * 2.05);
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
