import { resolve } from "node:path";
import {
  buildCubismExportPlan,
  clearCubismPreview,
  finalizeCubismExport,
  inspectCubismEditor,
  loadCalibration,
  loadProject,
  prepareCubismExport,
  previewCubismProject,
  PuppetLoomError,
  syncCubismProject,
  validateCubismEditorProject,
  verifyCubismModel,
  type CubismPreviewPose
} from "@puppetloom/core";
import type { Command } from "commander";
import { connectCubism, defaultCubismTokenFile, openCubismViewer, print, run } from "../cli-support.js";

export function registerCubismCommands(program: Command): void {
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
}
