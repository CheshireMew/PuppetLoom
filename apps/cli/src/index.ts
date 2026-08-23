#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { exitCode } from "./cli-support.js";
import { registerAuthoringCommands } from "./commands/authoring.js";
import { registerCubismCommands } from "./commands/cubism.js";
import { registerInputProjectCommands } from "./commands/input-project.js";
import { registerProjectWorkflowCommands } from "./commands/project-workflow.js";
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
registerProjectWorkflowCommands(program);

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
