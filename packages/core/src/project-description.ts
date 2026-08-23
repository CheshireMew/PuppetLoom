import { join, resolve } from "node:path";
import { authoringSummary } from "./authoring.js";
import { PuppetLoomError } from "./errors.js";
import { loadProjectRevision } from "./calibration-store.js";
import { loadCalibration, loadProject, readBaseProject } from "./project-store.js";
import { inspectLayerAlphaTopology } from "./topology.js";
import type { ProjectDescription } from "./types.js";

export async function describeProject(projectDirectory: string, layerId?: string, revision?: number): Promise<ProjectDescription> {
  const directory = resolve(projectDirectory);
  const [{ project: baseProject, hash }, calibration] = await Promise.all([readBaseProject(directory), loadCalibration(directory)]);
  const selectedRevision = revision ?? calibration.revision;
  const project = revision === undefined ? await loadProject(directory) : await loadProjectRevision(directory, selectedRevision);
  const selected = layerId ? project.layers.find((layer) => layer.id === layerId) : undefined;
  const selectedBase = selected ? baseProject.layers.find((layer) => layer.id === selected.id) : undefined;
  if (layerId && !selected) throw new PuppetLoomError("INVALID_INPUT", `找不到图层：${layerId}`);
  const selectedLayer = selected ? {
    id: selected.id,
    sourceName: selected.sourceName,
    sourcePath: selected.sourcePath,
    role: selected.role,
    side: selected.side,
    opacity: selected.opacity,
    blendMode: selected.blendMode,
    texture: selected.texture,
    parentGroup: selected.parentGroup,
    ...(selected.parentLayerId ? { parentLayerId: selected.parentLayerId } : {}),
    order: selected.order,
    visible: selected.visible !== false,
    locked: selected.locked === true,
    bounds: selected.bounds,
    pivot: selected.pivot,
    ...(selected.secondaryAnchors ? { secondaryAnchors: selected.secondaryAnchors } : {}),
    ...(selected.hairStrands ? { hairStrands: selected.hairStrands } : {}),
    weights: selected.weights,
    ...(selected.clipLayerId ? { clipLayerId: selected.clipLayerId } : {}),
    ...(selected.mouthVariant ? { mouthVariant: selected.mouthVariant } : {}),
    alphaTopology: await inspectLayerAlphaTopology(join(directory, selected.texture), selected),
    mesh: {
      topology: selected.mesh.topology,
      ...(selected.mesh.rows !== undefined ? { rows: selected.mesh.rows } : {}),
      ...(selected.mesh.cols !== undefined ? { cols: selected.mesh.cols } : {}),
      ...(selected.mesh.art ? {
        detail: selected.mesh.art.detail,
        regionCount: selected.mesh.art.regions.length,
        holeCount: selected.mesh.art.regions.reduce((count, region) => count + region.holes.length, 0)
      } : {}),
      points: selected.mesh.points.map((position, index) => {
        const uv = selected.mesh.uvs[index] ?? {
          x: 0,
          y: 0
        };
        const sameBaseLayout = selectedBase?.mesh.topology === selected.mesh.topology
          && selectedBase.mesh.points.length === selected.mesh.points.length
          && selectedBase.mesh.uvs.every((candidate, uvIndex) => {
            const current = selected.mesh.uvs[uvIndex];
            return current !== undefined && Math.abs(candidate.x - current.x) < 1e-8 && Math.abs(candidate.y - current.y) < 1e-8;
          });
        const basePosition = sameBaseLayout
          ? selectedBase.mesh.points[index] ?? position
          : {
              x: selected.bounds.x + selected.bounds.width * uv.x,
              y: selected.bounds.y + selected.bounds.height * uv.y
            };
        return {
          index,
          ...(selected.mesh.topology === "grid" && selected.mesh.cols !== undefined ? {
            row: Math.floor(index / selected.mesh.cols),
            col: index % selected.mesh.cols
          } : {}),
          basePosition,
          position,
          delta: { x: position.x - basePosition.x, y: position.y - basePosition.y },
          uv,
          influences: Object.fromEntries((["face", "skull", "head", "body", "gaze", "physics", "pin", "headAttachment", "physicsRelease"] as const).map((channel) => [
            channel,
            selected.mesh.influences?.[channel]?.[index] ?? (channel === "pin" || channel === "physicsRelease" ? 0 : 1)
          ])) as Record<import("./types.js").MeshInfluenceChannel, number>
        };
      }),
      triangles: selected.mesh.triangles
    }
  } : undefined;
  return {
    project: project.name,
    directory,
    version: project.version,
    calibrationRevision: selectedRevision,
    baseProjectSha256: hash,
    coordinateSystem: {
      unit: "normalized-canvas",
      origin: "top-left",
      xAxis: "right",
      yAxis: "down",
      sideConvention: "anatomical",
      note: "side 表示角色自身左右；正面角色的 left 通常显示在画面右侧。"
    },
    canvas: project.canvas,
    rigLevel: project.rigLevel,
    anchors: project.anchors,
    semanticPoints: project.runtime.semanticCage?.points ?? {},
    runtime: project.runtime,
    model: project.model,
    layers: project.layers.map((layer) => ({
      id: layer.id,
      sourceName: layer.sourceName,
      sourcePath: layer.sourcePath,
      role: layer.role,
      side: layer.side,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      texture: layer.texture,
      parentGroup: layer.parentGroup,
      ...(layer.parentLayerId ? { parentLayerId: layer.parentLayerId } : {}),
      ...(layer.deformerId ? { deformerId: layer.deformerId } : {}),
      order: layer.order,
      visible: layer.visible !== false,
      locked: layer.locked === true,
      bounds: layer.bounds,
      pivot: layer.pivot,
      ...(layer.secondaryAnchors ? { secondaryAnchors: layer.secondaryAnchors } : {}),
      ...(layer.hairStrands ? { hairStrands: layer.hairStrands } : {}),
      mesh: {
        topology: layer.mesh.topology,
        ...(layer.mesh.rows !== undefined ? { rows: layer.mesh.rows } : {}),
        ...(layer.mesh.cols !== undefined ? { cols: layer.mesh.cols } : {}),
        ...(layer.mesh.art ? {
          detail: layer.mesh.art.detail,
          regionCount: layer.mesh.art.regions.length,
          holeCount: layer.mesh.art.regions.reduce((count, region) => count + region.holes.length, 0)
        } : {}),
        pointCount: layer.mesh.points.length,
        triangleCount: Math.floor(layer.mesh.triangles.length / 3)
      },
      weights: layer.weights
    })),
    ...(selectedLayer ? { selectedLayer } : {})
  };
}

export async function describeAuthoringProject(projectDirectory: string): Promise<ReturnType<typeof authoringSummary>> {
  const root = resolve(projectDirectory);
  const [project, calibration] = await Promise.all([loadProject(root), loadCalibration(root)]);
  return authoringSummary(project, calibration.revision);
}
