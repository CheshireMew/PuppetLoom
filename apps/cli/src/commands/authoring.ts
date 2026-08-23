import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createModelAgentSpecificationTemplate,
  describeAuthoringProject,
  describeProject,
  loadCalibration,
  loadProject,
  planFrontHairAgent,
  planModelAgent,
  planRigExtensionUpgrade,
  planSecondaryPartAgent,
  planStandardPerformanceActions,
  PuppetLoomError,
  readModelAgentSpecification,
  runFrontHairAgent,
  runModelAgent,
  runSecondaryPartAgent,
  saveAuthoringPatch,
  saveCalibrationPatch,
  type AuthoringPatch,
  type ModelAgentOptions,
  type ModelAgentPart,
  type ModelAgentRequestScope,
  type SecondaryModelAgentPart
} from "@puppetloom/core";
import type { Command } from "commander";
import { print, run } from "../cli-support.js";

export const modelAgentScopes = ["whole", "headFace", "eyes", "mouth", "frontHair", "backHair", "ahoge", "ears", "headwear", "body", "topCloth", "skirt", "tail", "accessory"] as const;

export function registerAuthoringCommands(program: Command): void {
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
}
