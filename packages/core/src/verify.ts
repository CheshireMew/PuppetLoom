import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { listCalibrationSessions, loadCalibration, loadProject } from "./project.js";
import type { VerifyResult } from "./types.js";

export async function verifyProject(projectDirectory: string): Promise<VerifyResult> {
  const root = resolve(projectDirectory);
  const project = await loadProject(root);
  const missingTextures: string[] = [];
  const invalidTextures: Array<{ path: string; reason: string }> = [];
  const sourceIssues: string[] = [];
  const historyIssues: string[] = [];
  const evidenceIssues: string[] = [];
  const withinRoot = (path: string): boolean => {
    const relation = relative(root, path);
    return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
  };
  for (const layer of project.layers) {
    const path = resolve(root, layer.texture);
    if (!withinRoot(path)) {
      invalidTextures.push({ path: layer.texture, reason: "纹理路径越过项目目录边界。" });
      continue;
    }
    try {
      await access(path);
      const metadata = await sharp(path).metadata();
      const expectedWidth = Math.round(layer.bounds.width * project.canvas.width);
      const expectedHeight = Math.round(layer.bounds.height * project.canvas.height);
      if (metadata.format !== "png" || metadata.width !== expectedWidth || metadata.height !== expectedHeight || !metadata.hasAlpha) {
        invalidTextures.push({ path: layer.texture, reason: `应为 ${expectedWidth}×${expectedHeight} 的透明 PNG，实际为 ${metadata.width ?? "?"}×${metadata.height ?? "?"} ${metadata.format ?? "未知格式"}。` });
      } else {
        await sharp(path).ensureAlpha().raw().toBuffer();
      }
    } catch {
      try { await access(path); invalidTextures.push({ path: layer.texture, reason: "纹理无法解码。" }); }
      catch { missingTextures.push(layer.texture); }
    }
  }
  const hash = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
  const sourceAssets: Array<{ label: string; path: string; expected: string }> = [
    { label: "PSD", path: project.source.psdPath, expected: project.source.psdSha256 },
    ...(project.source.referencePath && project.source.referenceSha256 ? [{ label: "参考图", path: project.source.referencePath, expected: project.source.referenceSha256 }] : [])
  ];
  for (const asset of sourceAssets) {
    const path = resolve(root, asset.path);
    if (!withinRoot(path)) { sourceIssues.push(`${asset.label} 路径越过项目目录边界。`); continue; }
    try {
      if (await hash(path) !== asset.expected) sourceIssues.push(`${asset.label} 内容哈希与项目记录不一致。`);
    } catch {
      sourceIssues.push(`${asset.label} 文件缺失或无法读取。`);
    }
  }
  const [calibration, sessions] = await Promise.all([loadCalibration(root), listCalibrationSessions(root)]);
  let expectedRevision = 0;
  for (const session of sessions) {
    if (session.fromRevision !== expectedRevision || session.toRevision !== expectedRevision + 1) historyIssues.push(`会话 ${session.id} 没有形成连续历史。`);
    expectedRevision = session.toRevision;
    if (session.operationId) {
      const evidenceRoot = session.evidenceDirectory ? resolve(root, session.evidenceDirectory) : "";
      const required = ["comparison.json", "before-evidence.png", "after-evidence.png", "before-after.png", "difference.png"];
      if (!evidenceRoot || !withinRoot(evidenceRoot)) evidenceIssues.push(`会话 ${session.id} 的证据目录无效。`);
      else {
        let comparison: import("./types.js").RevisionComparisonResult | undefined;
        for (const name of required) {
          try {
            const path = join(evidenceRoot, name);
            await access(path);
            if (name.endsWith(".png")) await sharp(path).metadata();
            else comparison = JSON.parse(await readFile(path, "utf8")) as import("./types.js").RevisionComparisonResult;
          } catch {
            evidenceIssues.push(`会话 ${session.id} 缺少或损坏证据 ${name}。`);
          }
        }
        if (comparison?.artifactSha256) {
          const declared = comparison.artifactSha256;
          const paths: Array<[keyof typeof declared, string]> = [
            ["beforeEvidence", "before-evidence.png"], ["afterEvidence", "after-evidence.png"],
            ["comparisonSheet", "before-after.png"], ["differenceImage", "difference.png"]
          ];
          for (const [key, name] of paths) {
            try { if (await hash(join(evidenceRoot, name)) !== declared[key]) evidenceIssues.push(`会话 ${session.id} 的证据 ${name} 哈希不一致。`); }
            catch { /* Missing files are reported above. */ }
          }
        } else {
          evidenceIssues.push(`会话 ${session.id} 的证据清单没有文件哈希。`);
        }
      }
    }
  }
  if (expectedRevision !== calibration.revision) historyIssues.push(`历史末端 revision ${expectedRevision} 与当前 revision ${calibration.revision} 不一致。`);
  if (calibration.headSessionId && sessions.at(-1)?.id !== calibration.headSessionId) historyIssues.push("当前校准头指针与历史末端不一致。" );
  const failedPoses = project.quality.poseValidations.filter((pose) => !pose.passed);
  const warnings = [
    ...project.disabledReasons,
    ...(failedPoses.length > 0 ? [`${failedPoses.length} 个姿态未通过安全检查。`] : []),
    ...(missingTextures.length > 0 ? [`缺少 ${missingTextures.length} 个纹理文件。`] : []),
    ...(invalidTextures.length > 0 ? [`${invalidTextures.length} 个纹理无法用于渲染。`] : []),
    ...sourceIssues,
    ...historyIssues,
    ...evidenceIssues
  ];
  return {
    valid: missingTextures.length === 0 && invalidTextures.length === 0 && sourceIssues.length === 0 && historyIssues.length === 0 && evidenceIssues.length === 0 && failedPoses.length === 0,
    project: project.name,
    rigLevel: project.rigLevel,
    textureCount: project.layers.length,
    missingTextures,
    invalidTextures,
    sourceIssues,
    historyIssues,
    evidenceIssues,
    quality: project.quality,
    warnings
  };
}
