import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const projectDirectory = resolve(process.argv[2] ?? "");
const outputPath = resolve(process.argv[3] ?? resolve(projectDirectory, "reports/ear-hinge-sheet.png"));
if (!process.argv[2] || !existsSync(resolve(projectDirectory, "puppetloom.json"))) {
  throw new Error("用法：npm run test:ear-hinges -- <project-dir> [output.png]");
}

await mkdir(dirname(outputPath), { recursive: true });
const project = JSON.parse(await readFile(resolve(projectDirectory, "puppetloom.json"), "utf8"));
const headwear = project.layers.find((layer) => layer.role === "headwear" && layer.secondaryAnchors?.earHingeLeft && layer.secondaryAnchors?.earHingeRight);
if (!headwear) throw new Error("项目没有可验证的双耳钉点。");
const hinges = [headwear.secondaryAnchors.earHingeLeft, headwear.secondaryAnchors.earHingeRight];
const previewSize = 640;
const headTop = project.anchors?.headTop?.y ?? 0.04;
const chin = project.anchors?.chin?.y ?? 0.28;
const centerX = project.anchors?.nose?.x ?? 0.5;
const headSize = Math.max(0.2, Math.min(0.38, (chin - headTop) * 1.42));
const cropWidth = Math.round(headSize * previewSize * 1.18);
const cropHeight = Math.round(headSize * previewSize * 1.12);
const crop = {
  width: cropWidth,
  height: cropHeight,
  left: Math.max(0, Math.min(previewSize - cropWidth, Math.round(centerX * previewSize - cropWidth / 2))),
  top: Math.max(0, Math.min(previewSize - cropHeight, Math.round((headTop - headSize * 0.08) * previewSize)))
};
const poses = [
  { label: "ears up", state: { earY: -0.018, earX: 0 } },
  { label: "pinned neutral", state: { earY: 0, earX: 0 } },
  { label: "ears down", state: { earY: 0.018, earX: 0 } }
];
const marker = Buffer.from(`<svg width="${previewSize}" height="${previewSize}">${hinges.map((point) => `<circle cx="${point.x * previewSize}" cy="${point.y * previewSize}" r="4.5" fill="#ff3b45" stroke="#ffffff" stroke-width="1.5"/>`).join("")}</svg>`);

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
    if (!rendered) throw new Error(`无法渲染耳朵姿态：${pose.label}`);
    const dataUrl = await viewer.locator("canvas").evaluate((canvas, size) => {
      const output = document.createElement("canvas");
      output.width = size;
      output.height = size;
      output.getContext("2d")?.drawImage(canvas, 0, 0, size, size);
      return output.toDataURL("image/png");
    }, previewSize);
    const frame = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
    const marked = await sharp(frame).composite([{ input: marker }]).png().toBuffer();
    const head = await sharp(marked).extract(crop).resize(420, 390, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toBuffer();
    const label = Buffer.from(`<svg width="420" height="40"><rect width="420" height="40" fill="#111722"/><text x="14" y="27" fill="#e8eef8" font-family="Arial" font-size="17">${pose.label}</text></svg>`);
    tiles.push(await sharp({ create: { width: 420, height: 430, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: head, left: 0, top: 0 }, { input: label, left: 0, top: 390 }]).png().toBuffer());
  }
} finally {
  await app.close();
}

await sharp({ create: { width: 420 * tiles.length, height: 430, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(tiles.map((input, index) => ({ input, left: index * 420, top: 0 })))
  .png()
  .toFile(outputPath);
process.stdout.write(`${JSON.stringify({ ok: true, project: basename(projectDirectory), outputPath, hinges, poses: poses.map(({ label }) => label) }, null, 2)}\n`);
