import { PuppetLoomError } from "./errors.js";

export const runtimeMotionInputKeys = [
  "headYaw", "headPitch", "headRoll",
  "bodySway", "bodyPitch", "bodyRoll",
  "gazeX", "gazeY", "breath", "blink", "mouthOpen"
] as const;

export type RuntimeMotionInputKey = typeof runtimeMotionInputKeys[number];
export type RuntimeMotionInput = Partial<Record<RuntimeMotionInputKey, number>>;

export interface RuntimeBehaviorControl {
  id: string;
  startedAtMs: number;
}

export interface RuntimeControlSource {
  id: string;
  priority: number;
  blend: number;
  updatedAtMs: number;
  expiresAtMs?: number;
  motion?: RuntimeMotionInput;
  parameters?: Record<string, number>;
  expressions?: Record<string, number>;
  behavior?: RuntimeBehaviorControl;
}

export interface RuntimeControlSnapshot {
  version: 1;
  viewerId: number;
  capturedAtMs: number;
  sources: RuntimeControlSource[];
}

export interface RuntimeViewerDescriptor {
  id: number;
  projectDirectory: string;
  projectName: string;
  revision?: number;
  parameters: Array<{ id: string; name: string; min: number; default: number; max: number; semantic?: string }>;
  expressions: Array<{ id: string; name: string }>;
  behaviors: Array<{ id: string; name: string; duration: number; loop: boolean }>;
}

export interface RuntimeControlInspectRequest {
  version: 1;
  requestId: string;
  op: "inspect";
}

export interface RuntimeControlSetRequest {
  version: 1;
  requestId: string;
  op: "set";
  viewerId: number;
  source: {
    id: string;
    priority?: number;
    blend?: number;
    ttlMs?: number;
    motion?: RuntimeMotionInput;
    parameters?: Record<string, number>;
    expressions?: Record<string, number>;
  };
}

export interface RuntimeControlTriggerRequest {
  version: 1;
  requestId: string;
  op: "trigger";
  viewerId: number;
  sourceId: string;
  behaviorId?: string;
  expressionId?: string;
  strength?: number;
  durationMs?: number;
  priority?: number;
}

export interface RuntimeControlReleaseRequest {
  version: 1;
  requestId: string;
  op: "release";
  viewerId: number;
  sourceId?: string;
}

export type RuntimeControlRequest = RuntimeControlInspectRequest | RuntimeControlSetRequest | RuntimeControlTriggerRequest | RuntimeControlReleaseRequest;

export type RuntimeInputSessionEvent =
  | { atMs: number; op: "set"; source: RuntimeControlSetRequest["source"] }
  | { atMs: number; op: "trigger"; sourceId: string; behaviorId?: string; expressionId?: string; strength?: number; durationMs?: number; priority?: number }
  | { atMs: number; op: "release"; sourceId?: string };

export interface RuntimeInputSession {
  version: 1;
  id: string;
  recordedAt: string;
  durationMs: number;
  viewer: { projectDirectory: string; projectName: string; revision?: number };
  events: RuntimeInputSessionEvent[];
}

export interface RuntimeRecordStartRequest {
  version: 1;
  requestId: string;
  op: "record-start";
  viewerId: number;
}

export interface RuntimeRecordStopRequest {
  version: 1;
  requestId: string;
  op: "record-stop";
  viewerId: number;
}

export interface RuntimeReplayStartRequest {
  version: 1;
  requestId: string;
  op: "replay-start";
  viewerId: number;
  session: RuntimeInputSession;
  speed?: number;
  loop?: boolean;
}

export interface RuntimeReplayStopRequest {
  version: 1;
  requestId: string;
  op: "replay-stop";
  viewerId: number;
}

export type RuntimeControlServiceRequest = RuntimeControlRequest | RuntimeRecordStartRequest | RuntimeRecordStopRequest | RuntimeReplayStartRequest | RuntimeReplayStopRequest;

export interface RuntimeControlResponse {
  version: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface RuntimeControlManifest {
  version: 1;
  status: "running" | "stopped";
  url: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PuppetLoomError("INVALID_INPUT", `${label}必须是对象。`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new PuppetLoomError("INVALID_INPUT", `${label}必须是 ${minimum} 到 ${maximum} 之间的有限数字。`);
  }
  return value;
}

function optionalNumbers(value: unknown, label: string, allowed?: ReadonlySet<string>, minimum = -1_000_000, maximum = 1_000_000): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  const source = record(value, label);
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(source)) {
    if (allowed && !allowed.has(key)) throw new PuppetLoomError("INVALID_INPUT", `${label}包含不支持的字段：${key}`);
    result[key] = finite(item, `${label}.${key}`, minimum, maximum);
  }
  return result;
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) throw new PuppetLoomError("INVALID_INPUT", `${label}必须是 1 到 128 字符的字符串。`);
  return value.trim();
}

function requiredText(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new PuppetLoomError("INVALID_INPUT", `${label}必须是 1 到 ${maximum} 字符的字符串。`);
  return value.trim();
}

function viewerId(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new PuppetLoomError("INVALID_INPUT", "viewerId 必须是正整数。" );
  return Number(value);
}

/** Strict transport-boundary parser shared by the desktop service and external clients. */
export function parseRuntimeControlRequest(value: unknown): RuntimeControlRequest {
  const input = record(value, "运行时控制请求");
  if (input.version !== 1) throw new PuppetLoomError("INVALID_INPUT", "运行时控制协议 version 必须是 1。" );
  const requestId = requiredId(input.requestId, "requestId");
  if (input.op === "inspect") return { version: 1, requestId, op: "inspect" };
  if (input.op === "release") {
    return {
      version: 1,
      requestId,
      op: "release",
      viewerId: viewerId(input.viewerId),
      ...(input.sourceId === undefined ? {} : { sourceId: requiredId(input.sourceId, "sourceId") })
    };
  }
  if (input.op === "set") {
    const source = record(input.source, "source");
    const rawMotion = optionalNumbers(source.motion, "source.motion", new Set(runtimeMotionInputKeys), -1, 1) as RuntimeMotionInput | undefined;
    const motion = rawMotion && {
      ...rawMotion,
      ...(rawMotion.blink === undefined ? {} : { blink: finite(rawMotion.blink, "source.motion.blink", 0, 1) }),
      ...(rawMotion.mouthOpen === undefined ? {} : { mouthOpen: finite(rawMotion.mouthOpen, "source.motion.mouthOpen", 0, 1) })
    };
    const parameters = optionalNumbers(source.parameters, "source.parameters");
    const expressions = optionalNumbers(source.expressions, "source.expressions");
    if (!motion && !parameters && !expressions) throw new PuppetLoomError("INVALID_INPUT", "set 至少要提供 motion、parameters 或 expressions。" );
    return {
      version: 1,
      requestId,
      op: "set",
      viewerId: viewerId(input.viewerId),
      source: {
        id: requiredId(source.id, "source.id"),
        ...(source.priority === undefined ? {} : { priority: finite(source.priority, "source.priority", 0, 100) }),
        ...(source.blend === undefined ? {} : { blend: finite(source.blend, "source.blend", 0, 1) }),
        ...(source.ttlMs === undefined ? {} : { ttlMs: finite(source.ttlMs, "source.ttlMs", 50, 60_000) }),
        ...(motion ? { motion } : {}),
        ...(parameters ? { parameters } : {}),
        ...(expressions ? { expressions } : {})
      }
    };
  }
  if (input.op === "trigger") {
    const behaviorId = input.behaviorId === undefined ? undefined : requiredId(input.behaviorId, "behaviorId");
    const expressionId = input.expressionId === undefined ? undefined : requiredId(input.expressionId, "expressionId");
    if (Boolean(behaviorId) === Boolean(expressionId)) throw new PuppetLoomError("INVALID_INPUT", "trigger 必须且只能提供 behaviorId 或 expressionId。" );
    return {
      version: 1,
      requestId,
      op: "trigger",
      viewerId: viewerId(input.viewerId),
      sourceId: requiredId(input.sourceId, "sourceId"),
      ...(behaviorId ? { behaviorId } : {}),
      ...(expressionId ? { expressionId } : {}),
      ...(input.strength === undefined ? {} : { strength: finite(input.strength, "strength", 0, 1) }),
      ...(input.durationMs === undefined ? {} : { durationMs: finite(input.durationMs, "durationMs", 50, 600_000) }),
      ...(input.priority === undefined ? {} : { priority: finite(input.priority, "priority", 0, 100) })
    };
  }
  throw new PuppetLoomError("INVALID_INPUT", `不支持的运行时控制操作：${String(input.op)}`);
}

function nonNegativeTime(value: unknown, label: string, maximum = 86_400_000): number {
  return finite(value, label, 0, maximum);
}

export function parseRuntimeInputSession(value: unknown): RuntimeInputSession {
  const input = record(value, "运行时输入会话");
  if (input.version !== 1) throw new PuppetLoomError("INVALID_INPUT", "运行时输入会话 version 必须是 1。" );
  const viewer = record(input.viewer, "运行时输入会话.viewer");
  const projectDirectory = requiredText(viewer.projectDirectory, "viewer.projectDirectory");
  const projectName = requiredText(viewer.projectName, "viewer.projectName", 512);
  const revision = viewer.revision === undefined ? undefined : nonNegativeTime(viewer.revision, "viewer.revision", Number.MAX_SAFE_INTEGER);
  if (revision !== undefined && !Number.isInteger(revision)) throw new PuppetLoomError("INVALID_INPUT", "viewer.revision 必须是非负整数。" );
  if (!Array.isArray(input.events) || input.events.length > 1_000_000) throw new PuppetLoomError("INVALID_INPUT", "运行时输入会话.events 必须是不超过 1000000 项的数组。" );
  const durationMs = nonNegativeTime(input.durationMs, "durationMs");
  let previous = -1;
  const events = input.events.map((rawEvent, index): RuntimeInputSessionEvent => {
    const event = record(rawEvent, `events[${index}]`);
    const atMs = nonNegativeTime(event.atMs, `events[${index}].atMs`);
    if (atMs < previous || atMs > durationMs) throw new PuppetLoomError("INVALID_INPUT", `events[${index}].atMs 必须按时间排序且不超过 durationMs。`);
    previous = atMs;
    if (event.op === "set") {
      const parsed = parseRuntimeControlRequest({ version: 1, requestId: `session-${index}`, op: "set", viewerId: 1, source: event.source });
      if (parsed.op !== "set") throw new PuppetLoomError("INVALID_INPUT", `events[${index}] 不是有效的 set 事件。`);
      return { atMs, op: "set", source: parsed.source };
    }
    if (event.op === "trigger") {
      const parsed = parseRuntimeControlRequest({
        version: 1, requestId: `session-${index}`, op: "trigger", viewerId: 1,
        sourceId: event.sourceId, behaviorId: event.behaviorId, expressionId: event.expressionId,
        strength: event.strength, durationMs: event.durationMs, priority: event.priority
      });
      if (parsed.op !== "trigger") throw new PuppetLoomError("INVALID_INPUT", `events[${index}] 不是有效的 trigger 事件。`);
      return {
        atMs, op: "trigger", sourceId: parsed.sourceId,
        ...(parsed.behaviorId ? { behaviorId: parsed.behaviorId } : {}),
        ...(parsed.expressionId ? { expressionId: parsed.expressionId } : {}),
        ...(parsed.strength === undefined ? {} : { strength: parsed.strength }),
        ...(parsed.durationMs === undefined ? {} : { durationMs: parsed.durationMs }),
        ...(parsed.priority === undefined ? {} : { priority: parsed.priority })
      };
    }
    if (event.op === "release") {
      const parsed = parseRuntimeControlRequest({ version: 1, requestId: `session-${index}`, op: "release", viewerId: 1, sourceId: event.sourceId });
      if (parsed.op !== "release") throw new PuppetLoomError("INVALID_INPUT", `events[${index}] 不是有效的 release 事件。`);
      return { atMs, op: "release", ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}) };
    }
    throw new PuppetLoomError("INVALID_INPUT", `events[${index}].op 不受支持：${String(event.op)}`);
  });
  const recordedAt = requiredId(input.recordedAt, "recordedAt");
  if (Number.isNaN(Date.parse(recordedAt))) throw new PuppetLoomError("INVALID_INPUT", "recordedAt 必须是有效日期。" );
  return {
    version: 1,
    id: requiredId(input.id, "id"),
    recordedAt,
    durationMs,
    viewer: { projectDirectory, projectName, ...(revision === undefined ? {} : { revision }) },
    events
  };
}

export function parseRuntimeControlServiceRequest(value: unknown): RuntimeControlServiceRequest {
  const input = record(value, "运行时控制请求");
  if (!String(input.op).startsWith("record-") && !String(input.op).startsWith("replay-")) return parseRuntimeControlRequest(value);
  if (input.version !== 1) throw new PuppetLoomError("INVALID_INPUT", "运行时控制协议 version 必须是 1。" );
  const requestId = requiredId(input.requestId, "requestId");
  const id = viewerId(input.viewerId);
  if (input.op === "record-start" || input.op === "record-stop" || input.op === "replay-stop") return { version: 1, requestId, op: input.op, viewerId: id };
  if (input.op === "replay-start") {
    if (input.loop !== undefined && typeof input.loop !== "boolean") throw new PuppetLoomError("INVALID_INPUT", "loop 必须是布尔值。" );
    return {
      version: 1, requestId, op: "replay-start", viewerId: id,
      session: parseRuntimeInputSession(input.session),
      ...(input.speed === undefined ? {} : { speed: finite(input.speed, "speed", 0.1, 4) }),
      ...(input.loop === undefined ? {} : { loop: input.loop })
    };
  }
  throw new PuppetLoomError("INVALID_INPUT", `不支持的运行时会话操作：${String(input.op)}`);
}

function cloneDescriptor(descriptor: RuntimeViewerDescriptor): RuntimeViewerDescriptor {
  return {
    ...descriptor,
    parameters: descriptor.parameters.map((parameter) => ({ ...parameter })),
    expressions: descriptor.expressions.map((expression) => ({ ...expression })),
    behaviors: descriptor.behaviors.map((behavior) => ({ ...behavior }))
  };
}

function cloneSource(source: RuntimeControlSource): RuntimeControlSource {
  return {
    ...source,
    ...(source.motion ? { motion: { ...source.motion } } : {}),
    ...(source.parameters ? { parameters: { ...source.parameters } } : {}),
    ...(source.expressions ? { expressions: { ...source.expressions } } : {}),
    ...(source.behavior ? { behavior: { ...source.behavior } } : {})
  };
}

/** Pure state holder used by the desktop transport, IPC bridge, and tests. */
export class RuntimeControlStore {
  private readonly viewers = new Map<number, RuntimeViewerDescriptor>();
  private readonly sources = new Map<number, Map<string, RuntimeControlSource>>();

  registerViewer(descriptor: RuntimeViewerDescriptor): void {
    this.viewers.set(descriptor.id, cloneDescriptor(descriptor));
    if (!this.sources.has(descriptor.id)) this.sources.set(descriptor.id, new Map());
  }

  unregisterViewer(viewerId: number): void {
    this.viewers.delete(viewerId);
    this.sources.delete(viewerId);
  }

  inspect(): RuntimeViewerDescriptor[] {
    return [...this.viewers.values()].sort((left, right) => left.id - right.id).map(cloneDescriptor);
  }

  snapshot(viewerId: number, nowMs = Date.now()): RuntimeControlSnapshot {
    this.requireViewer(viewerId);
    const entries = this.sources.get(viewerId)!;
    for (const [id, source] of entries) if (source.expiresAtMs !== undefined && source.expiresAtMs <= nowMs) entries.delete(id);
    return {
      version: 1,
      viewerId,
      capturedAtMs: nowMs,
      sources: [...entries.values()].sort((left, right) => left.priority - right.priority || left.updatedAtMs - right.updatedAtMs || left.id.localeCompare(right.id)).map(cloneSource)
    };
  }

  apply(request: RuntimeControlRequest, nowMs = Date.now()): unknown {
    if (request.op === "inspect") return { viewers: this.inspect() };
    const viewer = this.requireViewer(request.viewerId);
    const entries = this.sources.get(viewer.id)!;
    if (request.op === "release") {
      const released = request.sourceId ? entries.delete(request.sourceId) : entries.size > 0;
      if (!request.sourceId) entries.clear();
      return { viewerId: viewer.id, released, snapshot: this.snapshot(viewer.id, nowMs) };
    }
    if (request.op === "set") {
      this.validateValues(viewer, request.source.parameters, request.source.expressions);
      const existing = entries.get(request.source.id);
      const source: RuntimeControlSource = {
        id: request.source.id,
        priority: request.source.priority ?? existing?.priority ?? 50,
        blend: request.source.blend ?? existing?.blend ?? 1,
        updatedAtMs: nowMs,
        ...(request.source.ttlMs === undefined ? {} : { expiresAtMs: nowMs + request.source.ttlMs }),
        ...(request.source.motion ? { motion: { ...request.source.motion } } : {}),
        ...(request.source.parameters ? { parameters: { ...request.source.parameters } } : {}),
        ...(request.source.expressions ? { expressions: { ...request.source.expressions } } : {})
      };
      entries.set(source.id, source);
      return { viewerId: viewer.id, source: cloneSource(source), snapshot: this.snapshot(viewer.id, nowMs) };
    }
    const strength = request.strength ?? 1;
    let source: RuntimeControlSource;
    if (request.behaviorId) {
      const behavior = viewer.behaviors.find((candidate) => candidate.id === request.behaviorId);
      if (!behavior) throw new PuppetLoomError("INVALID_INPUT", `角色 ${viewer.id} 不存在动作：${request.behaviorId}`);
      const durationMs = request.durationMs ?? (behavior.loop ? undefined : Math.max(50, behavior.duration * 1000));
      source = {
        id: request.sourceId,
        priority: request.priority ?? 70,
        blend: strength,
        updatedAtMs: nowMs,
        ...(durationMs === undefined ? {} : { expiresAtMs: nowMs + durationMs }),
        behavior: { id: behavior.id, startedAtMs: nowMs }
      };
    } else {
      const expression = viewer.expressions.find((candidate) => candidate.id === request.expressionId);
      if (!expression) throw new PuppetLoomError("INVALID_INPUT", `角色 ${viewer.id} 不存在表情：${request.expressionId ?? ""}`);
      source = {
        id: request.sourceId,
        priority: request.priority ?? 70,
        blend: 1,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + (request.durationMs ?? 1000),
        expressions: { [expression.id]: strength }
      };
    }
    entries.set(source.id, source);
    return { viewerId: viewer.id, source: cloneSource(source), snapshot: this.snapshot(viewer.id, nowMs) };
  }

  private requireViewer(viewerId: number): RuntimeViewerDescriptor {
    const viewer = this.viewers.get(viewerId);
    if (!viewer) throw new PuppetLoomError("INVALID_INPUT", `找不到运行中的角色窗口：${viewerId}`);
    return viewer;
  }

  private validateValues(viewer: RuntimeViewerDescriptor, parameters?: Record<string, number>, expressions?: Record<string, number>): void {
    for (const [id, value] of Object.entries(parameters ?? {})) {
      const parameter = viewer.parameters.find((candidate) => candidate.id === id);
      if (!parameter) throw new PuppetLoomError("INVALID_INPUT", `角色 ${viewer.id} 不存在参数：${id}`);
      if (value < parameter.min || value > parameter.max) throw new PuppetLoomError("INVALID_INPUT", `参数 ${id} 必须在 ${parameter.min} 到 ${parameter.max} 之间。`);
    }
    for (const [id, value] of Object.entries(expressions ?? {})) {
      if (!viewer.expressions.some((candidate) => candidate.id === id)) throw new PuppetLoomError("INVALID_INPUT", `角色 ${viewer.id} 不存在表情：${id}`);
      if (value < 0 || value > 1) throw new PuppetLoomError("INVALID_INPUT", `表情 ${id} 的强度必须在 0 到 1 之间。`);
    }
  }
}
