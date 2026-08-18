import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderAgentMotionSheet } from "../src/agent-evidence.js";

describe("Agent visual evidence", () => {
  it("packs ordered motion frames into a directly reviewable four-column sheet", async () => {
    const directory = join(process.env.PUPPETLOOM_ARTIFACT_RUN_ROOT!, "agent-motion-sheet");
    await mkdir(directory, { recursive: true });
    const frames: Array<{ index: number; path: string; timeSeconds: number }> = [];
    for (let index = 0; index < 5; index += 1) {
      const path = join(directory, `frame-${index}.png`);
      await sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 20 * index, g: 40, b: 80, alpha: 1 } } }).png().toFile(path);
      frames.push({ index, path, timeSeconds: index / 12 });
    }
    const manifestPath = join(directory, "focus-motion.json");
    await writeFile(manifestPath, `${JSON.stringify({ version: 1, frames })}\n`);

    const outputPath = await renderAgentMotionSheet(manifestPath);
    const metadata = await sharp(outputPath).metadata();
    expect(outputPath).toBe(join(directory, "focus-motion-sheet.png"));
    expect(metadata.width).toBe(80);
    expect(metadata.height).toBe(20);
  });
});
