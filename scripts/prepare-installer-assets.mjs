import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("build", "windows", "icon.png");
await mkdir(resolve("build", "windows"), { recursive: true });
await sharp(resolve("assets", "readme", "logo.svg"), { density: 384 }).resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(output);
process.stdout.write(`${JSON.stringify({ ok: true, output })}\n`);
