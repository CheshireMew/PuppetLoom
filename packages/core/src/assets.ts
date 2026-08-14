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
      output: { path: `supplements/${id}.png`, width: crop.width, height: crop.height, transparent: true },
      prompt: `Draw only the ${side} closed eyelid for the same anime character. Preserve the exact line weight, color, camera angle, and eye position from the supplied crop. Return a transparent PNG containing only the closed eyelid artwork.`,
      constraints: [
        "不得改变脸型、眉毛、皮肤、头发或另一只眼睛。",
        "不得生成整张脸或带背景的图片。",
        "闭眼线条必须位于原睫毛区域，并保持原角色画风。",
        "输出画布尺寸和请求完全一致，目标之外保持透明。"
      ],
      validation: { requireAlpha: true, minOpaqueCoverage: 0.002, maxOpaqueCoverage: 0.32 }
    });
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
    role: "eyeClosed",
    side: request.side,
    order: existing.order + 1,
    opacity: 0,
    blendMode: "normal",
    bounds,
    texture: request.output.path,
    pivot: { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.5 },
    mesh: makeGridMesh(bounds, 4, 4),
    weights: { head: 1, body: 0, gaze: 0, physics: 0 },
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
      const target = join(projectDirectory, request.output.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(candidate, target);
      const existing = project.layers.find((layer) => layer.side === request.side && layer.role === "eyelash") ?? project.layers.find((layer) => layer.side === request.side && layer.role === "eyeWhite");
      if (!existing) {
        rejected.push({ requestId: request.id, reason: "项目中没有对应的眼睛图层。" });
        continue;
      }
      layers.push(supplementalLayer(request, project, existing));
      accepted.push(request.id);
    } catch (error) {
      rejected.push({ requestId: request.id, reason: error instanceof Error ? error.message : "无法读取补充素材。" });
    }
  }

  const nextProject: PuppetLoomProject = {
    ...project,
    layers: layers.sort((a, b) => a.order - b.order),
    runtime: {
      ...project.runtime,
      features: {
        ...project.runtime.features,
        blink: ["left", "right"].every((side) => layers.some((layer) => layer.role === "eyeClosed" && layer.side === side))
      }
    },
    disabledReasons: project.disabledReasons.filter((reason) => !reason.includes("闭眼图层"))
  };

  if (accepted.length > 0) {
    const backup = join(projectDirectory, "reports", "pre-enhance-puppetloom.json");
    try {
      await writeFile(backup, JSON.stringify(project, null, 2), { encoding: "utf8", flag: "wx" });
    } catch {
      // A previous enhancement backup is intentionally preserved.
    }
    await writeFile(join(projectDirectory, "puppetloom.json"), `${JSON.stringify(nextProject, null, 2)}\n`, "utf8");
  }
  return { accepted, rejected, project: nextProject };
}
