import { resolve } from "node:path";
import { cleanupManagedArtifacts } from "./lib/managed-run.mjs";

const args = process.argv.slice(2);
const valueFlags = new Set(["--root", "--keep-succeeded", "--keep-failed"]);
const switchFlags = new Set(["--all", "--apply", "--keep-legacy"]);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (switchFlags.has(argument)) continue;
  if (valueFlags.has(argument) && args[index + 1] && !args[index + 1].startsWith("--")) {
    index += 1;
    continue;
  }
  throw new Error(`不支持或缺少值的参数：${argument}`);
}
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const integerAfter = (name, fallback) => {
  const value = valueAfter(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} 必须是非负整数。`);
  return parsed;
};

const root = resolve(valueAfter("--root") ?? "test/artifacts");
const result = await cleanupManagedArtifacts({
  root,
  all: args.includes("--all"),
  apply: args.includes("--apply"),
  includeLegacy: !args.includes("--keep-legacy"),
  keepSucceeded: integerAfter("--keep-succeeded", 2),
  keepFailed: integerAfter("--keep-failed", 1)
});

console.log(JSON.stringify({
  root: result.root,
  mode: result.mode,
  applied: result.applied,
  activeRuns: result.activeRuns,
  candidateCount: result.candidates.length,
  candidatePhysicalBytes: result.candidatePhysicalBytes,
  garbageCollectedObjects: result.garbageCollected.removed.length,
  garbageCollectedBytes: result.garbageCollected.releasedBytes,
  ...(!result.applied ? {
    candidates: result.candidates.slice(0, 50),
    omittedCandidates: Math.max(0, result.candidates.length - 50)
  } : {})
}, null, 2));
