import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { assetRequestDocumentSchema, calibrationDocumentSchema } from "./schema.js";
import { parsePuppetLoomProject } from "./project-format.js";
import { PUPPETLOOM_PROJECT_VERSION } from "./types.js";
import { makeGridMesh } from "./rig.js";
import type { AssetRequest, AssetRequestDocument, EnhanceOptions, EnhanceResult, LayerBinding, PuppetLoomProject, Rect } from "./types.js";

function paddedCrop(bounds: Rect, canvas: { width: number; height: number }): Rect {
  const padX = bounds.width * 0.22;
  const padY = bounds.height * 0.35;
  const x = Math.max(0, Math.floor(bounds.x - padX));
  const y = Math.max(0, Math.floor(bounds.y - padY));
  const right = Math.min(canvas.width, Math.ceil(bounds.x + bounds.width + padX));
  const bottom = Math.min(canvas.height, Math.ceil(bounds.y + bounds.height + padY));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export interface AssetRequestOptions {
  /** Request the optional A/I/U/E/O mouth set used by viseme tracking. */
  visemes?: boolean;
}

export function makeAssetRequests(project: PuppetLoomProject, options: AssetRequestOptions = {}): AssetRequestDocument {
  const requests: AssetRequest[] = [];
  for (const side of ["left", "right"] as const) {
    if (project.layers.some((layer) => layer.role === "eyeClosed" && layer.side === side)) continue;
    const sourceLayers = project.layers.filter((layer) => (layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash") && layer.side === side);
    if (sourceLayers.length === 0) continue;
    const normalized = sourceLayers.reduce(
      (rect, layer) => ({
        x: Math.min(rect.x, layer.bounds.x),
        y: Math.min(rect.y, layer.bounds.y),
        width: Math.max(rect.x + rect.width, layer.bounds.x + layer.bounds.width) - Math.min(rect.x, layer.bounds.x),
        height: Math.max(rect.y + rect.height, layer.bounds.y + layer.bounds.height) - Math.min(rect.y, layer.bounds.y)
      }),
      { ...sourceLayers[0]!.bounds }
    );
    const pixelBounds = {
      x: normalized.x * project.canvas.width,
      y: normalized.y * project.canvas.height,
      width: normalized.width * project.canvas.width,
      height: normalized.height * project.canvas.height
    };
    const crop = paddedCrop(pixelBounds, project.canvas);
    const id = `closed-eye-${side}`;
    requests.push({
      id,
      kind: "closed-eye",
      side,
      sourceLayerIds: sourceLayers.map((layer) => layer.id),
      crop,
      reference: { path: `requests/references/${id}.png` },
      output: { path: `supplements/${id}.png`, width: crop.width, height: crop.height, transparent: true },
      prompt: `Using the original character art, the current PSD recomposition, and this reference crop together, draw only this character's ${side} eye gently closed at the requested position. Match the original line weight, full upper-lash volume, outer-corner shape, shading, color treatment, and antialiasing; a single curved line is not acceptable. Put only the complete closed eyelid and lashes on a clean pure white background.`,
      constraints: [
        "不得包含皮肤、眉毛、头发或另一只眼睛。",
        "闭眼必须保留原画完整上睫毛体量和眼角结构，不能简化成一条弧线。",
        "眉毛是独立图层，不得画进闭眼素材，也不得用闭眼切换隐藏眉毛。",
        "生图阶段使用纯白背景，接入前抠成真实透明 PNG。"
      ],
      validation: { requireAlpha: true, minOpaqueCoverage: 0.002, maxOpaqueCoverage: 0.32 }
    });
  }

  const closedMouth = project.layers.find((layer) => layer.role === "mouth" && (layer.mouthVariant === "closed" || layer.mouthVariant === undefined));
  const face = project.layers.find((layer) => layer.role === "face");
  if (closedMouth) {
    const faceWidth = (face?.bounds.width ?? Math.max(closedMouth.bounds.width * 7, 0.04)) * project.canvas.width;
    const faceHeight = (face?.bounds.height ?? Math.max(closedMouth.bounds.height * 14, 0.04)) * project.canvas.height;
    const cropWidth = Math.max(40, Math.round(faceWidth * 0.42));
    const cropHeight = Math.max(28, Math.round(faceHeight * 0.2));
    const centerX = closedMouth.pivot.x * project.canvas.width;
    const centerY = closedMouth.pivot.y * project.canvas.height;
    const x = Math.max(0, Math.min(project.canvas.width - cropWidth, Math.round(centerX - cropWidth * 0.5)));
    const y = Math.max(0, Math.min(project.canvas.height - cropHeight, Math.round(centerY - cropHeight * 0.5)));
    const crop = { x, y, width: cropWidth, height: cropHeight };
    // The imported mouth is already the authoritative closed pose. Requesting
    // another closed drawing would duplicate it and can alter the neutral face.
    for (const variant of ["open"] as const) {
      if (project.layers.some((layer) => layer.role === "mouth" && layer.mouthVariant === variant)) continue;
      const id = "mouth-open-small";
      const description = "clearly open but restrained, preserving the same subtle smile";
      requests.push({
        id,
        kind: "mouth-shape",
        side: "center",
        variant,
        sourceLayerIds: [closedMouth.id],
        crop,
        reference: { path: `requests/references/${id}.png` },
        output: { path: `supplements/${id}.png`, width: crop.width, height: crop.height, transparent: true },
        prompt: `Using the original character art, the current PSD recomposition, and this reference crop together, draw only this character's mouth ${description} at the requested position. Match the original line weight, lip and mouth colors, shading, edge softness, and antialiasing. The existing closed mouth is authoritative and must not be redrawn. Put only the requested mouth shape on a clean pure white background.`,
        constraints: [
          "不得包含脸、鼻子、头发或背景。",
          "严格继承原画画风，不得把嘴形简化成与原图不一致的符号或线条。",
          "保持中立表情，不露齿；接入前抠成真实透明 PNG。"
        ],
        validation: { requireAlpha: true, minOpaqueCoverage: 0.002, maxOpaqueCoverage: 0.35 }
      });
    }
    if (options.visemes) {
      const descriptions: Record<"a" | "i" | "u" | "e" | "o", string> = {
        a: "A：自然纵向张开，保留角色原本嘴角和口腔配色",
        i: "I：横向略展开，嘴角自然，不露齿",
        u: "U：小幅收圆前突，保持角色原本线条",
        e: "E：比 I 更放松的横向开口，不露齿",
        o: "O：自然圆形开口，幅度小于夸张惊讶表情"
      };
      for (const variant of ["a", "i", "u", "e", "o"] as const) {
        if (project.layers.some((layer) => layer.role === "mouth" && layer.mouthVariant === variant)) continue;
        const id = `mouth-viseme-${variant}`;
        requests.push({
          id,
          kind: "mouth-shape",
          side: "center",
          variant,
          sourceLayerIds: [closedMouth.id],
          crop,
          reference: { path: `requests/references/${id}.png` },
          output: { path: `supplements/${id}.png`, width: crop.width, height: crop.height, transparent: true },
          prompt: `Using the original character art, the current PSD recomposition, and this reference crop together, draw only this character's ${descriptions[variant]} viseme at the requested position. Match the original line weight, mouth colors, shading, edge softness, and antialiasing. The existing closed mouth is authoritative and must not be redrawn. Put only the requested mouth shape on a clean pure white background.`,
          constraints: [
            "不得包含脸、鼻子、头发或背景。",
            "五个口型必须保持同一嘴部位置、尺寸体系和画风，差异只来自发音形状。",
            "保持中立发音，不添加牙齿、舌头或额外表情；接入前抠成真实透明 PNG。"
          ],
          validation: { requireAlpha: true, minOpaqueCoverage: 0.002, maxOpaqueCoverage: 0.35 }
        });
      }
    }
  }
  return { version: 1, optional: true, requests };
}

export interface TrackingAssetRequestResult {
  project: string;
  added: string[];
  total: number;
  requestPath: string;
}

/** Adds the optional viseme request set to an existing project without discarding prior requests or evidence. */
export async function prepareTrackingAssetRequests(projectDirectory: string): Promise<TrackingAssetRequestResult> {
  const root = resolve(projectDirectory);
  const project = parsePuppetLoomProject(JSON.parse(await readFile(join(root, "puppetloom.json"), "utf8")));
  const requestPath = join(root, "requests", "asset-requests.json");
  const current = assetRequestDocumentSchema.parse(JSON.parse(await readFile(requestPath, "utf8"))) as AssetRequestDocument;
  const proposed = makeAssetRequests(project, { visemes: true });
  const known = new Set(current.requests.map((request) => request.id));
  const additions = proposed.requests.filter((request) => !known.has(request.id));
  if (additions.length === 0) return { project: root, added: [], total: current.requests.length, requestPath };
  const neutralPath = join(root, "reports", "neutral.png");
  await access(neutralPath);
  const neutral = sharp(await readFile(neutralPath));
  await Promise.all(additions.map(async (request) => {
    if (!request.reference) return;
    const target = join(root, request.reference.path);
    try { await access(target); return; } catch { /* Create only missing reference crops. */ }
    await mkdir(dirname(target), { recursive: true });
    await neutral.clone().extract({ left: Math.round(request.crop.x), top: Math.round(request.crop.y), width: Math.round(request.crop.width), height: Math.round(request.crop.height) }).png().toFile(target);
  }));
  const backup = join(root, "requests", "asset-requests.pre-tracking.json");
  try { await writeFile(backup, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); } catch { /* Keep the first pre-upgrade document. */ }
  const next = { ...current, requests: [...current.requests, ...additions] };
  const temporary = `${requestPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, requestPath);
  return { project: root, added: additions.map((request) => request.id), total: next.requests.length, requestPath };
}

async function loadProjectAndRequests(projectDirectory: string): Promise<{ project: PuppetLoomProject; requests: AssetRequestDocument }> {
  const project = parsePuppetLoomProject(JSON.parse(await readFile(join(projectDirectory, "puppetloom.json"), "utf8")));
  const requestsPath = join(projectDirectory, "requests", "asset-requests.json");
  const requests = assetRequestDocumentSchema.parse(JSON.parse(await readFile(requestsPath, "utf8"))) as AssetRequestDocument;
  return { project, requests };
}

function supplementalLayer(request: AssetRequest, project: PuppetLoomProject, existing: LayerBinding): LayerBinding {
  const bounds = {
    x: request.crop.x / project.canvas.width,
    y: request.crop.y / project.canvas.height,
    width: request.crop.width / project.canvas.width,
    height: request.crop.height / project.canvas.height
  };
  return {
    id: request.id,
    sourceName: request.id,
    sourcePath: ["supplements", request.id],
    role: request.kind === "closed-eye" ? "eyeClosed" : "mouth",
    side: request.side,
    order: request.kind === "closed-eye"
      ? Math.max(...project.layers.filter((layer) => layer.role === "eyeWhite" || layer.role === "iris" || layer.role === "eyelash").map((layer) => layer.order), existing.order)
      : existing.order,
    opacity: 1,
    blendMode: "normal",
    bounds,
    texture: request.output.path,
    pivot: request.kind === "closed-eye" ? { ...existing.pivot } : { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.5 },
    mesh: makeGridMesh(bounds, 4, 4),
    weights: { head: 1, body: 0, gaze: 0, physics: 0 },
    ...(request.kind === "mouth-shape" && request.variant ? { mouthVariant: request.variant } : {}),
    parentGroup: "head"
  };
}

export async function enhanceProject(options: EnhanceOptions): Promise<EnhanceResult> {
  const projectDirectory = resolve(options.project);
  const loaded = await loadProjectAndRequests(projectDirectory);
  const project = loaded.project;
  let requests = loaded.requests;
  const activeRequests = requests.requests.filter((request) => !(request.kind === "mouth-shape" && request.variant === "slight" && !project.layers.some((layer) => layer.role === "mouth" && layer.mouthVariant === "slight")));
  if (activeRequests.length !== requests.requests.length) {
    const requestsPath = join(projectDirectory, "requests", "asset-requests.json");
    const backup = join(projectDirectory, "requests", "asset-requests.pre-two-state.json");
    try { await writeFile(backup, `${JSON.stringify(requests, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); } catch { /* Preserve the first migration backup. */ }
    requests = { ...requests, requests: activeRequests };
    const temporary = `${requestsPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(requests, null, 2)}\n`, "utf8");
    await rename(temporary, requestsPath);
  }
  const accepted: string[] = [];
  const rejected: Array<{ requestId: string; reason: string }> = [];
  const layers = [...project.layers];

  for (const request of requests.requests) {
    const candidate = join(resolve(options.assets), basename(request.output.path));
    try {
      if (layers.some((layer) => layer.id === request.id)) {
        rejected.push({ requestId: request.id, reason: "项目已经包含该补充素材。" });
        continue;
      }
      const { data, info } = await sharp(candidate).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== request.output.width || info.height !== request.output.height) {
        rejected.push({ requestId: request.id, reason: `尺寸应为 ${request.output.width}x${request.output.height}，实际为 ${info.width}x${info.height}。` });
        continue;
      }
      let opaque = 0;
      for (let index = 3; index < data.length; index += info.channels) if ((data[index] ?? 0) > 8) opaque += 1;
      const coverage = opaque / Math.max(1, info.width * info.height);
      if (coverage < request.validation.minOpaqueCoverage || coverage > request.validation.maxOpaqueCoverage) {
        rejected.push({ requestId: request.id, reason: `非透明区域比例 ${coverage.toFixed(4)} 超出安全范围。` });
        continue;
      }
      const existing = request.kind === "closed-eye"
        ? project.layers.find((layer) => layer.side === request.side && layer.role === "eyelash") ?? project.layers.find((layer) => layer.side === request.side && layer.role === "eyeWhite")
        : project.layers.find((layer) => layer.role === "mouth" && (layer.mouthVariant === "closed" || layer.mouthVariant === undefined));
      if (!existing) {
        rejected.push({ requestId: request.id, reason: request.kind === "closed-eye" ? "项目中没有对应的眼睛图层。" : "项目中没有闭合嘴部图层。" });
        continue;
      }
      const target = join(projectDirectory, request.output.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(candidate, target);
      layers.push(supplementalLayer(request, project, existing));
      accepted.push(request.id);
    } catch (error) {
      rejected.push({ requestId: request.id, reason: error instanceof Error ? error.message : "无法读取补充素材。" });
    }
  }

  const blinkEnabled = ["left", "right"].every((side) => layers.some((layer) => layer.role === "eyeClosed" && layer.side === side));
  const mouthMotionEnabled = ["closed", "open"].every((variant) => layers.some((layer) => layer.role === "mouth" && (layer.mouthVariant ?? "closed") === variant && layer.opacity > 0));
  const visemesEnabled = ["a", "i", "u", "e", "o"].every((variant) => layers.some((layer) => layer.role === "mouth" && layer.mouthVariant === variant && layer.opacity > 0));
  const nextProject: PuppetLoomProject = {
    ...project,
    version: PUPPETLOOM_PROJECT_VERSION,
    layers: layers.sort((a, b) => a.order - b.order),
    runtime: {
      ...project.runtime,
      features: {
        ...project.runtime.features,
        blink: blinkEnabled,
        mouthMotion: mouthMotionEnabled,
        asymmetricBlink: blinkEnabled,
        visemes: visemesEnabled
      }
    },
    disabledReasons: project.disabledReasons.filter((reason) => !(blinkEnabled && reason.includes("闭眼图层")) && !(mouthMotionEnabled && reason.includes("嘴部开合")))
  };

  if (accepted.length > 0) {
    const backup = join(projectDirectory, "reports", "pre-enhance-puppetloom.json");
    try {
      await writeFile(backup, JSON.stringify(project, null, 2), { encoding: "utf8", flag: "wx" });
    } catch {
      // A previous enhancement backup is intentionally preserved.
    }
    const projectText = `${JSON.stringify(nextProject, null, 2)}\n`;
    await writeFile(join(projectDirectory, "puppetloom.json"), projectText, "utf8");
    const calibrationPath = join(projectDirectory, "calibration", "current.json");
    try {
      const calibration = calibrationDocumentSchema.parse(JSON.parse(await readFile(calibrationPath, "utf8")));
      const nextCalibration = {
        ...calibration,
        baseProjectSha256: createHash("sha256").update(projectText).digest("hex"),
        updatedAt: new Date().toISOString()
      };
      const temporary = `${calibrationPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(nextCalibration, null, 2)}\n`, "utf8");
      await rename(temporary, calibrationPath);
    } catch {
      // Projects created before calibration support remain valid; calibration is created on the first edit.
    }
    const reportPath = join(projectDirectory, "reports", "build-report.json");
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        layerCount: number;
        enabledFeatures: string[];
        disabledFeatures: string[];
      };
      const features = Object.entries(nextProject.runtime.features);
      const optionalFeatureNames = new Set(["asymmetricBlink", "visemes", "upperBodyTracking"]);
      report.layerCount = nextProject.layers.length;
      report.enabledFeatures = features.filter(([, enabled]) => enabled).map(([name]) => name);
      report.disabledFeatures = features.filter(([name, enabled]) => !enabled && !optionalFeatureNames.has(name)).map(([name]) => name);
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch {
      // Older projects without a build report remain usable after enhancement.
    }
  }
  return { accepted, rejected, project: nextProject };
}
