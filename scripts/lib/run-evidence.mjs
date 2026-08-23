import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let sourceIdentityPromise;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parsePorcelainStatus(output) {
  const records = output.split("\0");
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = /[RC]/.test(status);
    changes.push({ status, path, ...(renamed ? { previousPath: records[index += 1] } : {}) });
  }
  return changes.sort((first, second) => first.path.localeCompare(second.path));
}

async function git(cwd, args, options = {}) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    ...options
  });
}

async function gitObjectHash(repositoryRoot, path) {
  if (!(await exists(resolve(repositoryRoot, path)))) return null;
  const { stdout } = await git(repositoryRoot, ["hash-object", "--no-filters", "--", path]);
  return stdout.trim();
}

async function captureGitSourceIdentity(cwd) {
  const { stdout: rootOutput } = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = resolve(rootOutput.trim());
  const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  ]);
  const changes = parsePorcelainStatus(statusOutput);
  const contentState = [];
  for (const change of changes) {
    contentState.push({
      ...change,
      objectHash: await gitObjectHash(repositoryRoot, change.path)
    });
  }
  const canonicalState = JSON.stringify(contentState);
  return {
    kind: "git-worktree",
    repositoryRoot: ".",
    commit: commitOutput.trim(),
    dirty: changes.length > 0,
    changedPathCount: changes.length,
    worktreeFingerprint: createHash("sha256").update(canonicalState).digest("hex"),
    workingDirectory: relative(repositoryRoot, cwd) || "."
  };
}

async function captureSourceIdentity(cwd) {
  try {
    return await captureGitSourceIdentity(cwd);
  } catch (error) {
    return {
      kind: "unversioned-directory",
      repositoryRoot: ".",
      commit: null,
      dirty: null,
      changedPathCount: null,
      worktreeFingerprint: null,
      workingDirectory: ".",
      note: `无法读取 Git 源码身份：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
  return value.trim();
}

export async function createRunEvidence({ command, scope, cwd = resolve(".") }) {
  const normalizedCwd = resolve(cwd);
  sourceIdentityPromise ??= captureSourceIdentity(normalizedCwd);
  return {
    schema: "puppetloom-run-evidence/v1",
    source: await sourceIdentityPromise,
    invocation: { command: requiredText(command, "evidence.command") },
    scope: requiredText(scope, "evidence.scope"),
    environment: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version
    }
  };
}
