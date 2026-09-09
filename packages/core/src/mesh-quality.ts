import type { Point } from "./types.js";

/** Scale-independent triangle quality: zero for degenerate, one for equilateral. */
export function triangleQuality(a: Point, b: Point, c: Point): number {
  const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const lengths = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (b.x - c.x) ** 2 + (b.y - c.y) ** 2 + (c.x - a.x) ** 2 + (c.y - a.y) ** 2;
  return lengths > 0 ? 2 * Math.sqrt(3) * area2 / lengths : 0;
}

/** Relocate interior points only when every incident triangle keeps its orientation
 * and the worst local triangle improves. Vertex budget and all boundary edges stay fixed. */
export function improveInteriorMeshQuality(points: Point[], triangles: number[]): Point[] {
  const result = points.map((point) => ({ ...point }));
  const fans = Array.from({ length: points.length }, () => [] as number[]);
  const edges = new Map<string, { a: number; b: number; count: number }>();
  const adjacent = Array.from({ length: points.length }, () => new Set<number>());
  for (let i = 0; i < triangles.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = triangles[i + j]!, b = triangles[i + (j + 1) % 3]!;
      fans[a]!.push(i); adjacent[a]!.add(b); adjacent[b]!.add(a);
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  }
  const fixed = new Set<number>();
  for (const edge of edges.values()) if (edge.count !== 2) { fixed.add(edge.a); fixed.add(edge.b); }
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let pass = 0; pass < 2; pass++) {
    for (let index = 0; index < result.length; index++) {
      if (fixed.has(index) || fans[index]!.length === 0) continue;
      const neighbors = [...adjacent[index]!];
      const center = neighbors.reduce((mean, neighbor) => ({ x: mean.x + result[neighbor]!.x / neighbors.length, y: mean.y + result[neighbor]!.y / neighbors.length }), { x: 0, y: 0 });
      const original = result[index]!;
      const fan = fans[index]!.map((start) => [triangles[start]!, triangles[start + 1]!, triangles[start + 2]!] as const);
      const before = Math.min(...fan.map(([a, b, c]) => triangleQuality(result[a]!, result[b]!, result[c]!)));
      for (const amount of [0.5, 0.25]) {
        const candidate = { x: original.x + (center.x - original.x) * amount, y: original.y + (center.y - original.y) * amount };
        const at = (id: number) => id === index ? candidate : result[id]!;
        if (fan.some(([a, b, c]) => cross(result[a]!, result[b]!, result[c]!) * cross(at(a), at(b), at(c)) <= 0)) continue;
        const after = Math.min(...fan.map(([a, b, c]) => triangleQuality(at(a), at(b), at(c))));
        if (after > before + 1e-6) { result[index] = candidate; break; }
      }
    }
  }
  return result;
}
