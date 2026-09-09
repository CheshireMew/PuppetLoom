import type { LayerBinding, Point, PuppetLoomProject } from "./types.js";

/** Geometry-mode keyforms own closure; legacy texture rigs retain their original compression. */
export function blinkPoint(_project: PuppetLoomProject, layer: LayerBinding, base: Point, blink: number): Point {
  if (layer.blinkMode === "geometry" || !["eyeWhite", "iris", "eyelash"].includes(layer.role)) return base;
  const t = Math.max(0, Math.min(1, blink));
  const closing = t * t * (3 - 2 * t);
  return { x: base.x, y: layer.pivot.y + (base.y - layer.pivot.y) * (1 - closing * 0.72) };
}
