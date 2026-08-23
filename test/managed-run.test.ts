import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupManagedArtifacts, executeManagedRun, startManagedRun } from "../scripts/lib/managed-run.mjs";
import { artifactPath } from "./support/artifacts.js";

describe("managed runtime artifacts", () => {
  const reuse = { applicable: false, reason: "测试样本用于验证每次运行的独立所有权。" };
  const evidence = { command: "npm test", scope: "test/managed-run.test.ts" };
  const managedOptions = { evidence, maximumRelativePathLength: 96 };

  it("writes a pending manifest before payloads and finalizes a complete owned inventory", async () => {
    const root = artifactPath("managed-run-contract");
    const run = await startManagedRun({ category: "contract", producer: "managed-run.test", root, estimatedBytes: 1024 ** 2, maximumManagedBytes: 32 * 1024 ** 2, minimumFreeBytes: 1, reuse, ...managedOptions });
    expect(JSON.parse(await readFile(run.manifestPath, "utf8"))).toMatchObject({
      version: 2,
      status: "pending",
      producer: "managed-run.test",
      evidence: {
        schema: "puppetloom-run-evidence/v1",
        source: { kind: "git-worktree", commit: expect.stringMatching(/^[a-f0-9]{40}$/), worktreeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
        invocation: { command: "npm test" },
        scope: "test/managed-run.test.ts",
        environment: { platform: "win32", node: expect.stringMatching(/^v\d+/) }
      },
      pathBudget: { maximumPathLength: 240, maximumRelativePathLength: 96 }
    });
    await writeFile(run.path("payload.bin"), Buffer.alloc(1024, 7));
    await run.finish("succeeded");
    const manifest = JSON.parse(await readFile(run.manifestPath, "utf8")) as { status: string; totalBytes: number; categoryBytes: Record<string, number>; inventory: Array<{ path: string; class: string; sha256: string }> };
    expect(manifest.status).toBe("succeeded");
    expect(manifest.totalBytes).toBeGreaterThan(1024);
    expect(manifest.categoryBytes.evidence).toBe(1024);
    expect(manifest.inventory).toEqual(expect.arrayContaining([{ path: "payload.bin", class: "evidence", bytes: 1024, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]));
  });

  it("blocks an insufficient deterministic budget before creating a run directory", async () => {
    const root = artifactPath("managed-run-insufficient-budget");
    await expect(startManagedRun({ category: "blocked", producer: "managed-run.test", root, estimatedBytes: 1024, maximumManagedBytes: 512, minimumFreeBytes: 1, reuse, ...managedOptions })).rejects.toThrow(/尚未写入运行目录/);
    await expect(access(root)).rejects.toThrow();
  });

  it("uses the declared complete path budget instead of rejecting a valid long run root", async () => {
    const root = artifactPath(`managed-run-long-root-${"x".repeat(32)}`);
    const run = await startManagedRun({ category: "path-budget", producer: "managed-run.test", root, estimatedBytes: 1024, maximumManagedBytes: 32 * 1024 ** 2, minimumFreeBytes: 1, reuse, evidence, maximumRelativePathLength: 72 });
    expect(run.directory.length).toBeGreaterThan(120);
    await writeFile(run.path("payload.bin"), Buffer.from("valid"));
    await run.finish("succeeded");
  });

  it("rejects an unsafe complete path budget before creating the managed root", async () => {
    const root = artifactPath("managed-run-unsafe-path-budget");
    await expect(startManagedRun({ category: "path-budget", producer: "managed-run.test", root, estimatedBytes: 1024, maximumManagedBytes: 32 * 1024 ** 2, minimumFreeBytes: 1, reuse, evidence, maximumRelativePathLength: 96, maximumPathLength: 120 })).rejects.toThrow(/路径预算不足.*尚未写入运行目录/);
    await expect(access(root)).rejects.toThrow();
  });

  it("serializes concurrent preflights and reserves active peak budgets", async () => {
    const root = artifactPath("managed-run-concurrent-budget");
    const options = { category: "concurrent", producer: "managed-run.test", root, estimatedBytes: 8 * 1024 ** 2, maximumManagedBytes: 12 * 1024 ** 2, minimumFreeBytes: 1, reuse, ...managedOptions };
    const results = await Promise.allSettled([startManagedRun(options), startManagedRun(options)]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startManagedRun>>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toContain("活动预留");
    await fulfilled[0]!.value.finish("succeeded");
  });

  it("marks abandoned manifests interrupted without deleting their payloads", async () => {
    const root = artifactPath("managed-run-recovery");
    const abandoned = join(root, "runs", "fixture", "abandoned");
    await mkdir(abandoned, { recursive: true });
    await writeFile(join(abandoned, "run.json"), JSON.stringify({ version: 1, id: "abandoned", category: "fixture", producer: "test", status: "pending", processId: 2_147_483_000 }));
    await writeFile(join(abandoned, "payload.bin"), Buffer.from("preserve"));
    const run = await startManagedRun({ category: "recovery", producer: "managed-run.test", root, estimatedBytes: 1024, maximumManagedBytes: 32 * 1024 **2, minimumFreeBytes: 1, reuse, ...managedOptions });
    expect(JSON.parse(await readFile(join(abandoned, "run.json"), "utf8"))).toMatchObject({ status: "interrupted", totalBytes: 8, cleanupCandidates: ["payload.bin"] });
    expect(await readFile(join(abandoned, "payload.bin"), "utf8")).toBe("preserve");
    await run.finish("succeeded");
  });

  it("records a failed public operation with owned cleanup candidates", async () => {
    const root = artifactPath("managed-run-failure");
    let manifestPath = "";
    await expect(executeManagedRun({ category: "failure", producer: "managed-run.test", root, estimatedBytes: 1024, maximumManagedBytes: 32 * 1024 ** 2, minimumFreeBytes: 1, reuse, ...managedOptions }, async (run) => {
      manifestPath = run.manifestPath;
      await writeFile(run.path("partial.bin"), Buffer.alloc(16, 3));
      throw new Error("controlled failure");
    })).rejects.toThrow("controlled failure");
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      status: "failed",
      error: "controlled failure",
      cleanupCandidates: ["partial.bin"]
    });
  });

  it("keeps independent runs while identical evidence shares one NTFS file", async () => {
    const root = artifactPath("managed-run-content-reuse");
    const options = { category: "reuse", producer: "managed-run.test", root, estimatedBytes: 1024 ** 2, maximumManagedBytes: 32 * 1024 ** 2, minimumFreeBytes: 1, reuse, ...managedOptions };
    const first = await startManagedRun(options);
    await writeFile(first.path("same.bin"), Buffer.alloc(64 * 1024, 9));
    await first.finish("succeeded");
    const second = await startManagedRun(options);
    await writeFile(second.path("same.bin"), Buffer.alloc(64 * 1024, 9));
    await second.finish("succeeded");

    const [firstStat, secondStat] = await Promise.all([
      stat(first.path("same.bin"), { bigint: true }),
      stat(second.path("same.bin"), { bigint: true })
    ]);
    expect(firstStat.dev).toBe(secondStat.dev);
    expect(firstStat.ino).toBe(secondStat.ino);
    const manifest = JSON.parse(await readFile(second.manifestPath, "utf8")) as { storageReuse: { mode: string; objectsReused: number; reusedLogicalBytes: number }; reusedObjects: Array<{ path: string }> };
    expect(manifest.storageReuse).toMatchObject({ mode: "sha256-hardlink-v1", objectsReused: 1, reusedLogicalBytes: 64 * 1024 });
    expect(manifest.reusedObjects).toEqual([{ path: "same.bin", bytes: 64 * 1024, sha256: expect.any(String), object: expect.any(String) }]);
  });

  it("previews retention cleanup, applies only the older run, and preserves reusable objects", async () => {
    const root = artifactPath("managed-run-cleanup");
    const options = { category: "cleanup", producer: "managed-run.test", root, estimatedBytes: 1024 ** 2, maximumManagedBytes: 32 * 1024 ** 2, minimumFreeBytes: 1, reuse, ...managedOptions };
    const first = await startManagedRun(options);
    await writeFile(first.path("same.bin"), Buffer.alloc(4096, 4));
    await first.finish("succeeded");
    const second = await startManagedRun(options);
    await writeFile(second.path("same.bin"), Buffer.alloc(4096, 4));
    await second.finish("succeeded");

    const preview = await cleanupManagedArtifacts({ root, apply: false, includeLegacy: false, keepSucceeded: 1, keepFailed: 1 });
    expect(preview.applied).toBe(false);
    expect(preview.candidates).toEqual([first.directory]);
    expect(await readFile(first.path("same.bin"))).toHaveLength(4096);

    const applied = await cleanupManagedArtifacts({ root, apply: true, includeLegacy: false, keepSucceeded: 1, keepFailed: 1 });
    expect(applied.applied).toBe(true);
    await expect(access(first.directory)).rejects.toThrow();
    expect(await readFile(second.path("same.bin"))).toHaveLength(4096);
  });
});
