import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { safetyPoses, safetyPoseState, validatePose } from "@puppetloom/core";
import { deformedPoints, neutralMotionState } from "@puppetloom/core/browser";
import { CalmMotionController } from "@puppetloom/renderer";

const projectDirectory = resolve(process.argv[2] ?? "");
const durationSeconds = Math.max(2, Math.min(120, Number(process.argv[3] ?? 26)));
if (!process.argv[2]) throw new Error("用法：node scripts/report-secondary-motion.mjs <project-dir> [seconds]");

const project = JSON.parse(await readFile(resolve(projectDirectory, "puppetloom.json"), "utf8"));
const controller = new CalmMotionController(project);
const fps = 60;
const secondaryKeys = [
  "hairX", "hairY", "ahogeX", "ahogeY", "backHairX", "backHairY", "headwearX", "headwearY", "earX", "earY",
  "clothX", "clothY", "tailX", "tailY", "accessoryX", "accessoryY"
];
const states = Array.from({ length: Math.round(durationSeconds * fps) }, (_, index) => controller.sample(index / fps));
const extrema = Object.fromEntries(secondaryKeys.map((key) => [key, Number(Math.max(...states.map((state) => Math.abs(state[key] ?? 0))).toFixed(6))]));
const inspectedRoles = new Set(["frontHair", "backHair", "headwear", "ear", "topWear", "bottomWear", "tail", "accessory"]);
const layers = [];

for (const layer of project.layers.filter((candidate) => inspectedRoles.has(candidate.role) && candidate.weights.physics > 0)) {
  const neutral = deformedPoints(project, layer, neutralMotionState);
  const pointMaxima = neutral.map(() => 0);
  for (const state of states) {
    const secondaryState = { ...neutralMotionState };
    for (const key of secondaryKeys) secondaryState[key] = state[key] ?? 0;
    const current = deformedPoints(project, layer, secondaryState);
    for (let index = 0; index < neutral.length; index += 1) {
      const from = neutral[index];
      const to = current[index];
      if (!from || !to) continue;
      const pixels = Math.hypot((to.x - from.x) * project.canvas.width, (to.y - from.y) * project.canvas.height);
      pointMaxima[index] = Math.max(pointMaxima[index] ?? 0, pixels);
    }
  }
  const sorted = [...pointMaxima].sort((left, right) => left - right);
  layers.push({
    id: layer.id,
    role: layer.role,
    mesh: `${layer.mesh.cols}x${layer.mesh.rows}`,
    physicsWeight: layer.weights.physics,
    anchorP20Pixels: Number((sorted[Math.floor((sorted.length - 1) * 0.2)] ?? 0).toFixed(3)),
    maximumPixels: Number((sorted.at(-1) ?? 0).toFixed(3))
  });
}

const poseSafety = safetyPoses.map((pose) => validatePose(project, pose.id, safetyPoseState(pose.yaw, pose.pitch, pose.roll)));
const report = { ok: poseSafety.every((pose) => pose.passed), durationSeconds, fps, extrema, layers, poseSafety };
const output = resolve(projectDirectory, "reports/secondary-motion-report.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, output }, null, 2)}\n`);
