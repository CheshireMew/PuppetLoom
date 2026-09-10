import type { Point } from './types.js';

// Thin-plate interpolation gives the same continuous displacement field inside
// and outside the landmark hull. The affine terms preserve translation/shear.
const kernel = (distanceSquared: number) => distanceSquared > 1e-20 ? .5 * distanceSquared * Math.log(distanceSquared) : 0;

function inverse(matrix: number[][]): number[][] | undefined {
  const n = matrix.length;
  const rows = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(rows[row]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = row;
    if (Math.abs(rows[pivot]![col]!) < 1e-12) return undefined;
    [rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!];
    const divisor = rows[col]![col]!;
    for (let j = 0; j < 2 * n; j++) rows[col]![j]! /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = rows[row]![col]!;
      for (let j = 0; j < 2 * n; j++) rows[row]![j]! -= factor * rows[col]![j]!;
    }
  }
  return rows.map(row => row.slice(n));
}

export function smoothCageWeights(points: Point[]): (point: Point) => number[] {
  if (!points.length) return () => [];
  const center = points.reduce((p, q) => ({ x: p.x + q.x / points.length, y: p.y + q.y / points.length }), { x: 0, y: 0 });
  const scale = Math.max(1e-6, ...points.map(p => Math.hypot(p.x - center.x, p.y - center.y)));
  const normalize = (p: Point) => ({ x: (p.x - center.x) / scale, y: (p.y - center.y) / scale });
  const nodes = points.map(normalize), n = nodes.length;
  const matrix = Array.from({ length: n + 3 }, () => Array<number>(n + 3).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) matrix[i]![j] = kernel((nodes[i]!.x - nodes[j]!.x) ** 2 + (nodes[i]!.y - nodes[j]!.y) ** 2);
    [1, nodes[i]!.x, nodes[i]!.y].forEach((value, j) => { matrix[i]![n + j] = value; matrix[n + j]![i] = value; });
  }
  const inv = inverse(matrix);
  return point => {
    const p = normalize(point);
    if (inv) {
      const basis = [...nodes.map(q => kernel((p.x - q.x) ** 2 + (p.y - q.y) ** 2)), 1, p.x, p.y];
      return nodes.map((_, i) => basis.reduce((sum, value, j) => sum + value * inv[j]![i]!, 0));
    }
    // Degenerate/coincident landmarks use one smooth rule everywhere as well.
    const weights = nodes.map(q => 1 / ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 + .0036));
    const total = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => w / total);
  };
}
