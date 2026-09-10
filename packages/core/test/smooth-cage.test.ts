import { describe, expect, it } from 'vitest';
import { smoothCageWeights } from '../src/smooth-cage.js';

describe('continuous landmark displacement', () => {
  const nodes = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: .4, y: .6 }];
  it('preserves landmark positions and affine motion outside the control hull', () => {
    const weights = smoothCageWeights(nodes);
    for (const [index, node] of nodes.entries()) weights(node).forEach((w, j) => expect(w).toBeCloseTo(j === index ? 1 : 0, 9));
    for (const p of [{ x: .25, y: .3 }, { x: -.2, y: 1.2 }, { x: 1.1, y: .6 }]) {
      const value = weights(p).reduce((sum, w, j) => sum + w * (2 * nodes[j]!.x - .6 * nodes[j]!.y + .3), 0);
      expect(value).toBeCloseTo(2 * p.x - .6 * p.y + .3, 9);
    }
  });
  it('does not switch displacement or tangent at the hull boundary', () => {
    const weights = smoothCageWeights(nodes), values = [0, .2, -.1, .3, -.15];
    const value = (x: number) => weights({ x, y: .45 }).reduce((sum, w, j) => sum + w * values[j]!, 0);
    for (const x of [0, 1]) {
      const h = 1e-5, left = (value(x) - value(x - h)) / h, right = (value(x + h) - value(x)) / h;
      expect(Math.abs(left - right)).toBeLessThan(.0001);
    }
  });
  it('keeps degenerate landmark layouts finite and continuous', () => {
    const weights = smoothCageWeights([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }]);
    for (const x of [-.1, 0, .5, 1, 1.1]) {
      const a = weights({ x, y: 0 }), b = weights({ x: x + 1e-8, y: 0 });
      expect(a.every(Number.isFinite)).toBe(true);
      expect(a.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 10);
      expect(Math.max(...a.map((w, j) => Math.abs(w - b[j]!)))).toBeLessThan(1e-6);
    }
  });
});
