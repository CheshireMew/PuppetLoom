import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function positiveNumber(name) {
  const value = Number(argument(name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} 必须是正数。`);
  return value;
}

const input = resolve(argument("input", ""));
const output = resolve(argument("output", ""));
const canvasWidth = Math.round(positiveNumber("canvas-width"));
const canvasHeight = Math.round(positiveNumber("canvas-height"));
const contentWidth = Math.round(positiveNumber("content-width"));
const contentHeight = Math.round(positiveNumber("content-height"));
const centerX = Number(argument("center-x", canvasWidth / 2));
const centerY = Number(argument("center-y", canvasHeight / 2));
const flip = process.argv.includes("--flip");

if (!argument("input") || !argument("output")) {
  throw new Error("用法：node scripts/extract-generated-supplement.mjs --input <image> --output <png> --canvas-width <n> --canvas-height <n> --content-width <n> --content-height <n> [--center-x <n>] [--center-y <n>] [--flip]");
}

const source = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const rgba = Buffer.alloc(source.info.width * source.info.height * 4);
let minX = source.info.width;
let minY = source.info.height;
let maxX = -1;
let maxY = -1;

for (let y = 0; y < source.info.height; y += 1) {
  for (let x = 0; x < source.info.width; x += 1) {
    const sourceIndex = (y * source.info.width + x) * source.info.channels;
    const targetIndex = (y * source.info.width + x) * 4;
    const red = source.data[sourceIndex] ?? 255;
    const green = source.data[sourceIndex + 1] ?? 255;
    const blue = source.data[sourceIndex + 2] ?? 255;
    const darkest = Math.min(red, green, blue);
    const alphaUnit = Math.max(0, Math.min(1, (245 - darkest) / 175));
    const alpha = Math.round(alphaUnit * 255);
    const removeWhiteMatte = (channel) => alphaUnit <= 0
      ? 0
      : Math.max(0, Math.min(255, Math.round((channel - 255 * (1 - alphaUnit)) / alphaUnit)));
    rgba[targetIndex] = removeWhiteMatte(red);
    rgba[targetIndex + 1] = removeWhiteMatte(green);
    rgba[targetIndex + 2] = removeWhiteMatte(blue);
    rgba[targetIndex + 3] = alpha;
    if (alpha > 12) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
}

if (maxX < minX || maxY < minY) throw new Error("没有从浅色背景中识别到可用图形。" );
const cropWidth = maxX - minX + 1;
const cropHeight = maxY - minY + 1;
let extracted = sharp(rgba, { raw: { width: source.info.width, height: source.info.height, channels: 4 } })
  .extract({ left: minX, top: minY, width: cropWidth, height: cropHeight })
  .resize({ width: contentWidth, height: contentHeight, fit: "inside", kernel: sharp.kernel.lanczos3 });
if (flip) extracted = extracted.flop();
const normalized = await extracted.png().toBuffer({ resolveWithObject: true });
const left = Math.round(centerX - normalized.info.width / 2);
const top = Math.round(centerY - normalized.info.height / 2);
if (left < 0 || top < 0 || left + normalized.info.width > canvasWidth || top + normalized.info.height > canvasHeight) {
  throw new Error("规范化后的图形超出目标画布。" );
}

await mkdir(dirname(output), { recursive: true });
await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: normalized.data, left, top }])
  .png()
  .toFile(output);

process.stdout.write(`${JSON.stringify({ input, output, sourceBounds: { x: minX, y: minY, width: cropWidth, height: cropHeight }, placed: { x: left, y: top, width: normalized.info.width, height: normalized.info.height } }, null, 2)}\n`);
