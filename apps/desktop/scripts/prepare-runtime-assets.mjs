import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

const assetDirectory = process.env.PUPPETLOOM_RUNTIME_ASSET_DIRECTORY ?? join("D:\\Tools", "PuppetLoom", "runtime-assets", "mediapipe");
const modelPath = join(assetDirectory, "face_landmarker.task");
const modelUrl = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const expectedBytes = 3_758_596;
const expectedSha256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";

function validModel() {
  return existsSync(modelPath)
    && statSync(modelPath).size === expectedBytes
    && createHash("sha256").update(readFileSync(modelPath)).digest("hex") === expectedSha256;
}

mkdirSync(assetDirectory, { recursive: true });
if (existsSync(modelPath) && !validModel()) {
  const archived = join(assetDirectory, `face_landmarker.incomplete-${new Date().toISOString().replaceAll(":", "-")}.task`);
  renameSync(modelPath, archived);
}
if (!existsSync(modelPath)) {
  const response = await fetch(modelUrl);
  if (!response.ok || !response.body) throw new Error(`无法下载 MediaPipe Face Landmarker：HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(modelPath, { flags: "wx" }));
}
if (!validModel()) throw new Error("MediaPipe Face Landmarker 文件校验失败。" );
writeFileSync(join(assetDirectory, "asset-manifest.json"), `${JSON.stringify({
  version: 1,
  model: "face_landmarker.task",
  source: modelUrl,
  bytes: expectedBytes,
  sha256: expectedSha256,
  license: "MediaPipe model; see Google model terms and project THIRD_PARTY_NOTICES.md",
  preparedAt: new Date().toISOString()
}, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, assetDirectory, modelPath, bytes: expectedBytes })}\n`);
