import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { packCubismAtlas } from '../src/cubism-atlas.js';

describe('Cubism source texture atlas', () => {
  it('keeps asymmetric small layers at full scale, without overwriting earlier layers', async () => {
    const rgba = Buffer.alloc(25 * 9 * 4);
    for (let i = 0; i < 25 * 9; i++) {
      rgba.set([i % 25 * 10, Math.floor(i / 25) * 28, 255, 255], i * 4);
    }
    const mouth = await sharp(rgba, { raw: { width: 25, height: 9, channels: 4 } }).png().toBuffer();
    const face = await sharp({ create: { width: 198, height: 185, channels: 4, background: '#ff8040' } }).png().toBuffer();
    const result = await packCubismAtlas([{ id: 'mouth', png: mouth }, { id: 'face', png: face }], 256);
    expect(result.size).toBe(256);
    for (const [id, png] of [['mouth', mouth], ['face', face]] as const) {
      const p = result.placements.get(id)!;
      const pixels = await sharp(result.pngs[p.page]).extract({ left: p.x, top: p.y, width: p.width, height: p.height }).raw().toBuffer();
      expect(pixels).toEqual(await sharp(png).raw().toBuffer());
    }
    expect([...result.placements.values()].every(p => p.x >= 4 && p.y >= 4)).toBe(true);
  });

  it('splits full pages and deterministically preserves every layer', async () => {
    const png = await sharp({ create: { width: 240, height: 240, channels: 4, background: '#ffffff' } }).png().toBuffer();
    const result = await packCubismAtlas([{ id: 'b', png }, { id: 'a', png }], 256);
    expect(result.pngs).toHaveLength(2);
    expect(result.placements.get('a')?.page).toBe(0);
    expect(result.placements.get('b')?.page).toBe(1);
    await expect(packCubismAtlas([], 358)).rejects.toThrow('二次幂');
  });
});
