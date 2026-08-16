#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PuppetLoomError,
  compareProjectRevisions,
  createProject,
  describeProject,
  enhanceProject,
  inspectPsd,
  listCalibrationSessions,
  renderProjectSuite,
  restoreCalibrationRevision,
  saveCalibrationPatch,
  setCalibrationEvidenceStatus,
  verifyProject
} from "@puppetloom/core";
import type { CalibrationPatch, RenderSuiteKind } from "@puppetloom/core";
import { Command, CommanderError } from "commander";

type OutputOptions = { json?: boolean };

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
  .command("describe")
  .description("列出 Agent 和编辑器可以调整的控制点、图层、网格与当前校准修订")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; json?: boolean }) => {
    await run(async () => print(await describeProject(resolve(options.project)), options), options);
  });

program
  .command("render")
  .description("渲染确定性的姿态、次级运动或完整校准证据")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--output <directory>", "证据输出目录")
  .option("--suite <kind>", "calibration、poses 或 motion", "calibration")
  .option("--revision <number>", "指定校准修订")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; output: string; suite: string; revision?: string; json?: boolean }) => {
    await run(async () => {
      if (!["calibration", "poses", "motion"].includes(options.suite)) throw new PuppetLoomError("INVALID_INPUT", "suite 必须是 calibration、poses 或 motion。" );
      const revision = options.revision === undefined ? undefined : Number(options.revision);
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw new PuppetLoomError("INVALID_INPUT", "revision 必须是非负整数。" );
      const result = await renderProjectSuite(resolve(options.project), resolve(options.output), options.suite as RenderSuiteKind, revision);
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
      const evidence = await compareProjectRevisions(
        project,
        result.session.fromRevision,
        result.session.toRevision,
        join(project, "reports", "calibration", result.session.id)
      );
      print({ ok: true, revision: result.calibration.revision, session: result.session, sessionPath: result.sessionPath, evidence }, options);
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
  .description("读取项目校准历史")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; json?: boolean }) => {
    await run(async () => print({ sessions: await listCalibrationSessions(resolve(options.project)) }, options), options);
  });

program
  .command("restore")
  .description("把校准恢复到指定修订，并保留新的审计记录")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .requiredOption("--revision <number>", "目标修订")
  .option("--label <text>", "恢复说明")
  .option("--json", "输出 JSON")
  .action(async (options: { project: string; revision: string; label?: string; json?: boolean }) => {
    await run(async () => {
      const result = await restoreCalibrationRevision(resolve(options.project), Number(options.revision), options.label);
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
  .description("验证并接入可选闭眼素材；不合格素材自动忽略")
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
  .command("play")
  .description("在透明、无边框角色窗口中运行现有项目")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .action(async (options: { project: string }) => {
    await run(async () => {
      await launchDesktop(["--project", resolve(options.project)]);
    });
  });

program
  .command("edit")
  .description("在 PuppetLoom 桌面编辑器中打开项目")
  .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
  .action(async (options: { project: string }) => {
    await run(async () => launchDesktop(["--edit", "--project", resolve(options.project)]));
  });

program.exitOverride();
program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CommanderError && (error.code === "commander.helpDisplayed" || error.code === "commander.version")) return;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = exitCode(error);
});
