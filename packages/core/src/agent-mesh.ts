import { applyCalibrationOverrides } from "./calibration.js";
import { makeAdaptiveMesh, remeshArtMesh } from "./art-mesh.js";
import { loadProjectTextureSources } from "./offline-render.js";
import { reprojectMeshInfluences } from "./mesh.js";
import { artMeshDetailForRole } from "./rig.js";
import { frontHairPhysicsMask } from "./front-hair-geometry.js";
import type { ModelAgentRepair } from "./agent.js";
import type { PixelBuffer } from "./psd.js";
import type { AuthoringModel, LayerBinding, MeshBinding, Point, PuppetLoomProject } from "./types.js";

export interface AgentMeshAssessment {
  layerId: string;
  sourceName: string;
  topology: MeshBinding["topology"];
  pointCount: number;
  triangleCount: number;
  connectedComponents: number;
  expectedComponents: number;
  tinyComponentCount: number;
  crowdedVertexCount: number;
  maximumBoundaryEdgePixels: number;
  orphanVertexIndices: number[];
  issues: string[];
  shouldRebuild: boolean;
}

function maximumBoundaryEdgePixels(mesh: MeshBinding): number {
  if (!mesh.art) return 0;
  const counts = new Map<string, { from: number; to: number; count: number }>();
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const first = mesh.triangles[index];
    const second = mesh.triangles[index + 1];
    const third = mesh.triangles[index + 2];
    if (first === undefined || second === undefined || third === undefined) continue;
    const edges: Array<[number, number]> = [[first, second], [second, third], [third, first]];
    for (const [from, to] of edges) {
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { from, to, count: 1 });
    }
  }
  return Math.max(0, ...[...counts.values()].flatMap(({ from, to, count }) => {
    if (count !== 1) return [];
    const a = mesh.uvs[from];
    const b = mesh.uvs[to];
    if (!a || !b) return [];
    return [Math.hypot(
      (b.x - a.x) * mesh.art!.textureSize.width,
      (b.y - a.y) * mesh.art!.textureSize.height
    )];
  }));
}

export interface PreparedAgentMeshes {
  project: PuppetLoomProject;
  replacements: Record<string, MeshBinding>;
  before: AgentMeshAssessment[];
  after: AgentMeshAssessment[];
  repairs: ModelAgentRepair[];
  blockers: string[];
}

function connectedComponents(mesh: MeshBinding): { count: number; sizes: number[]; orphanVertexIndices: number[] } {
  const referenced = new Set(mesh.triangles);
  const adjacency = Array.from({ length: mesh.points.length }, () => new Set<number>());
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const triangle = mesh.triangles.slice(index, index + 3);
    if (triangle.length !== 3) continue;
    for (const from of triangle) for (const to of triangle) if (from !== to && adjacency[from]) adjacency[from]!.add(to);
  }
  const visited = new Set<number>();
  let count = 0;
  const sizes: number[] = [];
  for (let index = 0; index < mesh.points.length; index += 1) {
    if (!referenced.has(index) || visited.has(index)) continue;
    count += 1;
    const queue = [index];
    let size = 0;
    visited.add(index);
    while (queue.length > 0) {
      const current = queue.shift()!;
      size += 1;
      for (const next of adjacency[current] ?? []) if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
    sizes.push(size);
  }
  return { count, sizes, orphanVertexIndices: mesh.points.flatMap((_point, index) => referenced.has(index) ? [] : [index]) };
}

function crowdedVertexCount(mesh: MeshBinding): number {
  const source = mesh.art;
  if (!source || mesh.uvs.length < 2) return 0;
  const minimumUsefulSpacing = source.detail * 0.25;
  return mesh.uvs.filter((point, index) => {
    const nearest = Math.min(...mesh.uvs.map((candidate, candidateIndex) => candidateIndex === index
      ? Number.POSITIVE_INFINITY
      : Math.hypot(
        (candidate.x - point.x) * source.textureSize.width,
        (candidate.y - point.y) * source.textureSize.height
      )));
    return nearest < minimumUsefulSpacing;
  }).length;
}

function maximumUsefulPoints(layer: LayerBinding): number {
  if (["eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth"].includes(layer.role)) return 500;
  if (["frontHair", "backHair", "sideHair", "ear", "headwear"].includes(layer.role)) return 900;
  return 1_500;
}

export function assessAgentMesh(layer: LayerBinding): AgentMeshAssessment {
  const mesh = layer.mesh;
  const components = connectedComponents(mesh);
  const expectedComponents = Math.max(1, mesh.art?.regions.length ?? 1);
  const tinyComponentCount = components.sizes.filter((size) => size < 6).length;
  const crowdedVertices = crowdedVertexCount(mesh);
  const longestBoundaryEdge = maximumBoundaryEdgePixels(mesh);
  const issues: string[] = [];
  if (mesh.topology !== "art" || !mesh.art) issues.push("仍是矩形网格，未贴合 Alpha 轮廓");
  if (mesh.points.length !== mesh.uvs.length) issues.push("顶点与 UV 数量不一致");
  if (mesh.triangles.length === 0 || mesh.triangles.length % 3 !== 0) issues.push("三角形索引不完整");
  if (mesh.triangles.some((index) => !Number.isInteger(index) || index < 0 || index >= mesh.points.length)) issues.push("三角形引用了不存在的顶点");
  if (components.orphanVertexIndices.length > 0) issues.push(`存在 ${components.orphanVertexIndices.length} 个孤立顶点`);
  if (components.count > expectedComponents) issues.push(`网格被拆成 ${components.count} 个连通块，但 Alpha 只有 ${expectedComponents} 个区域`);
  if (tinyComponentCount > 0) issues.push(`存在 ${tinyComponentCount} 个没有变形价值的微小网格碎片`);
  // A few close vertices are legitimate where two sides of a thin painted
  // lock approach each other. Rebuild only when the density is a real cluster;
  // the generated replacement must reduce it below eight percent (or twelve
  // vertices for small meshes), while still preserving the silhouette.
  if (crowdedVertices > Math.max(12, Math.ceil(mesh.points.length * 0.08))) issues.push(`存在 ${crowdedVertices} 个间距过密的轮廓顶点`);
  if (mesh.art && longestBoundaryEdge > mesh.art.detail * 2.2) issues.push(`存在 ${longestBoundaryEdge.toFixed(1)} 像素的过长轮廓边，无法保持平滑体积弧线`);
  if (mesh.points.length > maximumUsefulPoints(layer)) issues.push(`顶点数 ${mesh.points.length} 超出该部位的可维护范围`);
  return {
    layerId: layer.id,
    sourceName: layer.sourceName,
    topology: mesh.topology,
    pointCount: mesh.points.length,
    triangleCount: Math.floor(mesh.triangles.length / 3),
    connectedComponents: components.count,
    expectedComponents,
    tinyComponentCount,
    crowdedVertexCount: crowdedVertices,
    maximumBoundaryEdgePixels: longestBoundaryEdge,
    orphanVertexIndices: components.orphanVertexIndices,
    issues,
    shouldRebuild: issues.length > 0
  };
}

function meshDetailCandidates(layer: LayerBinding): number[] {
  const detail = Math.max(artMeshDetailForRole(layer.role), layer.mesh.art?.detail ?? 0);
  return [...new Set([
    detail,
    Math.round(detail * 0.75),
    Math.round(detail * 0.67),
    Math.round(detail * 1.25),
    Math.round(detail * 1.5)
  ].map((candidate) => Math.max(4, Math.min(256, candidate))))];
}

function assessmentRank(assessment: AgentMeshAssessment): [number, number, number, number] {
  return [
    assessment.issues.length,
    assessment.topology === "art" ? 0 : 1,
    assessment.crowdedVertexCount + assessment.orphanVertexIndices.length,
    assessment.pointCount
  ];
}

function betterAssessment(left: AgentMeshAssessment, right: AgentMeshAssessment): boolean {
  const leftRank = assessmentRank(left);
  const rightRank = assessmentRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index]! !== rightRank[index]!) return leftRank[index]! < rightRank[index]!;
  }
  return false;
}

/** Selects the first contract-valid nearby ArtMesh, retaining the best diagnostic candidate if none fully pass. */
export function rebuildAgentMesh(layer: LayerBinding, pixels?: PixelBuffer): MeshBinding {
  let selected = layer.mesh;
  let selectedAssessment = assessAgentMesh(layer);
  for (const detail of meshDetailCandidates(layer)) {
    let candidate: MeshBinding;
    try {
      candidate = pixels
        ? makeAdaptiveMesh({
            bounds: layer.bounds,
            pixels,
            detail,
            fallbackRows: layer.mesh.rows ?? 8,
            fallbackCols: layer.mesh.cols ?? 8
          })
        : layer.mesh.topology === "art" && layer.mesh.art
          ? remeshArtMesh(layer.mesh, layer.bounds, detail)
          : layer.mesh;
    } catch {
      continue;
    }
    const assessment = assessAgentMesh({ ...layer, mesh: candidate });
    if (assessment.issues.length === 0) {
      selected = candidate;
      selectedAssessment = assessment;
      break;
    }
    if (betterAssessment(assessment, selectedAssessment)) {
      selected = candidate;
      selectedAssessment = assessment;
    }
  }
  const mesh = {
    ...selected,
    influences: reprojectMeshInfluences(layer.mesh, selected)
  };
  if (layer.role === "frontHair") {
    const remeshedLayer = { ...layer, mesh };
    mesh.influences.physics = mesh.points.map((point) => frontHairPhysicsMask(remeshedLayer, point));
  }
  return mesh;
}

function barycentric(point: Point, a: Point, b: Point, c: Point): [number, number, number] | undefined {
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(denominator) < 1e-12) return undefined;
  const wa = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denominator;
  const wb = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denominator;
  const wc = 1 - wa - wb;
  return wa >= -1e-5 && wb >= -1e-5 && wc >= -1e-5 ? [wa, wb, wc] : undefined;
}

function sampleDelta(mesh: MeshBinding, deltas: Record<string, Point>, uv: Point): Point {
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const ia = mesh.triangles[index];
    const ib = mesh.triangles[index + 1];
    const ic = mesh.triangles[index + 2];
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    const weights = barycentric(uv, mesh.uvs[ia]!, mesh.uvs[ib]!, mesh.uvs[ic]!);
    if (!weights) continue;
    const values = [deltas[String(ia)] ?? { x: 0, y: 0 }, deltas[String(ib)] ?? { x: 0, y: 0 }, deltas[String(ic)] ?? { x: 0, y: 0 }];
    return {
      x: values[0]!.x * weights[0] + values[1]!.x * weights[1] + values[2]!.x * weights[2],
      y: values[0]!.y * weights[0] + values[1]!.y * weights[1] + values[2]!.y * weights[2]
    };
  }
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  mesh.uvs.forEach((candidate, index) => {
    const current = Math.hypot(candidate.x - uv.x, candidate.y - uv.y);
    if (current < distance) { distance = current; nearest = index; }
  });
  return deltas[String(nearest)] ?? { x: 0, y: 0 };
}

function reprojectModelBindings(project: PuppetLoomProject, replacements: Record<string, MeshBinding>): AuthoringModel {
  return {
    ...project.model,
    bindings: project.model.bindings.map((binding) => {
      if (binding.target.kind !== "layer") return binding;
      const replacement = replacements[binding.target.id];
      const layer = project.layers.find((candidate) => candidate.id === binding.target.id);
      if (!replacement || !layer) return binding;
      return {
        ...binding,
        keyforms: binding.keyforms.map((keyform) => {
          if (!keyform.meshPointDeltas) return keyform;
          const meshPointDeltas = Object.fromEntries(replacement.uvs.flatMap((uv, index) => {
            const delta = sampleDelta(layer.mesh, keyform.meshPointDeltas!, uv);
            return Math.hypot(delta.x, delta.y) <= 1e-12 ? [] : [[String(index), { x: Number(delta.x.toFixed(10)), y: Number(delta.y.toFixed(10)) }]];
          }));
          return { ...keyform, meshPointDeltas };
        })
      };
    })
  };
}

/** Rebuilds only meshes that fail the shared Agent topology contract, without writing project files. */
export async function prepareAgentMeshes(projectDirectory: string, project: PuppetLoomProject, layerIds: string[]): Promise<PreparedAgentMeshes> {
  const requested = new Set(layerIds);
  const targets = project.layers.filter((layer) => requested.has(layer.id));
  const missing = layerIds.filter((id) => !targets.some((layer) => layer.id === id));
  if (missing.length > 0) throw new Error(`找不到 Agent 网格目标：${missing.join("、")}`);
  const before = targets.map(assessAgentMesh);
  const sources = before.some((assessment) => assessment.shouldRebuild) ? await loadProjectTextureSources(projectDirectory, project) : new Map();
  const replacements: Record<string, MeshBinding> = {};
  const repairs: ModelAgentRepair[] = [];
  for (const layer of targets) {
    const assessment = before.find((candidate) => candidate.layerId === layer.id)!;
    if (!assessment.shouldRebuild) continue;
    const mesh = rebuildAgentMesh(layer, sources.get(layer.id));
    replacements[layer.id] = mesh;
    repairs.push({
      pass: repairs.length + 1,
      action: `重建 ${layer.sourceName} 的 Alpha ArtMesh`,
      reason: assessment.issues.join("；"),
      targetLayerIds: [layer.id],
      ...(assessment.orphanVertexIndices.length > 0 ? { affectedVertexIndices: assessment.orphanVertexIndices } : {})
    });
  }
  const prepared = Object.keys(replacements).length > 0
    ? applyCalibrationOverrides(project, {
        model: reprojectModelBindings(project, replacements),
        layers: Object.fromEntries(Object.entries(replacements).map(([id, mesh]) => [id, { mesh }]))
      })
    : project;
  const after = prepared.layers.filter((layer) => requested.has(layer.id)).map(assessAgentMesh);
  const blockers = after.flatMap((assessment) => assessment.issues.map((issue) => `${assessment.sourceName}：${issue}`));
  return { project: prepared, replacements, before, after, repairs, blockers };
}
