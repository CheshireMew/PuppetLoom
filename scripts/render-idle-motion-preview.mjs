import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { _electron as electron } from "playwright";
import { CalmMotionController } from "@puppetloom/renderer";
import sharp from "sharp";

const projectDirectory = resolve(process.argv[2] ?? "");
const durationSeconds = Math.max(4, Math.min(30, Number(process.argv[3] ?? 12)));
const outputPath = resolve(process.argv[4] ?? resolve(projectDirectory, "reports/idle-secondary-preview.webm"));
if (!process.argv[2] || !existsSync(resolve(projectDirectory, "puppetloom.json"))) {
  throw new Error("用法：npm run test:idle-motion -- <project-dir> [seconds] [output.webm]");
}

const ffmpeg = process.env.PUPPETLOOM_FFMPEG || (existsSync("D:\\Code\\MediaFlow\\bin\\ffmpeg.exe") ? "D:\\Code\\MediaFlow\\bin\\ffmpeg.exe" : "ffmpeg");
const fps = 12;
const frameCount = Math.round(durationSeconds * fps);
const previewSize = 640;
const sheetPath = resolve(dirname(outputPath), `${basename(outputPath, ".webm")}-sheet.png`);
const upperPath = resolve(dirname(outputPath), `${basename(outputPath, ".webm")}-upper.webm`);
const reportPath = resolve(dirname(outputPath), `${basename(outputPath, ".webm")}-report.json`);
await mkdir(dirname(outputPath), { recursive: true });
const project = JSON.parse(await readFile(resolve(projectDirectory, "puppetloom.json"), "utf8"));
const controller = new CalmMotionController(project);
const headTop = project.anchors?.headTop?.y ?? 0.04;
const bodyCenter = project.anchors?.bodyCenter?.y ?? 0.42;
const centerX = project.anchors?.nose?.x ?? 0.5;
const cropWidth = Math.round(previewSize * 0.46);
const cropTop = Math.max(0, Math.round((headTop - 0.015) * previewSize));
const cropBottom = Math.min(previewSize, Math.round((bodyCenter + 0.28) * previewSize));
const upperCrop = {
  width: cropWidth,
  height: Math.max(1, cropBottom - cropTop),
  left: Math.max(0, Math.min(previewSize - cropWidth, Math.round(centerX * previewSize - cropWidth / 2))),
  top: cropTop
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

const encoder = spawn(ffmpeg, [
  "-y", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(fps), "-vcodec", "png", "-i", "pipe:0",
  "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "27",
  "-row-mt", "1", "-metadata:s:v:0", "alpha_mode=1", outputPath
], { stdio: ["pipe", "ignore", "pipe"] });
const encoderExit = waitForExit(encoder, "静止头部预览编码");
const app = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js"), "--project", projectDirectory],
  cwd: resolve("."),
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1" }
});
const sampleIndices = new Set(Array.from({ length: 6 }, (_, index) => Math.min(frameCount - 1, Math.round(index * (frameCount - 1) / 5))));
const samples = [];
const secondaryKeys = ["hairX", "hairY", "ahogeX", "ahogeY", "backHairX", "backHairY", "headwearX", "headwearY", "earX", "earY", "clothX", "clothY", "tailX", "tailY", "accessoryX", "accessoryY"];
const extrema = Object.fromEntries(secondaryKeys.map((key) => [key, 0]));

try {
  const viewer = await app.firstWindow();
  await viewer.getByTestId("viewer").waitFor();
  await viewer.waitForFunction(() => typeof window.puppetloomRenderTestPose === "function");
  await viewer.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return false;
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    const pixel = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return pixel[3] > 0;
  });
  for (let index = 0; index < frameCount; index += 1) {
    const state = controller.sample(index / fps, { primaryMotion: false });
    for (const key of secondaryKeys) extrema[key] = Math.max(extrema[key], Math.abs(state[key] ?? 0));
    const frozen = {
      ...state,
      headYaw: 0,
      headPitch: 0,
      headRoll: 0,
      bodySway: 0,
      bodyPitch: 0,
      bodyRoll: 0,
      gazeX: 0,
      gazeY: 0,
      breath: 0,
      blink: 0,
      mouthOpen: 0
    };
    const rendered = await viewer.evaluate((pose) => window.puppetloomRenderTestPose?.(pose) ?? false, frozen);
    if (!rendered) throw new Error("无法渲染静止头部次级运动姿态。");
    const dataUrl = await viewer.locator("canvas").evaluate((canvas, size) => {
      const output = document.createElement("canvas");
      output.width = size;
      output.height = size;
      output.getContext("2d")?.drawImage(canvas, 0, 0, size, size);
      return output.toDataURL("image/png");
    }, previewSize);
    const frame = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
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
  await app.close();
}

const tiles = await Promise.all(samples.map((sample) => sharp(sample).extract(upperCrop).resize(360, 420, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toBuffer()));
await sharp({ create: { width: 360 * tiles.length, height: 420, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(tiles.map((input, index) => ({ input, left: index * 360, top: 0 })))
  .png()
  .toFile(sheetPath);

const upperEncoder = spawn(ffmpeg, [
  "-y", "-loglevel", "error", "-i", outputPath,
  "-vf", `crop=${upperCrop.width}:${upperCrop.height}:${upperCrop.left}:${upperCrop.top},scale=640:746:flags=lanczos`,
  "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "26",
  "-row-mt", "1", "-metadata:s:v:0", "alpha_mode=1", upperPath
], { stdio: ["ignore", "ignore", "pipe"] });
await waitForExit(upperEncoder, "上半身静止头部预览编码");

const report = {
  ok: true,
  projectDirectory,
  durationSeconds,
  fps,
  headAndBodyFrozen: true,
  outputPath,
  upperPath,
  sheetPath,
  upperCrop,
  extrema: Object.fromEntries(Object.entries(extrema).map(([key, value]) => [key, Number(value.toFixed(6))]))
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
