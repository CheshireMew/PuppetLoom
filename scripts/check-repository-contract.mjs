import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const failures = [];

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

function requireContract(condition, message) {
  if (!condition) failures.push(message);
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
requireContract(packageJson.packageManager === "npm@11.12.1", "package.json 必须把 npm@11.12.1 声明为唯一包管理器真源。");
requireContract(packageLock.packages?.[""]?.packageManager === packageJson.packageManager, "package-lock.json 根包必须与 packageManager 声明一致。");
requireContract(JSON.stringify(packageLock.packages?.[""]?.workspaces) === JSON.stringify(packageJson.workspaces), "package-lock.json 必须覆盖全部 npm workspaces。" );
requireContract(!(await exists("pnpm-lock.yaml")) && !(await exists("pnpm-workspace.yaml")), "仓库根目录不能同时保留 pnpm 真源；旧文件只允许放在 archive/package-manager。" );

const git = await execFileAsync("git", ["ls-files", "-z", "--", "runtime"], { encoding: "utf8", windowsHide: true });
const visibleTrackedRuntime = [];
for (const path of git.stdout.split("\0").filter(Boolean)) if (await exists(path)) visibleTrackedRuntime.push(path);
requireContract(visibleTrackedRuntime.length === 0, "runtime/ 是本机状态目录，不能有仍存在的 Git 跟踪文件。" );
const ignore = await readFile(".gitignore", "utf8");
requireContract(ignore.split(/\r?\n/).includes("/runtime/"), ".gitignore 必须忽略整个 /runtime/。" );

const starHistory = await readFile(".github/workflows/star-history.yml", "utf8");
requireContract(/uses:\s+CheshireMew\/project-steward\/\.github\/workflows\/star-history\.yml@[a-f0-9]{40}\s/.test(`${starHistory}\n`), "有 contents:write 权限的 Star History 工作流必须固定到 40 位提交。" );
requireContract(!/star-history\.yml@(main|master|HEAD|v\d+)/.test(starHistory), "Star History 工作流不能跟随可变分支或标签。" );

const storage = JSON.parse(await readFile(".project-steward/storage-contract.json", "utf8"));
const producerIds = new Set(storage.producers?.map((producer) => producer.id));
for (const id of ["test-evidence-runs", "psd-repair-operations", "desktop-runtime-logs"]) {
  requireContract(producerIds.has(id), `生产存储合同缺少 ${id}。`);
}

const managedRun = await readFile("scripts/lib/managed-run.mjs", "utf8");
for (const token of ["createRunEvidence", "maximumRelativePathLength", "version: 2", "policy: \"report-only\""]) {
  requireContract(managedRun.includes(token), `托管运行器缺少合同标记：${token}`);
}

if (failures.length) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Repository governance contract passed.\n");
}
