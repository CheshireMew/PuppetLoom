import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const projectDirectory = resolve(process.argv[2] ?? "");
const outputPath = resolve(process.argv[3] ?? resolve(projectDirectory, "reports/secondary-direction-sheet.png"));
if (!process.argv[2] || !existsSync(resolve(projectDirectory, "puppetloom.json"))) {
  throw new Error("用法：npm run test:secondary-directions -- <project-dir> [output.png]");
}

await mkdir(dirname(outputPath), { recursive: true });
const project = JSON.parse(await readFile(resolve(projectDirectory, "puppetloom.json"), "utf8"));
const previewSize = 640;
const poses = [
  { label: "skirt left", state: { clothX: -0.03 } },
  { label: "neutral", state: {} },
  { label: "skirt right", state: { clothX: 0.03 } },
  { label: "tail up", state: { tailY: -0.075 } },
  { label: "tail down", state: { tailY: 0.075 } }
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
  await viewer.waitForTimeout(120);
  for (const pose of poses) {
    const rendered = await viewer.evaluate((state) => window.puppetloomRenderTestPose?.(state) ?? false, pose.state);
    if (!rendered) throw new Error(`无法渲染次级运动姿态：${pose.label}`);
    const dataUrl = await viewer.locator("canvas").evaluate((canvas, size) => {
      const output = document.createElement("canvas");
      output.width = size;
      output.height = size;
      output.getContext("2d")?.drawImage(canvas, 0, 0, size, size);
      return output.toDataURL("image/png");
    }, previewSize);
    const frame = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
    const body = await sharp(frame).resize(360, 360, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toBuffer();
    const label = Buffer.from(`<svg width="360" height="40"><rect width="360" height="40" fill="#111722"/><text x="14" y="27" fill="#e8eef8" font-family="Arial" font-size="17">${pose.label}</text></svg>`);
    tiles.push(await sharp({ create: { width: 360, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: body, left: 0, top: 0 }, { input: label, left: 0, top: 360 }]).png().toBuffer());
  }
} finally {
  await app.close();
}

await sharp({ create: { width: 360 * tiles.length, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(tiles.map((input, index) => ({ input, left: index * 360, top: 0 })))
  .png()
  .toFile(outputPath);
process.stdout.write(`${JSON.stringify({ ok: true, project: basename(projectDirectory), outputPath, poses: poses.map(({ label }) => label) }, null, 2)}\n`);
