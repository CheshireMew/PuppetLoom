import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { inspectLayerAlphaTopology } from "../src/topology.js";
import type { LayerBinding } from "../src/types.js";

describe("layer alpha topology", () => {
  it("reports separate meaningful opaque regions in normalized canvas coordinates", async () => {
    const path = artifactPath(`topology-${process.pid}-${Date.now()}.png`);
    await sharp({ create: { width: 100, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: Buffer.from('<svg width="20" height="20"><rect width="20" height="20" fill="white"/></svg>'), left: 5, top: 8 },
        { input: Buffer.from('<svg width="30" height="25"><rect width="30" height="25" fill="white"/></svg>'), left: 60, top: 45 }
      ])
      .png().toFile(path);
    const layer = {
      id: "merged",
      sourceName: "merged parts",
      sourcePath: ["merged parts"],
      role: "accessory",
      side: "center",
      order: 0,
      opacity: 1,
      blendMode: "normal",
      bounds: { x: 0.2, y: 0.1, width: 0.5, height: 0.4 },
      texture: "unused.png",
      pivot: { x: 0.45, y: 0.3 },
      mesh: { rows: 2, cols: 2, points: [], uvs: [], triangles: [] },
      weights: { head: 0, body: 0, gaze: 0, physics: 0 },
      parentGroup: "root"
    } satisfies LayerBinding;
    const topology = await inspectLayerAlphaTopology(path, layer);
    expect(topology.componentCount).toBe(2);
    expect(topology.components.map((component) => component.pixelCount)).toEqual([750, 400]);
    expect(topology.components[0]?.bounds).toMatchObject({ x: 0.5, y: 0.325, width: 0.15, height: 0.125 });
  });
});
