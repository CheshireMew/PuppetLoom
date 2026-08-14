#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PuppetLoomError,
  createProject,
  enhanceProject,
  inspectPsd,
  verifyProject
} from "@puppetloom/core";
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
      const cliDirectory = dirname(fileURLToPath(import.meta.url));
      const desktopMain = resolve(cliDirectory, "../../desktop/dist/electron/main.js");
      if (!existsSync(desktopMain)) throw new PuppetLoomError("IO_ERROR", "桌面应用尚未构建，请先运行 npm run build。");
      const electronModule = await import("electron");
      const electronBinary = String(electronModule.default);
      await new Promise<void>((resolveChild, rejectChild) => {
        const child = spawn(electronBinary, [desktopMain, "--project", resolve(options.project)], { stdio: "inherit", windowsHide: false });
        child.once("error", rejectChild);
        child.once("exit", (code) => {
          if (code === 0) resolveChild();
          else rejectChild(new PuppetLoomError("IO_ERROR", `角色窗口退出，代码 ${code ?? "unknown"}。`));
        });
      });
    });
  });

program.exitOverride();
program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CommanderError && (error.code === "commander.helpDisplayed" || error.code === "commander.version")) return;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = exitCode(error);
});
