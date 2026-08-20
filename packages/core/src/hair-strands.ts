import type { ImportedLayer } from "./psd.js";
import type { HairStrandSpec, LayerBinding, Point, Size } from "./types.js";

interface BottomRun {
  start: number;
  end: number;
  tipX: number;
  tipY: number;
  score: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(value: number): number {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function roundedPoint(point: Point): Point {
  return { x: rounded(point.x), y: rounded(point.y) };
}

function alphaAt(layer: ImportedLayer, x: number, y: number): number {
  return layer.pixels.data[(y * layer.pixels.width + x) * 4 + 3] ?? 0;
}

function bottomContour(layer: ImportedLayer): Array<number | undefined> {
  return Array.from({ length: layer.pixels.width }, (_, x) => {
    for (let y = layer.pixels.height - 1; y >= 0; y -= 1) if (alphaAt(layer, x, y) > 8) return y;
    return undefined;
  });
}

function bottomRuns(layer: ImportedLayer): BottomRun[] {
  const contour = bottomContour(layer);
  const valid = contour.filter((value): value is number => value !== undefined);
  if (valid.length === 0) return [];
  const deepest = Math.max(...valid);
  const activeThreshold = deepest - Math.max(3, layer.pixels.height * 0.12);
  const runs: BottomRun[] = [];
  let start = -1;
  for (let x = 0; x <= contour.length; x += 1) {
    const active = x < contour.length && (contour[x] ?? -1) >= activeThreshold;
    if (active && start < 0) start = x;
    if (active || start < 0) continue;
    const end = x - 1;
    if (end - start + 1 >= Math.max(2, Math.round(layer.pixels.width * 0.012))) {
      let weightedX = 0;
      let weightTotal = 0;
      let tipY = 0;
      for (let column = start; column <= end; column += 1) {
        const y = contour[column] ?? 0;
        const weight = Math.max(1, y - activeThreshold + 1);
        weightedX += column * weight;
        weightTotal += weight;
        tipY = Math.max(tipY, y);
      }
      const widthScore = clamp((end - start + 1) / Math.max(1, layer.pixels.width * 0.16));
      const depthScore = clamp((tipY - activeThreshold) / Math.max(1, deepest - activeThreshold));
      runs.push({
        start,
        end,
        tipX: weightedX / Math.max(1, weightTotal),
        tipY,
        score: widthScore * 0.55 + depthScore * 0.45
      });
    }
    start = -1;
  }
  return runs;
}

function fallbackRuns(layer: ImportedLayer, desired: number): BottomRun[] {
  const contour = bottomContour(layer);
  const runs: BottomRun[] = [];
  for (let section = 0; section < desired; section += 1) {
    const start = Math.floor(section * contour.length / desired);
    const end = Math.max(start, Math.floor((section + 1) * contour.length / desired) - 1);
    let tipX = -1;
    let tipY = -1;
    for (let x = start; x <= end; x += 1) {
      const y = contour[x] ?? -1;
      if (y > tipY) {
        tipX = x;
        tipY = y;
      }
    }
    if (tipX >= 0) runs.push({ start, end, tipX, tipY, score: 0.42 });
  }
  return runs;
}

function selectedRuns(layer: ImportedLayer): BottomRun[] {
  const detected = bottomRuns(layer)
    .sort((left, right) => right.score - left.score || left.tipX - right.tipX)
    .slice(0, 6)
    .sort((left, right) => left.tipX - right.tipX);
  if (detected.length >= 2) return detected;
  const desired = layer.pixels.width >= 180 ? 3 : 2;
  return fallbackRuns(layer, desired).slice(0, 6);
}

function strandRootY(layer: ImportedLayer, binding: LayerBinding): number {
  if (layer.role === "frontHair") return binding.secondaryAnchors?.frontHairRoot?.y ?? binding.bounds.y + binding.bounds.height * 0.42;
  return binding.bounds.y + binding.bounds.height * (layer.role === "sideHair" ? 0.12 : 0.16);
}

function strandWidth(index: number, tips: Point[], boundsWidth: number): number {
  const leftDistance = index > 0 ? Math.abs(tips[index]!.x - tips[index - 1]!.x) : Number.POSITIVE_INFINITY;
  const rightDistance = index + 1 < tips.length ? Math.abs(tips[index + 1]!.x - tips[index]!.x) : Number.POSITIVE_INFINITY;
  const nearest = Math.min(leftDistance, rightDistance);
  return rounded(clamp(Number.isFinite(nearest) ? nearest * 0.62 : boundsWidth * 0.24, boundsWidth * 0.08, boundsWidth * 0.34));
}

function strandOwnership(point: Point, root: Point, tip: Point, width: number): { raw: number; release: number } {
  const dx = tip.x - root.x;
  const dy = tip.y - root.y;
  const lengthSquared = Math.max(1e-12, dx * dx + dy * dy);
  const projection = clamp(((point.x - root.x) * dx + (point.y - root.y) * dy) / lengthSquared);
  const expected = { x: root.x + dx * projection, y: root.y + dy * projection };
  const distance = Math.hypot(point.x - expected.x, point.y - expected.y);
  const raw = Math.exp(-0.5 * (distance / Math.max(1e-6, width)) ** 2);
  const release = point.y <= root.y ? 0 : smoothstep((projection - 0.04) / 0.96) ** 1.18;
  return { raw, release };
}

/** Builds persistent, vertex-owned strands from the painted lower contour. */
export function inferHairStrands(layer: ImportedLayer, binding: LayerBinding, canvas: Size): HairStrandSpec[] {
  if (layer.role !== "frontHair" && layer.role !== "backHair" && layer.role !== "sideHair") return [];
  const runs = selectedRuns(layer);
  if (runs.length < 2) return [];
  const rootY = strandRootY(layer, binding);
  const tips = runs.map((run) => roundedPoint({
    x: (layer.bounds.x + run.tipX) / canvas.width,
    y: (layer.bounds.y + run.tipY) / canvas.height
  }));
  const roots = tips.map((tip) => roundedPoint({
    x: clamp(tip.x, binding.bounds.x + binding.bounds.width * 0.04, binding.bounds.x + binding.bounds.width * 0.96),
    y: rootY
  }));
  const widths = tips.map((_, index) => strandWidth(index, tips, binding.bounds.width));
  const perVertex = binding.mesh.points.map((point) => {
    const values = tips.map((tip, index) => strandOwnership(point, roots[index]!, tip, widths[index]!));
    const total = values.reduce((sum, value) => sum + value.raw, 0);
    return values.map((value) => ({ weight: total > 1e-9 ? value.raw / total : 0, release: value.release }));
  });
  const roleProfile = layer.role === "frontHair"
    ? { stiffness: 30, damping: 9.4, segments: 4, maxDisplacement: 0.078 }
    : layer.role === "sideHair"
      ? { stiffness: 24, damping: 7.6, segments: 5, maxDisplacement: 0.098 }
      : { stiffness: 21, damping: 6.9, segments: 5, maxDisplacement: 0.112 };

  return runs.map((run, index) => ({
    id: `${binding.id}:strand-${String(index + 1).padStart(2, "0")}`,
    root: roots[index]!,
    tip: tips[index]!,
    width: widths[index]!,
    confidence: rounded(clamp(0.5 + run.score * 0.46)),
    source: "alpha-contour",
    physics: roleProfile,
    weights: perVertex.map((values) => rounded(values[index]!.weight)),
    release: perVertex.map((values) => rounded(values[index]!.release))
  }));
}

export function hairAttachmentInfluences(binding: LayerBinding, strands: HairStrandSpec[]): { headAttachment: number[]; physicsRelease: number[] } {
  const headAttachment = binding.mesh.points.map((_, vertexIndex) => {
    const released = strands.reduce((sum, strand) => sum + (strand.weights[vertexIndex] ?? 0) * (strand.release[vertexIndex] ?? 0), 0);
    return rounded(clamp(1 - released));
  });
  return {
    headAttachment,
    physicsRelease: headAttachment.map((attachment) => rounded(1 - attachment))
  };
}
