import { runMotionEvidence } from "./lib/motion-evidence.mjs";

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
  if (!values.project || !values.output) throw new Error("用法：record-motion-evidence --project <dir> --output <dir> [--mode autonomous|secondary] [--revision n] [--duration n] [--fps n] [--ffmpeg path]");
  return {
    project: values.project,
    outputDirectory: values.output,
    mode: values.mode ?? "autonomous",
    durationSeconds: Number(values.duration ?? 12),
    fps: Number(values.fps ?? 12),
    ...(values.revision !== undefined ? { revision: Number(values.revision) } : {}),
    ...(values.ffmpeg ? { ffmpeg: values.ffmpeg } : {})
  };
}

try {
  const result = await runMotionEvidence(optionsFromArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
