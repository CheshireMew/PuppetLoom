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
  const pointMaximaX = neutral.map(() => 0);
  const pointMaximaY = neutral.map(() => 0);
  const pointRadialDriftMaxima = neutral.map(() => 0);
  for (const state of states) {
    const secondaryState = { ...neutralMotionState, secondary: state.secondary };
    for (const key of secondaryKeys) secondaryState[key] = state[key] ?? 0;
    const current = deformedPoints(project, layer, secondaryState);
    for (let index = 0; index < neutral.length; index += 1) {
      const from = neutral[index];
      const to = current[index];
      if (!from || !to) continue;
      const xPixels = Math.abs((to.x - from.x) * project.canvas.width);
      const yPixels = Math.abs((to.y - from.y) * project.canvas.height);
      const pixels = Math.hypot(xPixels, yPixels);
      pointMaxima[index] = Math.max(pointMaxima[index] ?? 0, pixels);
      pointMaximaX[index] = Math.max(pointMaximaX[index] ?? 0, xPixels);
      pointMaximaY[index] = Math.max(pointMaximaY[index] ?? 0, yPixels);
      if (layer.role === "tail") {
        const neutralRadius = Math.hypot(from.x - layer.pivot.x, from.y - layer.pivot.y);
        const currentRadius = Math.hypot(to.x - layer.pivot.x, to.y - layer.pivot.y);
        pointRadialDriftMaxima[index] = Math.max(
          pointRadialDriftMaxima[index] ?? 0,
          Math.abs(currentRadius - neutralRadius) * Math.max(project.canvas.width, project.canvas.height)
        );
      }
    }
  }
  const sorted = [...pointMaxima].sort((left, right) => left - right);
  const crownIndices = layer.role === "frontHair" && layer.secondaryAnchors?.ahogeRoot && layer.secondaryAnchors?.frontHairRoot
    ? layer.mesh.points
      .map((point, index) => ({ point, index }))
      .filter(({ point }) => point.y >= layer.secondaryAnchors.ahogeRoot.y && point.y <= layer.secondaryAnchors.frontHairRoot.y)
      .map(({ index }) => index)
    : [];
  layers.push({
    id: layer.id,
    role: layer.role,
    mesh: `${layer.mesh.cols}x${layer.mesh.rows}`,
    physicsWeight: layer.weights.physics,
    anchorP20Pixels: Number((sorted[Math.floor((sorted.length - 1) * 0.2)] ?? 0).toFixed(3)),
    maximumPixels: Number((sorted.at(-1) ?? 0).toFixed(3)),
    maximumXPixels: Number(Math.max(...pointMaximaX).toFixed(3)),
    maximumYPixels: Number(Math.max(...pointMaximaY).toFixed(3)),
    ...(layer.role === "tail" ? {
      maximumRadialDriftPixels: Number(Math.max(...pointRadialDriftMaxima).toFixed(3))
    } : {}),
    ...(crownIndices.length > 0 ? {
      protectedCrownMaximumPixels: Number(Math.max(...crownIndices.map((index) => pointMaxima[index] ?? 0)).toFixed(3))
    } : {})
  });
}

const poseSafety = safetyPoses.map((pose) => validatePose(project, pose.id, safetyPoseState(pose.yaw, pose.pitch, pose.roll)));
const report = { ok: poseSafety.every((pose) => pose.passed), durationSeconds, fps, extrema, layers, poseSafety };
const output = resolve(projectDirectory, "reports/secondary-motion-report.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, output }, null, 2)}\n`);
