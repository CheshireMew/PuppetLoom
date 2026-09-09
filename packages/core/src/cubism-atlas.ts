import sharp from 'sharp';

/** PSD2Live AtlasPacker's deterministic shelf layout, with unscaled source pixels.
 * See THIRD_PARTY_NOTICES.md. Cubism atlas dimensions must be powers of two:
 * the Editor otherwise normalizes UVs to a padded size without padding the PNG.
 */
export async function packCubismAtlas(items: { id: string; png: Buffer }[], requestedSize = 2048, padding = 4) {
  if (!Number.isInteger(requestedSize) || requestedSize < 256 || requestedSize > 16384 || (requestedSize & (requestedSize - 1))) {
    throw new Error('Cubism 纹理图集尺寸必须是 256 到 16384 之间的二次幂。');
  }
  const rasters = await Promise.all(items.map(async item => {
    const metadata = await sharp(item.png).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`${item.id} 缺少图像尺寸`);
    return { ...item, width: metadata.width, height: metadata.height };
  }));
  rasters.sort((a, b) => b.height - a.height || b.width - a.width || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const largest = Math.max(requestedSize, ...rasters.map(item => Math.max(item.width, item.height) + padding * 2));
  const size = 2 ** Math.ceil(Math.log2(largest));
  if (size > 16384) throw new Error('图层超过 Cubism 图集容量，未缩小原画。');
  const pages: { input: Buffer; left: number; top: number }[][] = [[]];
  const placements = new Map<string, { page: number; x: number; y: number; width: number; height: number }>();
  let x = padding, y = padding, rowHeight = 0;
  for (const item of rasters) {
    if (x + item.width + padding > size) { x = padding; y += rowHeight + padding; rowHeight = 0; }
    if (y + item.height + padding > size) { pages.push([]); x = padding; y = padding; rowHeight = 0; }
    placements.set(item.id, { page: pages.length - 1, x, y, width: item.width, height: item.height });
    pages.at(-1)!.push({ input: item.png, left: x, top: y });
    x += item.width + padding * 2;
    rowHeight = Math.max(rowHeight, item.height);
  }
  const pngs = await Promise.all(pages.map(pieces => sharp({ create: {
    width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 },
  } }).composite(pieces).png().toBuffer()));
  return { size, placements, pngs };
}
