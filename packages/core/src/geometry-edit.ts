import { geometryEditOperationSchema } from "./schema.js";
import { compileShapeGuide } from "./shape-guides.js";
import type { GeometryEditOperation, GeometrySelection, Point, PuppetLoomProject } from "./types.js";

function selectionWeight(point: Point, index: number, selection: GeometrySelection, indices: Set<number>): number {
  if (selection.kind === "all") return 1;
  if (selection.kind === "indices") return indices.has(index) ? 1 : 0;
  let distance: number;
  if (selection.kind === "rect") {
    const r = selection.rect;
    distance = Math.max(Math.abs((point.x - r.x) / r.width * 2 - 1), Math.abs((point.y - r.y) / r.height * 2 - 1));
  } else if (selection.kind === "circle") {
    distance = Math.hypot(point.x - selection.center.x, point.y - selection.center.y) / selection.radius;
  } else {
    const dx = selection.end.x - selection.start.x;
    const dy = selection.end.y - selection.start.y;
    const t = Math.max(0, Math.min(1, ((point.x - selection.start.x) * dx + (point.y - selection.start.y) * dy) / (dx * dx + dy * dy)));
    distance = Math.hypot(point.x - selection.start.x - t * dx, point.y - selection.start.y - t * dy) / selection.radius;
  }
  if (distance > 1) return 0;
  const feather = selection.feather ?? 0;
  if (feather === 0) return 1;
  const t = Math.max(0, Math.min(1, (1 - distance) / feather));
  return t * t * (3 - 2 * t);
}

function topology(pointCount: number, triangles: number[]): { neighbors: Set<number>[]; boundary: Set<number> } {
  const neighbors = Array.from({ length: pointCount }, () => new Set<number>());
  const edges = new Map<string, { a: number; b: number; count: number }>();
  for (let t = 0; t < triangles.length; t += 3) {
    for (let j = 0; j < 3; j++) {
      const a = triangles[t + j]!;
      const b = triangles[t + (j + 1) % 3]!;
      neighbors[a]!.add(b);
      neighbors[b]!.add(a);
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  }
  const boundary = new Set<number>();
  for (const edge of edges.values()) if (edge.count === 1) { boundary.add(edge.a); boundary.add(edge.b); }
  return { neighbors, boundary };
}

/** Triangle area is quadratic during linear interpolation: check its actual minimum, not a few frames. */
function assertGuideTopology(rest: Point[], target: Point[], triangles: number[]): void {
  const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
  const subtract = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3) as [number, number, number];
    const u = subtract(rest[b]!, rest[a]!), v = subtract(rest[c]!, rest[a]!);
    const du = subtract(subtract(target[b]!, target[a]!), u), dv = subtract(subtract(target[c]!, target[a]!), v);
    const area = cross(u, v);
    if (Math.abs(area) < 1e-16) continue;
    const sign = Math.sign(area), A = cross(du, dv) * sign, B = (cross(du, v) + cross(u, dv)) * sign, C = Math.abs(area);
    const samples = [C, A + B + C];
    if (A > 0) { const t = -B / (2 * A); if (t > 0 && t < 1) samples.push(A * t * t + B * t + C); }
    if (Math.min(...samples) <= C * 1e-8) throw new Error(`目标修形会使三角形 ${i / 3} 在过渡中翻折或退化；调整目标、影响范围或网格后重试。`);
  }
}

/** Mutates only the selected existing keyform inside the caller's isolated authoring transaction. */
export function transformKeyform(project: PuppetLoomProject, raw: GeometryEditOperation): void {
  const operation = geometryEditOperationSchema.parse(raw) as GeometryEditOperation;
  const binding = project.model.bindings.find((candidate) => candidate.id === operation.bindingId);
  if (!binding) throw new Error(`找不到绑定：${operation.bindingId}`);
  const keyform = binding.keyforms.find((candidate) => candidate.values.length === operation.values.length && candidate.values.every((value, axis) => value === operation.values[axis]));
  if (!keyform) throw new Error("修形必须指定已有关键形的准确参数值；先插入关键形再修形。" );
  const layer = binding.target.kind === "layer" ? project.layers.find((candidate) => candidate.id === binding.target.id) : undefined;
  const deformer = binding.target.kind === "deformer" ? project.model.deformers.find((candidate) => candidate.id === binding.target.id) : undefined;
  if (layer?.locked) throw new Error(`图层已锁定：${layer.id}`);
  if (!layer && deformer?.kind !== "warp") throw new Error("区域修形只支持图层网格或 warp 控制点。" );
  const rest = layer ? layer.mesh.points : deformer?.kind === "warp" ? deformer.controlPoints : [];
  const triangles = layer ? layer.mesh.triangles : [];
  if (deformer?.kind === "warp") {
    for (let y = 0; y < deformer.rows - 1; y++) for (let x = 0; x < deformer.cols - 1; x++) {
      const i = y * deformer.cols + x;
      triangles.push(i, i + 1, i + deformer.cols, i + 1, i + deformer.cols + 1, i + deformer.cols);
    }
  }
  const selection = operation.selection;
  const indices = new Set(selection.kind === "indices" ? selection.indices : []);
  if ([...indices].some((index) => index >= rest.length)) throw new Error("选区引用了不存在的顶点。" );
  if (selection.kind === "line" && selection.start.x === selection.end.x && selection.start.y === selection.end.y) throw new Error("线段选区的两端不能重合。" );
  // Selection is frozen in rest space; earlier transforms cannot move vertices into a later selection.
  const weights = rest.map((point, index) => selectionWeight(point, index, selection, indices));
  if (!weights.some((weight) => weight > 0)) throw new Error("选区没有包含可编辑顶点。" );
  const field = layer ? "meshPointDeltas" : "warpPointDeltas";
  const original = keyform[field] ?? {};
  let deltas = rest.map((_, index) => ({ ...(original[String(index)] ?? { x: 0, y: 0 }) }));
  const { neighbors, boundary } = topology(rest.length, triangles);
  for (const transform of operation.transforms) {
    const guide = transform.kind === "fit-landmarks" || transform.kind === "curve-warp" ? compileShapeGuide(transform, project.canvas) : undefined;
    if (transform.kind === "smooth") {
      for (let iteration = 0; iteration < transform.iterations; iteration++) {
        const previous = deltas;
        deltas = previous.map((delta, index) => {
          const adjacent = [...neighbors[index]!];
          if (adjacent.length === 0 || (transform.preserveBoundary !== false && boundary.has(index))) return delta;
          const amount = weights[index]! * transform.strength;
          const mean = adjacent.reduce((sum, neighbor) => ({ x: sum.x + previous[neighbor]!.x / adjacent.length, y: sum.y + previous[neighbor]!.y / adjacent.length }), { x: 0, y: 0 });
          return { x: delta.x + (mean.x - delta.x) * amount, y: delta.y + (mean.y - delta.y) * amount };
        });
      }
      continue;
    }
    deltas = deltas.map((delta, index) => {
      const base = rest[index]!;
      const point = { x: base.x + delta.x, y: base.y + delta.y };
      let target: Point;
      if (guide) target = guide(point);
      else if (transform.kind === "translate") target = { x: point.x + transform.delta.x, y: point.y + transform.delta.y };
      else if (transform.kind === "scale") target = { x: transform.origin.x + (point.x - transform.origin.x) * transform.factors.x, y: transform.origin.y + (point.y - transform.origin.y) * transform.factors.y };
      else if (transform.kind === "rotate") {
        const angle = transform.degrees * Math.PI / 180;
        const x = point.x - transform.origin.x, y = point.y - transform.origin.y;
        target = { x: transform.origin.x + x * Math.cos(angle) - y * Math.sin(angle), y: transform.origin.y + x * Math.sin(angle) + y * Math.cos(angle) };
      } else if (transform.kind === "bend") {
        const along = transform.axis === "x" ? base.y : base.x;
        const u = (along - transform.center) / transform.halfSpan;
        const amount = transform.amount * Math.max(0, 1 - u * u);
        target = { ...point, [transform.axis]: point[transform.axis] + amount };
      } else throw new Error("不支持的修形操作。");
      const weight = weights[index]!;
      return { x: delta.x + (target.x - point.x) * weight, y: delta.y + (target.y - point.y) * weight };
    });
  }
  // Preserve untouched sparse entries exactly, including explicit zero values.
  if (operation.transforms.some(t => t.kind === "fit-landmarks" || t.kind === "curve-warp")) {
    const target = rest.map((p, i) => ({ x: p.x + deltas[i]!.x, y: p.y + deltas[i]!.y }));
    assertGuideTopology(rest, target, triangles);
    assertGuideTopology(rest.map((p, i) => ({ x: p.x + (original[String(i)]?.x ?? 0), y: p.y + (original[String(i)]?.y ?? 0) })), target, triangles);
  }
  const result = { ...original };
  deltas.forEach((delta, index) => {
    if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) throw new Error("修形产生了非有限坐标。" );
    const previous = original[String(index)] ?? { x: 0, y: 0 };
    if (delta.x !== previous.x || delta.y !== previous.y) result[String(index)] = delta;
  });
  if (Object.keys(result).length > 0) keyform[field] = result;
}
