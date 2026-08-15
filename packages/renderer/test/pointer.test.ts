import { describe, expect, it } from "vitest";
import { pointerTargetFromScreen } from "../src/pointer.js";

describe("system pointer mapping", () => {
  const windowBounds = { x: 600, y: 180, width: 720, height: 720 };
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  it("uses the character head region as the neutral target", () => {
    const target = pointerTargetFromScreen({ x: 960, y: 309.6 }, windowBounds, workArea, { x: 0.5, y: 0.18 });
    expect(target).toEqual({ x: 0, y: 0, strength: 1 });
  });

  it("maps all screen directions without exceeding the safe motion range", () => {
    const leftUp = pointerTargetFromScreen({ x: 0, y: 0 }, windowBounds, workArea);
    const rightDown = pointerTargetFromScreen({ x: 1919, y: 1039 }, windowBounds, workArea);
    expect(leftUp.x).toBeLessThan(-0.9);
    expect(leftUp.y).toBeLessThan(-0.7);
    expect(rightDown.x).toBeGreaterThan(0.9);
    expect(rightDown.y).toBeGreaterThan(0.7);
    for (const value of [leftUp.x, leftUp.y, rightDown.x, rightDown.y]) expect(Math.abs(value)).toBeLessThanOrEqual(1);
  });
});
