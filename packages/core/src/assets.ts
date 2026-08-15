import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { assetRequestDocumentSchema, puppetLoomProjectSchema } from "./schema.js";
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

export function makeAssetRequests(project: PuppetLoomProject): AssetRequestDocument {
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
      prompt: `Using the reference crop, draw only this character's ${side} eye gently closed in the same position and style. Put only the eyelid and lashes on a clean pure white background.`,
      constraints: [
        "不得包含皮肤、眉毛、头发或另一只眼睛。",
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
    for (const variant of ["closed", "slight", "open"] as const) {
      if (variant === "closed" ? project.layers.some((layer) => layer.id === "mouth-neutral") : project.layers.some((layer) => layer.role === "mouth" && layer.mouthVariant === variant)) continue;
      const id = variant === "closed" ? "mouth-neutral" : variant === "slight" ? "mouth-slight" : "mouth-open-small";
      const description = variant === "closed" ? "closed with a very subtle, relaxed smile" : variant === "slight" ? "slightly open with the same subtle smile" : "open a small, natural amount with the same subtle smile";
      requests.push({
        id,
        kind: "mouth-shape",
        side: "center",
        variant,
        sourceLayerIds: [closedMouth.id],
        crop,
        reference: { path: `requests/references/${id}.png` },
        output: { path: `supplements/${id}.png`, width: crop.width, height: crop.height, transparent: true },
        prompt: `Using the reference crop, draw only this character's mouth ${description} in the same position and style. Put only the mouth on a clean pure white background.`,
        constraints: [
          "不得包含脸、鼻子、头发或背景。",
          "保持中立表情，不露齿；接入前抠成真实透明 PNG。"
        ],
        validation: { requireAlpha: true, minOpaqueCoverage: 0.002, maxOpaqueCoverage: 0.35 }
      });
    }
  }
  return { version: 1, optional: true, requests };
}

async function loadProjectAndRequests(projectDirectory: string): Promise<{ project: PuppetLoomProject; requests: AssetRequestDocument }> {
  const project = puppetLoomProjectSchema.parse(JSON.parse(await readFile(join(projectDirectory, "puppetloom.json"), "utf8"))) as PuppetLoomProject;
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
  const { project, requests } = await loadProjectAndRequests(projectDirectory);
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
      if (request.kind === "mouth-shape" && request.variant === "closed") {
        const existingIndex = layers.findIndex((layer) => layer.id === existing.id);
        if (existingIndex >= 0) layers[existingIndex] = { ...layers[existingIndex]!, opacity: 0 };
      }
      accepted.push(request.id);
    } catch (error) {
      rejected.push({ requestId: request.id, reason: error instanceof Error ? error.message : "无法读取补充素材。" });
    }
  }

  const blinkEnabled = ["left", "right"].every((side) => layers.some((layer) => layer.role === "eyeClosed" && layer.side === side));
  const mouthMotionEnabled = ["closed", "slight", "open"].every((variant) => layers.some((layer) => layer.role === "mouth" && layer.mouthVariant === variant && layer.opacity > 0));
  const nextProject: PuppetLoomProject = {
    ...project,
    layers: layers.sort((a, b) => a.order - b.order),
    runtime: {
      ...project.runtime,
      features: {
        ...project.runtime.features,
        blink: blinkEnabled,
        mouthMotion: mouthMotionEnabled
      }
    },
    disabledReasons: project.disabledReasons.filter((reason) => !(blinkEnabled && reason.includes("闭眼图层")) && !(mouthMotionEnabled && reason.includes("三态嘴形")))
  };

  if (accepted.length > 0) {
    const backup = join(projectDirectory, "reports", "pre-enhance-puppetloom.json");
    try {
      await writeFile(backup, JSON.stringify(project, null, 2), { encoding: "utf8", flag: "wx" });
    } catch {
      // A previous enhancement backup is intentionally preserved.
    }
    await writeFile(join(projectDirectory, "puppetloom.json"), `${JSON.stringify(nextProject, null, 2)}\n`, "utf8");
    const reportPath = join(projectDirectory, "reports", "build-report.json");
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        layerCount: number;
        enabledFeatures: string[];
        disabledFeatures: string[];
      };
      const features = Object.entries(nextProject.runtime.features);
      report.layerCount = nextProject.layers.length;
      report.enabledFeatures = features.filter(([, enabled]) => enabled).map(([name]) => name);
      report.disabledFeatures = features.filter(([, enabled]) => !enabled).map(([name]) => name);
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch {
      // Older projects without a build report remain usable after enhancement.
    }
  }
  return { accepted, rejected, project: nextProject };
}
