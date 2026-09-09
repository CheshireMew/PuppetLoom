import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { applyAuthoringOperations, buildAuthoringAudit } from "./authoring.js";
import { authoringPatchSchema } from "./schema.js";
import { loadCalibration, loadCalibrationDraft, loadProject } from "./project.js";
import { authoringPreviewState, renderProjectSuiteFromProject } from "./render-suite.js";
import { validatePose } from "./safety.js";
import { renderProjectDirectoryPosePng } from "./offline-render.js";
import { deformedPoints, neutralMotionState } from "./deform.js";
import { featureGatedMotionState } from "./render-contract.js";
import { PuppetLoomError } from "./errors.js";
import type { AuthoringPatch, AuthoringPreview, GeometryTransform, PuppetLoomProject, Point, RenderFocusScope } from "./types.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const fail = (message: string): never => { throw new PuppetLoomError("INVALID_INPUT", message); };

/** Review the renderer's effective state. A closing aperture is intentionally thin and clips its iris. */
export function validateAuthoringPreview(project: PuppetLoomProject, preview: AuthoringPreview) {
  const state = featureGatedMotionState(project, authoringPreviewState(project, preview));
  const validation = validatePose(project, preview.id, state);
  const closing = (id: string | undefined) => {
    const layer = project.layers.find(l => l.id === id);
    return layer?.blinkMode === 'geometry' && (layer.side === 'left' ? state.blinkLeft ?? state.blink : layer.side === 'right' ? state.blinkRight ?? state.blink : state.blink) > 0;
  };
  const openParameters = { ...state.parameters };
  for (const p of project.model.parameters) if (p.semantic === 'blink' || p.semantic === 'blink-left' || p.semantic === 'blink-right') openParameters[p.id] = 0;
  const { behavior: _behavior, ...withoutBehavior } = state;
  const openState = { ...withoutBehavior, blink: 0, blinkLeft: 0, blinkRight: 0, parameters: openParameters, expressions: {} };
  const open = validation.issues.some(i => i.code === 'eye-outside' && closing(i.layerId)) ? validatePose(project, `${preview.id}-open-aperture`, openState) : undefined;
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const issues = validation.issues.filter(issue => {
    if (!closing(issue.layerId)) return true;
    const layer = project.layers.find(l => l.id === issue.layerId)!;
    if (issue.code === 'eye-outside' && layer.clipLayerId && closing(layer.clipLayerId)) return open?.issues.some(i => i.code === issue.code && i.layerId === issue.layerId) === true;
    if (issue.code !== 'mesh-inversion' || !['eyeWhite', 'eyelash'].includes(layer.role)) return true;
    const points = deformedPoints(project, layer, state), rest = layer.mesh.points;
    for (let i = 0; i < layer.mesh.triangles.length; i += 3) {
      const [a, b, c] = layer.mesh.triangles.slice(i, i + 3) as [number, number, number];
      const base = cross(rest[a]!, rest[b]!, rest[c]!), area = cross(points[a]!, points[b]!, points[c]!);
      if (!Number.isFinite(area) || base * area <= 0 || Math.abs(area) <= Math.abs(base) * 1e-8) return true;
    }
    return false;
  });
  return { ...validation, score: Math.max(0, 1 - issues.reduce((n, i) => n + (i.severity === 'error' ? .28 : .08), 0)), issues, passed: !issues.some(i => i.severity === 'error') };
}

/** Original artwork and mesh share an explicit full-canvas coordinate map; no inferred anatomy is approved here. */
export async function inspectShape(directory: string, layerId: string, outputDirectory: string) {
  const root = resolve(directory), output = resolve(outputDirectory), project = await loadProject(root), revision = (await loadCalibration(root)).revision;
  const layer = project.layers.find(l => l.id === layerId);
  if (!layer) return fail(`找不到图层：${layerId}`);
  await mkdir(output, { recursive: true });
  const png = await readFile(join(root, layer.texture)), width = project.canvas.width, height = project.canvas.height;
  // Bound raster size while retaining source-canvas coordinates in the SVG viewBox.
  const scale = Math.min(1, 1600 / Math.max(width, height)), b = layer.bounds;
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ddd"/><image href="data:image/png;base64,${png.toString('base64')}" x="${b.x * width}" y="${b.y * height}" width="${b.width * width}" height="${b.height * height}"/>${body}</svg>`;
  const pixel = (p: Point) => `${p.x * width},${p.y * height}`;
  const lines: string[] = [];
  for (let i = 0; i < layer.mesh.triangles.length; i += 3) lines.push(`<polygon points="${layer.mesh.triangles.slice(i, i + 3).map(j => pixel(layer.mesh.points[j]!)).join(' ')}" fill="none" stroke="#007aaa" stroke-width=".45"/>`);
  await sharp(Buffer.from(svg(''))).png().toFile(join(output, 'source.png'));
  await sharp(Buffer.from(svg(lines.join('')))).png().toFile(join(output, 'mesh.png'));
  await writeFile(join(output, 'composite.png'), await renderProjectDirectoryPosePng(root, project, neutralMotionState, Math.round(width * scale), Math.round(height * scale)));
  const result = { projectDirectory: root, revision, projectFingerprint: hash(project), layerId, role: layer.role, side: layer.side, texture: join(root, layer.texture), textureSha256: createHash('sha256').update(png).digest('hex'),
    coordinates: { space: 'rest-canvas', origin: 'top-left', normalizedToPixels: { x: width, y: height }, previewScale: scale, parentTransformsApplied: false },
    bounds: layer.bounds, pixelBounds: { x: b.x * width, y: b.y * height, width: b.width * width, height: b.height * height }, parent: layer.deformerId ?? null,
    pointCount: layer.mesh.points.length, sourceView: join(output, 'source.png'), meshView: join(output, 'mesh.png'), compositeView: join(output, 'composite.png'),
    limitation: 'sourceView 按原纹理矩形映射，meshView 显示当前中立网格；已有修形、UV 或父级变换时二者不能直接混用，须结合 author geometry 的实际点位。区域语义由外部 Agent 看图标记。' };
  await writeFile(join(output, 'map.json'), JSON.stringify(result, null, 2));
  return result;
}

function guideSvg(transform: GeometryTransform, project: PuppetLoomProject): string {
  const { width, height } = project.canvas;
  const xy = (p: Point) => `${p.x * width} ${p.y * height}`;
  if (transform.kind === 'fit-landmarks') return transform.points.map(p => `<path d="M${xy(p.source)} L${xy(p.target)}" stroke="#ffae00"/><circle cx="${p.source.x * width}" cy="${p.source.y * height}" r="2" fill="#00bfea"/><circle cx="${p.target.x * width}" cy="${p.target.y * height}" r="2" fill="#ffae00"/><text x="${p.target.x * width + 3}" y="${p.target.y * height - 3}" font-size="10" fill="#222">${escape(p.label)}</text>`).join('');
  if (transform.kind === 'curve-warp') return [transform.source, transform.target].map((curve, i) => `<path d="M${xy(curve[0])} Q${xy(curve[1])} ${xy(curve[2])}" fill="none" stroke="${i ? '#ffae00' : '#00bfea'}" stroke-width="1.5"/>`).join('');
  return '';
}

/** Read-only proposal rendering. It neither creates a revision nor marks visual quality accepted. */
export async function previewAuthoringPatch(directory: string, raw: AuthoringPatch, outputDirectory: string, focus: RenderFocusScope = 'whole', size = 1080) {
  const patch = authoringPatchSchema.parse(raw) as AuthoringPatch, root = resolve(directory), output = resolve(outputDirectory);
  const [before, calibration, draft] = await Promise.all([loadProject(root), loadCalibration(root), loadCalibrationDraft(root)]);
  if (patch.baseRevision !== calibration.revision) throw new PuppetLoomError('REVISION_CONFLICT', '预览基线已变化，重新读取项目后制定目标。');
  if (draft) return fail('项目存在未提交草稿，先处理该草稿，预览不能忽略它。');
  const after = applyAuthoringOperations(before, patch.operations), audit = buildAuthoringAudit(patch, before, after);
  const previews: AuthoringPreview[] = [...audit.previews];
  const previewIds = new Set(previews.map(p => p.id));
  let nextPreviewId = 0;
  const bindings = after.model.bindings.filter(b => patch.operations.some(op => op.op === 'upsert-binding' && op.binding.id === b.id || op.op === 'transform-keyform' && op.bindingId === b.id));
  for (const binding of bindings) {
    const axes = binding.parameterIds.map(id => {
      const values = [...new Set(binding.keyforms.map(k => k.values[binding.parameterIds.indexOf(id)]!))].sort((a, b) => a - b);
      return values.flatMap((v, i) => i ? [(values[i - 1]! + v) / 2, v] : [v]);
    });
    const combinations = axes.length === 1 ? axes[0]!.map(x => [x]) : axes[0]!.flatMap(x => axes[1]!.map(y => [x, y]));
    for (const values of combinations) {
      const parameters = Object.fromEntries(binding.parameterIds.map((id, i) => [id, values[i]!]));
      const sameParameters = (p: AuthoringPreview) => Object.keys(p.parameters ?? {}).length === Object.keys(parameters).length && Object.entries(parameters).every(([id, value]) => p.parameters?.[id] === value);
      if (!previews.some(p => sameParameters(p) && !Object.keys(p.expressions ?? {}).length && !p.behavior && !p.settleSeconds)) {
        while (previewIds.has(`shape-${nextPreviewId}`)) nextPreviewId++;
        const id = `shape-${nextPreviewId++}`;
        previewIds.add(id);
        previews.push({ id, label: `${binding.id}: ${values.join(',')}`, parameters });
      }
    }
  }
  if (previews.length > 100) return fail('单次目标预览超过 100 个姿态，请按相关部位分开预览。');
  const checks = previews.map(p => validateAuthoringPreview(after, p));
  await mkdir(output, { recursive: true });
  const options = { size, focus };
  const beforeRender = await renderProjectSuiteFromProject(root, before, join(output, 'before'), 'calibration', calibration.revision, previews, options);
  const proposedRender = await renderProjectSuiteFromProject(root, after, join(output, 'proposal'), 'calibration', calibration.revision, previews, { ...options, contextLabel: '未保存提案，revision 为来源基线' });
  const overlays: string[] = [];
  for (const [index, op] of patch.operations.entries()) if (op.op === 'transform-keyform') {
    const body = op.transforms.map(t => guideSvg(t, before)).join('');
    if (!body) continue;
    const png = await renderProjectDirectoryPosePng(root, before, neutralMotionState, Math.min(before.canvas.width, 1600), Math.round(before.canvas.height * Math.min(1, 1600 / before.canvas.width)));
    const width = before.canvas.width, height = before.canvas.height, scale = Math.min(1, 1600 / Math.max(width, height));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}" viewBox="0 0 ${width} ${height}"><image href="data:image/png;base64,${png.toString('base64')}" width="${width}" height="${height}"/>${body}</svg>`;
    const path = join(output, `guide-${index}.png`); await sharp(Buffer.from(svg)).png().toFile(path); overlays.push(path);
  }
  // A concurrent edit invalidates the proposal instead of returning evidence for an obsolete baseline.
  if ((await loadCalibration(root)).revision !== calibration.revision || hash(await loadProject(root)) !== hash(before)) throw new PuppetLoomError('REVISION_CONFLICT', '渲染期间项目发生变化，当前预览已过期。');
  const result = { status: checks.every(c => c.passed) ? 'awaiting-visual-review' : 'blocked', visualReview: 'unreviewed', saved: false, checks, projectDirectory: root, baseRevision: calibration.revision,
    baseFingerprint: hash(before), proposalFingerprint: hash(after), patchFingerprint: hash(patch), coordinateSpace: 'rest-canvas',
    guideLegend: '蓝色为输入曲线/来源点，橙色为目标。标记在父级变换之前；合成图只作定位背景，最终效果看 proposal。',
    changes: audit.changes, samples: previews, overlays, before: beforeRender, proposal: proposedRender };
  await writeFile(join(output, 'preview.json'), JSON.stringify(result, null, 2));
  await writeFile(join(output, 'patch.json'), JSON.stringify(patch, null, 2));
  return result;
}
