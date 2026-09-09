#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCliBuild, skillIdentity } from "../../../scripts/lib/cli-build-identity.mjs";
import { exitCode } from "./cli-support.js";
import { registerAuthoringCommands } from "./commands/authoring.js";
import { registerAssetCommands } from "./commands/assets.js";
import { registerCubismCommands } from "./commands/cubism.js";
import { registerInputProjectCommands } from "./commands/input-project.js";
import { registerProjectWorkflowCommands } from "./commands/project-workflow.js";
import { registerProductionCommands } from "./commands/production.js";
import { registerRuntimeCommands } from "./commands/runtime.js";

const parseAsJson = process.argv.includes("--json");
const program = new Command()
  .name("puppetloom")
  .description("将分层角色 PSD 创建为安全、自主运动的 2D 角色项目")
  .version("0.1.0")
  .showHelpAfterError();

registerInputProjectCommands(program);
registerRuntimeCommands(program);
registerCubismCommands(program);
registerAuthoringCommands(program);
registerAssetCommands(program);
registerProjectWorkflowCommands(program);
registerProductionCommands(program);

program.command("capabilities")
  .description("返回当前 CLI 注册的命令、选项、构建身份与配套 Skill 身份")
  .option("--json", "输出 JSON")
  .action(async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const describe = (command: Command): unknown => ({
      name: command.name(), aliases: command.aliases(), description: command.description(),
      options: command.options.map((option) => ({ flags: option.flags, required: option.mandatory, description: option.description, ...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}) })),
      commands: command.commands.map(describe)
    });
    const build = await inspectCliBuild(root);
    process.stdout.write(`${JSON.stringify({ protocol: 1, build, skill: await skillIdentity(root), commands: program.commands.map(describe), note: "命令已注册不代表外部设备、桌面进程或 Cubism 已就绪；这些命令仍执行各自的运行时检查。" }, null, 2)}\n`);
    if (!build.current) process.exitCode = 2;
  });

function configureCommandParsing(command: Command): void {
  command.exitOverride();
  if (parseAsJson) command.configureOutput({ writeErr: () => undefined });
  for (const child of command.commands) configureCommandParsing(child);
}

configureCommandParsing(program);
try {
  if (process.argv[2] !== "capabilities" && !process.argv.some((argument) => ["--help", "-h", "--version", "-V"].includes(argument))) {
    const build = await inspectCliBuild(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
    if (!build.current) throw new Error(`CLI 构建不是当前源码：${build.problems.join("；")}。请运行 npm run build -w @puppetloom/cli。`);
  }
  await program.parseAsync(process.argv);
} catch (error: unknown) {
  if (!(error instanceof CommanderError && (error.code === "commander.helpDisplayed" || error.code === "commander.version"))) {
    const code = exitCode(error);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(parseAsJson ? `${JSON.stringify({ ok: false, error: message, exitCode: code })}\n` : `${message}\n`);
    process.exitCode = code;
  }
}
