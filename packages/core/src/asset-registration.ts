import { z } from "zod";
import type { Point, Rect } from "./types.js";

const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() }).strict();
export const assetRegistrationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frame"), generatedRect: rect, sourceRect: rect, allowStretch: z.boolean().optional(), mirrorX: z.boolean().optional(), mirrorY: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("landmarks"), anchors: z.array(z.object({ generated: point, source: point }).strict()).min(2).max(64), maxErrorPixels: z.number().positive().max(100).default(3), mirrorX: z.boolean().optional(), mirrorY: z.boolean().optional() }).strict()
]);
export type AssetRegistrationInput = z.input<typeof assetRegistrationSchema>;
/** x' = a*x + c*y + tx; y' = b*x + d*y + ty, in pixel-edge coordinates. */
export interface AssetAffine { a: number; b: number; c: number; d: number; tx: number; ty: number }
export function mapAssetPoint(matrix: AssetAffine, point: Point): Point {
  return { x: matrix.a * point.x + matrix.c * point.y + matrix.tx, y: matrix.b * point.x + matrix.d * point.y + matrix.ty };
}

export function solveAssetRegistration(raw: AssetRegistrationInput, image: { width: number; height: number }) {
  const input = assetRegistrationSchema.parse(raw);
  const mx = input.mirrorX ? -1 : 1, my = input.mirrorY ? -1 : 1;
  let matrix: AssetAffine;
  let rmsErrorPixels = 0;
  if (input.kind === "frame") {
    const from = input.generatedRect, to = input.sourceRect;
    if (from.x < 0 || from.y < 0 || from.x + from.width > image.width || from.y + from.height > image.height) throw new Error("generatedRect 超出原始 PNG。" );
    const sx = to.width / from.width, sy = to.height / from.height;
    if (!input.allowStretch && Math.abs(sx / sy - 1) > 0.005) throw new Error("配准会产生非等比拉伸；请修正框或明确 allowStretch。" );
    matrix = { a: sx * mx, b: 0, c: 0, d: sy * my, tx: to.x - from.x * sx * mx + (input.mirrorX ? to.width : 0), ty: to.y - from.y * sy * my + (input.mirrorY ? to.height : 0) };
  } else {
    const anchors = input.anchors.map(({ generated, source }) => {
      if (generated.x < 0 || generated.y < 0 || generated.x > image.width || generated.y > image.height) throw new Error("生成图锚点必须位于原始 PNG 内。" );
      return { source, generated: { x: generated.x * mx + (input.mirrorX ? image.width : 0), y: generated.y * my + (input.mirrorY ? image.height : 0) } };
    });
    const n = anchors.length;
    const g = anchors.reduce((sum, anchor) => ({ x: sum.x + anchor.generated.x / n, y: sum.y + anchor.generated.y / n }), { x: 0, y: 0 });
    const s = anchors.reduce((sum, anchor) => ({ x: sum.x + anchor.source.x / n, y: sum.y + anchor.source.y / n }), { x: 0, y: 0 });
    let denominator = 0, dot = 0, cross = 0;
    for (const anchor of anchors) {
      const gx = anchor.generated.x - g.x, gy = anchor.generated.y - g.y, sx = anchor.source.x - s.x, sy = anchor.source.y - s.y;
      denominator += gx * gx + gy * gy; dot += gx * sx + gy * sy; cross += gx * sy - gy * sx;
    }
    if (denominator < 1e-8) throw new Error("锚点重合，无法计算位置、比例和旋转。" );
    const a = dot / denominator, b = cross / denominator;
    if (Math.hypot(a, b) < 1e-8) throw new Error("目标锚点退化，无法配准。" );
    const ox = input.mirrorX ? image.width : 0, oy = input.mirrorY ? image.height : 0;
    matrix = { a: a * mx, b: b * mx, c: -b * my, d: a * my, tx: s.x - a * g.x + b * g.y + a * ox - b * oy, ty: s.y - b * g.x - a * g.y + b * ox + a * oy };
    rmsErrorPixels = Math.sqrt(input.anchors.reduce((sum, anchor) => { const mapped = mapAssetPoint(matrix, anchor.generated); return sum + (mapped.x - anchor.source.x) ** 2 + (mapped.y - anchor.source.y) ** 2; }, 0) / n);
    if (rmsErrorPixels > input.maxErrorPixels) throw new Error(`锚点配准误差 ${rmsErrorPixels.toFixed(2)} px 超过 ${input.maxErrorPixels} px；检查对应点及显式镜像选项。`);
  }
  return { matrix, rmsErrorPixels, input, warnings: input.kind === "landmarks" && input.anchors.length === 2 ? ["两个锚点不能独立核验镜像或非等比变形；建议增加不共线的第三点。"] : [] };
}

/** Rasterize from the original pixels once; premultiplied interpolation avoids dark alpha fringes. */
export function rasterizeRegisteredAsset(data: Uint8Array, width: number, height: number, matrix: AssetAffine, canvas: { width: number; height: number }) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3]! > 0) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  if (maxX < 0) throw new Error("PNG 没有可见像素。" );
  const corners = [{ x: minX, y: minY }, { x: maxX + 1, y: minY }, { x: minX, y: maxY + 1 }, { x: maxX + 1, y: maxY + 1 }].map((p) => mapAssetPoint(matrix, p));
  const snap = (value: number) => Math.abs(value - Math.round(value)) < 1e-8 ? Math.round(value) : value;
  const left = Math.floor(snap(Math.min(...corners.map((p) => p.x)))), top = Math.floor(snap(Math.min(...corners.map((p) => p.y))));
  const right = Math.ceil(snap(Math.max(...corners.map((p) => p.x)))), bottom = Math.ceil(snap(Math.max(...corners.map((p) => p.y))));
  if (left < 0 || top < 0 || right > canvas.width || bottom > canvas.height) throw new Error("配准后的素材超出角色画布；本次没有裁掉素材，请修正配准。" );
  const bounds: Rect = { x: left, y: top, width: right - left, height: bottom - top };
  if (bounds.width < 1 || bounds.height < 1) throw new Error("配准后的素材尺寸为空。" );
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error("配准矩阵不可逆。" );
  const output = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
    const dx = left + x + 0.5 - matrix.tx, dy = top + y + 0.5 - matrix.ty;
    const sx = (matrix.d * dx - matrix.c * dy) / determinant - 0.5, sy = (-matrix.b * dx + matrix.a * dy) / determinant - 0.5;
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
    const rgba = [0, 0, 0, 0];
    for (let v = 0; v < 2; v++) for (let u = 0; u < 2; u++) {
      const px = ix + u, py = iy + v;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const source = (py * width + px) * 4, weight = (u ? fx : 1 - fx) * (v ? fy : 1 - fy), alpha = data[source + 3]! / 255;
      for (let channel = 0; channel < 3; channel++) rgba[channel]! += data[source + channel]! * alpha * weight;
      rgba[3]! += alpha * weight;
    }
    const target = (y * bounds.width + x) * 4;
    output[target + 3] = rgba[3]! * 255;
    for (let channel = 0; channel < 3; channel++) output[target + channel] = output[target + 3]! > 0 ? rgba[channel]! / rgba[3]! : 0;
  }
  return { data: output, bounds };
}
