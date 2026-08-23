import { startManagedRun } from "./managed-run.mjs";

export default async function setup() {
  const run = await startManagedRun({
    category: "vitest",
    producer: "vitest",
    evidence: { command: "npm test", scope: "vitest.config.ts 中声明的全部单元与契约测试" },
    root: process.env.PUPPETLOOM_ARTIFACT_ROOT,
    estimatedBytes: 768 * 1024 ** 2,
    maximumRelativePathLength: 152,
    reuse: { applicable: false, reason: "每次测试运行都是独立证据；固定输入直接复用仓库中唯一的 test/fixtures 真源。" }
  });
  process.env.PUPPETLOOM_ARTIFACT_RUN_ROOT = run.directory;
  return async () => run.finish(process.exitCode && process.exitCode !== 0 ? "failed" : "succeeded");
}
