#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PuppetLoomError,
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
  planSecondaryPartAgent,
  inspectPsd,
  inspectCubismEditor,
  listCalibrationSessions,
  loadCalibration,
  loadProject,
  migrateProject,
  planModelAgent,
  readModelAgentSpecification,
  renderProjectSuite,
  runModelAgent,
  runFrontHairAgent,
  runSecondaryPartAgent,
  restoreCalibrationRevision,
  saveAuthoringPatch,
  saveCalibrationPatch,
  setCalibrationEvidenceStatus,
  syncCubismProject,
  prepareCubismExport,
  previewCubismProject,
  verifyCubismModel,
  verifyProject
} from "@puppetloom/core";
import type { AuthoringPatch, CalibrationPatch, CubismPreviewPose, ModelAgentOptions, ModelAgentPart, ModelAgentRequestScope, RenderFocusScope, RenderSuiteKind, SecondaryModelAgentPart } from "@puppetloom/core";
import { Command, CommanderError } from "commander";

type OutputOptions = { json?: boolean };

const defaultCubismTokenFile = join(process.env.LOCALAPPDATA ?? process.cwd(), "PuppetLoom", "cubism-editor-token.txt");

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
  .option("--json", "输出 JSON")
  .action(async (options: { input: string; reference?: string; json?: boolean }) => {
    await run(async () => {
      const report = await inspectPsd(resolve(options.input));
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
  .option("--json", "输出 JSON")
  .action(async (options: { input: string; reference?: string; output: string; seed: string; name?: string; json?: boolean }) => {
    await run(async () => {
      const seed = Number(options.seed);
      if (!Number.isSafeInteger(seed)) throw new PuppetLoomError("INVALID_INPUT", "seed 必须是安全整数。");
      const result = await createProject({
        input: resolve(options.input),
        output: resolve(options.output),
        seed,
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
  .description("生成参数映射、兼容性报告及 exp3/motion3/physics3/cdi3 文件，不生成 moc3")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--output <new-directory>", "尚不存在的准备目录")
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

const author = program.command("author").description("供 Agent 检查和修改参数、关键形态与变形器");

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
