import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { applyAssetAssembly, planAssetAssembly, prepareAssetReference, registerAssetImage } from "@puppetloom/core";
import { print, run } from "../cli-support.js";

export function registerAssetCommands(program: Command): void {
  const assets = program.command("assets").description("准备补件参考、登记 PNG 配准、试装并以可恢复修订应用");
  assets.command("reference")
    .requiredOption("--project <directory>", "角色项目")
    .requiredOption("--layer <id>", "提供外观、父级和运动继承的参考图层")
    .option("--json", "输出 JSON")
    .action(async (options: { project: string; layer: string; json?: boolean }) => run(async () => print(await prepareAssetReference(options.project, options.layer), options), options));
  assets.command("register")
    .requiredOption("--project <directory>", "角色项目")
    .requiredOption("--reference <id>", "参考记录 ID")
    .requiredOption("--image <png>", "原始 PNG；不会覆盖原文件")
    .requiredOption("--registration <json>", "frame 或 landmarks 配准 JSON，坐标单位为像素")
    .option("--json", "输出 JSON")
    .action(async (options: { project: string; reference: string; image: string; registration: string; json?: boolean }) => run(async () => print(await registerAssetImage(options.project, options.reference, options.image, JSON.parse(await readFile(options.registration, "utf8"))), options), options));
  assets.command("preview")
    .requiredOption("--project <directory>", "角色项目")
    .requiredOption("--assembly <json>", "包含 baseRevision、additions、replaceLayerIds 的试装 JSON")
    .option("--json", "输出 JSON")
    .action(async (options: { project: string; assembly: string; json?: boolean }) => run(async () => print(await planAssetAssembly(options.project, JSON.parse(await readFile(options.assembly, "utf8"))), options), options));
  assets.command("apply")
    .requiredOption("--project <directory>", "角色项目")
    .requiredOption("--plan <id>", "已查看试装证据的计划 ID")
    .option("--json", "输出 JSON")
    .action(async (options: { project: string; plan: string; json?: boolean }) => run(async () => {
      const result = await applyAssetAssembly(options.project, options.plan);
      print({ ok: true, revision: result.calibration.revision, session: result.session, evidence: result.evidence, operation: result.operation }, options);
    }, options));
}
