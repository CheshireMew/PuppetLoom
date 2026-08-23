import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeManagedRun } from "./lib/managed-run.mjs";

await executeManagedRun({ category: "launcher-smoke", producer: "scripts/run-launcher-smoke.mjs", evidence: { command: "node scripts/run-launcher-smoke.mjs", scope: "Windows 启动器冒烟检查" }, estimatedBytes: 64 * 1024 ** 2, maximumRelativePathLength: 96, reuse: { applicable: false, reason: "运行日志记录本次进程身份和事件序列，不能冒充另一轮启动证据。" } }, async (artifactRun) => {
const profile = artifactRun.path("profile");
const runtimeLog = resolve(profile, "runtime.log");
await mkdir(profile, { recursive: true });

const launched = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/start-puppetloom.ps1")],
  {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      PUPPETLOOM_ALLOW_MULTIPLE: "1",
      PUPPETLOOM_E2E_EXIT_AFTER_MS: "1500",
      PUPPETLOOM_E2E_USER_DATA: profile
    }
  }
);
if (launched.status !== 0) {
  throw new Error(`Windows 启动脚本失败（exit ${launched.status}）：${launched.stderr || launched.stdout}`);
}

const deadline = Date.now() + 20_000;
let log = "";
while (Date.now() < deadline) {
  try {
    log = await readFile(runtimeLog, "utf8");
    if (log.includes('"event":"app-ready"') && log.includes('"event":"app-will-quit"')) break;
  } catch {
    // The detached desktop process may not have created the log yet.
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
}

if (!log.includes('"event":"app-ready"')) throw new Error(`Windows 启动脚本没有抵达 app-ready：${runtimeLog}`);
if (!log.includes('"event":"app-will-quit"')) throw new Error(`Windows 启动脚本启动的进程没有按测试约定退出：${runtimeLog}`);
process.stdout.write(`${JSON.stringify({ ok: true, profile, runtimeLog }, null, 2)}\n`);
});
