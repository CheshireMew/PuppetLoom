import { describe, expect, it } from "vitest";
import { closedEyePoint, eyeClosureBinding, eyeInkProfile } from "../src/eye-closure-authoring.js";
import type { PixelBuffer } from "../src/psd.js";
import type { LayerBinding } from "../src/types.js";
import { opacityFor } from "../src/render-contract.js";
import { blinkPoint } from "../src/blink-geometry.js";
import { neutralMotionState } from "../src/deform.js";
import { makeGridMesh } from "../src/mesh.js";

function fixture(padding: number, role: "eyelash" | "eyeWhite" = "eyelash") {
  const width = 8 + padding * 2, height = 8 + padding * 2;
  const pixels: PixelBuffer = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let x = 0; x < 8; x++) for (let y = 2; y < (role === "eyelash" ? 4 : 8); y++) {
    pixels.data[((y + padding) * width + x + padding) * 4 + 3] = 255;
  }
  const layer = {
    id: role, role, side: "left", bounds: { x: -padding, y: -padding, width, height },
    mesh: makeGridMesh({ x: -padding, y: -padding, width, height }, 3, 3)
  } as LayerBinding;
  return { layer, pixels };
}

describe("pixel-derived eye closure", () => {
  it("keeps authored eyelash geometry opaque and skips the procedural blink in geometry mode", () => {
    const { layer } = fixture(0);
    layer.opacity = 1;
    layer.blinkMode = "geometry";
    const point = { x: 4, y: 3 };
    expect(opacityFor(layer, { ...neutralMotionState, blink: 1 })).toBe(1);
    // The bypass must not inspect another layer or apply a second deformation.
    expect(blinkPoint({} as never, layer, point, 1)).toEqual(point);
    expect(opacityFor({ ...layer, role: "eyeClosed" }, { ...neutralMotionState, blink: 1 })).toBe(0);
    expect(opacityFor({ ...layer, blinkMode: "texture" }, { ...neutralMotionState, blink: 1 })).toBe(0);
  });
  it("gives the same closed geometry with or without transparent texture padding", () => {
    const compact = fixture(0), padded = fixture(12), white = fixture(0, "eyeWhite");
    padded.layer.mesh.points = structuredClone(compact.layer.mesh.points);
    padded.layer.mesh.uvs = padded.layer.mesh.points.map(p => ({ x: (p.x + 12) / 32, y: (p.y + 12) / 32 }));
    const a = eyeClosureBinding(compact.layer, compact.pixels, white.layer, white.pixels, "param-blink-left");
    const b = eyeClosureBinding(padded.layer, padded.pixels, white.layer, white.pixels, "param-blink-left");
    expect(b.keyforms).toEqual(a.keyforms);
    expect(a.keyforms[0]!.meshPointDeltas).toEqual({});
  });

  it("transports closure through an edited eye surface without resetting neutral points", () => {
    const lash = fixture(0), white = fixture(0, "eyeWhite");
    lash.layer.mesh.points = [{ x: 0.5, y: 2 }, { x: 4, y: 3 }, { x: 7.5, y: 4 }];
    lash.layer.mesh.uvs = lash.layer.mesh.points.map(p => ({ x: p.x / 8, y: p.y / 8 }));
    const baseline = eyeClosureBinding(lash.layer, lash.pixels, white.layer, white.pixels, "param-blink-left");
    white.layer.mesh.points = white.layer.mesh.points.map(p => ({ x: p.x + p.y * 0.3 + 10, y: p.y * 0.8 - 2 }));
    const moved = eyeClosureBinding(lash.layer, lash.pixels, white.layer, white.pixels, "param-blink-left");
    expect(moved.keyforms[0]!.meshPointDeltas).toEqual({});
    for (const [id, delta] of Object.entries(baseline.keyforms[1]!.meshPointDeltas!)) {
      expect(moved.keyforms[1]!.meshPointDeltas![id]!.x).toBeCloseTo(delta.y * 0.3);
      expect(moved.keyforms[1]!.meshPointDeltas![id]!.y).toBeCloseTo(delta.y * 0.8);
    }
  });

  it("keeps the lash thick enough to cover the compressed aperture on a common curve", () => {
    const lash = fixture(0), white = fixture(0, "eyeWhite");
    const ink = eyeInkProfile(lash.layer, lash.pixels)!;
    const aperture = eyeInkProfile(white.layer, white.pixels)!;
    const lashMiddle = closedEyePoint({ x: 4, y: 3 }, "eyelash", ink, aperture);
    const whiteMiddle = closedEyePoint({ x: 4, y: 5 }, "eyeWhite", aperture, aperture);
    expect(lashMiddle.y).toBeCloseTo(whiteMiddle.y);
    const top = closedEyePoint({ x: 4, y: 2 }, "eyelash", ink, aperture);
    const bottom = closedEyePoint({ x: 4, y: 4 }, "eyelash", ink, aperture);
    expect(bottom.y - top.y).toBeCloseTo(1.76);
    expect(lashMiddle.y).toBeGreaterThan(closedEyePoint({ x: 0, y: 3 }, "eyelash", ink, aperture).y);
  });

  it("does not create plausible-looking closure geometry from a blank texture or mismatched eye", () => {
    const lash = fixture(0), white = fixture(0, "eyeWhite");
    lash.pixels.data.fill(0);
    expect(() => eyeClosureBinding(lash.layer, lash.pixels, white.layer, white.pixels, "param-blink-left")).toThrow("painted");
    white.layer.side = "right";
    expect(() => eyeClosureBinding(lash.layer, lash.pixels, white.layer, white.pixels, "param-blink-left")).toThrow("matching");
  });
});
