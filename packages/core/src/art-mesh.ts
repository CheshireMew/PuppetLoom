import { SweepContext, type XY } from "poly2tri";
import { roundPoint } from "./math.js";
import { defaultMeshInfluences, makeGridMesh, reprojectMeshInfluences } from "./mesh.js";
import type { PixelBuffer } from "./psd.js";
import type { ArtMeshRegion, ArtMeshSource, MeshBinding, Point, Rect } from "./types.js";

interface RasterPoint extends Point {}

interface RasterEdge {
  start: RasterPoint;
  end: RasterPoint;
  direction: number;
}

interface PixelComponent {
  label: number;
  pixels: number[];
}

interface TriangulationPoint extends XY {
  meshIndex: number;
}

export interface AdaptiveMeshOptions {
  bounds: Rect;
  pixels: PixelBuffer;
  detail: number;
  fallbackRows: number;
  fallbackCols: number;
  alphaThreshold?: number;
}

const MAX_ART_MESH_VERTICES_PER_REGION = 12_000;
const MAX_ART_MESH_VERTICES = 60_000;

function pointKey(point: RasterPoint): string {
  return `${point.x},${point.y}`;
}

function signedArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return area * 0.5;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
  const amount = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + dx * amount), point.y - (a.y + dy * amount));
}

function distanceToLoops(point: Point, loops: Point[][]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const loop of loops) {
    for (let index = 0; index < loop.length; index += 1) {
      distance = Math.min(distance, distanceToSegment(point, loop[index]!, loop[(index + 1) % loop.length]!));
    }
  }
  return distance;
}

function removeCollinear(points: RasterPoint[]): RasterPoint[] {
  if (points.length <= 3) return points;
  const output: RasterPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]!;
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const cross = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
    if (Math.abs(cross) > 1e-9) output.push(current);
  }
  return output.length >= 3 ? output : points;
}

function perpendicularDistance(point: Point, start: Point, end: Point): number {
  return distanceToSegment(point, start, end);
}

function simplifyOpenPath(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  let furthestIndex = 0;
  let furthestDistance = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index]!, points[0]!, points.at(-1)!);
    if (distance > furthestDistance) {
      furthestDistance = distance;
      furthestIndex = index;
    }
  }
  if (furthestDistance <= tolerance) return [points[0]!, points.at(-1)!];
  const left = simplifyOpenPath(points.slice(0, furthestIndex + 1), tolerance);
  const right = simplifyOpenPath(points.slice(furthestIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function pathBetween(points: Point[], start: number, end: number): Point[] {
  const output: Point[] = [points[start]!];
  for (let index = start; index !== end;) {
    index = (index + 1) % points.length;
    output.push(points[index]!);
  }
  return output;
}

function simplifyClosedLoop(points: Point[], tolerance: number): Point[] {
  if (points.length <= 4 || tolerance <= 0) return points;
  let first = 0;
  let second = 1;
  let bestDistance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const distance = (points[index]!.x - points[first]!.x) ** 2 + (points[index]!.y - points[first]!.y) ** 2;
    if (distance > bestDistance) {
      second = index;
      bestDistance = distance;
    }
  }
  first = second;
  bestDistance = 0;
  for (let index = 0; index < points.length; index += 1) {
    const distance = (points[index]!.x - points[first]!.x) ** 2 + (points[index]!.y - points[first]!.y) ** 2;
    if (distance > bestDistance) {
      second = index;
      bestDistance = distance;
    }
  }
  const forward = simplifyOpenPath(pathBetween(points, first, second), tolerance);
  const backward = simplifyOpenPath(pathBetween(points, second, first), tolerance);
  const simplified = removeCollinear([...forward.slice(0, -1), ...backward.slice(0, -1)]);
  return simplified.length >= 3 ? simplified : points;
}

function labelComponents(mask: Uint8Array, width: number, height: number): PixelComponent[] {
  const labels = new Int32Array(mask.length);
  const components: PixelComponent[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start] !== 0) continue;
    const label = components.length + 1;
    const queue = [start];
    const pixels: number[] = [];
    labels[start] = label;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      pixels.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || !mask[neighbor] || labels[neighbor] !== 0) continue;
        labels[neighbor] = label;
        queue.push(neighbor);
      }
    }
    components.push({ label, pixels });
  }
  return components;
}

function chooseNextEdge(incoming: RasterEdge, candidateIndices: number[], edges: RasterEdge[], unvisited: Set<number>): number | undefined {
  const available = candidateIndices.filter((index) => unvisited.has(index));
  const priority = (candidate: RasterEdge): number => {
    const turn = (candidate.direction - incoming.direction + 4) % 4;
    return turn === 1 ? 0 : turn === 0 ? 1 : turn === 3 ? 2 : 3;
  };
  return available.sort((left, right) => priority(edges[left]!) - priority(edges[right]!))[0];
}

function traceComponentLoops(component: PixelComponent, width: number, height: number, labels: Int32Array): RasterPoint[][] {
  const edges: RasterEdge[] = [];
  const add = (start: RasterPoint, end: RasterPoint, direction: number): void => { edges.push({ start, end, direction }); };
  for (const pixel of component.pixels) {
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (y === 0 || labels[pixel - width] !== component.label) add({ x, y }, { x: x + 1, y }, 0);
    if (x + 1 === width || labels[pixel + 1] !== component.label) add({ x: x + 1, y }, { x: x + 1, y: y + 1 }, 1);
    if (y + 1 === height || labels[pixel + width] !== component.label) add({ x: x + 1, y: y + 1 }, { x, y: y + 1 }, 2);
    if (x === 0 || labels[pixel - 1] !== component.label) add({ x, y: y + 1 }, { x, y }, 3);
  }

  const outgoing = new Map<string, number[]>();
  edges.forEach((edge, index) => outgoing.set(pointKey(edge.start), [...(outgoing.get(pointKey(edge.start)) ?? []), index]));
  const unvisited = new Set(edges.map((_, index) => index));
  const loops: RasterPoint[][] = [];
  while (unvisited.size > 0) {
    const firstIndex = unvisited.values().next().value as number;
    const first = edges[firstIndex]!;
    const loop: RasterPoint[] = [first.start];
    let currentIndex = firstIndex;
    let closed = false;
    for (let count = 0; count <= edges.length; count += 1) {
      const current = edges[currentIndex]!;
      unvisited.delete(currentIndex);
      if (current.end.x === first.start.x && current.end.y === first.start.y) {
        closed = true;
        break;
      }
      loop.push(current.end);
      const next = chooseNextEdge(current, outgoing.get(pointKey(current.end)) ?? [], edges, unvisited);
      if (next === undefined) break;
      currentIndex = next;
    }
    const clean = removeCollinear(loop);
    if (closed && clean.length >= 3 && Math.abs(signedArea(clean)) >= 1) loops.push(clean);
  }
  return loops;
}

function groupLoops(loops: RasterPoint[][]): Array<{ outer: RasterPoint[]; holes: RasterPoint[][] }> {
  const outers = loops.filter((loop) => signedArea(loop) > 0).map((outer) => ({ outer, holes: [] as RasterPoint[][] }));
  const holes = loops.filter((loop) => signedArea(loop) < 0);
  if (outers.length === 0 && loops.length > 0) {
    const largest = [...loops].sort((left, right) => Math.abs(signedArea(right)) - Math.abs(signedArea(left)))[0]!;
    outers.push({ outer: signedArea(largest) > 0 ? largest : [...largest].reverse(), holes: [] });
  }
  for (const hole of holes) {
    const containers = outers
      .filter(({ outer }) => pointInPolygon(hole[0]!, outer))
      .sort((left, right) => Math.abs(signedArea(left.outer)) - Math.abs(signedArea(right.outer)));
    if (containers[0] && Math.abs(signedArea(hole)) >= 4) containers[0].holes.push(hole);
  }
  return outers;
}

function toUv(points: Point[], width: number, height: number): Point[] {
  return points.map((point) => roundPoint({ x: point.x / width, y: point.y / height }));
}

function isMeaningfulComponent(component: PixelComponent, pixels: PixelBuffer, detail: number, alphaThreshold: number): boolean {
  let minX = pixels.width;
  let maxX = 0;
  let minY = pixels.height;
  let maxY = 0;
  let peakAlpha = 0;
  for (const pixel of component.pixels) {
    const x = pixel % pixels.width;
    const y = Math.floor(pixel / pixels.width);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    peakAlpha = Math.max(peakAlpha, pixels.data[pixel * 4 + 3] ?? 0);
  }
  const span = Math.max(maxX - minX + 1, maxY - minY + 1);
  const clearlyVisible = peakAlpha >= Math.max(32, alphaThreshold * 4);
  const structurallyLarge = span >= Math.max(8, detail * 1.5)
    || component.pixels.length >= Math.max(16, detail * detail * 0.5);
  return clearlyVisible || structurallyLarge;
}

export function traceArtMeshSource(pixels: PixelBuffer, alphaThreshold = 8, detail = 32): ArtMeshSource {
  const mask = new Uint8Array(pixels.width * pixels.height);
  let opaquePixels = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if ((pixels.data[index * 4 + 3] ?? 0) < alphaThreshold) continue;
    mask[index] = 1;
    opaquePixels += 1;
  }
  const components = labelComponents(mask, pixels.width, pixels.height);
  const labels = new Int32Array(mask.length);
  for (const component of components) for (const pixel of component.pixels) labels[pixel] = component.label;
  const minimumPixels = Math.max(4, Math.floor(opaquePixels * 0.0001));
  const regions: ArtMeshRegion[] = [];
  for (const component of components.filter((candidate) => candidate.pixels.length >= minimumPixels
    && isMeaningfulComponent(candidate, pixels, detail, alphaThreshold))) {
    for (const region of groupLoops(traceComponentLoops(component, pixels.width, pixels.height, labels))) {
      const outer = simplifyClosedLoop(region.outer, 0.65);
      const holes = region.holes.map((hole) => simplifyClosedLoop(hole, 0.65)).filter((hole) => hole.length >= 3);
      if (outer.length >= 3) regions.push({ outer: toUv(outer, pixels.width, pixels.height), holes: holes.map((hole) => toUv(hole, pixels.width, pixels.height)) });
    }
  }
  return {
    textureSize: { width: pixels.width, height: pixels.height },
    alphaThreshold,
    detail: Math.max(4, Math.min(256, detail)),
    regions
  };
}

function pixelLoop(loop: Point[], source: ArtMeshSource, tolerance: number): Point[] {
  const points = loop.map((point) => ({ x: point.x * source.textureSize.width, y: point.y * source.textureSize.height }));
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  if (points.length > 4 && Math.max(maxX - minX, maxY - minY) <= tolerance * 2) {
    const box = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
    return signedArea(points) < 0 ? box.reverse() : box;
  }
  return simplifyClosedLoop(points, tolerance);
}

function triangulateRegion(region: ArtMeshRegion, source: ArtMeshSource, detail: number): { points: Point[]; triangles: number[] } {
  // `detail` is the target deformation scale in texture pixels. Keeping the
  // contour within one tenth of that value preserved pixel stair-steps as
  // one-pixel edges, while the interior was tens of pixels apart. Besides
  // producing a noisy editor overlay, that imbalance creates long sliver
  // triangles which fold easily during deformation. A third of the target
  // scale still follows visible silhouettes while discarding raster noise.
  const tolerance = Math.max(1, detail * 0.45);
  const outer = pixelLoop(region.outer, source, tolerance);
  const holes = region.holes.map((hole) => pixelLoop(hole, source, tolerance)).filter((hole) => hole.length >= 3);
  if (outer.length < 3) throw new Error("ArtMesh 外轮廓不足三个点。" );

  const input: TriangulationPoint[] = [];
  const makePoints = (loop: Point[]): TriangulationPoint[] => loop.map(({ x, y }) => {
    const point = { x, y, meshIndex: input.length };
    input.push(point);
    return point;
  });
  const contour = makePoints(outer);
  const holePoints = holes.map(makePoints);
  const context = new SweepContext(contour, { cloneArrays: true });
  if (holePoints.length > 0) context.addHoles(holePoints);

  const area = Math.abs(signedArea(outer)) - holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
  // Keep boundary and interior scales close enough that constrained
  // triangulation cannot fan many tiny contour edges into one distant point.
  // The interior may be a little coarser than the silhouette, but not several
  // times coarser as it was before.
  const desiredInteriorSpacing = detail * 1.65;
  const interiorSpacing = Math.max(
    desiredInteriorSpacing,
    Math.sqrt(Math.max(0, area) / Math.max(1, MAX_ART_MESH_VERTICES_PER_REGION - input.length))
  );
  const boundaryDistance = Math.max(1, detail * 0.42);
  const steiner: TriangulationPoint[] = [];
  const minX = Math.min(...outer.map((point) => point.x));
  const maxX = Math.max(...outer.map((point) => point.x));
  const minY = Math.min(...outer.map((point) => point.y));
  const maxY = Math.max(...outer.map((point) => point.y));
  let row = 0;
  for (let y = minY + interiorSpacing * 0.5; y < maxY; y += interiorSpacing, row += 1) {
    const offset = row % 2 === 0 ? 0 : interiorSpacing * 0.5;
    for (let x = minX + interiorSpacing * 0.5 + offset; x < maxX; x += interiorSpacing) {
      const point = { x, y };
      if (!pointInPolygon(point, outer) || holes.some((hole) => pointInPolygon(point, hole))) continue;
      if (distanceToLoops(point, [outer, ...holes]) <= boundaryDistance) continue;
      const candidate = { ...point, meshIndex: input.length };
      input.push(candidate);
      steiner.push(candidate);
    }
  }
  if (steiner.length > 0) context.addPoints(steiner);
  context.triangulate();
  const triangles: number[] = [];
  for (const triangle of context.getTriangles()) {
    const [a, b, c] = triangle.getPoints() as [TriangulationPoint, TriangulationPoint, TriangulationPoint];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (cross > 0) triangles.push(a.meshIndex, c.meshIndex, b.meshIndex);
    else triangles.push(a.meshIndex, b.meshIndex, c.meshIndex);
  }
  return { points: input, triangles };
}

export function buildArtMesh(bounds: Rect, source: ArtMeshSource, detail = source.detail): MeshBinding {
  const clampedDetail = Math.max(4, Math.min(256, detail));
  const points: Point[] = [];
  const uvs: Point[] = [];
  const triangles: number[] = [];
  for (const region of source.regions) {
    const triangulated = triangulateRegion(region, source, clampedDetail);
    if (points.length + triangulated.points.length > MAX_ART_MESH_VERTICES) {
      throw new Error(`ArtMesh 顶点不能超过 ${MAX_ART_MESH_VERTICES}，请增大细节尺度。`);
    }
    const offset = points.length;
    for (const point of triangulated.points) {
      const uv = roundPoint({ x: point.x / source.textureSize.width, y: point.y / source.textureSize.height });
      uvs.push(uv);
      points.push(roundPoint({ x: bounds.x + bounds.width * uv.x, y: bounds.y + bounds.height * uv.y }));
    }
    triangles.push(...triangulated.triangles.map((index) => index + offset));
  }
  if (points.length < 3 || triangles.length < 3) throw new Error("Alpha 轮廓没有生成可渲染的 ArtMesh。" );
  return {
    topology: "art",
    art: { ...source, detail: clampedDetail },
    points,
    uvs,
    triangles,
    influences: defaultMeshInfluences(points.length)
  };
}

export function remeshArtMesh(mesh: MeshBinding, bounds: Rect, detail: number): MeshBinding {
  if (mesh.topology !== "art" || !mesh.art) throw new Error("只有 Alpha ArtMesh 可以按细节尺度重建。" );
  const rebuilt = buildArtMesh(bounds, mesh.art, detail);
  rebuilt.influences = reprojectMeshInfluences(mesh, rebuilt);
  return rebuilt;
}

export function makeAdaptiveMesh(options: AdaptiveMeshOptions): MeshBinding {
  const source = traceArtMeshSource(options.pixels, options.alphaThreshold ?? 8, options.detail);
  let opaquePixels = 0;
  for (let index = 3; index < options.pixels.data.length; index += 4) if ((options.pixels.data[index] ?? 0) >= source.alphaThreshold) opaquePixels += 1;
  const coverage = options.pixels.width * options.pixels.height > 0 ? opaquePixels / (options.pixels.width * options.pixels.height) : 0;
  const rectangular = coverage >= 0.985
    && source.regions.length === 1
    && source.regions[0]!.holes.length === 0
    && source.regions[0]!.outer.length <= 4;
  if (rectangular || source.regions.length === 0) return makeGridMesh(options.bounds, options.fallbackRows, options.fallbackCols);
  try {
    return buildArtMesh(options.bounds, source, options.detail);
  } catch {
    return makeGridMesh(options.bounds, options.fallbackRows, options.fallbackCols);
  }
}
