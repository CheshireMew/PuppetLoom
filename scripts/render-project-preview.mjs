import { dirname, resolve } from "node:path";
import { runMotionEvidence } from "./lib/motion-evidence.mjs";

if (!process.argv[2]) throw new Error("用法：npm run preview -- <project-dir> [seconds] [output.webm]");
const outputPath = resolve(process.argv[4] ?? resolve(process.argv[2], "reports/motion-preview.webm"));
const result = await runMotionEvidence({
  project: process.argv[2],
  outputDirectory: dirname(outputPath),
  outputPath,
  mode: "autonomous",
  durationSeconds: Number(process.argv[3] ?? 20),
  fps: 12
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
