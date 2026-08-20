#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PuppetLoomError,
  parseRuntimeControlRequest,
  parseRuntimeControlServiceRequest,
  parseRuntimeInputSession,
  CubismEditorClient,
  buildCubismExportPlan,
  clearCubismPreview,
  compareProjectRevisions,
  createModelAgentSpecificationTemplate,
  createProject,
  describeAuthoringProject,
  describeProject,
  enhanceProject,
  exportPortableProject,
  finalizeCubismExport,
  planFrontHairAgent,
  planRigExtensionUpgrade,
  planSecondaryPartAgent,
  inspectPsd,
  inspectCubismEditor,
  readCharacterBenchmarkManifest,
  listCalibrationSessions,
  loadCalibration,
  loadProject,
  migrateProject,
  planModelAgent,
  planStandardPerformanceActions,
  readModelAgentSpecification,
  renderProjectSuite,
  runModelAgent,
  runFrontHairAgent,
  runCharacterBenchmarks,
  runSecondaryPartAgent,
  restoreCalibrationRevision,
  saveAuthoringPatch,
  saveCalibrationPatch,
  setCalibrationEvidenceStatus,
  syncCubismProject,
  prepareCubismExport,
  previewCubismProject,
  verifyCubismModel,
  validateCubismEditorProject,
  verifyProject
} from "@puppetloom/core";
import type { AuthoringPatch, CalibrationPatch, CubismPreviewPose, ModelAgentOptions, ModelAgentPart, ModelAgentRequestScope, RenderFocusScope, RenderSuiteKind, RuntimeControlManifest, RuntimeControlResponse, RuntimeControlServiceRequest, RuntimeInputSession, RuntimeMotionInput, SecondaryModelAgentPart } from "@puppetloom/core";
import { Command, CommanderError } from "commander";

type OutputOptions = { json?: boolean };

const defaultCubismTokenFile = join(process.env.LOCALAPPDATA ?? process.cwd(), "PuppetLoom", "cubism-editor-token.txt");
const defaultRuntimeManifest = process.env.PUPPETLOOM_CONTROL_MANIFEST ?? join("D:\\Tools", "PuppetLoom", "user-data", "runtime-control.json");

function print(value: unknown, options: OutputOptions = {}): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function exitCode(error: unknown): number {
  if (error instanceof PuppetLoomError && error.code === "INVALID_INPUT") return 2;
  if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return 0;
  if (error instanceof CommanderError) return 2;
  return 3;
}

async function launchDesktop(arguments_: string[]): Promise<void> {
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const desktopMain = resolve(cliDirectory, "../../desktop/dist/electron/main.js");
  if (!existsSync(desktopMain)) throw new PuppetLoomError("IO_ERROR", "桌面应用尚未构建，请先运行 npm run build。" );
  const electronModule = await import("electron");
  const electronBinary = String(electronModule.default);
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(electronBinary, [desktopMain, ...arguments_], { stdio: "inherit", windowsHide: false });
    child.once("error", rejectChild);
    child.once("exit", (code) => {
      if (code === 0) resolveChild();
      else rejectChild(new PuppetLoomError("IO_ERROR", `桌面应用退出，代码 ${code ?? "unknown"}。`));
    });
  });
}

async function readOptionalText(path: string): Promise<string> {
  try { return (await readFile(path, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new PuppetLoomError("IO_ERROR", `无法读取文件：${path}`, { cause: error });
  }
}

function finiteOption(value: string | undefined, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须是 ${minimum} 到 ${maximum} 之间的数字。`);
  return number;
}

function positiveInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须是正整数。`);
  return number;
}

function assignment(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function assignments(values: string[] | undefined, label: string): Record<string, number> | undefined {
  if (!values?.length) return undefined;
  const result: Record<string, number> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const id = separator > 0 ? value.slice(0, separator).trim() : "";
    const number = separator > 0 ? Number(value.slice(separator + 1)) : Number.NaN;
    if (!id || !Number.isFinite(number)) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须使用 id=数值 格式：${value}`);
    result[id] = number;
  }
  return result;
}

async function runtimeControlUrl(explicit?: string): Promise<string> {
  const direct = explicit ?? process.env.PUPPETLOOM_CONTROL_URL;
  if (direct) return direct.replace(/\/$/, "");
  let manifest: RuntimeControlManifest;
  try {
    manifest = JSON.parse(await readFile(defaultRuntimeManifest, "utf8")) as RuntimeControlManifest;
  } catch (cause) {
    throw new PuppetLoomError("IO_ERROR", `找不到运行时控制清单：${defaultRuntimeManifest}。请先打开 PuppetLoom，或用 --url 指定服务地址。`, { cause });
  }
  if (manifest.version !== 1 || manifest.status !== "running" || !manifest.url) throw new PuppetLoomError("IO_ERROR", "PuppetLoom 运行时控制服务当前没有运行。" );
  return manifest.url.replace(/\/$/, "");
}

async function sendRuntimeControl(request: RuntimeControlServiceRequest, explicitUrl?: string): Promise<unknown> {
  const url = await runtimeControlUrl(explicitUrl);
  let response: Response;
  try {
    response = await fetch(`${url}/v1/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5000)
    });
  } catch (cause) {
    throw new PuppetLoomError("IO_ERROR", `无法连接 PuppetLoom 运行时控制服务：${url}`, { cause });
  }
  const body = await response.json() as RuntimeControlResponse;
  if (!response.ok || !body.ok) throw new PuppetLoomError("INVALID_INPUT", body.error ?? `运行时控制请求失败：HTTP ${response.status}`);
  return body.result;
}

async function connectCubism(url: string, tokenFile: string): Promise<CubismEditorClient> {
  const client = new CubismEditorClient(url);
  const tokenPath = resolve(tokenFile);
  const token = await client.register(await readOptionalText(tokenPath));
  if (token) {
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, token, "utf8");
  }
  return client;
}

function cubismViewerPath(explicit?: string): string {
  const candidates = [
    explicit ? resolve(explicit) : undefined,
    process.env.CUBISM_VIEWER_PATH,
    "D:\\Software\\Work\\Live2D Cubism 5.3\\CubismViewer5.exe",
    "C:\\Program Files\\Live2D Cubism 5.3\\CubismViewer5.exe"
  ].filter((value): value is string => Boolean(value));
  const viewer = candidates.find(existsSync);
  if (!viewer) throw new PuppetLoomError("INVALID_INPUT", "找不到 Cubism Viewer。请用 --viewer 指定 CubismViewer5.exe，或设置 CUBISM_VIEWER_PATH。" );
  return viewer;
}

async function openCubismViewer(model: string, viewer?: string): Promise<void> {
  const executable = cubismViewerPath(viewer);
  const modelPath = resolve(model);
  if (!existsSync(modelPath)) throw new PuppetLoomError("INVALID_INPUT", `找不到 Cubism 模型：${modelPath}`);
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    const child = spawn(executable, [modelPath], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", rejectLaunch);
    child.once("spawn", () => { child.unref(); resolveLaunch(); });
  });
}

async function runWorkspaceTool(scriptName: string, arguments_: string[]): Promise<unknown> {
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(cliDirectory, "../../../scripts", scriptName);
  if (!existsSync(scriptPath)) throw new PuppetLoomError("IO_ERROR", `找不到工作区工具：${scriptName}`);
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [scriptPath, ...arguments_], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectChild);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectChild(new PuppetLoomError("IO_ERROR", stderr.trim() || `${scriptName} 退出，代码 ${code ?? "unknown"}。`));
        return;
      }
      try {
        resolveChild(JSON.parse(stdout));
      } catch (error) {
        rejectChild(new PuppetLoomError("IO_ERROR", `${scriptName} 没有返回有效 JSON。`, { cause: error }));
      }
    });
  });
}

async function run(action: () => Promise<void>, options: OutputOptions = {}): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) process.stderr.write(`${JSON.stringify({ ok: false, error: message, exitCode: exitCode(error) })}\n`);
    else process.stderr.write(`PuppetLoom：${message}\n`);
    process.exitCode = exitCode(error);
  }
}

const program = new Command()
  .name("puppetloom")
  .description("将分层角色 PSD 创建为安全、自主运动的 2D 角色项目")
  .version("0.1.0")
  .showHelpAfterError();

const parseAsJson = process.argv.includes("--json");

program
  .command("inspect")
  .description("检查 PSD 图层、语义和建议绑定等级，不写入项目")
  .requiredOption("--input <character.psd>", "输入 PSD")
  .option("--reference <image>", "可选原始角色图；inspect 只记录参数，不写入")
  .option("--clean-alpha", "高级：预演移除全部微小区域，包括可能有效的绘画细节；不修改源 PSD")
  .option("--preserve-alpha-noise", "高级：保留自动检测到的高置信度 Alpha 噪点")
  .option("--json", "输出 JSON")
  .action(async (options: { input: string; reference?: string; cleanAlpha?: boolean; preserveAlphaNoise?: boolean; json?: boolean }) => {
    await run(async () => {
      if (options.cleanAlpha && options.preserveAlphaNoise) throw new PuppetLoomError("INVALID_INPUT", "--clean-alpha 与 --preserve-alpha-noise 不能同时使用。");
      const report = await inspectPsd(resolve(options.input), {
        ...(options.cleanAlpha ? { alphaCleanup: "remove-all-tiny" as const } : {}),
        ...(options.preserveAlphaNoise ? { alphaCleanup: "preserve-all" as const } : {})
      });
      print({ ...report, ...(options.reference ? { reference: resolve(options.reference) } : {}) }, options);
    }, options);
  });

program
  .command("create")
  .description("创建并验证普通目录形式的 PuppetLoom 项目")
  .requiredOption("--input <character.psd>", "输入 PSD")
  .option("--reference <image>", "可选原始角色图")
  .requiredOption("--output <project-dir>", "新建或空的输出目录")
  .option("--seed <number>", "动作时间线种子", "42")
  .option("--name <name>", "项目名称")
  .option("--clean-alpha", "高级：移除全部微小区域，包括可能有效的绘画细节；源 PSD 始终原样保存")
  .option("--preserve-alpha-noise", "高级：保留自动检测到的高置信度 Alpha 噪点")
  .option("--json", "输出 JSON")
  .action(async (options: { input: string; reference?: string; output: string; seed: string; name?: string; cleanAlpha?: boolean; preserveAlphaNoise?: boolean; json?: boolean }) => {
    await run(async () => {
      const seed = Number(options.seed);
      if (!Number.isSafeInteger(seed)) throw new PuppetLoomError("INVALID_INPUT", "seed 必须是安全整数。");
      if (options.cleanAlpha && options.preserveAlphaNoise) throw new PuppetLoomError("INVALID_INPUT", "--clean-alpha 与 --preserve-alpha-noise 不能同时使用。");
      const result = await createProject({
        input: resolve(options.input),
        output: resolve(options.output),
        seed,
        ...(options.cleanAlpha ? { alphaCleanup: "remove-all-tiny" as const } : {}),
        ...(options.preserveAlphaNoise ? { alphaCleanup: "preserve-all" as const } : {}),
        ...(options.reference ? { reference: resolve(options.reference) } : {}),
        ...(options.name ? { name: options.name } : {})
      });
      print({ ok: true, outputDirectory: result.outputDirectory, report: result.report }, options);
    }, options);
  });

program
  .command("verify")
  .description("重新检查项目文件与 13 个姿态的安全结果")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; json?: boolean }) => {
    await run(async () => {
      const result = await verifyProject(resolve(options.project));
      print(result, options);
      if (!result.valid) process.exitCode = 3;
    }, options);
  });

program
  .command("export")
  .description("把当前有效修订烘焙成新的可移植项目目录，不压缩、不覆盖现有目录")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--output <new-project-dir>", "尚不存在的导出目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; output: string; json?: boolean }) => {
    await run(async () => print(await exportPortableProject({ project: resolve(options.project), output: resolve(options.output) }), options), options);
  });

const benchmark = program.command("benchmark").description("校验真实角色基准清单，并批量生成可复现的项目能力报告");

benchmark
  .command("validate")
  .description("只检查基准清单格式和素材使用声明，不运行角色项目")
  .requiredOption("--manifest <corpus.json>", "真实角色基准清单")
  .option("--json", "输出 JSON")
  .action(async (options: { manifest: string; json?: boolean }) => {
    await run(async () => {
      const manifestPath = resolve(options.manifest);
      const manifest = await readCharacterBenchmarkManifest(manifestPath);
      print({
        valid: true,
        manifest: manifestPath,
        name: manifest.name,
        characters: manifest.characters.length,
        readyForMaterials: manifest.characters.length === 0,
        entries: manifest.characters.map(({ id, label, project, revision, materialUse, tags }) => ({ id, label, project, ...(revision === undefined ? {} : { revision }), materialUse, tags }))
      }, options);
    }, options);
  });

benchmark
  .command("run")
  .description("运行清单内全部角色，写入 JSON 与 Markdown 报告；不修改角色项目")
  .requiredOption("--manifest <corpus.json>", "真实角色基准清单")
  .requiredOption("--output <new-report-dir>", "尚不存在的报告目录")
  .option("--json", "输出 JSON")
  .action(async (options: { manifest: string; output: string; json?: boolean }) => {
    await run(async () => {
      const output = resolve(options.output);
      if (existsSync(output)) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `基准报告目录已经存在：${output}`);
      const report = await runCharacterBenchmarks(resolve(options.manifest));
      await mkdir(output, { recursive: true });
      const jsonPath = join(output, "benchmark-report.json");
      const markdownPath = join(output, "benchmark-summary.md");
      await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      const rows = report.results.length
        ? report.results.map((result) => `| ${result.id} | ${result.revision} | ${result.passed ? "通过" : "失败"} | ${result.checks.filter((check) => !check.passed).map((check) => check.id).join(", ") || "—"} |`).join("\n")
        : "| — | — | 等待素材 | — |";
      await writeFile(markdownPath, `# ${report.name}\n\n生成时间：${report.generatedAt}\n\n清单角色：${report.summary.declared}；通过：${report.summary.passed}；失败：${report.summary.failed}。\n\n| 角色 | Revision | 结果 | 未通过检查 |\n| --- | ---: | --- | --- |\n${rows}\n`, "utf8");
      print({ ok: report.passed, output, report: jsonPath, summary: markdownPath, result: report.summary, readyForMaterials: report.readyForMaterials }, options);
      if (!report.passed) process.exitCode = 3;
    }, options);
  });

const runtime = program.command("runtime").description("检查并实时控制已打开的角色窗口，供外部 Agent、输入设备和自动化脚本调用");

runtime
  .command("inspect")
  .description("列出运行中的角色窗口及其可用参数、表情和动作")
  .option("--url <address>", "运行时控制服务地址；默认读取 D:\\Tools\\PuppetLoom\\user-data\\runtime-control.json")
  .option("--json", "输出 JSON")
  .action(async (options: { url?: string; json?: boolean }) => {
    await run(async () => print(await sendRuntimeControl({ version: 1, requestId: randomUUID(), op: "inspect" }, options.url), options), options);
  });

runtime
  .command("set")
  .description("设置一个持续或带超时的控制来源；同一 source 的下一次设置会替换上一次")
  .requiredOption("--viewer <id>", "角色窗口 ID")
  .requiredOption("--source <id>", "控制来源 ID，例如 camera、microphone 或 agent-demo")
  .option("--head-yaw <value>", "头部左右，-1 到 1")
  .option("--head-pitch <value>", "头部俯仰，-1 到 1")
  .option("--head-roll <value>", "头部侧倾，-1 到 1")
  .option("--body-sway <value>", "身体左右，-1 到 1")
  .option("--body-pitch <value>", "身体俯仰，-1 到 1")
  .option("--body-roll <value>", "身体侧倾，-1 到 1")
  .option("--gaze-x <value>", "视线左右，-1 到 1")
  .option("--gaze-y <value>", "视线上下，-1 到 1")
  .option("--breath <value>", "呼吸，-1 到 1")
  .option("--blink <value>", "闭眼，0 到 1")
  .option("--mouth-open <value>", "张嘴，0 到 1")
  .option("--parameter <id=value>", "模型参数，可重复", assignment, [])
  .option("--expression <id=value>", "表情强度，可重复", assignment, [])
  .option("--priority <value>", "优先级 0 到 100；高优先级后混合", "50")
  .option("--blend <value>", "来源混合比例 0 到 1", "1")
  .option("--ttl <milliseconds>", "50 到 60000 毫秒；超时后自动回到自主动作")
  .option("--url <address>", "运行时控制服务地址")
  .option("--json", "输出 JSON")
  .action(async (options: {
    viewer: string; source: string; headYaw?: string; headPitch?: string; headRoll?: string; bodySway?: string; bodyPitch?: string; bodyRoll?: string;
    gazeX?: string; gazeY?: string; breath?: string; blink?: string; mouthOpen?: string; parameter?: string[]; expression?: string[];
    priority: string; blend: string; ttl?: string; url?: string; json?: boolean;
  }) => {
    await run(async () => {
      const motion = Object.fromEntries(Object.entries({
        headYaw: finiteOption(options.headYaw, "head-yaw", -1, 1),
        headPitch: finiteOption(options.headPitch, "head-pitch", -1, 1),
        headRoll: finiteOption(options.headRoll, "head-roll", -1, 1),
        bodySway: finiteOption(options.bodySway, "body-sway", -1, 1),
        bodyPitch: finiteOption(options.bodyPitch, "body-pitch", -1, 1),
        bodyRoll: finiteOption(options.bodyRoll, "body-roll", -1, 1),
        gazeX: finiteOption(options.gazeX, "gaze-x", -1, 1),
        gazeY: finiteOption(options.gazeY, "gaze-y", -1, 1),
        breath: finiteOption(options.breath, "breath", -1, 1),
        blink: finiteOption(options.blink, "blink", 0, 1),
        mouthOpen: finiteOption(options.mouthOpen, "mouth-open", 0, 1)
      }).filter((entry): entry is [string, number] => entry[1] !== undefined)) as RuntimeMotionInput;
      const parameters = assignments(options.parameter, "parameter");
      const expressions = assignments(options.expression, "expression");
      const request = parseRuntimeControlRequest({
        version: 1,
        requestId: randomUUID(),
        op: "set",
        viewerId: positiveInteger(options.viewer, "viewer"),
        source: {
          id: options.source,
          priority: finiteOption(options.priority, "priority", 0, 100),
          blend: finiteOption(options.blend, "blend", 0, 1),
          ...(options.ttl === undefined ? {} : { ttlMs: finiteOption(options.ttl, "ttl", 50, 60_000) }),
          ...(Object.keys(motion).length ? { motion } : {}),
          ...(parameters ? { parameters } : {}),
          ...(expressions ? { expressions } : {})
        }
      });
      print(await sendRuntimeControl(request, options.url), options);
    }, options);
  });

runtime
  .command("trigger")
  .description("触发表情或动作；非循环动作结束后自动释放")
  .requiredOption("--viewer <id>", "角色窗口 ID")
  .requiredOption("--source <id>", "触发来源 ID")
  .option("--behavior <id>", "动作 ID")
  .option("--expression <id>", "表情 ID")
  .option("--strength <value>", "强度 0 到 1", "1")
  .option("--duration <milliseconds>", "持续时间；省略时使用动作自身时长，表情默认 1000 毫秒")
  .option("--priority <value>", "优先级 0 到 100", "70")
  .option("--url <address>", "运行时控制服务地址")
  .option("--json", "输出 JSON")
  .action(async (options: { viewer: string; source: string; behavior?: string; expression?: string; strength: string; duration?: string; priority: string; url?: string; json?: boolean }) => {
    await run(async () => {
      const request = parseRuntimeControlRequest({
        version: 1, requestId: randomUUID(), op: "trigger", viewerId: positiveInteger(options.viewer, "viewer"), sourceId: options.source,
        ...(options.behavior ? { behaviorId: options.behavior } : {}),
        ...(options.expression ? { expressionId: options.expression } : {}),
        strength: finiteOption(options.strength, "strength", 0, 1),
        ...(options.duration === undefined ? {} : { durationMs: finiteOption(options.duration, "duration", 50, 600_000) }),
        priority: finiteOption(options.priority, "priority", 0, 100)
      });
      print(await sendRuntimeControl(request, options.url), options);
    }, options);
  });

runtime
  .command("release")
  .description("释放一个控制来源；省略 source 时释放该角色的全部外部控制")
  .requiredOption("--viewer <id>", "角色窗口 ID")
  .option("--source <id>", "控制来源 ID")
  .option("--url <address>", "运行时控制服务地址")
  .option("--json", "输出 JSON")
  .action(async (options: { viewer: string; source?: string; url?: string; json?: boolean }) => {
    await run(async () => {
      const request = parseRuntimeControlRequest({ version: 1, requestId: randomUUID(), op: "release", viewerId: positiveInteger(options.viewer, "viewer"), ...(options.source ? { sourceId: options.source } : {}) });
      print(await sendRuntimeControl(request, options.url), options);
    }, options);
  });

runtime
  .command("record-start")
  .description("开始录制该角色收到的摄像头、麦克风、快捷键和外部控制事件")
  .requiredOption("--viewer <id>", "角色窗口 ID")
  .option("--url <address>", "运行时控制服务地址")
  .option("--json", "输出 JSON")
  .action(async (options: { viewer: string; url?: string; json?: boolean }) => {
    await run(async () => print(await sendRuntimeControl(parseRuntimeControlServiceRequest({
      version: 1, requestId: randomUUID(), op: "record-start", viewerId: positiveInteger(options.viewer, "viewer")
    }), options.url), options), options);
  });

runtime
  .command("record-stop")
  .description("停止输入录制，并保存为可确定性回放的 JSON；不会覆盖已有文件")
  .requiredOption("--viewer <id>", "角色窗口 ID")
  .requiredOption("--output <session.json>", "尚不存在的输出 JSON")
  .option("--url <address>", "运行时控制服务地址")
  .option("--json", "输出 JSON")
  .action(async (options: { viewer: string; output: string; url?: string; json?: boolean }) => {
    await run(async () => {
      const output = resolve(options.output);
      if (existsSync(output)) throw new PuppetLoomError("INVALID_INPUT", `输出文件已存在，不会覆盖：${output}`);
      const result = await sendRuntimeControl(parseRuntimeControlServiceRequest({
        version: 1, requestId: randomUUID(), op: "record-stop", viewerId: positiveInteger(options.viewer, "viewer")
      }), options.url) as { session: RuntimeInputSession };
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result.session, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      print({ ...result, output }, options);
    }, options);
  });

runtime
  .command("replay")
  .description("按原时间线回放输入会话；回放来源与当前实时输入相互隔离")
  .requiredOption("--viewer <id>", "角色窗口 ID")
  .requiredOption("--input <session.json>", "输入会话 JSON")
  .option("--speed <value>", "回放速度 0.1 到 4", "1")
  .option("--loop", "循环回放")
  .option("--url <address>", "运行时控制服务地址")
  .option("--json", "输出 JSON")
  .action(async (options: { viewer: string; input: string; speed: string; loop?: boolean; url?: string; json?: boolean }) => {
    await run(async () => {
      const session = parseRuntimeInputSession(JSON.parse(await readFile(resolve(options.input), "utf8")) as unknown);
      const request = parseRuntimeControlServiceRequest({
        version: 1, requestId: randomUUID(), op: "replay-start", viewerId: positiveInteger(options.viewer, "viewer"),
        session, speed: finiteOption(options.speed, "speed", 0.1, 4), loop: Boolean(options.loop)
      });
      print(await sendRuntimeControl(request, options.url), options);
    }, options);
  });

runtime
  .command("replay-stop")
  .description("停止该角色正在进行的输入回放，并只释放回放创建的控制来源")
  .requiredOption("--viewer <id>", "角色窗口 ID")
  .option("--url <address>", "运行时控制服务地址")
  .option("--json", "输出 JSON")
  .action(async (options: { viewer: string; url?: string; json?: boolean }) => {
    await run(async () => print(await sendRuntimeControl(parseRuntimeControlServiceRequest({
      version: 1, requestId: randomUUID(), op: "replay-stop", viewerId: positiveInteger(options.viewer, "viewer")
    }), options.url), options), options);
  });

const cubism = program.command("cubism").description("通过 Cubism Editor 官方链路同步可写结构并生成、校验 model3 运行时目录");

cubism
  .command("plan")
  .description("分析当前修订可自动同步的内容和官方 API 阻断项，不写入文件")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; json?: boolean }) => {
    await run(async () => {
      const projectDirectory = resolve(options.project);
      const [project, calibration] = await Promise.all([loadProject(projectDirectory), loadCalibration(projectDirectory)]);
      print(buildCubismExportPlan(project, calibration.revision), options);
    }, options);
  });

cubism
  .command("prepare")
  .description("生成官方交接包：映射、阻断报告、Editor 清单及 exp3/motion3/physics3/cdi3；不生成 moc3")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--output <new-directory>", "尚不存在的准备目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; output: string; json?: boolean }) => {
    await run(async () => print(await prepareCubismExport(resolve(options.project), resolve(options.output)), options), options);
  });

cubism
  .command("handoff")
  .description("生成与 prepare 相同的完整 Cubism 官方交接包，名称用于交付流程")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--output <new-directory>", "尚不存在的交接目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; output: string; json?: boolean }) => {
    await run(async () => print(await prepareCubismExport(resolve(options.project), resolve(options.output)), options), options);
  });

cubism
  .command("finalize")
  .description("以 Cubism Editor 官方导出的 model3/moc3 为真源，合并 PuppetLoom 侧车并验证新目录")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--editor-model <model3.json>", "Cubism Editor 导出的 model3.json")
  .requiredOption("--output <new-runtime-dir>", "尚不存在的最终运行时目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; editorModel: string; output: string; json?: boolean }) => {
    await run(async () => print(await finalizeCubismExport({ project: resolve(options.project), editorModel: resolve(options.editorModel), output: resolve(options.output) }), options), options);
  });

cubism
  .command("verify")
  .description("验证 model3.json 的引用、moc3 文件头、JSON 侧车与纹理")
  .requiredOption("--model <model3.json>", "待验证的 Cubism model3.json")
  .option("--json", "输出 JSON")
  .action(async (options: { model: string; json?: boolean }) => {
    await run(async () => {
      const result = await verifyCubismModel(resolve(options.model));
      print(result, options);
      if (!result.valid) process.exitCode = 3;
    }, options);
  });

cubism
  .command("open")
  .description("在本机 Live2D Cubism Viewer 中打开 model3.json")
  .requiredOption("--model <model3.json>", "Cubism model3.json")
  .option("--viewer <CubismViewer5.exe>", "显式指定 Viewer 可执行文件")
  .action(async (options: { model: string; viewer?: string }) => {
    await run(async () => openCubismViewer(options.model, options.viewer));
  });

const cubismEditor = cubism.command("editor").description("连接 Cubism Editor External API；结构编辑需要 5.4 alpha 或更新版本");

cubismEditor
  .command("inspect")
  .description("检查连接、Allow/Edit 授权、API 版本、当前模型参数和对象")
  .option("--url <websocket-url>", "Editor WebSocket 地址", "ws://127.0.0.1:22033")
  .option("--token-file <path>", "授权 Token 文件", defaultCubismTokenFile)
  .option("--json", "输出 JSON")
  .action(async (options: { url: string; tokenFile: string; json?: boolean }) => {
    await run(async () => {
      const client = await connectCubism(options.url, options.tokenFile);
      try { print(await inspectCubismEditor(client, options.url, client.getVersion()), options); }
      finally { await client.close(); }
    }, options);
  });

cubismEditor
  .command("validate")
  .description("按同步前或同步后阶段核对授权、Editor 模式、同名 ArtMesh、参数范围和不可自动验证的几何项")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--stage <pre-sync|post-sync>", "校验阶段")
  .option("--url <websocket-url>", "Editor WebSocket 地址", "ws://127.0.0.1:22033")
  .option("--token-file <path>", "授权 Token 文件", defaultCubismTokenFile)
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; stage: "pre-sync" | "post-sync"; url: string; tokenFile: string; json?: boolean }) => {
    await run(async () => {
      if (options.stage !== "pre-sync" && options.stage !== "post-sync") throw new PuppetLoomError("INVALID_INPUT", "--stage 必须是 pre-sync 或 post-sync。" );
      const client = await connectCubism(options.url, options.tokenFile);
      try {
        const result = await validateCubismEditorProject(resolve(options.project), client, options.stage, { url: options.url, apiVersion: client.getVersion() });
        print(result, options);
        if (options.stage === "pre-sync" ? !result.readyForPartialSync : !result.readyForOfficialExportReview) process.exitCode = 3;
      } finally { await client.close(); }
    }, options);
  });

cubismEditor
  .command("sync")
  .description("在一个可回滚事务中同步参数、可匹配对象、变形器和 API 可写关键形态")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--url <websocket-url>", "Editor WebSocket 地址", "ws://127.0.0.1:22033")
  .option("--token-file <path>", "授权 Token 文件", defaultCubismTokenFile)
  .option("--allow-partial", "明确允许跳过官方 API 无法写入的网格/程序化变形")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; url: string; tokenFile: string; allowPartial?: boolean; json?: boolean }) => {
    await run(async () => {
      const client = await connectCubism(options.url, options.tokenFile);
      try {
        print(await syncCubismProject(resolve(options.project), client, { allowPartial: options.allowPartial === true, url: options.url, apiVersion: client.getVersion() }), options);
      } finally { await client.close(); }
    }, options);
  });

cubismEditor
  .command("preview")
  .description("用稳定 External API 临时预览映射参数；Cubism Editor 5.3 也可使用")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--pose <pose>", "neutral、left、right、up、down、blink 或 mouth", "neutral")
  .option("--url <websocket-url>", "Editor WebSocket 地址", "ws://127.0.0.1:22033")
  .option("--token-file <path>", "授权 Token 文件", defaultCubismTokenFile)
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; pose: string; url: string; tokenFile: string; json?: boolean }) => {
    await run(async () => {
      const poses = ["neutral", "left", "right", "up", "down", "blink", "mouth"];
      if (!poses.includes(options.pose)) throw new PuppetLoomError("INVALID_INPUT", "pose 必须是 neutral、left、right、up、down、blink 或 mouth。" );
      const client = await connectCubism(options.url, options.tokenFile);
      try { print(await previewCubismProject(resolve(options.project), client, options.pose as CubismPreviewPose, { url: options.url, apiVersion: client.getVersion() }), options); }
      finally { await client.close(); }
    }, options);
  });

cubismEditor
  .command("clear-preview")
  .description("清除 SetParameterValues 的临时预览缓存")
  .option("--url <websocket-url>", "Editor WebSocket 地址", "ws://127.0.0.1:22033")
  .option("--token-file <path>", "授权 Token 文件", defaultCubismTokenFile)
  .option("--json", "输出 JSON")
  .action(async (options: { url: string; tokenFile: string; json?: boolean }) => {
    await run(async () => {
      const client = await connectCubism(options.url, options.tokenFile);
      try { print({ ok: true, inspection: await clearCubismPreview(client, { url: options.url, apiVersion: client.getVersion() }) }, options); }
      finally { await client.close(); }
    }, options);
  });

program
  .command("describe")
  .description("列出 Agent 和编辑器可以调整的控制点、图层、网格与当前校准修订")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--layer <id>", "返回一个图层的完整网格、逐顶点权重与透明区域拓扑")
  .option("--revision <number>", "读取指定校准修订")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; layer?: string; revision?: string; json?: boolean }) => {
    await run(async () => {
      const revision = options.revision === undefined ? undefined : Number(options.revision);
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw new PuppetLoomError("INVALID_INPUT", "revision 必须是非负整数。" );
      print(await describeProject(resolve(options.project), options.layer, revision), options);
    }, options);
  });

const extensions = program.command("extensions").description("让现有项目以可回退 revision 接入多房束、侧脸深度和可选躯干体积，不重建项目");

extensions
  .command("plan")
  .description("分析现有项目自己的源 PSD，列出可追加的新绑定能力，不写入")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--torso-volume", "显式计划躯干体积曲线；默认不假定身体或服装需要体积")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; torsoVolume?: boolean; json?: boolean }) => {
    await run(async () => {
      print(await planRigExtensionUpgrade(resolve(options.project), { includeTorsoVolume: options.torsoVolume === true }), options);
    }, options);
  });

extensions
  .command("apply")
  .description("把计划作为同一项目的新校准 revision 写入，并生成前后对比证据")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--torso-volume", "显式启用躯干体积曲线")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; torsoVolume?: boolean; json?: boolean }) => {
    await run(async () => {
      const directory = resolve(options.project);
      const plan = await planRigExtensionUpgrade(directory, { includeTorsoVolume: options.torsoVolume === true });
      if (!plan.patch) {
        print({ ok: true, upToDate: true, revision: plan.baseRevision, plan }, options);
        return;
      }
      const result = await saveCalibrationPatch(directory, plan.patch);
      print({ ok: true, upToDate: false, revision: result.calibration.revision, plan, session: result.session, sessionPath: result.sessionPath, evidence: result.evidence, operation: result.operation }, options);
    }, options);
  });

const author = program.command("author").description("供 Agent 检查和修改参数、关键形态与变形器");

const actions = program.command("actions").description("建立并检查可由快捷键、CLI 和表演输入触发的标准表情与动作库");

actions
  .command("plan")
  .description("按真实图层与耳部铰点规划表情、肢体、耳朵和尾巴动作，并逐部位报告 completed/not-present/needs-assets，不写入项目")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; json?: boolean }) => {
    await run(async () => {
      const directory = resolve(options.project);
      const [project, calibration] = await Promise.all([loadProject(directory), loadCalibration(directory)]);
      print(planStandardPerformanceActions(project, calibration.revision), options);
    }, options);
  });

actions
  .command("apply")
  .description("以可回滚修订写入标准表情、点头、摇头、鞠躬、观察、挥手、踏步、眨眼、短句、耳朵轻弹和尾巴摇摆动作")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; json?: boolean }) => {
    await run(async () => {
      const directory = resolve(options.project);
      const [project, calibration] = await Promise.all([loadProject(directory), loadCalibration(directory)]);
      const plan = planStandardPerformanceActions(project, calibration.revision);
      if (!plan.patch) {
        print({ ok: true, upToDate: true, revision: calibration.revision, plan }, options);
        return;
      }
      const result = await saveAuthoringPatch(directory, plan.patch);
      print({ ok: true, upToDate: false, revision: result.calibration.revision, plan, session: result.session, sessionPath: result.sessionPath, evidence: result.evidence, operation: result.operation }, options);
    }, options);
  });

const agent = program.command("agent").description("让 Agent 按部位完成分析、制作、自检和证据闭环");
const modelAgentScopes = ["whole", "headFace", "eyes", "mouth", "frontHair", "backHair", "ahoge", "ears", "headwear", "body", "topCloth", "skirt", "tail", "accessory"] as const;
function modelAgentScope(value: string): ModelAgentRequestScope {
  if (!(modelAgentScopes as readonly string[]).includes(value)) throw new PuppetLoomError("INVALID_INPUT", `不支持的 Agent 范围：${value}`);
  return value as "whole" | ModelAgentPart;
}

type ModelAgentCliOptions = { project: string; spec?: string; instruction?: string; scope?: string; json?: boolean };

async function modelAgentOptions(options: ModelAgentCliOptions): Promise<ModelAgentOptions> {
  if (options.spec) {
    if (options.instruction || options.scope) throw new PuppetLoomError("INVALID_INPUT", "使用 --spec 时不能再传 --instruction 或 --scope；范围和意图已经由制作规格明确给出。" );
    return { specification: await readModelAgentSpecification(resolve(options.spec)) };
  }
  return {
    instruction: options.instruction ?? "把整个模型做得自然、协调，并自动检查和返修",
    scope: modelAgentScope(options.scope ?? "whole")
  };
}

agent
  .command("specification")
  .alias("spec")
  .description("生成与当前 revision 绑定的结构化制作规格模板，交给外部 Agent 看图后填写")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--scope <scope>", `模板范围：${modelAgentScopes.join("、")}`, "whole")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; scope: string; json?: boolean }) => {
    await run(async () => {
      const scope = modelAgentScope(options.scope);
      print(await createModelAgentSpecificationTemplate(resolve(options.project), scope === "whole" ? "whole" : [scope]), options);
    }, options);
  });

agent
  .command("plan")
  .description("验证并展开外部 Agent 的结构化制作规格；旧自然语言参数仅为兼容入口")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--spec <rig-spec.json>", "外部 Agent 生成的结构化制作规格（正式入口）")
  .option("--instruction <text>", "旧版自然语言目标（兼容入口）")
  .option("--scope <scope>", `旧版范围：${modelAgentScopes.join("、")}`)
  .option("--json", "输出 JSON")
  .action(async (options: ModelAgentCliOptions) => {
    await run(async () => print(await planModelAgent(resolve(options.project), await modelAgentOptions(options)), options), options);
  });

agent
  .command("apply")
  .description("确定性执行外部 Agent 的结构化制作规格，并生成可回滚 revision 与视觉证据")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--spec <rig-spec.json>", "外部 Agent 生成的结构化制作规格（正式入口）")
  .option("--instruction <text>", "旧版自然语言目标（兼容入口）")
  .option("--scope <scope>", `旧版范围：${modelAgentScopes.join("、")}`)
  .option("--json", "输出 JSON")
  .action(async (options: ModelAgentCliOptions) => {
    await run(async () => print(await runModelAgent(resolve(options.project), await modelAgentOptions(options)), options), options);
  });

const frontHairAgent = agent.command("front-hair").description("自动完成前发网格接管、转向关键形、滞后回弹和安全检查");

frontHairAgent
  .command("plan")
  .description("分析前发与当前草稿，生成完整执行计划但不写入项目")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--instruction <text>", "自然语言目标", "让前发随头部转向自然变形，并增加轻微滞后和回弹")
  .option("--layer <id>", "显式指定前发图层")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; instruction: string; layer?: string; json?: boolean }) => {
    await run(async () => print(await planFrontHairAgent(resolve(options.project), {
      instruction: options.instruction,
      ...(options.layer ? { layerId: options.layer } : {})
    }), options), options);
  });

const secondaryAgentParts = ["backHair", "ahoge", "ears", "headwear", "topCloth", "skirt", "tail", "accessory"] as const;
function secondaryAgentPart(value: string): SecondaryModelAgentPart {
  if (!(secondaryAgentParts as readonly string[]).includes(value)) throw new PuppetLoomError("INVALID_INPUT", `不支持的次级运动部位：${value}`);
  return value as SecondaryModelAgentPart;
}

const secondaryAgent = agent.command("secondary").description("自动完成后发、呆毛、耳朵、头饰、衣服、裙摆、尾巴或配饰的制作与自检");

secondaryAgent
  .command("plan")
  .description("分析指定部位并生成自动制作与返修计划，但不写入项目")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--part <part>", `部位：${secondaryAgentParts.join("、")}`)
  .option("--instruction <text>", "自然语言目标")
  .option("--layer <id...>", "显式指定一个或多个图层")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; part: string; instruction?: string; layer?: string[]; json?: boolean }) => {
    await run(async () => print(await planSecondaryPartAgent(resolve(options.project), {
      part: secondaryAgentPart(options.part),
      ...(options.instruction ? { instruction: options.instruction } : {}),
      ...(options.layer?.length ? { layerIds: options.layer } : {})
    }), options), options);
  });

secondaryAgent
  .command("apply")
  .description("执行指定部位的自动制作、自检、返修和证据闭环")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--part <part>", `部位：${secondaryAgentParts.join("、")}`)
  .option("--instruction <text>", "自然语言目标")
  .option("--layer <id...>", "显式指定一个或多个图层")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; part: string; instruction?: string; layer?: string[]; json?: boolean }) => {
    await run(async () => print(await runSecondaryPartAgent(resolve(options.project), {
      part: secondaryAgentPart(options.part),
      ...(options.instruction ? { instruction: options.instruction } : {}),
      ...(options.layer?.length ? { layerIds: options.layer } : {})
    }), options), options);
  });

frontHairAgent
  .command("apply")
  .description("执行前发制作闭环；每一步形成可回滚修订并生成前后证据")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--instruction <text>", "自然语言目标", "让前发随头部转向自然变形，并增加轻微滞后和回弹")
  .option("--layer <id>", "显式指定前发图层")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; instruction: string; layer?: string; json?: boolean }) => {
    await run(async () => print(await runFrontHairAgent(resolve(options.project), {
      instruction: options.instruction,
      ...(options.layer ? { layerId: options.layer } : {})
    }), options), options);
  });

author
  .command("inspect")
  .description("读取当前 authoring 图、图层挂接关系和修订号")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; json?: boolean }) => {
    await run(async () => print(await describeAuthoringProject(resolve(options.project)), options), options);
  });

author
  .command("apply")
  .description("以高层操作事务修改 authoring 图，并生成前后视觉证据")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--patch <authoring.json>", "包含 baseRevision 与 operations 的 authoring 补丁")
  .option("--label <text>", "覆盖补丁中的修订说明")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; patch: string; label?: string; json?: boolean }) => {
    await run(async () => {
      let document: AuthoringPatch;
      try {
        document = JSON.parse(await readFile(resolve(options.patch), "utf8")) as AuthoringPatch;
      } catch (error) {
        throw new PuppetLoomError("INVALID_INPUT", "无法读取 authoring 补丁 JSON。", { cause: error });
      }
      const result = await saveAuthoringPatch(resolve(options.project), { ...document, ...(options.label ? { label: options.label } : {}) });
      print({
        ok: true,
        revision: result.calibration.revision,
        session: result.session,
        sessionPath: result.sessionPath,
        evidence: result.evidence,
        operation: result.operation
      }, options);
    }, options);
  });

program
  .command("migrate")
  .description("从更新后的 PSD 创建新项目，并保守迁移能够证明兼容的校准")
  .requiredOption("--project <old-project-dir>", "旧 PuppetLoom 项目目录")
  .requiredOption("--input <updated.psd>", "更新后的 PSD")
  .requiredOption("--output <new-project-dir>", "新建或空的输出目录；不会覆盖旧项目")
  .option("--reference <image>", "与更新 PSD 对应的可选参考图")
  .option("--seed <number>", "覆盖旧项目动作时间线种子")
  .option("--name <name>", "新项目名称")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; input: string; output: string; reference?: string; seed?: string; name?: string; json?: boolean }) => {
    await run(async () => {
      const seed = options.seed === undefined ? undefined : Number(options.seed);
      if (seed !== undefined && !Number.isSafeInteger(seed)) throw new PuppetLoomError("INVALID_INPUT", "seed 必须是安全整数。" );
      print(await migrateProject({
        project: resolve(options.project),
        input: resolve(options.input),
        output: resolve(options.output),
        ...(options.reference ? { reference: resolve(options.reference) } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(options.name ? { name: options.name } : {})
      }), options);
    }, options);
  });

program
  .command("render")
  .description("渲染确定性的姿态、次级运动或完整校准证据")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--output <directory>", "证据输出目录")
  .option("--suite <kind>", "calibration、poses 或 motion", "calibration")
  .option("--revision <number>", "指定校准修订")
  .option("--size <pixels>", "原生证据尺寸，300 到 1600", "600")
  .option("--focus <scope>", "同时生成 whole 或指定部位的高清局部证据")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; output: string; suite: string; revision?: string; size: string; focus?: string; json?: boolean }) => {
    await run(async () => {
      if (!["calibration", "poses", "motion"].includes(options.suite)) throw new PuppetLoomError("INVALID_INPUT", "suite 必须是 calibration、poses 或 motion。" );
      const revision = options.revision === undefined ? undefined : Number(options.revision);
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw new PuppetLoomError("INVALID_INPUT", "revision 必须是非负整数。" );
      const size = Number(options.size);
      if (!Number.isInteger(size) || size < 300 || size > 1600) throw new PuppetLoomError("INVALID_INPUT", "size 必须是 300 到 1600 之间的整数。" );
      if (options.focus && !(modelAgentScopes as readonly string[]).includes(options.focus)) throw new PuppetLoomError("INVALID_INPUT", `不支持的证据范围：${options.focus}`);
      const result = await renderProjectSuite(resolve(options.project), resolve(options.output), options.suite as RenderSuiteKind, revision, {
        size,
        ...(options.focus ? { focus: options.focus as RenderFocusScope } : {})
      });
      print(result, options);
    }, options);
  });

program
  .command("calibrate")
  .description("通过经过验证的 JSON 补丁校准锚点、控制点、网格、权重和动作参数")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--patch <change-set.json>", "校准补丁")
  .option("--label <text>", "覆盖补丁中的校准说明")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; patch: string; label?: string; json?: boolean }) => {
    await run(async () => {
      let document: CalibrationPatch;
      try {
        document = JSON.parse(await readFile(resolve(options.patch), "utf8")) as CalibrationPatch;
      } catch (error) {
        throw new PuppetLoomError("INVALID_INPUT", "无法读取校准补丁 JSON。", { cause: error });
      }
      const project = resolve(options.project);
      const result = await saveCalibrationPatch(project, { ...document, ...(options.label ? { label: options.label } : {}) });
      print({ ok: true, revision: result.calibration.revision, session: result.session, sessionPath: result.sessionPath, evidence: result.evidence, operation: result.operation }, options);
    }, options);
  });

program
  .command("compare")
  .description("渲染两个校准修订的前后对比和像素差异")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--from <revision>", "修改前修订")
  .requiredOption("--to <revision>", "修改后修订")
  .requiredOption("--output <directory>", "对比输出目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; from: string; to: string; output: string; json?: boolean }) => {
    await run(async () => {
      const from = Number(options.from); const to = Number(options.to);
      if (![from, to].every((value) => Number.isInteger(value) && value >= 0)) throw new PuppetLoomError("INVALID_INPUT", "from 和 to 必须是非负整数。" );
      print(await compareProjectRevisions(resolve(options.project), from, to, resolve(options.output)), options);
    }, options);
  });

program
  .command("history")
  .description("读取精简的项目修订历史；需要完整补丁和网格数据时显式使用 --full")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--full", "返回完整会话、补丁和累计覆盖数据")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; full?: boolean; json?: boolean }) => {
    await run(async () => {
      const project = resolve(options.project);
      const [calibration, sessions] = await Promise.all([loadCalibration(project), listCalibrationSessions(project)]);
      print({
        currentRevision: calibration.revision,
        headSessionId: calibration.headSessionId,
        sessions: options.full ? sessions : sessions.map((session) => ({
          id: session.id,
          label: session.label,
          createdAt: session.createdAt,
          fromRevision: session.fromRevision,
          toRevision: session.toRevision,
          evidenceStatus: session.evidenceStatus,
          parentSessionId: session.parentSessionId,
          evidenceDirectory: session.evidenceDirectory
        }))
      }, options);
    }, options);
  });

program
  .command("restore")
  .description("把校准恢复到指定修订，并保留新的审计记录")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--revision <number>", "目标修订")
  .requiredOption("--base-revision <number>", "当前修订；用于阻止并发覆盖")
  .option("--label <text>", "恢复说明")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; revision: string; baseRevision: string; label?: string; json?: boolean }) => {
    await run(async () => {
      const result = await restoreCalibrationRevision(resolve(options.project), Number(options.revision), Number(options.baseRevision), options.label);
      print({ ok: true, revision: result.calibration.revision, session: result.session }, options);
    }, options);
  });

program
  .command("evidence")
  .description("把用户确认的校准会话标记为可复用证据，或明确拒绝")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--session <id>", "校准会话 ID")
  .requiredOption("--status <status>", "accepted、rejected 或 unreviewed")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; session: string; status: string; json?: boolean }) => {
    await run(async () => {
      if (!["accepted", "rejected", "unreviewed"].includes(options.status)) throw new PuppetLoomError("INVALID_INPUT", "status 必须是 accepted、rejected 或 unreviewed。" );
      print(await setCalibrationEvidenceStatus(resolve(options.project), options.session, options.status as "accepted" | "rejected" | "unreviewed"), options);
    }, options);
  });

program
  .command("enhance")
  .description("验证并接入可选闭眼和三态嘴形素材；不合格素材自动忽略")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--assets <supplement-dir>", "补充素材目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; assets: string; json?: boolean }) => {
    await run(async () => {
      const result = await enhanceProject({ project: resolve(options.project), assets: resolve(options.assets) });
      print({ ok: true, accepted: result.accepted, rejected: result.rejected }, options);
    }, options);
  });

program
  .command("record")
  .description("为准确校准修订录制确定性的透明动态证据")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--output <directory>", "证据输出目录")
  .option("--mode <kind>", "autonomous 或 secondary", "autonomous")
  .option("--duration <seconds>", "录制时长，2 到 120 秒", "12")
  .option("--fps <number>", "帧率，1 到 60", "12")
  .option("--revision <number>", "指定校准修订")
  .option("--ffmpeg <path>", "覆盖 ffmpeg 路径")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; output: string; mode: string; duration: string; fps: string; revision?: string; ffmpeg?: string; json?: boolean }) => {
    await run(async () => {
      if (!['autonomous', 'secondary'].includes(options.mode)) throw new PuppetLoomError("INVALID_INPUT", "mode 必须是 autonomous 或 secondary。" );
      const duration = Number(options.duration);
      const fps = Number(options.fps);
      const revision = options.revision === undefined ? undefined : Number(options.revision);
      if (!Number.isFinite(duration) || duration < 2 || duration > 120) throw new PuppetLoomError("INVALID_INPUT", "duration 必须在 2 到 120 秒之间。" );
      if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new PuppetLoomError("INVALID_INPUT", "fps 必须是 1 到 60 的整数。" );
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw new PuppetLoomError("INVALID_INPUT", "revision 必须是非负整数。" );
      const arguments_ = [
        "--project", resolve(options.project),
        "--output", resolve(options.output),
        "--mode", options.mode,
        "--duration", String(duration),
        "--fps", String(fps),
        ...(revision !== undefined ? ["--revision", String(revision)] : []),
        ...(options.ffmpeg ? ["--ffmpeg", resolve(options.ffmpeg)] : [])
      ];
      print(await runWorkspaceTool("record-motion-evidence.mjs", arguments_), options);
    }, options);
  });

program
  .command("play")
  .description("在透明、无边框角色窗口中运行现有项目")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--revision <number>", "运行指定校准修订")
  .action(async (options: { project: string; revision?: string }) => {
    await run(async () => {
      const revision = options.revision === undefined ? undefined : Number(options.revision);
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw new PuppetLoomError("INVALID_INPUT", "revision 必须是非负整数。" );
      await launchDesktop(["--project", resolve(options.project), ...(revision !== undefined ? ["--revision", String(revision)] : [])]);
    });
  });

program
  .command("edit")
  .description("在 PuppetLoom 桌面编辑器中打开项目")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .action(async (options: { project: string }) => {
    await run(async () => launchDesktop(["--edit", "--project", resolve(options.project)]));
  });

function configureCommandParsing(command: Command): void {
  command.exitOverride();
  if (parseAsJson) command.configureOutput({ writeErr: () => undefined });
  for (const child of command.commands) configureCommandParsing(child);
}

configureCommandParsing(program);
try {
  await program.parseAsync(process.argv);
} catch (error: unknown) {
  if (!(error instanceof CommanderError && (error.code === "commander.helpDisplayed" || error.code === "commander.version"))) {
    const code = exitCode(error);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(parseAsJson ? `${JSON.stringify({ ok: false, error: message, exitCode: code })}\n` : `${message}\n`);
    process.exitCode = code;
  }
}
