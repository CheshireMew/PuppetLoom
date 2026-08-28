import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { measureProjectPerformance } from "./lib/render-performance.mjs";

function optionsFromArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index];
    if (!key?.startsWith("--")) throw new Error(`未知参数：${key}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少值。`);
    values[key.slice(2)] = value;
    index += 1;
  }
  if (!values.project || !values.output) throw new Error("用法：measure-project-performance --project <dir> --output <new-dir> [--revision n] [--trials n]");
  const revision = values.revision === undefined ? undefined : Number(values.revision);
  const trials = Number(values.trials ?? 3);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw new Error("revision 必须是非负整数。");
  if (!Number.isInteger(trials) || trials < 1 || trials > 5) throw new Error("trials 必须是 1 到 5 的整数。");
  return { project: resolve(values.project), output: resolve(values.output), revision, trials };
}

try {
  const options = optionsFromArguments(process.argv.slice(2));
  if (existsSync(options.output)) throw new Error(`性能证据目录必须尚不存在：${options.output}`);
  await mkdir(options.output, { recursive: true });
  const result = await measureProjectPerformance({
    projectDirectory: options.project,
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    trials: options.trials
  });
  const report = join(options.output, "performance.json");
  const documented = { ...result, report };
  await writeFile(report, `${JSON.stringify(documented, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(documented, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
