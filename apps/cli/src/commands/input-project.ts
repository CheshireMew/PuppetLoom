import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createProject,
  executePhotoshopPsdRepairOperation,
  exportPortableProject,
  finalizePhotoshopPsdRepairVisualReview,
  inspectPsd,
  planPhotoshopPsdRepair,
  planPhotoshopPsdReview,
  PuppetLoomError,
  readCharacterBenchmarkManifest,
  runCharacterBenchmarks,
  verifyProject
} from "@puppetloom/core";
import type { Command } from "commander";
import { print, run, runPhotoshopRepairTool } from "../cli-support.js";

export function registerInputProjectCommands(program: Command): void {
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

  const psd = program.command("psd").description("检查或修复进入 PuppetLoom 前的分层 PSD");

  psd
    .command("repair")
    .description("按结构化配方通过本机 Photoshop 修复 PSD；只写入新的输出和工作目录")
    .requiredOption("--recipe <repair.json>", "修复配方")
    .requiredOption("--output <new.psd>", "尚不存在的新 PSD")
    .requiredOption("--workdir <new-directory>", "尚不存在的审计与复核目录")
    .option("--show-photoshop", "显示 Photoshop 窗口，便于观察或人工接管")
    .option("--dry-run", "只校验配方、输入、输出保护和哈希，不启动 Photoshop 或写文件")
    .option("--json", "输出 JSON")
    .action(async (options: { recipe: string; output: string; workdir: string; showPhotoshop?: boolean; dryRun?: boolean; json?: boolean }) => {
      await run(async () => {
        const plan = await planPhotoshopPsdRepair({ recipe: resolve(options.recipe), output: resolve(options.output), workDirectory: resolve(options.workdir) });
        if (options.dryRun) {
          print({ ok: true, stage: "psd-repair-planned", dryRun: true, ...plan }, options);
          return;
        }
        const execution = await executePhotoshopPsdRepairOperation(plan, async (resolvedRecipePath, output) => {
          await mkdir(dirname(output), { recursive: true });
          return runPhotoshopRepairTool(resolvedRecipePath, output, Boolean(options.showPhotoshop));
        });
        print(execution.result, options);
        if (execution.record.status === "awaiting-visual-review") process.exitCode = 4;
        if (execution.record.status === "failed") process.exitCode = 3;
      }, options);
    });

  psd
    .command("review")
    .description("重新打开现有 PSD，按修复配方生成白底、深色、棋盘和逐图层复核证据")
    .requiredOption("--input <character.psd>", "要复核的 PSD")
    .requiredOption("--recipe <repair.json>", "包含图层与 Alpha 检查要求的配方")
    .requiredOption("--workdir <operation-directory>", "新的复核目录，或需要恢复的原任务目录")
    .option("--json", "输出 JSON")
    .action(async (options: { input: string; recipe: string; workdir: string; json?: boolean }) => {
      await run(async () => {
        const plan = await planPhotoshopPsdReview({ input: resolve(options.input), recipe: resolve(options.recipe), workDirectory: resolve(options.workdir) });
        const execution = await executePhotoshopPsdRepairOperation(plan);
        print(execution.result, options);
        if (execution.record.status === "awaiting-visual-review") process.exitCode = 4;
        if (execution.record.status === "failed") process.exitCode = 3;
      }, options);
    });

  psd
    .command("finalize")
    .description("校验外部 Agent 已逐图查看的结论，并把 PSD 任务写入唯一终态")
    .requiredOption("--workdir <operation-directory>", "包含 operation.json 的 PSD 任务目录")
    .requiredOption("--decision <visual-review.json>", "由外部 Agent 填写完毕的视觉结论")
    .option("--json", "输出 JSON")
    .action(async (options: { workdir: string; decision: string; json?: boolean }) => {
      await run(async () => {
        const execution = await finalizePhotoshopPsdRepairVisualReview({ workDirectory: resolve(options.workdir), decision: resolve(options.decision) });
        print(execution.result, options);
        if (execution.record.status === "rejected") process.exitCode = 4;
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
}
