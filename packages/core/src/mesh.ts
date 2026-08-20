import { roundPoint } from "./math.js";
import type { MeshBinding, MeshInfluenceChannel, MeshInfluences, Point, Rect } from "./types.js";

export const meshInfluenceChannels = ["face", "skull", "head", "body", "gaze", "physics", "pin", "headAttachment", "physicsRelease"] as const satisfies readonly MeshInfluenceChannel[];

export function defaultMeshInfluences(pointCount: number): MeshInfluences {
  return {
    face: Array(pointCount).fill(1),
    skull: Array(pointCount).fill(1),
    head: Array(pointCount).fill(1),
    body: Array(pointCount).fill(1),
    gaze: Array(pointCount).fill(1),
    physics: Array(pointCount).fill(1),
    pin: Array(pointCount).fill(0)
  };
}

export function makeGridMesh(bounds: Rect, rows: number, cols: number): MeshBinding {
  const points: Point[] = [];
  const uvs: Point[] = [];
  const triangles: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    const v = rows <= 1 ? 0 : row / (rows - 1);
    for (let col = 0; col < cols; col += 1) {
      const u = cols <= 1 ? 0 : col / (cols - 1);
      points.push(roundPoint({ x: bounds.x + bounds.width * u, y: bounds.y + bounds.height * v }));
      uvs.push({ x: u, y: v });
    }
  }
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const topLeft = row * cols + col;
      const topRight = topLeft + 1;
      const bottomLeft = (row + 1) * cols + col;
      const bottomRight = bottomLeft + 1;
      triangles.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }
  return {
    topology: "grid",
    rows,
    cols,
    points,
    uvs,
    triangles,
    influences: defaultMeshInfluences(points.length)
  };
}

interface BarycentricSample {
  indices: [number, number, number];
  weights: [number, number, number];
}

function barycentricWeights(point: Point, a: Point, b: Point, c: Point): [number, number, number] | undefined {
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(denominator) < 1e-12) return undefined;
  const wa = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denominator;
  const wb = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denominator;
  const wc = 1 - wa - wb;
  return [wa, wb, wc];
}

function barycentric(point: Point, a: Point, b: Point, c: Point): [number, number, number] | undefined {
  const weights = barycentricWeights(point, a, b, c);
  return weights?.every((weight) => weight >= -1e-7) ? weights : undefined;
}

function sampleLocation(mesh: MeshBinding, uv: Point): BarycentricSample {
  let closest: BarycentricSample | undefined;
  let closestTriangle: { indices: [number, number, number]; vertices: [Point, Point, Point] } | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let triangle = 0; triangle < mesh.triangles.length; triangle += 3) {
    const ia = mesh.triangles[triangle];
    const ib = mesh.triangles[triangle + 1];
    const ic = mesh.triangles[triangle + 2];
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    const a = mesh.uvs[ia];
    const b = mesh.uvs[ib];
    const c = mesh.uvs[ic];
    if (!a || !b || !c) continue;
    const weights = barycentric(uv, a, b, c);
    if (weights) return { indices: [ia, ib, ic], weights };
    const vertices = [a, b, c] as const;
    const ids = [ia, ib, ic] as const;
    for (let edge = 0; edge < 3; edge += 1) {
      const start = vertices[edge]!;
      const end = vertices[(edge + 1) % 3]!;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const amount = lengthSquared <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((uv.x - start.x) * dx + (uv.y - start.y) * dy) / lengthSquared));
      const distance = (uv.x - (start.x + dx * amount)) ** 2 + (uv.y - (start.y + dy * amount)) ** 2;
      if (distance >= closestDistance) continue;
      const edgeWeights: [number, number, number] = [0, 0, 0];
      edgeWeights[edge] = 1 - amount;
      edgeWeights[(edge + 1) % 3] = amount;
      closest = { indices: [ids[0], ids[1], ids[2]], weights: edgeWeights };
      closestTriangle = { indices: [ids[0], ids[1], ids[2]], vertices: [vertices[0], vertices[1], vertices[2]] };
      closestDistance = distance;
    }
  }

  if (closestTriangle) {
    const weights = barycentricWeights(uv, ...closestTriangle.vertices);
    // A denser remesh can place a new silhouette vertex just outside the old
    // polygonal chord. A small affine extrapolation preserves smooth authored
    // weights there; large extrapolations remain clamped to the nearest edge.
    if (weights?.every((weight) => weight >= -0.35 && weight <= 1.35)) {
      return { indices: closestTriangle.indices, weights };
    }
  }
  if (closest) return closest;

  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < mesh.uvs.length; index += 1) {
    const candidate = mesh.uvs[index]!;
    const distance = (candidate.x - uv.x) ** 2 + (candidate.y - uv.y) ** 2;
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return { indices: [nearest, nearest, nearest], weights: [1, 0, 0] };
}

/** Reprojects every influence channel by UV, so remeshing does not reset authored weights. */
export function reprojectMeshInfluences(source: MeshBinding, target: MeshBinding): MeshInfluences {
  const samples = target.uvs.map((uv) => sampleLocation(source, uv));
  return Object.fromEntries(meshInfluenceChannels.flatMap((channel) => {
    const values = source.influences?.[channel];
    // These two masks opt a layer into authored strand attachment. Keeping
    // them absent on old projects preserves the earlier geometric heuristics.
    if ((channel === "headAttachment" || channel === "physicsRelease") && !values) return [];
    const fallback = channel === "pin" || channel === "physicsRelease" ? 0 : 1;
    return [[channel, samples.map(({ indices, weights }) => Math.max(0, Math.min(1,
      (values?.[indices[0]] ?? fallback) * weights[0]
      + (values?.[indices[1]] ?? fallback) * weights[1]
      + (values?.[indices[2]] ?? fallback) * weights[2]
    )))]];
  })) as MeshInfluences;
}

/**
 * Reprojects sparse authored point offsets by UV. This keeps hand-tuned neutral
 * or pose corrections attached to the artwork when an AI remesh changes vertex
 * count and topology.
 */
export function reprojectSparsePointDeltas(
  source: MeshBinding,
  target: MeshBinding,
  deltas: Record<string, Point> | undefined
): Record<string, Point> | undefined {
  if (!deltas || Object.keys(deltas).length === 0) return undefined;
  const samples = target.uvs.map((uv) => sampleLocation(source, uv));
  const projected: Record<string, Point> = {};
  samples.forEach(({ indices, weights }, index) => {
    const point = { x: 0, y: 0 };
    for (let corner = 0; corner < 3; corner += 1) {
      const delta = deltas[String(indices[corner])] ?? { x: 0, y: 0 };
      point.x += delta.x * weights[corner]!;
      point.y += delta.y * weights[corner]!;
    }
    if (Math.hypot(point.x, point.y) > 1e-9) projected[String(index)] = roundPoint(point);
  });
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/** Shortest surface distance along mesh edges; disconnected components remain unreachable. */
export function meshGeodesicDistances(points: Point[], triangles: number[], selected: number): number[] {
  const neighbors: Array<Map<number, number>> = Array.from({ length: points.length }, () => new Map());
  const connect = (left: number, right: number): void => {
    const a = points[left];
    const b = points[right];
    if (!a || !b || left === right) return;
    const length = Math.hypot(a.x - b.x, a.y - b.y);
    neighbors[left]!.set(right, Math.min(neighbors[left]!.get(right) ?? Number.POSITIVE_INFINITY, length));
    neighbors[right]!.set(left, Math.min(neighbors[right]!.get(left) ?? Number.POSITIVE_INFINITY, length));
  };
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index];
    const b = triangles[index + 1];
    const c = triangles[index + 2];
    if (a === undefined || b === undefined || c === undefined) continue;
    connect(a, b); connect(b, c); connect(c, a);
  }

  const distances = Array(points.length).fill(Number.POSITIVE_INFINITY) as number[];
  if (!points[selected]) return distances;
  distances[selected] = 0;
  const heap: Array<{ vertex: number; distance: number }> = [{ vertex: selected, distance: 0 }];
  const push = (entry: { vertex: number; distance: number }): void => {
    heap.push(entry);
    for (let child = heap.length - 1; child > 0;) {
      const parent = Math.floor((child - 1) / 2);
      if (heap[parent]!.distance <= heap[child]!.distance) break;
      [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
      child = parent;
    }
  };
  const pop = (): { vertex: number; distance: number } | undefined => {
    const first = heap[0];
    const last = heap.pop();
    if (!first || !last || heap.length === 0) return first;
    heap[0] = last;
    for (let parent = 0;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;
      if (heap[left] && heap[left]!.distance < heap[smallest]!.distance) smallest = left;
      if (heap[right] && heap[right]!.distance < heap[smallest]!.distance) smallest = right;
      if (smallest === parent) break;
      [heap[parent], heap[smallest]] = [heap[smallest]!, heap[parent]!];
      parent = smallest;
    }
    return first;
  };
  while (heap.length > 0) {
    const current = pop()!;
    if (current.distance !== distances[current.vertex]) continue;
    for (const [neighbor, edgeLength] of neighbors[current.vertex]!) {
      const candidate = current.distance + edgeLength;
      if (candidate >= distances[neighbor]!) continue;
      distances[neighbor] = candidate;
      push({ vertex: neighbor, distance: candidate });
    }
  }
  return distances;
}
