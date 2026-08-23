import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  parseRuntimeControlRequest,
  parseRuntimeControlServiceRequest,
  parseRuntimeInputSession,
  PuppetLoomError,
  type RuntimeInputSession,
  type RuntimeMotionInput
} from "@puppetloom/core";
import type { Command } from "commander";
import { assignment, assignments, finiteOption, positiveInteger, print, run, sendRuntimeControl } from "../cli-support.js";

export function registerRuntimeCommands(program: Command): void {
  const runtime = program.command("runtime").description("检查并实时控制已打开的角色窗口，供外部 Agent、输入设备和自动化脚本调用");

  runtime
    .command("inspect")
    .description("列出运行中的角色窗口及其可用参数、表情和动作")
    .option("--url <address>", "运行时控制服务地址；默认读取 D:\\Tools\\PuppetLoom\\user-data\\runtime-control.json")
    .option("--json", "输出 JSON")
    .action(async (options: { url?: string; json?: boolean }) => {
      await run(async () => print(await sendRuntimeControl({ version: 1, requestId: randomUUID(), op: "inspect" }, options.url), options), options);
    });

  runtime
    .command("set")
    .description("设置一个持续或带超时的控制来源；同一 source 的下一次设置会替换上一次")
    .requiredOption("--viewer <id>", "角色窗口 ID")
    .requiredOption("--source <id>", "控制来源 ID，例如 camera、microphone 或 agent-demo")
    .option("--head-yaw <value>", "头部左右，-1 到 1")
    .option("--head-pitch <value>", "头部俯仰，-1 到 1")
    .option("--head-roll <value>", "头部侧倾，-1 到 1")
    .option("--body-sway <value>", "身体左右，-1 到 1")
    .option("--body-pitch <value>", "身体俯仰，-1 到 1")
    .option("--body-roll <value>", "身体侧倾，-1 到 1")
    .option("--gaze-x <value>", "视线左右，-1 到 1")
    .option("--gaze-y <value>", "视线上下，-1 到 1")
    .option("--breath <value>", "呼吸，-1 到 1")
    .option("--blink <value>", "闭眼，0 到 1")
    .option("--mouth-open <value>", "张嘴，0 到 1")
    .option("--parameter <id=value>", "模型参数，可重复", assignment, [])
    .option("--expression <id=value>", "表情强度，可重复", assignment, [])
    .option("--priority <value>", "优先级 0 到 100；高优先级后混合", "50")
    .option("--blend <value>", "来源混合比例 0 到 1", "1")
    .option("--ttl <milliseconds>", "50 到 60000 毫秒；超时后自动回到自主动作")
    .option("--url <address>", "运行时控制服务地址")
    .option("--json", "输出 JSON")
    .action(async (options: {
      viewer: string; source: string; headYaw?: string; headPitch?: string; headRoll?: string; bodySway?: string; bodyPitch?: string; bodyRoll?: string;
      gazeX?: string; gazeY?: string; breath?: string; blink?: string; mouthOpen?: string; parameter?: string[]; expression?: string[];
      priority: string; blend: string; ttl?: string; url?: string; json?: boolean;
    }) => {
      await run(async () => {
        const motion = Object.fromEntries(Object.entries({
          headYaw: finiteOption(options.headYaw, "head-yaw", -1, 1),
          headPitch: finiteOption(options.headPitch, "head-pitch", -1, 1),
          headRoll: finiteOption(options.headRoll, "head-roll", -1, 1),
          bodySway: finiteOption(options.bodySway, "body-sway", -1, 1),
          bodyPitch: finiteOption(options.bodyPitch, "body-pitch", -1, 1),
          bodyRoll: finiteOption(options.bodyRoll, "body-roll", -1, 1),
          gazeX: finiteOption(options.gazeX, "gaze-x", -1, 1),
          gazeY: finiteOption(options.gazeY, "gaze-y", -1, 1),
          breath: finiteOption(options.breath, "breath", -1, 1),
          blink: finiteOption(options.blink, "blink", 0, 1),
          mouthOpen: finiteOption(options.mouthOpen, "mouth-open", 0, 1)
        }).filter((entry): entry is [string, number] => entry[1] !== undefined)) as RuntimeMotionInput;
        const parameters = assignments(options.parameter, "parameter");
        const expressions = assignments(options.expression, "expression");
        const request = parseRuntimeControlRequest({
          version: 1,
          requestId: randomUUID(),
          op: "set",
          viewerId: positiveInteger(options.viewer, "viewer"),
          source: {
            id: options.source,
            priority: finiteOption(options.priority, "priority", 0, 100),
            blend: finiteOption(options.blend, "blend", 0, 1),
            ...(options.ttl === undefined ? {} : { ttlMs: finiteOption(options.ttl, "ttl", 50, 60_000) }),
            ...(Object.keys(motion).length ? { motion } : {}),
            ...(parameters ? { parameters } : {}),
            ...(expressions ? { expressions } : {})
          }
        });
        print(await sendRuntimeControl(request, options.url), options);
      }, options);
    });

  runtime
    .command("trigger")
    .description("触发表情或动作；非循环动作结束后自动释放")
    .requiredOption("--viewer <id>", "角色窗口 ID")
    .requiredOption("--source <id>", "触发来源 ID")
    .option("--behavior <id>", "动作 ID")
    .option("--expression <id>", "表情 ID")
    .option("--strength <value>", "强度 0 到 1", "1")
    .option("--duration <milliseconds>", "持续时间；省略时使用动作自身时长，表情默认 1000 毫秒")
    .option("--priority <value>", "优先级 0 到 100", "70")
    .option("--url <address>", "运行时控制服务地址")
    .option("--json", "输出 JSON")
    .action(async (options: { viewer: string; source: string; behavior?: string; expression?: string; strength: string; duration?: string; priority: string; url?: string; json?: boolean }) => {
      await run(async () => {
        const request = parseRuntimeControlRequest({
          version: 1, requestId: randomUUID(), op: "trigger", viewerId: positiveInteger(options.viewer, "viewer"), sourceId: options.source,
          ...(options.behavior ? { behaviorId: options.behavior } : {}),
          ...(options.expression ? { expressionId: options.expression } : {}),
          strength: finiteOption(options.strength, "strength", 0, 1),
          ...(options.duration === undefined ? {} : { durationMs: finiteOption(options.duration, "duration", 50, 600_000) }),
          priority: finiteOption(options.priority, "priority", 0, 100)
        });
        print(await sendRuntimeControl(request, options.url), options);
      }, options);
    });

  runtime
    .command("release")
    .description("释放一个控制来源；省略 source 时释放该角色的全部外部控制")
    .requiredOption("--viewer <id>", "角色窗口 ID")
    .option("--source <id>", "控制来源 ID")
    .option("--url <address>", "运行时控制服务地址")
    .option("--json", "输出 JSON")
    .action(async (options: { viewer: string; source?: string; url?: string; json?: boolean }) => {
      await run(async () => {
        const request = parseRuntimeControlRequest({ version: 1, requestId: randomUUID(), op: "release", viewerId: positiveInteger(options.viewer, "viewer"), ...(options.source ? { sourceId: options.source } : {}) });
        print(await sendRuntimeControl(request, options.url), options);
      }, options);
    });

  runtime
    .command("record-start")
    .description("开始录制该角色收到的摄像头、麦克风、快捷键和外部控制事件")
    .requiredOption("--viewer <id>", "角色窗口 ID")
    .option("--url <address>", "运行时控制服务地址")
    .option("--json", "输出 JSON")
    .action(async (options: { viewer: string; url?: string; json?: boolean }) => {
      await run(async () => print(await sendRuntimeControl(parseRuntimeControlServiceRequest({
        version: 1, requestId: randomUUID(), op: "record-start", viewerId: positiveInteger(options.viewer, "viewer")
      }), options.url), options), options);
    });

  runtime
    .command("record-stop")
    .description("停止输入录制，并保存为可确定性回放的 JSON；不会覆盖已有文件")
    .requiredOption("--viewer <id>", "角色窗口 ID")
    .requiredOption("--output <session.json>", "尚不存在的输出 JSON")
    .option("--url <address>", "运行时控制服务地址")
    .option("--json", "输出 JSON")
    .action(async (options: { viewer: string; output: string; url?: string; json?: boolean }) => {
      await run(async () => {
        const output = resolve(options.output);
        if (existsSync(output)) throw new PuppetLoomError("INVALID_INPUT", `输出文件已存在，不会覆盖：${output}`);
        const result = await sendRuntimeControl(parseRuntimeControlServiceRequest({
          version: 1, requestId: randomUUID(), op: "record-stop", viewerId: positiveInteger(options.viewer, "viewer")
        }), options.url) as { session: RuntimeInputSession };
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify(result.session, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        print({ ...result, output }, options);
      }, options);
    });

  runtime
    .command("replay")
    .description("按原时间线回放输入会话；回放来源与当前实时输入相互隔离")
    .requiredOption("--viewer <id>", "角色窗口 ID")
    .requiredOption("--input <session.json>", "输入会话 JSON")
    .option("--speed <value>", "回放速度 0.1 到 4", "1")
    .option("--loop", "循环回放")
    .option("--url <address>", "运行时控制服务地址")
    .option("--json", "输出 JSON")
    .action(async (options: { viewer: string; input: string; speed: string; loop?: boolean; url?: string; json?: boolean }) => {
      await run(async () => {
        const session = parseRuntimeInputSession(JSON.parse(await readFile(resolve(options.input), "utf8")) as unknown);
        const request = parseRuntimeControlServiceRequest({
          version: 1, requestId: randomUUID(), op: "replay-start", viewerId: positiveInteger(options.viewer, "viewer"),
          session, speed: finiteOption(options.speed, "speed", 0.1, 4), loop: Boolean(options.loop)
        });
        print(await sendRuntimeControl(request, options.url), options);
      }, options);
    });

  runtime
    .command("replay-stop")
    .description("停止该角色正在进行的输入回放，并只释放回放创建的控制来源")
    .requiredOption("--viewer <id>", "角色窗口 ID")
    .option("--url <address>", "运行时控制服务地址")
    .option("--json", "输出 JSON")
    .action(async (options: { viewer: string; url?: string; json?: boolean }) => {
      await run(async () => print(await sendRuntimeControl(parseRuntimeControlServiceRequest({
        version: 1, requestId: randomUUID(), op: "replay-stop", viewerId: positiveInteger(options.viewer, "viewer")
      }), options.url), options), options);
    });
}
