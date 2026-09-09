import type { GeometryTransform, Point, Size } from "./types.js";

export type ShapeGuide = Extract<GeometryTransform, { kind: "fit-landmarks" | "curve-warp" }>;
const kernel = (r: number) => r >= 1 ? 0 : (1 - r) ** 4 * (4 * r + 1);

/** Compile once per operation, with distances measured in source pixels on rectangular canvases. */
export function compileShapeGuide(guide: ShapeGuide, canvas: Size): (point: Point) => Point {
  const pixel = (p: Point): Point => ({ x: p.x * canvas.width, y: p.y * canvas.height });
  const normalized = (p: Point): Point => ({ x: p.x / canvas.width, y: p.y / canvas.height });
  if (guide.kind === "fit-landmarks") {
    const points = guide.points.map(p => ({ source: pixel(p.source), target: pixel(p.target) }));
    const n = points.length;
    const matrix = points.map((p, i) => [
      ...points.map((q, j) => {
        const distance = Math.hypot(p.source.x - q.source.x, p.source.y - q.source.y);
        if (i !== j && distance < 1e-4) throw new Error("目标点的来源位置重合；合并或分开这些标记。");
        return kernel(distance / guide.radiusPixels);
      }), p.target.x - p.source.x, p.target.y - p.source.y
    ]);
    // Pivoted solve: zero-displacement landmarks remain actual constraints, not soft suggestions.
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++) if (Math.abs(matrix[row]![col]!) > Math.abs(matrix[pivot]![col]!)) pivot = row;
      [matrix[col], matrix[pivot]] = [matrix[pivot]!, matrix[col]!];
      const divisor = matrix[col]![col]!;
      if (Math.abs(divisor) < 1e-10) throw new Error("目标点约束过于接近或影响半径过大，无法稳定求解。");
      for (let j = col; j < n + 2; j++) matrix[col]![j]! /= divisor;
      for (let row = 0; row < n; row++) if (row !== col) {
        const factor = matrix[row]![col]!;
        for (let j = col; j < n + 2; j++) matrix[row]![j]! -= factor * matrix[col]![j]!;
      }
    }
    return point => {
      const p = pixel(point);
      let dx = 0, dy = 0;
      for (let i = 0; i < n; i++) {
        const q = points[i]!.source, weight = kernel(Math.hypot(p.x - q.x, p.y - q.y) / guide.radiusPixels);
        dx += matrix[i]![n]! * weight; dy += matrix[i]![n + 1]! * weight;
      }
      return normalized({ x: p.x + dx, y: p.y + dy });
    };
  }
  const source = guide.source.map(pixel), target = guide.target.map(pixel);
  const origin = source[0]!, end = source[2]!;
  const length = Math.hypot(end.x - origin.x, end.y - origin.y);
  if (length < 1e-4) throw new Error("曲线两端不能重合。");
  const tangent = { x: (end.x - origin.x) / length, y: (end.y - origin.y) / length };
  const normal = { x: -tangent.y, y: tangent.x };
  const along = (p: Point) => (p.x - origin.x) * tangent.x + (p.y - origin.y) * tangent.y;
  const across = (p: Point) => (p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y;
  // Graphs over one shared eye axis keep a strictly positive Jacobian for monotone profiles.
  for (const curve of [source, target]) for (let i = 0; i < 3; i++) {
    if (Math.abs(along(curve[i]!) - length * i / 2) > 0.01) throw new Error("曲线控制点须按同一眼轴的起点、中点、终点排列；目标只沿眼轴法线移动。");
  }
  const profile = guide.profile;
  for (let i = 1; i < profile.length; i++) if (profile[i]!.source <= profile[i - 1]!.source || profile[i]!.target <= profile[i - 1]!.target) throw new Error("收缩分区的 source 和 target 必须严格递增，不能翻转或压成零宽。");
  const quadratic = (v: number[], u: number) => (1 - u) ** 2 * v[0]! + 2 * (1 - u) * u * v[1]! + u * u * v[2]!;
  const a = source.map(across), b = target.map(across);
  return point => {
    const p = pixel(point), s = along(p), u = s / length, offset = across(p) - quadratic(a, u);
    let index = profile.findIndex((entry, i) => i > 0 && offset <= entry.source);
    if (index < 0) index = profile.length - 1;
    const left = profile[index - 1]!, right = profile[index]!;
    const mapped = left.target + (offset - left.source) * (right.target - left.target) / (right.source - left.source);
    const t = Math.max(0, Math.min(1, u)), taper = guide.taper;
    const thickness = taper ? (t < .5 ? taper.start + (taper.middle - taper.start) * Math.sin(t * Math.PI) : taper.end + (taper.middle - taper.end) * Math.sin(t * Math.PI)) : 1;
    const v = quadratic(b, u) + mapped * thickness;
    return normalized({ x: origin.x + s * tangent.x + v * normal.x, y: origin.y + s * tangent.y + v * normal.y });
  };
}
