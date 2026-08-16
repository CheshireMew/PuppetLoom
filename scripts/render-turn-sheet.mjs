import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const projectDirectory = resolve(process.argv[2] ?? "");
const outputPath = resolve(process.argv[3] ?? resolve(projectDirectory, "reports/turn-sheet.png"));
const closeup = process.argv.includes("--closeup");
const extreme = process.argv.includes("--extreme");
if (!process.argv[2] || !existsSync(resolve(projectDirectory, "puppetloom.json"))) {
  throw new Error("用法：npm run test:turns -- <project-dir> [output.png]");
}

await mkdir(dirname(outputPath), { recursive: true });
const project = JSON.parse(await readFile(resolve(projectDirectory, "puppetloom.json"), "utf8"));
const previewSize = 640;
const headTop = project.anchors?.headTop?.y ?? 0.04;
const chin = project.anchors?.chin?.y ?? 0.28;
const headCenterX = project.anchors?.nose?.x ?? 0.5;
const headSize = Math.max(0.18, Math.min(0.36, (chin - headTop) * 1.3));
const cropWidth = Math.round(headSize * previewSize * (closeup ? 1.35 : 1.55));
const cropHeight = Math.round(headSize * previewSize * (closeup ? 1.24 : 1.9));
const crop = {
  width: cropWidth,
  height: cropHeight,
  left: Math.max(0, Math.min(previewSize - cropWidth, Math.round(headCenterX * previewSize - cropWidth / 2))),
  top: Math.max(0, Math.min(previewSize - cropHeight, Math.round((headTop - headSize * 0.08) * previewSize)))
};
const poseState = (yaw, pitch) => ({
  headYaw: yaw,
  headPitch: pitch,
  gazeX: yaw * 0.29,
  gazeY: pitch * 0.24,
  bodySway: yaw * 0.62,
  bodyPitch: pitch * 0.46,
  bodyRoll: yaw * 0.16
});
const yawLimit = extreme ? 1 : 0.85;
const pitchLimit = extreme ? 1 : 0.75;
const poses = [
  { label: "left + up", state: poseState(-yawLimit, -pitchLimit) },
  { label: "up", state: poseState(0, -pitchLimit) },
  { label: "right + up", state: poseState(yawLimit, -pitchLimit) },
  { label: "left", state: poseState(-yawLimit, 0) },
  { label: "neutral", state: poseState(0, 0) },
  { label: "right", state: poseState(yawLimit, 0) },
  { label: "left + down", state: poseState(-yawLimit, pitchLimit) },
  { label: "down", state: poseState(0, pitchLimit) },
  { label: "right + down", state: poseState(yawLimit, pitchLimit) }
];
const tileWidth = closeup ? 512 : 320;
const tileImageHeight = closeup ? 466 : 390;
const labelHeight = 38;

const app = await electron.launch({
  args: [resolve("apps/desktop/dist/electron/main.js"), "--project", projectDirectory],
  cwd: resolve("."),
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", PUPPETLOOM_ALLOW_MULTIPLE: "1" }
});

const tiles = [];
try {
  const viewer = await app.firstWindow();
  await viewer.getByTestId("viewer").waitFor();
  await viewer.waitForFunction(() => typeof window.puppetloomRenderTestPose === "function");
  for (const pose of poses) {
    const rendered = await viewer.evaluate((state) => window.puppetloomRenderTestPose?.(state) ?? false, pose.state);
    if (!rendered) throw new Error(`无法渲染测试姿态：${pose.label}`);
    await viewer.waitForTimeout(60);
    const dataUrl = await viewer.locator("canvas").evaluate((canvas, size) => {
      const output = document.createElement("canvas");
      output.width = size;
      output.height = size;
      output.getContext("2d")?.drawImage(canvas, 0, 0, size, size);
      return output.toDataURL("image/png");
    }, previewSize);
    const frame = Buffer.from(dataUrl.split(",")[1], "base64");
    const head = await sharp(frame).extract(crop).resize(tileWidth, tileImageHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toBuffer();
    const label = Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}"><rect width="${tileWidth}" height="${labelHeight}" fill="#111722"/><text x="12" y="25" fill="#e8eef8" font-family="Arial" font-size="16">${pose.label}</text></svg>`);
    tiles.push(await sharp({ create: { width: tileWidth, height: tileImageHeight + labelHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: head, left: 0, top: 0 }, { input: label, left: 0, top: tileImageHeight }]).png().toBuffer());
  }
} finally {
  await app.close();
}

await sharp({ create: { width: tileWidth * 3, height: (tileImageHeight + labelHeight) * 3, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(tiles.map((input, index) => ({ input, left: (index % 3) * tileWidth, top: Math.floor(index / 3) * (tileImageHeight + labelHeight) })))
  .png()
  .toFile(outputPath);
process.stdout.write(`${JSON.stringify({ ok: true, project: basename(projectDirectory), outputPath, poses: poses.map(({ label }) => label) }, null, 2)}\n`);
