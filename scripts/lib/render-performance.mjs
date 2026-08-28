import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { loadCalibration, loadProjectRevision } from "@puppetloom/core";

export const PERFORMANCE_THRESHOLDS = Object.freeze({
  medianFps: 59,
  p95FrameMs: 20,
  p99FrameMs: 26,
  activeLongFrameAllowance: 1
});

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function aggregate(trials) {
  const intervals = trials.flatMap((trial) => trial.intervals).sort((left, right) => left - right);
  return {
    trials: trials.map(({ intervals: _intervals, ...trial }) => trial),
    frameCount: intervals.length,
    medianFps: median(trials.map((trial) => trial.fps)),
    p95FrameMs: percentile(intervals, 0.95),
    p99FrameMs: percentile(intervals, 0.99),
    worstFrameMs: intervals.at(-1) ?? 0,
    longFramesOver40Ms: intervals.filter((value) => value > 40).length
  };
}

async function measureTrial(viewer, warmupFrames, measuredFrames) {
  return viewer.evaluate(async ({ warmupFrames: warmup, measuredFrames: measured }) => {
    const intervals = [];
    let previous = performance.now();
    for (let frame = 0; frame < warmup + measured; frame += 1) {
      const now = await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      if (frame >= warmup) intervals.push(now - previous);
      previous = now;
    }
    const sorted = [...intervals].sort((left, right) => left - right);
    const averageInterval = intervals.reduce((sum, value) => sum + value, 0) / Math.max(1, intervals.length);
    const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
    return {
      fps: 1000 / averageInterval,
      p95FrameMs: at(0.95),
      p99FrameMs: at(0.99),
      worstFrameMs: sorted.at(-1) ?? 0,
      longFramesOver40Ms: intervals.filter((value) => value > 40).length,
      intervals
    };
  }, { warmupFrames, measuredFrames });
}

async function measureRenderCpu(viewer, frames = 90) {
  return viewer.evaluate((count) => {
    const durations = [];
    for (let index = 0; index < count; index += 1) {
      const started = performance.now();
      window.puppetloomRenderTestPose?.({ headYaw: index % 2 === 0 ? -0.55 : 0.55, headPitch: 0.2 });
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    const at = (ratio) => durations[Math.min(durations.length - 1, Math.floor(durations.length * ratio))] ?? 0;
    return {
      frameCount: durations.length,
      averageMs: durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length),
      p95Ms: at(0.95),
      p99Ms: at(0.99),
      worstMs: durations.at(-1) ?? 0
    };
  }, frames);
}

export async function measureProjectPerformance({
  projectDirectory,
  revision,
  trials = 3,
  stabilizationFrames = 180,
  warmupFrames = 60,
  measuredFrames = 240
}) {
  const project = resolve(projectDirectory);
  const calibration = await loadCalibration(project);
  const effectiveRevision = revision ?? calibration.revision;
  const projectSnapshot = await loadProjectRevision(project, effectiveRevision);
  const profile = join("D:\\Tools", "PuppetLoom", "performance", `${Date.now()}-${randomUUID()}`);
  await mkdir(profile, { recursive: true });
  const electronApp = await electron.launch({
    args: [resolve("apps/desktop/dist/electron/main.js"), "--project", project, "--revision", String(effectiveRevision)],
    cwd: resolve("."),
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      PUPPETLOOM_ALLOW_MULTIPLE: "1",
      PUPPETLOOM_E2E_USER_DATA: profile
    }
  });

  try {
    const viewer = await electronApp.firstWindow();
    await viewer.getByTestId("viewer").waitFor();
    await viewer.waitForFunction(() => document.querySelector("canvas")?.getContext("webgl2") !== null && typeof window.puppetloomRenderCurrentFrame === "function");
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.show();
      window?.setAlwaysOnTop(true, "floating");
      window?.moveTop();
      window?.focus();
    });
    await viewer.waitForTimeout(1000);
    const source = await viewer.evaluate(() => window.puppetloom.viewerProject());
    const webgl = await viewer.evaluate(() => {
      const context = document.querySelector("canvas")?.getContext("webgl2");
      if (!context) return { webgl2: false };
      const extension = context.getExtension("WEBGL_debug_renderer_info");
      return {
        webgl2: true,
        vendor: extension ? context.getParameter(extension.UNMASKED_VENDOR_WEBGL) : context.getParameter(context.VENDOR),
        renderer: extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER)
      };
    });

    const motionFrameHashes = [];
    for (let index = 0; index < 3; index += 1) {
      await viewer.waitForTimeout(350);
      const screenshot = await viewer.locator("canvas").screenshot();
      motionFrameHashes.push(createHash("sha256").update(screenshot).digest("hex"));
    }
    const motionActivity = { sampledFrames: motionFrameHashes.length, distinctFrames: new Set(motionFrameHashes).size };

    // Canvas screenshots synchronously read the GPU surface and a fresh renderer
    // still has shaders and JIT paths to settle. Record that period separately so
    // cold-start/readback stalls remain visible without being mislabeled as a
    // recurring animation-frame failure.
    const stabilizationTrial = await measureTrial(viewer, 0, stabilizationFrames);
    const { intervals: _stabilizationIntervals, ...stabilization } = stabilizationTrial;
    const activeTrials = [];
    for (let index = 0; index < trials; index += 1) activeTrials.push(await measureTrial(viewer, warmupFrames, measuredFrames));
    await viewer.evaluate(() => window.puppetloom.viewerAction("pause"));
    await viewer.waitForTimeout(250);
    const pausedTrials = [];
    for (let index = 0; index < trials; index += 1) pausedTrials.push(await measureTrial(viewer, warmupFrames, measuredFrames));
    const renderCpu = await measureRenderCpu(viewer);
    const active = aggregate(activeTrials);
    const paused = aggregate(pausedTrials);
    const checks = {
      webgl2: webgl.webgl2 === true,
      motionVisible: motionActivity.distinctFrames > 1,
      medianFps: active.medianFps >= PERFORMANCE_THRESHOLDS.medianFps,
      activeP95: active.trials.every((trial) => trial.p95FrameMs <= PERFORMANCE_THRESHOLDS.p95FrameMs),
      activeP99: active.trials.every((trial) => trial.p99FrameMs <= PERFORMANCE_THRESHOLDS.p99FrameMs),
      activeLongFrames: active.longFramesOver40Ms <= paused.longFramesOver40Ms + PERFORMANCE_THRESHOLDS.activeLongFrameAllowance
    };
    const frameDropSource = !checks.webgl2
      ? "webgl-unavailable"
      : !checks.activeLongFrames && paused.longFramesOver40Ms === 0
        ? "active-rendering"
        : paused.p95FrameMs > PERFORMANCE_THRESHOLDS.p95FrameMs || paused.p99FrameMs > PERFORMANCE_THRESHOLDS.p99FrameMs
          ? "window-or-system-scheduling"
          : Object.values(checks).every(Boolean)
            ? "none-detected"
            : "active-rendering";
    return {
      ok: true,
      valid: Object.values(checks).every(Boolean),
      measuredAt: new Date().toISOString(),
      project,
      revision: effectiveRevision,
      sourceLabel: source.sourceLabel,
      thresholds: PERFORMANCE_THRESHOLDS,
      checks,
      diagnosis: { frameDropSource, animationOutput: checks.motionVisible ? "changing" : "static" },
      projectComplexity: {
        canvas: `${projectSnapshot.canvas.width}x${projectSnapshot.canvas.height}`,
        layers: projectSnapshot.layers.length,
        meshPoints: projectSnapshot.layers.reduce((sum, layer) => sum + (layer.mesh?.points.length ?? 0), 0),
        triangles: projectSnapshot.layers.reduce((sum, layer) => sum + (layer.mesh?.triangles.length ?? 0) / 3, 0),
        modelBindings: projectSnapshot.model?.bindings.length ?? 0,
        physicsGroups: projectSnapshot.model?.physics?.length ?? 0
      },
      webgl,
      motionActivity,
      stabilization,
      active,
      paused,
      renderCpu
    };
  } finally {
    await electronApp.close();
  }
}
