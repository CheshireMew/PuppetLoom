import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { _electron as electron } from "playwright";
import { loadCalibration, loadProjectRevision } from "@puppetloom/core";
import { CalmMotionController } from "@puppetloom/renderer";
import sharp from "sharp";

const motionKeys = [
  "headYaw", "headPitch", "headRoll", "bodySway", "bodyPitch", "bodyRoll", "gazeX", "gazeY", "breath", "blink", "mouthOpen",
  "hairX", "hairY", "ahogeX", "ahogeY", "backHairX", "backHairY", "headwearX", "headwearY", "earX", "earY",
  "clothX", "clothY", "tailX", "tailY", "accessoryX", "accessoryY"
];

function waitForExit(child, label) {
  return new Promise((resolveExit, reject) => {
    let errorText = "";
    child.stderr?.on("data", (chunk) => { errorText += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolveExit()
      : reject(new Error(`${label} 失败（${code}）：${errorText.trim()}`)));
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

function resolveFfmpeg(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.PUPPETLOOM_FFMPEG) return resolve(process.env.PUPPETLOOM_FFMPEG);
  const local = "D:\\Code\\MediaFlow\\bin\\ffmpeg.exe";
  return existsSync(local) ? local : "ffmpeg";
}

function previewFit(project, size) {
  const aspect = project.canvas.width / project.canvas.height;
  if (aspect >= 1) {
    const height = Math.max(1, Math.round(size / aspect));
    return { left: 0, top: Math.round((size - height) / 2), width: size, height };
  }
  const width = Math.max(1, Math.round(size * aspect));
  return { left: Math.round((size - width) / 2), top: 0, width, height: size };
}

function cropFor(project, mode, fit) {
  const headTop = project.anchors?.headTop?.y ?? 0.04;
  const chin = project.anchors?.chin?.y ?? 0.28;
  const bodyCenter = project.anchors?.bodyCenter?.y ?? 0.42;
  const centerX = project.anchors?.nose?.x ?? 0.5;
  const aspect = project.canvas.width / project.canvas.height;
  const toPixels = (rect) => ({
    left: Math.round(fit.left + rect.x * fit.width),
    top: Math.round(fit.top + rect.y * fit.height),
    width: Math.max(1, Math.round(rect.width * fit.width)),
    height: Math.max(1, Math.round(rect.height * fit.height))
  });
  if (mode === "autonomous") {
    const normalized = Math.max(0.18, Math.min(0.38, (chin - headTop) * 1.35));
    const normalizedWidth = Math.min(0.9, normalized / aspect);
    return toPixels({
      x: Math.max(0, Math.min(1 - normalizedWidth, centerX - normalizedWidth / 2)),
      y: Math.max(0, Math.min(1 - normalized, headTop - normalized * 0.08)),
      width: normalizedWidth,
      height: normalized
    });
  }
  const normalizedWidth = Math.min(0.9, 0.46 / aspect);
  const top = Math.max(0, headTop - 0.015);
  const bottom = Math.min(1, bodyCenter + 0.28);
  return toPixels({
    x: Math.max(0, Math.min(1 - normalizedWidth, centerX - normalizedWidth / 2)),
    y: top,
    width: normalizedWidth,
    height: Math.max(0.01, bottom - top)
  });
}

function frozenSecondaryState(state) {
  return {
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
}

async function requireAbsent(paths) {
  const existing = paths.filter((path) => existsSync(path));
  if (existing.length > 0) throw new Error(`证据文件已存在，不会覆盖：${existing.join("；")}`);
}

export async function runMotionEvidence(options) {
  const projectDirectory = resolve(options.project);
  const outputDirectory = resolve(options.outputDirectory);
  const mode = options.mode ?? "autonomous";
  const durationSeconds = Number(options.durationSeconds ?? 12);
  const fps = Number(options.fps ?? 12);
  if (!existsSync(join(projectDirectory, "puppetloom.json"))) throw new Error(`不是有效的 PuppetLoom 项目：${projectDirectory}`);
  if (!["autonomous", "secondary"].includes(mode)) throw new Error("mode 必须是 autonomous 或 secondary。" );
  if (!Number.isFinite(durationSeconds) || durationSeconds < 2 || durationSeconds > 120) throw new Error("duration 必须在 2 到 120 秒之间。" );
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("fps 必须是 1 到 60 的整数。" );

  const calibration = await loadCalibration(projectDirectory);
  const revision = options.revision ?? calibration.revision;
  if (!Number.isInteger(revision) || revision < 0) throw new Error("revision 必须是非负整数。" );
  const project = await loadProjectRevision(projectDirectory, revision);
  const baseName = options.baseName ?? mode;
  const outputPath = resolve(options.outputPath ?? join(outputDirectory, `${baseName}.webm`));
  const stem = basename(outputPath, ".webm");
  const sheetPath = join(dirname(outputPath), `${stem}-sheet.png`);
  const focusPath = join(dirname(outputPath), `${stem}-${mode === "autonomous" ? "head" : "upper"}.webm`);
  const reportPath = join(dirname(outputPath), `${stem}-report.json`);
  await requireAbsent([outputPath, sheetPath, focusPath, reportPath]);
  await mkdir(dirname(outputPath), { recursive: true });

  const ffmpeg = resolveFfmpeg(options.ffmpeg);
  const previewSize = 640;
  const frameCount = Math.round(durationSeconds * fps);
  const renderArea = previewFit(project, previewSize);
  const crop = cropFor(project, mode, renderArea);
  const controller = new CalmMotionController(project);
  const eventTimes = controller.events
    .map((event) => event.start + event.transition + event.hold * 0.5)
    .filter((time) => time > 0 && time < durationSeconds)
    .slice(0, 4);
  const sampleTimes = mode === "autonomous"
    ? [0, ...eventTimes, Math.max(0, durationSeconds - 1 / fps)]
    : Array.from({ length: 6 }, (_, index) => index * Math.max(0, durationSeconds - 1 / fps) / 5);
  const sampleIndices = new Set(sampleTimes.map((time) => Math.min(frameCount - 1, Math.round(time * fps))));
  const samples = [];
  const extrema = Object.fromEntries(motionKeys.map((key) => [key, 0]));

  const encoder = spawn(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(fps), "-vcodec", "png", "-i", "pipe:0",
    "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "27",
    "-row-mt", "1", "-metadata:s:v:0", "alpha_mode=1", outputPath
  ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  const encoderExit = waitForExit(encoder, "动态证据编码");
  const app = await electron.launch({
    args: [
      resolve("apps/desktop/dist/electron/main.js"),
      "--project", projectDirectory,
      "--revision", String(revision),
      "--capture"
    ],
    cwd: resolve("."),
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      PUPPETLOOM_ALLOW_MULTIPLE: "1",
      PUPPETLOOM_E2E_USER_DATA: join("D:\\Tools", "PuppetLoom", "evidence", `record-${process.pid}`)
    }
  });

  let viewport;
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
    viewport = await viewer.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }));
    for (let index = 0; index < frameCount; index += 1) {
      const state = controller.sample(index / fps, { primaryMotion: mode === "autonomous" });
      const pose = mode === "secondary" ? frozenSecondaryState(state) : state;
      for (const key of motionKeys) extrema[key] = Math.max(extrema[key], Math.abs(pose[key] ?? 0));
      const rendered = await viewer.evaluate((nextPose) => window.puppetloomRenderTestPose?.(nextPose) ?? false, pose);
      if (!rendered) throw new Error("渲染器没有接受动态证据姿态。" );
      const dataUrl = await viewer.locator("canvas").evaluate((canvas, capture) => {
        const output = document.createElement("canvas");
        output.width = capture.size;
        output.height = capture.size;
        output.getContext("2d")?.drawImage(canvas, capture.fit.left, capture.fit.top, capture.fit.width, capture.fit.height);
        return output.toDataURL("image/png");
      }, { size: previewSize, fit: renderArea });
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

  const croppedTiles = await Promise.all(samples.map((sample) => sharp(sample)
    .extract(crop)
    .resize(320, 360, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: sharp.kernel.lanczos3 })
    .png().toBuffer()));
  await sharp({ create: { width: 320 * croppedTiles.length, height: 360, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(croppedTiles.map((input, index) => ({ input, left: index * 320, top: 0 })))
    .png().toFile(sheetPath);

  const rawSamples = await Promise.all(samples.map((sample) => sharp(sample).ensureAlpha().raw().toBuffer()));
  const changeRatios = rawSamples.slice(1).map((sample) => changedRatio(rawSamples[0], sample));
  const focusEncoder = spawn(ffmpeg, [
    "-y", "-loglevel", "error", "-i", outputPath,
    "-vf", `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top},scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "26",
    "-row-mt", "1", "-metadata:s:v:0", "alpha_mode=1", focusPath
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  await waitForExit(focusEncoder, "局部动态证据编码");

  const baseText = await readFile(join(projectDirectory, "puppetloom.json"));
  const maximumChangedRatio = changeRatios.length > 0 ? Math.max(...changeRatios) : 0;
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    projectDirectory,
    projectName: project.name,
    baseProjectSha256: createHash("sha256").update(baseText).digest("hex"),
    revision,
    currentRevisionAtStart: calibration.revision,
    mode,
    headAndBodyFrozen: mode === "secondary",
    durationSeconds,
    fps,
    frameCount,
    previewSize,
    renderArea,
    viewport,
    projectAspectRatio: project.canvas.width / project.canvas.height,
    viewportAspectRatio: viewport.width / viewport.height,
    outputPath,
    focusPath,
    sheetPath,
    reportPath,
    crop,
    sampleTimes: sampleTimes.map((value) => Number(value.toFixed(3))),
    changeRatios: changeRatios.map((value) => Number(value.toFixed(6))),
    maximumChangedRatio: Number(maximumChangedRatio.toFixed(6)),
    motionDetected: maximumChangedRatio > 0.00001,
    extrema: Object.fromEntries(Object.entries(extrema).map(([key, value]) => [key, Number(value.toFixed(6))])),
    ffmpeg
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
