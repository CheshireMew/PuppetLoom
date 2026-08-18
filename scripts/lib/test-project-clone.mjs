import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, copyFile, link, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function normalizedRelativePath(path) {
  return path.split(sep).join("/");
}

function clonePolicy(relativePath) {
  const path = normalizedRelativePath(relativePath);
  if (path === "reports" || path.startsWith("reports/")) return "skip";
  if (path === "calibration/draft.json" || path.startsWith("calibration/locks/") || path === "calibration/write.lock") return "skip";
  if (path === "source" || path.startsWith("source/") || path === "textures" || path.startsWith("textures/") || path === "supplements" || path.startsWith("supplements/")) return "object";
  return "copy";
}

async function projectFiles(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const ownedPath = relative(root, path);
      if (clonePolicy(ownedPath) === "skip") continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`真实项目测试副本不支持符号链接或特殊文件：${path}`);
    }
  };
  await visit(root);
  return files;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function ensureSharedObject(source, objectsRoot) {
  const hash = await sha256File(source);
  const objectPath = join(objectsRoot, hash.slice(0, 2), hash);
  let seeded = false;
  if (!(await exists(objectPath))) {
    await mkdir(dirname(objectPath), { recursive: true });
    const temporary = `${objectPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    try {
      await rename(temporary, objectPath);
      seeded = true;
    } catch (error) {
      if (!(await exists(objectPath))) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      await unlink(temporary);
    }
  }
  const [sourceStat, objectStat] = await Promise.all([stat(source), stat(objectPath)]);
  if (sourceStat.size !== objectStat.size) throw new Error(`共享对象大小不匹配：${objectPath}`);
  return { objectPath, seeded };
}

async function linkOrCopy(source, target) {
  try {
    await link(source, target);
    return "linked";
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) throw error;
    await copyFile(source, target);
    return "copied";
  }
}

export async function cloneProjectForTest(sourceDirectory, targetDirectory, { objectRoot } = {}) {
  const source = resolve(sourceDirectory);
  const target = resolve(targetDirectory);
  const objectsRoot = resolve(objectRoot ?? join(dirname(target), "objects", "sha256"));
  if (!(await exists(join(source, "puppetloom.json")))) throw new Error(`不是可编辑的 PuppetLoom 项目：${source}`);
  if (await exists(target)) throw new Error(`测试项目目标已存在，拒绝覆盖：${target}`);
  if (target === source || target.startsWith(`${source}${sep}`)) throw new Error(`测试项目不能建在来源项目内部：${target}`);

  await mkdir(target, { recursive: false });
  const report = { source, target, objectRoot: objectsRoot, linkedFiles: 0, copiedFiles: 0, seededObjects: 0, linkedBytes: 0, copiedBytes: 0 };
  for (const sourcePath of await projectFiles(source)) {
    const ownedPath = relative(source, sourcePath);
    const targetPath = join(target, ownedPath);
    await mkdir(dirname(targetPath), { recursive: true });
    const bytes = (await stat(sourcePath)).size;
    let result = "copied";
    if (clonePolicy(ownedPath) === "object") {
      const shared = await ensureSharedObject(sourcePath, objectsRoot);
      if (shared.seeded) report.seededObjects += 1;
      result = await linkOrCopy(shared.objectPath, targetPath);
    } else {
      await copyFile(sourcePath, targetPath);
    }
    if (result === "linked") {
      report.linkedFiles += 1;
      report.linkedBytes += bytes;
    } else {
      report.copiedFiles += 1;
      report.copiedBytes += bytes;
    }
  }
  return report;
}

/** Creates a valid independent revision-0 project from the source's effective current state. */
export async function cloneCurrentProjectForTest(sourceDirectory, targetDirectory, { objectRoot } = {}) {
  const source = resolve(sourceDirectory);
  const target = resolve(targetDirectory);
  const objectsRoot = resolve(objectRoot ?? join(dirname(target), "objects", "sha256"));
  if (await exists(target)) throw new Error(`测试项目目标已存在，拒绝覆盖：${target}`);
  const { loadCalibration, loadProject } = await import("../../packages/core/dist/index.js");
  const [project, calibration] = await Promise.all([loadProject(source), loadCalibration(source)]);
  const assets = [...new Set([
    project.source.psdPath,
    ...(project.source.referencePath ? [project.source.referencePath] : []),
    ...project.layers.map((layer) => layer.texture)
  ])];
  await mkdir(target, { recursive: false });
  const report = { source, target, objectRoot: objectsRoot, linkedFiles: 0, copiedFiles: 2, seededObjects: 0, linkedBytes: 0, copiedBytes: 0, sourceRevision: calibration.revision };
  for (const asset of assets) {
    const sourcePath = resolve(source, asset);
    const targetPath = resolve(target, asset);
    if (!sourcePath.startsWith(`${source}${sep}`) || !targetPath.startsWith(`${target}${sep}`)) throw new Error(`项目资源路径越界：${asset}`);
    await mkdir(dirname(targetPath), { recursive: true });
    const shared = await ensureSharedObject(sourcePath, objectsRoot);
    if (shared.seeded) report.seededObjects += 1;
    const result = await linkOrCopy(shared.objectPath, targetPath);
    const bytes = (await stat(sourcePath)).size;
    if (result === "linked") {
      report.linkedFiles += 1;
      report.linkedBytes += bytes;
    } else {
      report.copiedFiles += 1;
      report.copiedBytes += bytes;
    }
  }
  const projectText = `${JSON.stringify(project, null, 2)}\n`;
  const calibrationText = `${JSON.stringify({
    version: 2,
    baseProjectSha256: createHash("sha256").update(projectText).digest("hex"),
    revision: 0,
    updatedAt: new Date().toISOString(),
    label: `测试副本来自 revision ${calibration.revision}`,
    overrides: {}
  }, null, 2)}\n`;
  await mkdir(join(target, "calibration", "sessions"), { recursive: true });
  await writeFile(join(target, "puppetloom.json"), projectText, "utf8");
  await writeFile(join(target, "calibration", "current.json"), calibrationText, "utf8");
  report.copiedBytes += Buffer.byteLength(projectText) + Buffer.byteLength(calibrationText);
  return report;
}
