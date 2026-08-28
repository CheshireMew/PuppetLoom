import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compareProjectRevisions,
  enhanceProject,
  prepareTrackingAssetRequests,
  listCalibrationSessions,
  loadCalibration,
  migrateProject,
  PuppetLoomError,
  renderProjectSuite,
  restoreCalibrationRevision,
  saveCalibrationPatch,
  setCalibrationEvidenceStatus,
  type CalibrationPatch,
  type RenderFocusScope,
  type RenderSuiteKind
} from "@puppetloom/core";
import type { Command } from "commander";
import { launchDesktop, print, run, runWorkspaceTool } from "../cli-support.js";
import { modelAgentScopes } from "./authoring.js";

export function registerProjectWorkflowCommands(program: Command): void {
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
    .command("performance")
    .description("测量指定项目和校准修订在活动与暂停状态下的真实帧率和长帧")
    .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
    .requiredOption("--output <new-directory>", "新建的性能证据目录")
    .option("--revision <number>", "指定校准修订；省略时锁定当前修订")
    .option("--trials <number>", "活动与暂停状态分别测量 1 到 5 轮", "3")
    .option("--json", "输出 JSON")
    .action(async (options: { project: string; output: string; revision?: string; trials: string; json?: boolean }) => {
      await run(async () => {
        const revision = options.revision === undefined ? undefined : Number(options.revision);
        const trials = Number(options.trials);
        if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw new PuppetLoomError("INVALID_INPUT", "revision 必须是非负整数。" );
        if (!Number.isInteger(trials) || trials < 1 || trials > 5) throw new PuppetLoomError("INVALID_INPUT", "trials 必须是 1 到 5 的整数。" );
        const result = await runWorkspaceTool("measure-project-performance.mjs", [
          "--project", resolve(options.project),
          "--output", resolve(options.output),
          "--trials", String(trials),
          ...(revision === undefined ? [] : ["--revision", String(revision)])
        ]) as { valid?: boolean };
        print(result, options);
        if (result.valid === false) process.exitCode = 3;
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
    .description("验证并接入可选闭眼和张口素材；不合格素材自动忽略")
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
    .command("tracking-assets")
    .description("为现有项目补充 A/I/U/E/O 口型任务与参考裁切；保留原请求和首份升级前文档")
    .requiredOption("--project <project-dir>", "PuppetLoom 项目目录")
    .option("--json", "输出 JSON")
    .action(async (options: { project: string; json?: boolean }) => {
      await run(async () => print({ ok: true, ...(await prepareTrackingAssetRequests(resolve(options.project))) }, options), options);
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
}
