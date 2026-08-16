import { describe, expect, it } from "vitest";
import { SegmentedSpringChain } from "../src/secondary-motion.js";

describe("segmented secondary motion", () => {
  it("passes movement from the fixed root toward the tip with visible delay", () => {
    const chain = new SegmentedSpringChain({ segments: 5, stiffness: 16, damping: 6, propagation: 1.1, maxDisplacement: 0.12 });
    const samples: number[][] = [];
    for (let frame = 0; frame < 240; frame += 1) {
      chain.advance(0.06, -0.03, 1 / 60);
      if (frame === 5 || frame === 59 || frame === 239) samples.push(chain.sample().x);
    }
    expect(Math.abs(samples[0]![0]!)).toBeGreaterThan(Math.abs(samples[0]!.at(-1)!));
    expect(Math.abs(samples[1]![0]!)).toBeGreaterThan(Math.abs(samples[1]!.at(-1)!));
    expect(Math.abs(samples.at(-1)!.at(-1)!)).toBeGreaterThan(Math.abs(samples.at(-1)![0]!));
    expect(chain.sample().y.every(Number.isFinite)).toBe(true);
  });

  it("returns smoothly without exceeding its configured range", () => {
    const chain = new SegmentedSpringChain({ segments: 4, stiffness: 20, damping: 7, propagation: 1.08, maxDisplacement: 0.08 });
    for (let frame = 0; frame < 90; frame += 1) chain.advance(-0.2, 0.15, 1 / 60);
    expect(chain.sample().x.every((value) => Math.abs(value) <= 0.08)).toBe(true);
    for (let frame = 0; frame < 180; frame += 1) chain.advance(0, 0, 1 / 60);
    expect(Math.abs(chain.sample().x.at(-1)!)).toBeLessThan(0.01);
  });
});
