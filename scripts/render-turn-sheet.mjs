import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const projectDirectory = resolve(process.argv[2] ?? "");
const outputPath = resolve(process.argv[3] ?? resolve(projectDirectory, "reports/turn-sheet.png"));
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
const cropWidth = Math.round(headSize * previewSize * 1.55);
const cropHeight = Math.round(headSize * previewSize * 1.9);
const crop = {
  width: cropWidth,
  height: cropHeight,
  left: Math.max(0, Math.min(previewSize - cropWidth, Math.round(headCenterX * previewSize - cropWidth / 2))),
  top: Math.max(0, Math.min(previewSize - cropHeight, Math.round((headTop - headSize * 0.08) * previewSize)))
};
const poses = [
  { label: "left 0.85", state: { headYaw: -0.85, gazeX: -0.25, bodySway: -0.425, bodyRoll: -0.102 } },
  { label: "left 0.55", state: { headYaw: -0.55, gazeX: -0.14, bodySway: -0.275, bodyRoll: -0.066 } },
  { label: "neutral", state: { headYaw: 0, gazeX: 0, bodySway: 0, bodyRoll: 0 } },
  { label: "right 0.55", state: { headYaw: 0.55, gazeX: 0.14, bodySway: 0.275, bodyRoll: 0.066 } },
  { label: "right 0.85", state: { headYaw: 0.85, gazeX: 0.25, bodySway: 0.425, bodyRoll: 0.102 } }
];

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
    const head = await sharp(frame).extract(crop).resize(320, 390, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toBuffer();
    const label = Buffer.from(`<svg width="320" height="38"><rect width="320" height="38" fill="#111722"/><text x="12" y="25" fill="#e8eef8" font-family="Arial" font-size="16">${pose.label}</text></svg>`);
    tiles.push(await sharp({ create: { width: 320, height: 428, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: head, left: 0, top: 0 }, { input: label, left: 0, top: 390 }]).png().toBuffer());
  }
} finally {
  await app.close();
}

await sharp({ create: { width: 320 * tiles.length, height: 428, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(tiles.map((input, index) => ({ input, left: index * 320, top: 0 })))
  .png()
  .toFile(outputPath);
process.stdout.write(`${JSON.stringify({ ok: true, project: basename(projectDirectory), outputPath, poses: poses.map(({ label }) => label) }, null, 2)}\n`);
