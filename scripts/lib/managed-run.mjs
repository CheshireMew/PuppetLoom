import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, link, mkdir, open, readFile, readdir, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { createRunEvidence } from "./run-evidence.mjs";

export const DEFAULT_MAXIMUM_MANAGED_BYTES = 2 * 1024 ** 3;
export const DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 ** 3;
export const DEFAULT_MAXIMUM_PATH_LENGTH = 240;
const RESERVED_RUN_ID_LENGTH = 32;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function nearestExistingDirectory(path) {
  let current = resolve(path);
  while (!(await exists(current))) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`找不到可用的产物根目录：${path}`);
    current = parent;
  }
  return current;
}

async function filesUnder(root) {
  if (!(await exists(root))) return [];
  const result = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause) => {
      if (cause?.code === "ENOENT") return [];
      throw cause;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  await visit(root);
  return result;
}

async function bytesUnder(root) {
  let total = 0;
  for (const path of await filesUnder(root)) {
    const fileStat = await stat(path).catch((cause) => {
      if (cause?.code === "ENOENT") return undefined;
      throw cause;
    });
    if (fileStat) total += fileStat.size;
  }
  return total;
}

function physicalFileKey(path, fileStat) {
  return fileStat.ino && fileStat.ino !== 0n ? `${fileStat.dev}:${fileStat.ino}` : resolve(path);
}

async function physicalBytesUnderPaths(paths) {
  let total = 0;
  const seen = new Set();
  for (const root of paths) {
    const rootStat = await stat(root, { bigint: true }).catch(() => undefined);
    if (!rootStat) continue;
    const files = rootStat.isDirectory() ? await filesUnder(root) : [root];
    for (const path of files) {
      const fileStat = await stat(path, { bigint: true }).catch((cause) => {
        if (cause?.code === "ENOENT") return undefined;
        throw cause;
      });
      if (!fileStat) continue;
      const key = physicalFileKey(path, fileStat);
      if (seen.has(key)) continue;
      seen.add(key);
      total += Number(fileStat.size);
    }
  }
  return total;
}

async function physicalBytesUnder(root) {
  return physicalBytesUnderPaths([root]);
}

async function ownedRunManifests(runsRoot) {
  const manifests = [];
  for (const entry of await readdir(runsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const direct = join(runsRoot, entry.name, "run.json");
    if (await exists(direct)) manifests.push(direct);
    for (const legacy of await readdir(join(runsRoot, entry.name), { withFileTypes: true }).catch(() => [])) {
      if (!legacy.isDirectory()) continue;
      const nested = join(runsRoot, entry.name, legacy.name, "run.json");
      if (await exists(nested)) manifests.push(nested);
    }
  }
  return manifests;
}

function artifactClass(path) {
  return path === "preflight-lock.json" || /(^|[\\/])(?:cache|code cache|gpucache|dawnwebgpucache)(?:[\\/]|$)/i.test(path) ? "temporary" : "evidence";
}

function cleanupCandidates(inventory) {
  return inventory.filter((item) => item.path !== "preflight-lock.json").map((item) => item.path);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventoryUnder(directory, manifestPath) {
  const inventory = [];
  for (const path of await filesUnder(directory)) {
    if (resolve(path) === resolve(manifestPath)) continue;
    const ownedPath = relative(directory, path);
    try {
      const fileStat = await stat(path);
      inventory.push({ path: ownedPath, class: artifactClass(ownedPath), bytes: fileStat.size, sha256: await sha256File(path) });
    } catch (cause) {
      // Electron profile databases remove transient WAL files during shutdown.
      // A file that disappears after enumeration no longer belongs in the
      // completed inventory; all other read failures remain actionable.
      if (cause?.code !== "ENOENT") throw cause;
    }
  }
  return inventory;
}

function samePhysicalFile(first, second) {
  return first.dev === second.dev && first.ino !== 0n && first.ino === second.ino;
}

async function replaceWithObjectLink(sourcePath, objectPath, expectedBytes) {
  await mkdir(dirname(objectPath), { recursive: true });
  let objectAlreadyExisted = await exists(objectPath);
  if (!objectAlreadyExisted) {
    try {
      await link(sourcePath, objectPath);
      return { state: "stored" };
    } catch (error) {
      if (error.code !== "EEXIST") return { state: "fallback", error: error.message };
      objectAlreadyExisted = true;
    }
  }

  try {
    const [sourceStat, objectStat] = await Promise.all([
      stat(sourcePath, { bigint: true }),
      stat(objectPath, { bigint: true })
    ]);
    if (Number(objectStat.size) !== expectedBytes) {
      return { state: "fallback", error: `对象大小不匹配：${objectPath}` };
    }
    if (samePhysicalFile(sourceStat, objectStat)) return { state: objectAlreadyExisted ? "reused" : "stored" };

    const backupPath = `${sourcePath}.${process.pid}.${randomUUID().slice(0, 8)}.dedupe-backup`;
    await rename(sourcePath, backupPath);
    try {
      await link(objectPath, sourcePath);
      await unlink(backupPath);
      return { state: "reused" };
    } catch (error) {
      await unlink(sourcePath).catch(() => undefined);
      try {
        await rename(backupPath, sourcePath);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `去重失败且无法恢复原文件：${sourcePath}`);
      }
      return { state: "fallback", error: error.message };
    }
  } catch (error) {
    if (error instanceof AggregateError) throw error;
    return { state: "fallback", error: error.message };
  }
}

async function deduplicateInventory(managedRoot, directory, inventory) {
  const objectsRoot = join(managedRoot, "objects", "sha256");
  const reusedObjects = [];
  const fallbackObjects = [];
  let objectsCreated = 0;
  let reusedLogicalBytes = 0;
  for (const item of inventory) {
    if (item.class !== "evidence") continue;
    const sourcePath = join(directory, item.path);
    const objectPath = join(objectsRoot, item.sha256.slice(0, 2), item.sha256);
    const result = await replaceWithObjectLink(sourcePath, objectPath, item.bytes);
    if (result.state === "stored") objectsCreated += 1;
    if (result.state === "reused") {
      reusedLogicalBytes += item.bytes;
      reusedObjects.push({ path: item.path, bytes: item.bytes, sha256: item.sha256, object: relative(managedRoot, objectPath) });
    }
    if (result.state === "fallback") fallbackObjects.push({ path: item.path, reason: result.error });
  }
  return {
    mode: "sha256-hardlink-v1",
    objectRoot: relative(managedRoot, objectsRoot),
    objectsCreated,
    objectsReused: reusedObjects.length,
    reusedLogicalBytes,
    fallbackCount: fallbackObjects.length,
    fallbackObjects,
    reusedObjects
  };
}

function categoryBytes(inventory) {
  return Object.fromEntries([...new Set(inventory.map((item) => item.class))].sort().map((category) => [
    category,
    inventory.filter((item) => item.class === category).reduce((sum, item) => sum + item.bytes, 0)
  ]));
}

function positiveInteger(value, fallback, label) {
  const selected = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error(`${label} 必须是正整数。`);
  return selected;
}

function validatePathBudget(managedRoot, maximumRelativePathLength, maximumPathLength) {
  const prospectiveDirectory = join(managedRoot, "runs", "x".repeat(RESERVED_RUN_ID_LENGTH));
  const requiredPathLength = prospectiveDirectory.length + 1 + maximumRelativePathLength;
  if (requiredPathLength > maximumPathLength) {
    throw new Error(
      `托管运行路径预算不足：运行根最多 ${prospectiveDirectory.length} 字符 + 产物相对路径 ${maximumRelativePathLength} 字符 > 上限 ${maximumPathLength} 字符；尚未写入运行目录。`
    );
  }
  return { maximumPathLength, maximumRelativePathLength, prospectiveRunDirectoryLength: prospectiveDirectory.length };
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function processIsAlive(processId) {
  try { process.kill(processId, 0); return true; } catch { return false; }
}

async function acquirePreflightLock(runsRoot, producer) {
  const lockPath = join(runsRoot, ".preflight.lock");
  const archive = join(runsRoot, ".locks");
  await mkdir(archive, { recursive: true });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx");
      const record = { version: 1, producer, processId: process.pid, createdAt: new Date().toISOString(), state: "held" };
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
        return { handle, lockPath, archive };
      } catch (writeError) {
        await handle.close().catch(() => undefined);
        await rename(lockPath, join(archive, `failed-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.json`)).catch(() => undefined);
        throw writeError;
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const existing = JSON.parse(await readFile(lockPath, "utf8"));
        if (existing.state !== "held" || !processIsAlive(existing.processId)) {
          await rename(lockPath, join(archive, `stale-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.json`));
          continue;
        }
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error(`产物预检仍由另一个进程占用：${runsRoot}`);
}

async function releasePreflightLock(lock, destination) {
  await lock.handle.close();
  const target = destination ?? join(lock.archive, `released-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.json`);
  await rename(lock.lockPath, target);
}

async function pendingReservationBytes(runsRoot) {
  let reserved = 0;
  for (const path of await ownedRunManifests(runsRoot)) {
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      if (manifest.status === "pending" && processIsAlive(manifest.processId)) reserved += Number(manifest.preflight?.estimatedBytes ?? 0);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  return reserved;
}

async function recoverInterruptedRuns(runsRoot) {
  const recovered = [];
  for (const path of await ownedRunManifests(runsRoot)) {
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      if (manifest.status !== "pending" || processIsAlive(manifest.processId)) continue;
      const now = new Date().toISOString();
      const inventory = await inventoryUnder(dirname(path), path);
      const next = {
        ...manifest,
        status: "interrupted",
        updatedAt: now,
        completedAt: now,
        note: "所有者进程已结束；产物保留并等待人工处置。",
        inventory,
        categoryBytes: categoryBytes(inventory),
        totalBytes: inventory.reduce((sum, item) => sum + item.bytes, 0),
        cleanupCandidates: cleanupCandidates(inventory)
      };
      await atomicJson(path, next);
      recovered.push(path);
    } catch {
      // A malformed record is reported by reportManagedArtifacts and is never deleted automatically.
    }
  }
  return recovered;
}

export async function startManagedRun({
  category,
  producer,
  evidence,
  root = process.env.PUPPETLOOM_ARTIFACT_ROOT || resolve("test/artifacts"),
  estimatedBytes,
  reuse,
  maximumRelativePathLength,
  maximumPathLength = process.env.PUPPETLOOM_ARTIFACT_MAX_PATH_LENGTH,
  maximumManagedBytes = process.env.PUPPETLOOM_ARTIFACT_MAX_BYTES,
  minimumFreeBytes = process.env.PUPPETLOOM_ARTIFACT_MIN_FREE_BYTES
}) {
  if (!category || !producer) throw new Error("托管产物运行必须声明 category 和 producer。" );
  if (!evidence || typeof evidence !== "object") throw new Error("托管产物运行必须声明 evidence。" );
  if (!reuse || typeof reuse.applicable !== "boolean" || typeof reuse.reason !== "string" || !reuse.reason.trim()) {
    throw new Error("托管产物运行必须声明可复用性判断和依据。" );
  }
  const estimate = positiveInteger(estimatedBytes, undefined, "estimatedBytes");
  const maximum = positiveInteger(maximumManagedBytes, DEFAULT_MAXIMUM_MANAGED_BYTES, "maximumManagedBytes");
  const minimumFree = positiveInteger(minimumFreeBytes, DEFAULT_MINIMUM_FREE_BYTES, "minimumFreeBytes");
  const maximumRelative = positiveInteger(maximumRelativePathLength, undefined, "maximumRelativePathLength");
  const maximumPath = positiveInteger(maximumPathLength, DEFAULT_MAXIMUM_PATH_LENGTH, "maximumPathLength");
  const managedRoot = resolve(root);
  const pathBudget = validatePathBudget(managedRoot, maximumRelative, maximumPath);
  const runEvidence = await createRunEvidence(evidence);
  const runsRoot = join(managedRoot, "runs");
  const initialFilesystem = await statfs(await nearestExistingDirectory(managedRoot));
  const initialFreeBytes = Number(initialFilesystem.bavail) * Number(initialFilesystem.bsize);
  if (estimate > maximum) throw new Error(`产物预算不足：预计 ${estimate} > 上限 ${maximum} 字节；尚未写入运行目录。`);
  if (initialFreeBytes - estimate < minimumFree) throw new Error(`磁盘余量不足：预计写入后低于 ${minimumFree} 字节；尚未写入运行目录。`);

  const lock = await acquirePreflightLock(runsRoot, producer);
  let lockReleased = false;
  try {
    await recoverInterruptedRuns(runsRoot);
    const currentBytes = await physicalBytesUnder(managedRoot);
    const reservedBytes = await pendingReservationBytes(runsRoot);
    const filesystem = await statfs(await nearestExistingDirectory(managedRoot));
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (currentBytes + reservedBytes + estimate > maximum) {
      throw new Error(`产物预算不足：当前 ${currentBytes} + 活动预留 ${reservedBytes} + 预计 ${estimate} > 上限 ${maximum} 字节；尚未写入运行目录。`);
    }
    if (freeBytes - reservedBytes - estimate < minimumFree) {
      throw new Error(`磁盘余量不足：活动预留与预计写入后低于 ${minimumFree} 字节；尚未写入运行目录。`);
    }

    const id = `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`;
    const directory = join(runsRoot, id);
    if (directory.length + 1 + maximumRelative > maximumPath) {
      throw new Error(`托管运行路径预算不足：${directory.length} + 1 + ${maximumRelative} > ${maximumPath}；尚未写入运行目录。`);
    }
    const manifestPath = join(directory, "run.json");
    const createdAt = new Date().toISOString();
    await mkdir(directory, { recursive: true });
    const pending = {
      version: 2, id, category, producer, status: "pending", createdAt, updatedAt: createdAt, processId: process.pid,
      root: relative(resolve("."), directory),
      evidence: runEvidence,
      pathBudget,
      artifactClasses: ["evidence", "temporary"],
      reuse: { applicable: reuse.applicable, reason: reuse.reason.trim(), ...(reuse.identity ? { identity: String(reuse.identity) } : {}) },
      reusedObjects: [],
      preflight: { estimatedBytes: estimate, currentManagedBytes: currentBytes, reservedBytes, maximumManagedBytes: maximum, freeBytes, minimumFreeBytes: minimumFree }
    };
    await atomicJson(manifestPath, pending);
    await releasePreflightLock(lock, join(directory, "preflight-lock.json"));
    lockReleased = true;

    let finished = false;
    return {
      id,
      directory,
      managedRoot,
      objectDirectory: join(managedRoot, "objects", "sha256"),
      manifestPath,
      path: (...parts) => join(directory, ...parts),
      async finish(status = "succeeded", error) {
        if (finished) return;
        if (!["succeeded", "failed"].includes(status)) throw new Error(`不支持的托管运行终态：${status}`);
        const inventory = await inventoryUnder(directory, manifestPath);
        const storageReuse = await deduplicateInventory(managedRoot, directory, inventory);
        const completedAt = new Date().toISOString();
        await atomicJson(manifestPath, {
          ...pending, status, updatedAt: completedAt, completedAt,
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
          inventory,
          categoryBytes: categoryBytes(inventory),
          totalBytes: inventory.reduce((sum, item) => sum + item.bytes, 0),
          storageReuse: Object.fromEntries(Object.entries(storageReuse).filter(([key]) => key !== "reusedObjects")),
          reusedObjects: storageReuse.reusedObjects,
          peakBytes: { kind: "preflight-upper-bound", bytes: estimate },
          cleanupCandidates: status === "failed" ? cleanupCandidates(inventory) : []
        });
        finished = true;
      }
    };
  } finally {
    if (!lockReleased) await releasePreflightLock(lock).catch(() => undefined);
  }
}

export async function executeManagedRun(options, operation) {
  const run = await startManagedRun(options);
  try {
    const result = await operation(run);
    await run.finish("succeeded");
    return result;
  } catch (error) {
    await run.finish("failed", error).catch(() => undefined);
    throw error;
  }
}

export async function reportManagedArtifacts(root = resolve("test/artifacts")) {
  const managedRoot = resolve(root);
  const entries = await readdir(managedRoot, { withFileTypes: true }).catch(() => []);
  const unmanagedCandidates = [];
  for (const entry of entries) {
    if (["runs", "objects", ".locks", ".gitkeep"].includes(entry.name)) continue;
    const path = join(managedRoot, entry.name);
    unmanagedCandidates.push({ path, bytes: entry.isDirectory() ? await bytesUnder(path) : (await stat(path)).size, lastModified: (await stat(path)).mtime.toISOString() });
  }
  const manifests = [];
  for (const path of await ownedRunManifests(join(managedRoot, "runs"))) {
    try { manifests.push({ path, manifest: JSON.parse(await readFile(path, "utf8")) }); }
    catch { manifests.push({ path, manifest: { status: "invalid" } }); }
  }
  const objectsRoot = join(managedRoot, "objects");
  return {
    root: managedRoot,
    policy: "report-only",
    logicalBytes: await bytesUnder(managedRoot),
    physicalBytes: await physicalBytesUnder(managedRoot),
    objectStore: {
      path: objectsRoot,
      files: (await filesUnder(objectsRoot)).length,
      logicalBytes: await bytesUnder(objectsRoot),
      physicalBytes: await physicalBytesUnder(objectsRoot)
    },
    unmanagedCandidates,
    runs: manifests
  };
}

function assertSafeManagedRoot(root) {
  const managedRoot = resolve(root);
  const driveRoot = parse(managedRoot).root;
  if (managedRoot === driveRoot || managedRoot === resolve(".")) throw new Error(`拒绝清理过宽目录：${managedRoot}`);
  if (managedRoot.length <= driveRoot.length + 3) throw new Error(`拒绝清理可疑目录：${managedRoot}`);
  return managedRoot;
}

function terminalBucket(status) {
  if (status === "succeeded") return "succeeded";
  if (["failed", "interrupted"].includes(status)) return "failed";
  return undefined;
}

export async function planManagedArtifactCleanup({
  root = resolve("test/artifacts"),
  all = false,
  keepSucceeded = 2,
  keepFailed = 1,
  includeLegacy = true
} = {}) {
  const managedRoot = assertSafeManagedRoot(root);
  const entries = await readdir(managedRoot, { withFileTypes: true }).catch(() => []);
  const manifests = [];
  const activeRuns = [];
  for (const manifestPath of await ownedRunManifests(join(managedRoot, "runs"))) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const record = { manifestPath, directory: dirname(manifestPath), manifest };
      manifests.push(record);
      if (manifest.status === "pending" && processIsAlive(manifest.processId)) activeRuns.push(record);
    } catch {
      // Invalid manifests stay untouched in retention mode; --all remains explicit.
    }
  }

  let candidates = [];
  if (all) {
    candidates = entries.filter((entry) => entry.name !== ".gitkeep").map((entry) => join(managedRoot, entry.name));
  } else {
    const grouped = new Map();
    for (const record of manifests) {
      const bucket = terminalBucket(record.manifest.status);
      if (!bucket) continue;
      const key = `${record.manifest.category}\u0000${record.manifest.producer}\u0000${bucket}`;
      const group = grouped.get(key) ?? [];
      group.push(record);
      grouped.set(key, group);
    }
    for (const [key, group] of grouped) {
      const bucket = key.slice(key.lastIndexOf("\u0000") + 1);
      const keep = bucket === "succeeded" ? keepSucceeded : keepFailed;
      group.sort((a, b) => String(b.manifest.completedAt ?? b.manifest.createdAt ?? "").localeCompare(String(a.manifest.completedAt ?? a.manifest.createdAt ?? "")));
      candidates.push(...group.slice(keep).map((record) => record.directory));
    }
    if (includeLegacy) {
      candidates.push(...entries
        .filter((entry) => !["runs", "objects", ".locks", ".gitkeep"].includes(entry.name))
        .map((entry) => join(managedRoot, entry.name)));
    }
  }

  candidates = [...new Set(candidates.map((candidate) => resolve(candidate)))].filter((candidate) => candidate.startsWith(`${managedRoot}${sep}`));
  return {
    root: managedRoot,
    mode: all ? "all" : "retention",
    activeRuns: activeRuns.map((record) => ({ id: record.manifest.id, producer: record.manifest.producer, directory: record.directory })),
    candidates,
    candidatePhysicalBytes: await physicalBytesUnderPaths(candidates)
  };
}

async function garbageCollectObjects(managedRoot) {
  const objectsRoot = join(managedRoot, "objects", "sha256");
  const removed = [];
  let releasedBytes = 0;
  for (const path of await filesUnder(objectsRoot)) {
    const fileStat = await stat(path);
    if (fileStat.nlink > 1) continue;
    releasedBytes += fileStat.size;
    await unlink(path);
    removed.push(path);
  }
  return { removed, releasedBytes };
}

export async function cleanupManagedArtifacts(options = {}) {
  const plan = await planManagedArtifactCleanup(options);
  if (!options.apply) return { ...plan, applied: false, garbageCollected: { removed: [], releasedBytes: 0 } };
  if (plan.activeRuns.length) throw new Error(`仍有 ${plan.activeRuns.length} 个测试运行中，已拒绝清理。`);
  for (const candidate of plan.candidates) {
    if (!candidate.startsWith(`${plan.root}${sep}`)) throw new Error(`清理目标越界：${candidate}`);
    await rm(candidate, { recursive: true, force: true });
  }
  const garbageCollected = options.all ? { removed: [], releasedBytes: 0 } : await garbageCollectObjects(plan.root);
  await mkdir(plan.root, { recursive: true });
  return { ...plan, applied: true, garbageCollected };
}
