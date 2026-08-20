import { describe, expect, it } from "vitest";
import { reprojectMeshInfluences } from "../src/mesh.js";
import type { MeshBinding } from "../src/types.js";

describe("mesh influence reprojection", () => {
  it("clamps small silhouette extrapolations to the valid influence range", () => {
    const source: MeshBinding = {
      topology: "art",
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      triangles: [0, 1, 2],
      influences: {
        physics: [0, 1, 1],
        pin: [1, 0, 0]
      }
    };
    const target: MeshBinding = {
      topology: "art",
      points: [{ x: 0.6, y: 0.6 }],
      uvs: [{ x: 0.6, y: 0.6 }],
      triangles: []
    };

    const projected = reprojectMeshInfluences(source, target);

    expect(projected.physics).toEqual([1]);
    expect(projected.pin).toEqual([0]);
    expect(Object.values(projected).flat().every((value) => value >= 0 && value <= 1)).toBe(true);
  });
});
