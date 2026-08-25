import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  finalizeSourceReview,
  applyProductionConfiguration,
  analyzeCrossProjectImprovements,
  inspectProductionConfiguration,
  inspectWindowsEnvironment,
  editPerformanceTake,
  exportPerformanceTake,
  importPerformanceTake,
  listPerformanceTakes,
  writeImprovementAnalysis,
  inspectProjectHealth,
  prepareSourceTask,
  PuppetLoomError,
  reviewSourceCandidate,
  scanProjectLibrary
} from "@puppetloom/core";
import type { Command } from "commander";
import { positiveInteger, print, run } from "../cli-support.js";

function libraryMarkdown(report: Awaited<ReturnType<typeof scanProjectLibrary>>): string {
  const rows = report.projects.length > 0
    ? report.projects.map((project) => `| ${project.project} | ${project.revision} | ${project.score} | ${project.valid ? "通过" : "失败"} | ${project.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.message).join("；") || "—"} |`).join("\n")
    : "| — | — | — | 未发现项目 | — |";
  return `# PuppetLoom 项目库体检\n\n扫描根目录：${report.root}\n\n生成时间：${report.generatedAt}\n\n项目：${report.summary.total}；有效：${report.summary.valid}；需要处理：${report.summary.needsAttention}；平均分：${report.summary.averageScore}。\n\n| 项目 | Revision | 分数 | 验证 | 需要处理 |\n| --- | ---: | ---: | --- | --- |\n${rows}\n`;
}

export function registerProductionCommands(program: Command): void {
  program
    .command("environment-doctor")
    .description("检查 Windows、D 盘运行目录、面捕模型、GPU、FFmpeg、桌面/Web 构建和安装器工具")
    .option("--workspace <directory>", "源码工作区；默认当前目录")
    .option("--json", "输出 JSON")
    .action(async (options: { workspace?: string; json?: boolean }) => {
      await run(async () => {
        const report = await inspectWindowsEnvironment(resolve(options.workspace ?? process.cwd()));
        print(report, options); if (!report.ready) process.exitCode = 3;
      }, options);
    });

  program
    .command("doctor")
    .description("生成项目文件、历史、证据、素材和表演能力的统一体检报告")
    .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
    .option("--json", "输出 JSON")
    .action(async (options: { project: string; json?: boolean }) => {
      await run(async () => {
        const report = await inspectProjectHealth(resolve(options.project));
        print(report, options);
        if (!report.valid || report.issues.some((issue) => issue.severity === "error")) process.exitCode = 3;
      }, options);
    });

  const library = program.command("library").description("扫描和体检用户选择的多角色项目目录");
  library
    .command("scan")
    .description("有界扫描项目库，生成每个角色的能力、缺失素材、证据和下一步报告")
    .requiredOption("--root <directory>", "只扫描这个目录及其子目录")
    .option("--depth <number>", "最大递归深度，0 到 8", "4")
    .option("--limit <number>", "最多读取的项目数，1 到 500", "200")
    .option("--output <new-directory>", "可选的新报告目录")
    .option("--json", "输出 JSON")
    .action(async (options: { root: string; depth: string; limit: string; output?: string; json?: boolean }) => {
      await run(async () => {
        const depth = positiveInteger(String(Number(options.depth) + 1), "depth") - 1;
        if (depth > 8) throw new PuppetLoomError("INVALID_INPUT", "depth 必须在 0 到 8 之间。" );
        const limit = positiveInteger(options.limit, "limit");
        if (limit > 500) throw new PuppetLoomError("INVALID_INPUT", "limit 必须在 1 到 500 之间。" );
        const report = await scanProjectLibrary(resolve(options.root), { maxDepth: depth, maximumProjects: limit });
        if (options.output) {
          const output = resolve(options.output);
          if (existsSync(output)) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `项目库报告目录已经存在：${output}`);
          await mkdir(output, { recursive: true });
          await writeFile(join(output, "project-library.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
          await writeFile(join(output, "project-library.md"), libraryMarkdown(report), "utf8");
          print({ ...report, output }, options);
        } else print(report, options);
        if (report.failures.length > 0) process.exitCode = 3;
      }, options);
    });

  const source = program.command("source").description("从单张原画准备、复核并确认进入 PuppetLoom 的分层素材");
  source
    .command("prepare")
    .description("创建自包含的原画分层任务和 See-Through 官方交接说明")
    .requiredOption("--reference <image>", "单张原画")
    .requiredOption("--output <new-task-directory>", "新的素材任务目录")
    .option("--name <name>", "角色名称")
    .option("--provider <provider>", "see-through-official 或 external", "see-through-official")
    .option("--json", "输出 JSON")
    .action(async (options: { reference: string; output: string; name?: string; provider: string; json?: boolean }) => {
      await run(async () => {
        if (options.provider !== "see-through-official" && options.provider !== "external") throw new PuppetLoomError("INVALID_INPUT", "provider 必须是 see-through-official 或 external。" );
        print(await prepareSourceTask({ reference: resolve(options.reference), output: resolve(options.output), ...(options.name ? { name: options.name } : {}), provider: options.provider }), options);
      }, options);
    });

  source
    .command("review")
    .description("保存一版候选 PSD，并生成原画对比、三种背景、逐图层和结构证据")
    .requiredOption("--task <task-directory>", "素材任务目录")
    .requiredOption("--psd <candidate.psd>", "待复核的分层 PSD")
    .option("--json", "输出 JSON")
    .action(async (options: { task: string; psd: string; json?: boolean }) => {
      await run(async () => {
        const result = await reviewSourceCandidate({ task: resolve(options.task), psd: resolve(options.psd) });
        print(result, options);
        if (result.blockers.length > 0) process.exitCode = 4;
      }, options);
    });

  source
    .command("finalize")
    .description("记录准确候选版本的人工目视结论；不删除或覆盖旧候选")
    .requiredOption("--task <task-directory>", "素材任务目录")
    .requiredOption("--review <number>", "复核序号")
    .requiredOption("--decision <decision>", "ready 或 needs-repair")
    .requiredOption("--note <text>", "基于画面的具体结论")
    .option("--json", "输出 JSON")
    .action(async (options: { task: string; review: string; decision: string; note: string; json?: boolean }) => {
      await run(async () => {
        if (options.decision !== "ready" && options.decision !== "needs-repair") throw new PuppetLoomError("INVALID_INPUT", "decision 必须是 ready 或 needs-repair。" );
        print(await finalizeSourceReview({ task: resolve(options.task), review: positiveInteger(options.review, "review"), decision: options.decision, note: options.note }), options);
      }, options);
    });

  const production = program.command("production-config").description("管理服装变体、道具、状态预设、运动范围和图层碰撞约束");
  production
    .command("inspect")
    .description("输出可直接编辑后重新应用的完整制作配置")
    .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
    .option("--output <new-json>", "可选的新配置 JSON；不会覆盖")
    .option("--json", "输出 JSON")
    .action(async (options: { project: string; output?: string; json?: boolean }) => {
      await run(async () => {
        const document = await inspectProductionConfiguration(resolve(options.project));
        if (options.output) {
          const output = resolve(options.output);
          if (existsSync(output)) throw new PuppetLoomError("INVALID_INPUT", `输出文件已存在，不会覆盖：${output}`);
          await mkdir(resolve(output, ".."), { recursive: true });
          await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
          print({ ok: true, output, document }, options);
        } else print(document, options);
      }, options);
    });
  production
    .command("apply")
    .description("验证并原子应用制作配置；保留首份修改前项目文档")
    .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
    .requiredOption("--config <production.json>", "version 1 制作配置")
    .option("--json", "输出 JSON")
    .action(async (options: { project: string; config: string; json?: boolean }) => {
      await run(async () => {
        const document = JSON.parse(await readFile(resolve(options.config), "utf8")) as unknown;
        print({ ok: true, ...(await applyProductionConfiguration(resolve(options.project), document)) }, options);
      }, options);
    });

  const take = program.command("take").description("管理项目内非破坏性的表演 Take，并进行裁切、变速、平滑与通道静音");
  take.command("list").requiredOption("--project <project-dir>", "PuppetLoom 项目目录").option("--json", "输出 JSON")
    .action(async (options: { project: string; json?: boolean }) => run(async () => print({ project: resolve(options.project), takes: await listPerformanceTakes(resolve(options.project)) }, options), options));
  take.command("import").description("把动作会话导入 Take 库，原文件保持不变")
    .requiredOption("--project <project-dir>", "PuppetLoom 项目目录").requiredOption("--session <session.json>", "运行时动作会话")
    .option("--name <name>", "Take 名称").option("--tag <tag>", "标签，可重复", (value: string, previous: string[]) => [...previous, value], []).option("--note <text>", "备注").option("--json", "输出 JSON")
    .action(async (options: { project: string; session: string; name?: string; tag?: string[]; note?: string; json?: boolean }) => run(async () => print(await importPerformanceTake(resolve(options.project), JSON.parse(await readFile(resolve(options.session), "utf8")) as unknown, { ...(options.name ? { name: options.name } : {}), ...(options.tag?.length ? { tags: options.tag } : {}), ...(options.note ? { note: options.note } : {}) }), options), options));
  take.command("edit").description("从已有 Take 创建编辑版；operations JSON 支持 trim、speed、smoothWindow、muteSources、muteMotion、muteParameters、muteExpressions、name、tags 和 note")
    .requiredOption("--project <project-dir>", "PuppetLoom 项目目录").requiredOption("--take <id>", "原 Take ID").requiredOption("--operations <edit.json>", "编辑操作 JSON").option("--json", "输出 JSON")
    .action(async (options: { project: string; take: string; operations: string; json?: boolean }) => run(async () => print(await editPerformanceTake(resolve(options.project), options.take, JSON.parse(await readFile(resolve(options.operations), "utf8")) as never), options), options));
  take.command("export").description("导出为可回放动作会话 JSON 或逐事件 CSV")
    .requiredOption("--project <project-dir>", "PuppetLoom 项目目录").requiredOption("--take <id>", "Take ID").requiredOption("--output <new-file>", "尚不存在的输出文件")
    .option("--format <format>", "session-json 或 events-csv", "session-json").option("--json", "输出 JSON")
    .action(async (options: { project: string; take: string; output: string; format: string; json?: boolean }) => run(async () => {
      if (options.format !== "session-json" && options.format !== "events-csv") throw new PuppetLoomError("INVALID_INPUT", "format 必须是 session-json 或 events-csv。");
      print({ ok: true, output: await exportPerformanceTake(resolve(options.project), options.take, resolve(options.output), options.format) }, options);
    }, options));

  const improvements = program.command("improvements").description("从多个角色的重复缺口和已接受证据中提炼优化候选；不会自动修改默认值");
  improvements.command("analyze")
    .requiredOption("--root <project-library>", "项目库根目录").requiredOption("--output <new-directory>", "尚不存在的报告目录").option("--json", "输出 JSON")
    .action(async (options: { root: string; output: string; json?: boolean }) => run(async () => {
      const output = resolve(options.output); if (existsSync(output)) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `报告目录已存在：${output}`);
      const report = await analyzeCrossProjectImprovements(resolve(options.root));
      print({ ...report, output: await writeImprovementAnalysis(report, output) }, options);
    }, options));
}
