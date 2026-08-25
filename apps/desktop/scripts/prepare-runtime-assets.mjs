import { createHash } from "node:crypto";
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";

const assetDirectory = process.env.PUPPETLOOM_RUNTIME_ASSET_DIRECTORY ?? join("D:\\Tools", "PuppetLoom", "runtime-assets", "mediapipe");
const models = [
  {
    file: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    bytes: 3_758_596,
    sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
  },
  {
    file: "pose_landmarker_lite.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    bytes: 5_777_746,
    sha256: "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"
  },
  {
    file: "hand_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    bytes: 7_819_105,
    sha256: "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
  }
];

function validModel(path, model) {
  return existsSync(path)
    && statSync(path).size === model.bytes
    && createHash("sha256").update(readFileSync(path)).digest("hex") === model.sha256;
}

mkdirSync(assetDirectory, { recursive: true });
for (const model of models) {
  const path = join(assetDirectory, model.file);
  if (existsSync(path) && !validModel(path, model)) {
    const archived = join(assetDirectory, `${model.file.replace(/\.task$/, "")}.incomplete-${new Date().toISOString().replaceAll(":", "-")}.task`);
    renameSync(path, archived);
  }
  if (!existsSync(path)) {
    const response = await fetch(model.url);
    if (!response.ok || !response.body) throw new Error(`无法下载 MediaPipe ${model.file}：HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(path, { flags: "wx" }));
  }
  if (!validModel(path, model)) throw new Error(`MediaPipe ${model.file} 文件校验失败。`);
}

writeFileSync(join(assetDirectory, "asset-manifest.json"), `${JSON.stringify({
  version: 2,
  models: models.map((model) => ({ model: model.file, source: model.url, bytes: model.bytes, sha256: model.sha256 })),
  license: "MediaPipe models; see Google model terms and project THIRD_PARTY_NOTICES.md",
  preparedAt: new Date().toISOString()
}, null, 2)}\n`, "utf8");
const bundledDirectory = resolve("dist", "runtime-assets", "mediapipe");
mkdirSync(bundledDirectory, { recursive: true });
for (const model of models) copyFileSync(join(assetDirectory, model.file), join(bundledDirectory, model.file));
copyFileSync(join(assetDirectory, "asset-manifest.json"), join(bundledDirectory, "asset-manifest.json"));
cpSync(resolve("..", "..", "node_modules", "@mediapipe", "tasks-vision", "wasm"), join(bundledDirectory, "wasm"), { recursive: true, force: true });
const webRuntimeDirectory = resolve("dist", "runtime-assets", "web");
mkdirSync(webRuntimeDirectory, { recursive: true });
copyFileSync(resolve("..", "..", "packages", "web-runtime", "dist", "puppetloom-web.js"), join(webRuntimeDirectory, "puppetloom-web.js"));
process.stdout.write(`${JSON.stringify({ ok: true, assetDirectory, bundledDirectory, models: models.map((model) => ({ file: model.file, bytes: model.bytes })) })}\n`);
