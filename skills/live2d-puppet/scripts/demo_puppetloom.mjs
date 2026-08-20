import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const execFileAsync = promisify(execFile);

function parseArguments(argv) {
  const options = { paceMs: 320, keepOpen: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep-open") options.keepOpen = true;
    else if (argument === "--root") options.root = argv[++index];
    else if (argument === "--project") options.project = argv[++index];
    else if (argument === "--revision") options.revision = Number(argv[++index]);
    else if (argument === "--pace") options.paceMs = Number(argv[++index]);
    else throw new Error(`未知参数：${argument}`);
  }
  if (!options.root || !options.project) throw new Error("必须提供 --root 和 --project。" );
  if (!Number.isInteger(options.paceMs) || options.paceMs < 120 || options.paceMs > 2000) throw new Error("--pace 必须是 120 到 2000 之间的整数毫秒。" );
  if (options.revision !== undefined && (!Number.isInteger(options.revision) || options.revision < 0)) throw new Error("--revision 必须是非负整数。" );
  return options;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function samePath(left, right) {
  const canonical = (value) => normalize(resolve(value)).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
  return canonical(left) === canonical(right);
}

function parseJson(output, label) {
  try { return JSON.parse(output); }
  catch { throw new Error(`${label} 没有返回有效 JSON：${output.slice(0, 500)}`); }
}

const options = parseArguments(process.argv.slice(2));
const root = resolve(options.root);
const project = resolve(options.project);
const wrapper = join(root, "skills", "live2d-puppet", "scripts", "invoke_puppetloom.ps1");
const desktopMain = join(root, "apps", "desktop", "dist", "electron", "main.js");
const runProfile = join("D:\\Tools", "PuppetLoom", "agent-demo", `${Date.now()}-${process.pid}`);
const runtimeManifest = join(runProfile, "runtime-control.json");
const runtimeEnvironment = { PUPPETLOOM_ROOT: root, PUPPETLOOM_CONTROL_MANIFEST: runtimeManifest };
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function runCli(arguments_, environment = {}) {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...arguments_
  ], {
    cwd: root,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

async function cliJson(arguments_, environment = {}) {
  return parseJson(await runCli([...arguments_, "--json"], environment), arguments_.join(" "));
}

async function waitForRuntimeViewer() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const inspection = await cliJson(["runtime", "inspect"], runtimeEnvironment);
      const viewer = inspection.viewers?.find((candidate) => samePath(candidate.projectDirectory, project));
      if (viewer) return { inspection, viewer };
    } catch (cause) { lastError = cause; }
    await delay(250);
  }
  throw new Error(`角色窗口启动后仍未出现在 runtime inspect 中${lastError ? `：${lastError.message}` : "。"}`);
}

async function setRange(locator, value) {
  await locator.evaluate((element, nextValue) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(element, String(nextValue));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

const historyBefore = await cliJson(["history", "--project", project]);
const revision = options.revision ?? historyBefore.currentRevision;
if (revision !== historyBefore.currentRevision) {
  throw new Error(`编辑器演示必须使用规范项目当前 revision；当前为 ${historyBefore.currentRevision}，请求为 ${revision}。`);
}

await mkdir(runProfile, { recursive: true });
let electronApp;
let viewerId;
const sourceId = `agent-demo-${process.pid}`;

try {
  electronApp = await electron.launch({
    args: [desktopMain, "--edit", "--project", project],
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      PUPPETLOOM_ALLOW_MULTIPLE: "1",
      PUPPETLOOM_E2E_USER_DATA: runProfile
    }
  });

  const editor = await electronApp.firstWindow();
  editor.on("pageerror", (cause) => process.stderr.write(`[editor pageerror] ${cause.message}\n`));
  await editor.getByTestId("editor").waitFor({ timeout: 30_000 });
  await editor.waitForFunction(() => {
    const canvas = document.querySelector(".editor-canvas");
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
  }, undefined, { timeout: 30_000 });

  const baseline = await editor.evaluate((directory) => window.puppetloom.readEditorWorkspace(directory), project);
  if (baseline.calibration.revision !== revision) throw new Error(`编辑器实际打开 revision ${baseline.calibration.revision}，预期 ${revision}。`);
  const baselineDraft = JSON.stringify(baseline.draft ?? null);
  emit({ demo: "editor-ready", project, revision, paceMs: options.paceMs });

  const navigation = editor.getByRole("navigation", { name: "编辑工作区" });
  const openWorkspace = async (name, pattern) => {
    await navigation.getByRole("button", { name: pattern }).click();
    await editor.waitForTimeout(options.paceMs);
    emit({ demo: "editor-workspace", name });
  };

  await openWorkspace("01 项目总览", /01 项目总览/);
  await openWorkspace("02 结构与网格", /02 结构与网格/);
  const meshButton = editor.getByRole("button", { name: "网格与权重", exact: true });
  await meshButton.click();
  await editor.waitForTimeout(options.paceMs);
  const autonomousPreview = editor.getByRole("button", { name: "自主预览", exact: true });
  if (await autonomousPreview.count()) {
    await autonomousPreview.click();
    await editor.waitForTimeout(options.paceMs * 2);
    await editor.getByRole("button", { name: "暂停动作", exact: true }).click();
  }
  await meshButton.click();

  await openWorkspace("03 参数与姿态", /03 参数与姿态/);
  for (const pose of ["头部姿态 -0.88, 0", "头部姿态 0.88, 0", "头部姿态 0, -0.82", "头部姿态 0, 0.82", "头部姿态 0, 0"]) {
    await editor.getByRole("button", { name: pose, exact: true }).click();
    await editor.waitForTimeout(Math.max(120, Math.round(options.paceMs * 0.75)));
  }

  await openWorkspace("04 表情与物理", /04 表情与物理/);
  const expressionRange = editor.locator(".dynamics-inspector section").first().locator('input[type="range"]').first();
  if (await expressionRange.count()) {
    await setRange(expressionRange, 0.8);
    await editor.waitForTimeout(options.paceMs);
    await setRange(expressionRange, 0);
  }
  const behaviorButtons = editor.locator(".system-catalog section").last().locator("button");
  if (await behaviorButtons.count()) {
    await behaviorButtons.first().click();
    const playBehavior = editor.locator(".dynamics-inspector .transport-row").getByRole("button", { name: "播放", exact: true });
    if (await playBehavior.count()) {
      await playBehavior.click();
      await editor.waitForTimeout(options.paceMs * 2);
      const pauseBehavior = editor.locator(".dynamics-inspector .transport-row").getByRole("button", { name: "暂停", exact: true });
      if (await pauseBehavior.count()) await pauseBehavior.click();
    }
  }

  await openWorkspace("05 预览与验收", /05 预览与验收/);
  const previewSamples = editor.locator(".preview-sample-list button");
  for (let index = 0; index < Math.min(7, await previewSamples.count()); index += 1) {
    await previewSamples.nth(index).click();
    await editor.waitForTimeout(Math.max(120, Math.round(options.paceMs * 0.6)));
  }
  for (const background of ["深色", "浅色", "透明"]) {
    await editor.locator(".segmented-control").getByRole("button", { name: background, exact: true }).click();
    await editor.waitForTimeout(Math.max(120, Math.round(options.paceMs * 0.7)));
  }

  const viewerPromise = electronApp.waitForEvent("window", { timeout: 30_000 });
  await editor.getByRole("button", { name: "运行角色窗口", exact: true }).click();
  const viewerPage = await viewerPromise;
  viewerPage.on("pageerror", (cause) => process.stderr.write(`[viewer pageerror] ${cause.message}\n`));
  await viewerPage.getByTestId("viewer").waitFor({ timeout: 30_000 });
  await viewerPage.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
  }, undefined, { timeout: 30_000 });

  const { viewer } = await waitForRuntimeViewer();
  viewerId = viewer.id;
  if (viewer.revision !== undefined && viewer.revision !== revision) throw new Error(`runtime inspect 返回 revision ${viewer.revision}，预期 ${revision}。`);
  emit({ demo: "viewer-ready", viewerId, revision: viewer.revision ?? revision, expressions: viewer.expressions.length, behaviors: viewer.behaviors.length });

  const setPose = async (name, values) => {
    const arguments_ = ["runtime", "set", "--viewer", String(viewerId), "--source", sourceId];
    for (const [flag, value] of Object.entries(values)) arguments_.push(`--${flag}`, String(value));
    arguments_.push("--priority", "90", "--ttl", String(Math.max(1000, options.paceMs * 5)));
    await cliJson(arguments_, runtimeEnvironment);
    emit({ demo: "runtime-pose", name });
    await delay(options.paceMs);
  };

  await setPose("向左", { "head-yaw": -0.85, "body-sway": -0.35, "body-roll": -0.12, "gaze-x": -0.45 });
  await setPose("向右", { "head-yaw": 0.85, "body-sway": 0.35, "body-roll": 0.12, "gaze-x": 0.45 });
  await setPose("抬头", { "head-pitch": -0.75, "body-pitch": -0.2, "gaze-y": -0.4 });
  await setPose("低头", { "head-pitch": 0.75, "body-pitch": 0.2, "gaze-y": 0.4 });
  await setPose("侧倾", { "head-roll": -0.65, "body-roll": -0.2 });
  await setPose("眨眼张嘴", { blink: 1, "mouth-open": 0.8 });
  await setPose("回到中立", { "head-yaw": 0, "head-pitch": 0, "head-roll": 0, "body-sway": 0, "body-pitch": 0, "body-roll": 0, "gaze-x": 0, "gaze-y": 0, blink: 0, "mouth-open": 0 });

  for (const expression of viewer.expressions.slice(0, 2)) {
    await cliJson(["runtime", "trigger", "--viewer", String(viewerId), "--source", sourceId, "--expression", expression.id, "--duration", String(Math.max(500, options.paceMs * 2)), "--priority", "90"], runtimeEnvironment);
    emit({ demo: "runtime-expression", id: expression.id, name: expression.name });
    await delay(Math.max(500, options.paceMs * 2));
  }

  const preferredBehaviorIds = ["action-nod", "action-wave-left", "action-body-bounce", "action-ear-flick", "action-tail-wag"];
  const selectedBehaviors = [];
  for (const id of preferredBehaviorIds) {
    const behavior = viewer.behaviors.find((candidate) => candidate.id === id);
    if (behavior) selectedBehaviors.push(behavior);
  }
  for (const behavior of viewer.behaviors) {
    if (selectedBehaviors.length >= 5) break;
    if (!selectedBehaviors.some((candidate) => candidate.id === behavior.id)) selectedBehaviors.push(behavior);
  }
  for (const behavior of selectedBehaviors) {
    await cliJson(["runtime", "trigger", "--viewer", String(viewerId), "--source", sourceId, "--behavior", behavior.id, "--priority", "90"], runtimeEnvironment);
    emit({ demo: "runtime-behavior", id: behavior.id, name: behavior.name });
    await delay(Math.min(1400, Math.max(options.paceMs * 2, Math.round(behavior.duration * 650))));
  }

  await cliJson(["runtime", "release", "--viewer", String(viewerId), "--source", sourceId], runtimeEnvironment);
  viewerId = undefined;

  const workspaceAfter = await editor.evaluate((directory) => window.puppetloom.readEditorWorkspace(directory), project);
  const historyAfter = await cliJson(["history", "--project", project]);
  if (workspaceAfter.calibration.revision !== revision || historyAfter.currentRevision !== revision) throw new Error("演示过程中项目 revision 发生了变化。" );
  if (JSON.stringify(workspaceAfter.draft ?? null) !== baselineDraft) throw new Error("演示过程中校准草稿发生了变化。" );
  if (editor.isClosed() || viewerPage.isClosed()) throw new Error("演示结束前窗口已经关闭。" );

  emit({ demo: "ready", project, revision, editor: true, viewer: true, keepOpen: options.keepOpen, runtimeReleased: true, profile: runProfile });
  if (options.keepOpen) await electronApp.waitForEvent("close", { timeout: 0 });
  else await electronApp.close();
} catch (cause) {
  if (viewerId !== undefined) {
    try { await cliJson(["runtime", "release", "--viewer", String(viewerId), "--source", sourceId], runtimeEnvironment); }
    catch { /* The viewer may already be gone. */ }
  }
  const message = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
  process.stderr.write(`${message}\n`);
  emit({ demo: "failed", project, revision, keepOpen: options.keepOpen, windowsKeptOpen: Boolean(options.keepOpen && electronApp) });
  process.exitCode = 3;
  if (options.keepOpen && electronApp) await electronApp.waitForEvent("close", { timeout: 0 });
  else if (electronApp) await electronApp.close();
}
