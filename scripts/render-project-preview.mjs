import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { CalmMotionController } from "@puppetloom/renderer";
import sharp from "sharp";

const projectDirectory = resolve(process.argv[2] ?? "");
const durationSeconds = Math.max(2, Math.min(120, Number(process.argv[3] ?? 20)));
const outputPath = resolve(process.argv[4] ?? resolve(projectDirectory, "reports/motion-preview.webm"));
const sheetPath = resolve(dirname(outputPath), `${basename(outputPath, ".webm")}-sheet.png`);
const headOutputPath = resolve(dirname(outputPath), `${basename(outputPath, ".webm")}-head.webm`);
const headSheetPath = resolve(dirname(outputPath), `${basename(outputPath, ".webm")}-head-sheet.png`);
const reportPath = resolve(dirname(outputPath), `${basename(outputPath, ".webm")}-report.json`);
const fps = 12;
const frameCount = Math.round(durationSeconds * fps);
const previewSize = 640;
const bundledFfmpeg = "D:\\Code\\MediaFlow\\bin\\ffmpeg.exe";
const ffmpeg = process.env.PUPPETLOOM_FFMPEG || (existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg");

if (!process.argv[2]) throw new Error("用法：npm run preview -- <project-dir> [seconds] [output.webm]");
if (!existsSync(resolve(projectDirectory, "puppetloom.json"))) throw new Error(`不是有效的 PuppetLoom 项目：${projectDirectory}`);
await mkdir(dirname(outputPath), { recursive: true });
const project = JSON.parse(await readFile(resolve(projectDirectory, "puppetloom.json"), "utf8"));
const headTop = project.anchors?.headTop?.y ?? 0.04;
const chin = project.anchors?.chin?.y ?? 0.28;
const headCenterX = project.anchors?.nose?.x ?? 0.5;
const headSizeNormalized = Math.max(0.18, Math.min(0.36, (chin - headTop) * 1.3));
const headCrop = {
  width: Math.round(headSizeNormalized * previewSize),
  height: Math.round(headSizeNormalized * previewSize),
  left: Math.max(0, Math.min(previewSize - Math.round(headSizeNormalized * previewSize), Math.round((headCenterX - headSizeNormalized / 2) * previewSize))),
  top: Math.max(0, Math.min(previewSize - Math.round(headSizeNormalized * previewSize), Math.round((headTop - headSizeNormalized * 0.08) * previewSize)))
};

function waitForExit(child, label) {
  return new Promise((resolveExit, reject) => {
    let errorText = "";
    child.stderr?.on("data", (chunk) => { errorText += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveExit() : reject(new Error(`${label} 失败（${code}）：${errorText.trim()}`)));
  });
}

function writeChunk(stream, chunk) {
  return new Promise((resolveWrite, reject) => {
    const onError = (error) => { stream.off("drain", onDrain); reject(error); };
    const onDrain = () => { stream.off("error", onError); resolveWrite(); };
    stream.once("error", onError);
    if (stream.write(chunk)) {
      stream.off("error", onError);
      resolveWrite();
    } else stream.once("drain", onDrain);
  });
}

function changedRatio(left, right) {
  let changed = 0;
  for (let index = 0; index < left.length; index += 4) {
    const difference = Math.abs((left[index] ?? 0) - (right[index] ?? 0))
      + Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0))
      + Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0))
      + Math.abs((left[index + 3] ?? 0) - (right[index + 3] ?? 0));
    if (difference > 20) changed += 1;
  }
  return changed / (left.length / 4);
}

const electronApp = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js"), "--project", projectDirectory],
  cwd: resolve("."),
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1" }
});

const encoder = spawn(ffmpeg, [
  "-y", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(fps), "-vcodec", "png", "-i", "pipe:0",
  "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "28",
  "-row-mt", "1", "-metadata:s:v:0", "alpha_mode=1", outputPath
], { stdio: ["pipe", "ignore", "pipe"] });
const encoderExit = waitForExit(encoder, "预览编码");
const motionProbe = new CalmMotionController(project);
let mouthPeak = { time: 0, value: 0 };
for (let index = 0; index < frameCount; index += 1) {
  const time = index / fps;
  const value = motionProbe.sample(time).mouthOpen;
  if (value > mouthPeak.value) mouthPeak = { time, value };
}
const eventPeaks = new CalmMotionController(project).events
  .map((event) => event.start + event.transition + event.hold * 0.5)
  .filter((time) => time < durationSeconds - 0.5)
  .slice(0, 3);
const sampleTimes = [0, ...(mouthPeak.value > 0 ? [mouthPeak.time] : []), ...eventPeaks];
const sampleIndices = new Set(sampleTimes.map((time) => Math.min(frameCount - 1, Math.round(time * fps))));
const samples = [];

try {
  const viewer = await electronApp.firstWindow();
  await viewer.getByTestId("viewer").waitFor();
  await viewer.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    const pixel = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return pixel[3] > 0;
  });

  const startedAt = Date.now();
  for (let index = 0; index < frameCount; index += 1) {
    const dueAt = startedAt + index * 1000 / fps;
    const delay = dueAt - Date.now();
    if (delay > 1) await viewer.waitForTimeout(delay);
    const dataUrl = await viewer.locator("canvas").evaluate((canvas, size) => {
      const output = document.createElement("canvas");
      output.width = size;
      output.height = size;
      output.getContext("2d")?.drawImage(canvas, 0, 0, size, size);
      return output.toDataURL("image/png");
    }, previewSize);
    const frame = Buffer.from(dataUrl.split(",")[1], "base64");
    if (sampleIndices.has(index)) samples.push(frame);
    await writeChunk(encoder.stdin, frame);
  }
  encoder.stdin.end();
  await encoderExit;
} catch (error) {
  encoder.stdin.destroy();
  encoder.kill();
  throw error;
} finally {
  await electronApp.close();
}

const normalizedSamples = await Promise.all(samples.map((sample) => sharp(sample).ensureAlpha().raw().toBuffer()));
const changeRatios = normalizedSamples.slice(1).map((sample) => changedRatio(normalizedSamples[0], sample));
const tiles = await Promise.all(samples.map((sample) => sharp(sample)
  .resize(320, 320, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer()));
await sharp({ create: { width: 320 * tiles.length, height: 320, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(tiles.map((input, index) => ({ input, left: index * 320, top: 0 })))
  .png().toFile(sheetPath);
const headTiles = await Promise.all(samples.map((sample) => sharp(sample)
  .extract(headCrop)
  .resize(320, 320, { fit: "fill", kernel: sharp.kernel.lanczos3 })
  .png().toBuffer()));
await sharp({ create: { width: 320 * headTiles.length, height: 320, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(headTiles.map((input, index) => ({ input, left: index * 320, top: 0 })))
  .png().toFile(headSheetPath);

const headEncoder = spawn(ffmpeg, [
  "-y", "-loglevel", "error", "-i", outputPath,
  "-vf", `crop=${headCrop.width}:${headCrop.height}:${headCrop.left}:${headCrop.top},scale=640:640:flags=lanczos`,
  "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "26",
  "-row-mt", "1", "-metadata:s:v:0", "alpha_mode=1", headOutputPath
], { stdio: ["ignore", "ignore", "pipe"] });
await waitForExit(headEncoder, "头部预览编码");

const report = {
  ok: true,
  projectDirectory,
  outputPath,
  sheetPath,
  headOutputPath,
  headSheetPath,
  headCrop,
  durationSeconds,
  fps,
  frameCount,
  previewSize,
  sampleTimes: sampleTimes.map((time) => Number(time.toFixed(2))),
  mouthPeak: {
    time: Number(mouthPeak.time.toFixed(2)),
    value: Number(mouthPeak.value.toFixed(4))
  },
  changedRatios: changeRatios.map((value) => Number(value.toFixed(6))),
  maximumChangedRatio: Number(Math.max(...changeRatios).toFixed(6))
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
