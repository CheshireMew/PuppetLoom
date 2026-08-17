import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const DEFAULT_MAXIMUM_MANAGED_BYTES = 2 * 1024 ** 3;
export const DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 ** 3;

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
    for (const entry of await readdir(directory, { withFileTypes: true })) {
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
  for (const path of await filesUnder(root)) total += (await stat(path)).size;
  return total;
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

async function inventoryUnder(directory, manifestPath) {
  const inventory = [];
  for (const path of await filesUnder(directory)) {
    if (resolve(path) === resolve(manifestPath)) continue;
    const bytes = await readFile(path);
    const ownedPath = relative(directory, path);
    inventory.push({ path: ownedPath, class: artifactClass(ownedPath), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return inventory;
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
  root = resolve("test/artifacts"),
  estimatedBytes,
  reuse,
  maximumManagedBytes = process.env.PUPPETLOOM_ARTIFACT_MAX_BYTES,
  minimumFreeBytes = process.env.PUPPETLOOM_ARTIFACT_MIN_FREE_BYTES
}) {
  if (!category || !producer) throw new Error("托管产物运行必须声明 category 和 producer。" );
  if (!reuse || typeof reuse.applicable !== "boolean" || typeof reuse.reason !== "string" || !reuse.reason.trim()) {
    throw new Error("托管产物运行必须声明可复用性判断和依据。" );
  }
  const estimate = positiveInteger(estimatedBytes, undefined, "estimatedBytes");
  const maximum = positiveInteger(maximumManagedBytes, DEFAULT_MAXIMUM_MANAGED_BYTES, "maximumManagedBytes");
  const minimumFree = positiveInteger(minimumFreeBytes, DEFAULT_MINIMUM_FREE_BYTES, "minimumFreeBytes");
  const managedRoot = resolve(root);
  const runsRoot = join(managedRoot, "runs");
  const initialFilesystem = await statfs(await nearestExistingDirectory(managedRoot));
  const initialFreeBytes = Number(initialFilesystem.bavail) * Number(initialFilesystem.bsize);
  if (estimate > maximum) throw new Error(`产物预算不足：预计 ${estimate} > 上限 ${maximum} 字节；尚未写入运行目录。`);
  if (initialFreeBytes - estimate < minimumFree) throw new Error(`磁盘余量不足：预计写入后低于 ${minimumFree} 字节；尚未写入运行目录。`);

  const lock = await acquirePreflightLock(runsRoot, producer);
  let lockReleased = false;
  try {
    await recoverInterruptedRuns(runsRoot);
    const currentBytes = await bytesUnder(managedRoot);
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
    if (directory.length > 120) throw new Error(`托管运行根目录过长，无法为 Windows 产物保留安全路径余量：${directory}`);
    const manifestPath = join(directory, "run.json");
    const createdAt = new Date().toISOString();
    await mkdir(directory, { recursive: true });
    const pending = {
      version: 1, id, category, producer, status: "pending", createdAt, updatedAt: createdAt, processId: process.pid,
      root: relative(resolve("."), directory),
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
      manifestPath,
      path: (...parts) => join(directory, ...parts),
      async finish(status = "succeeded", error) {
        if (finished) return;
        if (!["succeeded", "failed"].includes(status)) throw new Error(`不支持的托管运行终态：${status}`);
        finished = true;
        const inventory = await inventoryUnder(directory, manifestPath);
        const completedAt = new Date().toISOString();
        await atomicJson(manifestPath, {
          ...pending, status, updatedAt: completedAt, completedAt,
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
          inventory,
          categoryBytes: categoryBytes(inventory),
          totalBytes: inventory.reduce((sum, item) => sum + item.bytes, 0),
          peakBytes: { kind: "preflight-upper-bound", bytes: estimate },
          cleanupCandidates: status === "failed" ? cleanupCandidates(inventory) : []
        });
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
    if (entry.name === "runs") continue;
    const path = join(managedRoot, entry.name);
    unmanagedCandidates.push({ path, bytes: entry.isDirectory() ? await bytesUnder(path) : (await stat(path)).size, lastModified: (await stat(path)).mtime.toISOString() });
  }
  const manifests = [];
  for (const path of await ownedRunManifests(join(managedRoot, "runs"))) {
    try { manifests.push({ path, manifest: JSON.parse(await readFile(path, "utf8")) }); }
    catch { manifests.push({ path, manifest: { status: "invalid" } }); }
  }
  return { root: managedRoot, policy: "report-only", unmanagedCandidates, runs: manifests };
}
