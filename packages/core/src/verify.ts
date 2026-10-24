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
      invalidTextures.push({ path: layer.texture, reason: "텍스처 경로가 프로젝트 폴더 밖입니다." });
      continue;
    }
    try {
      await access(path);
      const metadata = await sharp(path).metadata();
      const expectedWidth = Math.round(layer.bounds.width * project.canvas.width);
      const expectedHeight = Math.round(layer.bounds.height * project.canvas.height);
      if (metadata.format !== "png" || metadata.width !== expectedWidth || metadata.height !== expectedHeight || !metadata.hasAlpha) {
        invalidTextures.push({ path: layer.texture, reason: `${expectedWidth}×${expectedHeight} 투명 PNG여야 하는데 실제는 ${metadata.width ?? "?"}×${metadata.height ?? "?"} ${metadata.format ?? "알 수 없는 형식"}입니다.` });
      } else {
        await sharp(path).ensureAlpha().raw().toBuffer();
      }
    } catch {
      try { await access(path); invalidTextures.push({ path: layer.texture, reason: "텍스처를 디코딩할 수 없습니다." }); }
      catch { missingTextures.push(layer.texture); }
    }
  }
  const hash = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
  const sourceAssets: Array<{ label: string; path: string; expected: string }> = [
    { label: "PSD", path: project.source.psdPath, expected: project.source.psdSha256 },
    ...(project.source.referencePath && project.source.referenceSha256 ? [{ label: "참고 이미지", path: project.source.referencePath, expected: project.source.referenceSha256 }] : [])
  ];
  for (const asset of sourceAssets) {
    const path = resolve(root, asset.path);
    if (!withinRoot(path)) { sourceIssues.push(`${asset.label} 경로가 프로젝트 폴더 밖입니다.`); continue; }
    try {
      if (await hash(path) !== asset.expected) sourceIssues.push(`${asset.label} 내용 해시가 프로젝트 기록과 다릅니다.`);
    } catch {
      sourceIssues.push(`${asset.label} 파일이 없거나 읽을 수 없습니다.`);
    }
  }
  const [calibration, sessions] = await Promise.all([loadCalibration(root), listCalibrationSessions(root)]);
  let expectedRevision = 0;
  for (const session of sessions) {
    if (session.fromRevision !== expectedRevision || session.toRevision !== expectedRevision + 1) historyIssues.push(`세션 ${session.id}이(가) 연속 이력을 이루지 않습니다.`);
    expectedRevision = session.toRevision;
    if (session.operationId) {
      const evidenceRoot = session.evidenceDirectory ? resolve(root, session.evidenceDirectory) : "";
      const required = ["comparison.json", "before-evidence.png", "after-evidence.png", "before-after.png", "difference.png"];
      if (!evidenceRoot || !withinRoot(evidenceRoot)) evidenceIssues.push(`세션 ${session.id}의 증거 폴더가 유효하지 않습니다.`);
      else {
        let comparison: import("./types.js").RevisionComparisonResult | undefined;
        for (const name of required) {
          try {
            const path = join(evidenceRoot, name);
            await access(path);
            if (name.endsWith(".png")) await sharp(path).metadata();
            else comparison = JSON.parse(await readFile(path, "utf8")) as import("./types.js").RevisionComparisonResult;
          } catch {
            evidenceIssues.push(`세션 ${session.id}에 증거 ${name}이(가) 없거나 손상되었습니다.`);
          }
        }
        if (comparison?.artifactSha256) {
          const declared = comparison.artifactSha256;
          const paths: Array<[keyof typeof declared, string]> = [
            ["beforeEvidence", "before-evidence.png"], ["afterEvidence", "after-evidence.png"],
            ["comparisonSheet", "before-after.png"], ["differenceImage", "difference.png"]
          ];
          for (const [key, name] of paths) {
            try { if (await hash(join(evidenceRoot, name)) !== declared[key]) evidenceIssues.push(`세션 ${session.id}의 증거 ${name} 해시가 일치하지 않습니다.`); }
            catch { /* Missing files are reported above. */ }
          }
        } else {
          evidenceIssues.push(`세션 ${session.id}의 증거 목록에 파일 해시가 없습니다.`);
        }
      }
    }
  }
  if (expectedRevision !== calibration.revision) historyIssues.push(`이력 끝 revision ${expectedRevision}과(와) 현재 revision ${calibration.revision}이(가) 다릅니다.`);
  if (calibration.headSessionId && sessions.at(-1)?.id !== calibration.headSessionId) historyIssues.push("현재 캘리브레이션 헤드 포인터가 이력 끝과 다릅니다.");
  const failedPoses = project.quality.poseValidations.filter((pose) => !pose.passed);
  const warnings = [
    ...project.disabledReasons,
    ...(failedPoses.length > 0 ? [`자세 ${failedPoses.length}개가 안전 검사를 통과하지 못했습니다.`] : []),
    ...(missingTextures.length > 0 ? [`텍스처 파일 ${missingTextures.length}개가 없습니다.`] : []),
    ...(invalidTextures.length > 0 ? [`렌더링에 쓸 수 없는 텍스처 ${invalidTextures.length}개가 있습니다.`] : []),
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
