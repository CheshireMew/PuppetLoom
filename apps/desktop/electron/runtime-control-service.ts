import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRuntimeControlServiceRequest,
  RuntimeControlStore,
  type RuntimeControlManifest,
  type RuntimeControlRequest,
  type RuntimeControlServiceRequest,
  type RuntimeInputSession,
  type RuntimeInputSessionEvent,
  type RuntimeControlResponse,
  type RuntimeControlSnapshot,
  type RuntimeViewerDescriptor
} from "@puppetloom/core/browser";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

interface ActiveRecording {
  startedAtMs: number;
  recordedAt: string;
  viewer: RuntimeViewerDescriptor;
  events: RuntimeInputSessionEvent[];
}

interface ActiveReplay {
  session: RuntimeInputSession;
  speed: number;
  loop: boolean;
  startedAtMs: number;
  cursor: number;
  sourceIds: Set<string>;
  timer: ReturnType<typeof setInterval>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  response.end(json);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("运行时控制请求超过 1 MiB。" );
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new Error("请求正文不能为空。" );
  return JSON.parse(text) as unknown;
}

export interface RuntimeControlServiceOptions {
  profileDirectory: string;
  port?: number;
  log?: (event: string, details?: Record<string, unknown>) => void;
  onChange?: (viewerId: number, snapshot: RuntimeControlSnapshot) => void;
  onReplayState?: (viewerId: number, state: { replaying: boolean; reason: "started" | "finished" | "stopped" }) => void;
}

/** Loopback-only JSON service used by Agent CLIs and local input adapters. */
export class RuntimeControlService {
  readonly store = new RuntimeControlStore();
  private readonly profileDirectory: string;
  private readonly preferredPort: number;
  private readonly log: NonNullable<RuntimeControlServiceOptions["log"]>;
  private readonly onChange: NonNullable<RuntimeControlServiceOptions["onChange"]>;
  private readonly onReplayState: NonNullable<RuntimeControlServiceOptions["onReplayState"]>;
  private server: Server | undefined;
  private manifest: RuntimeControlManifest | undefined;
  private readonly recordings = new Map<number, ActiveRecording>();
  private readonly replays = new Map<number, ActiveReplay>();
  private runtimeRequestLog: {
    startedAt: string;
    count: number;
    operations: Record<string, number>;
    viewers: Set<number>;
    lastRequestId: string;
  } | undefined;
  private runtimeRequestLogTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RuntimeControlServiceOptions) {
    this.profileDirectory = options.profileDirectory;
    this.preferredPort = options.port ?? 31_987;
    this.log = options.log ?? (() => undefined);
    this.onChange = options.onChange ?? (() => undefined);
    this.onReplayState = options.onReplayState ?? (() => undefined);
  }

  async start(): Promise<RuntimeControlManifest> {
    if (this.manifest?.status === "running") return this.manifest;
    const startedAt = new Date().toISOString();
    this.server = createServer((request, response) => { void this.handle(request, response); });
    this.server.on("clientError", (error, socket) => {
      this.log("runtime-control-client-error", { error: error.message });
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      const server = this.server!;
      const onError = (error: Error) => rejectStart(error);
      server.once("error", onError);
      server.listen(this.preferredPort, "127.0.0.1", () => {
        server.off("error", onError);
        resolveStart();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("无法确定运行时控制服务端口。" );
    const now = new Date().toISOString();
    this.manifest = { version: 1, status: "running", url: `http://127.0.0.1:${address.port}`, pid: process.pid, startedAt, updatedAt: now };
    this.writeManifest(this.manifest);
    this.log("runtime-control-started", { url: this.manifest.url });
    return this.manifest;
  }

  registerViewer(descriptor: RuntimeViewerDescriptor): void {
    this.store.registerViewer(descriptor);
    this.log("runtime-control-viewer-registered", { viewerId: descriptor.id, project: descriptor.projectDirectory });
  }

  unregisterViewer(viewerId: number): void {
    this.stopReplay(viewerId);
    this.recordings.delete(viewerId);
    this.store.unregisterViewer(viewerId);
    this.log("runtime-control-viewer-unregistered", { viewerId });
  }

  snapshot(viewerId: number): RuntimeControlSnapshot {
    return this.presentationSnapshot(viewerId);
  }

  applyLocal(request: RuntimeControlServiceRequest): unknown {
    return this.apply(request);
  }

  async stop(): Promise<void> {
    for (const viewerId of [...this.replays.keys()]) this.stopReplay(viewerId);
    this.recordings.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
    if (this.manifest) {
      this.manifest = { ...this.manifest, status: "stopped", updatedAt: new Date().toISOString() };
      this.writeManifest(this.manifest);
      this.log("runtime-control-stopped", { url: this.manifest.url });
    }
    this.flushRuntimeRequestLog();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "OPTIONS") {
      reply(response, 204, {});
      return;
    }
    if (request.method === "GET" && request.url === "/v1/health") {
      reply(response, 200, { ok: true, service: "PuppetLoom runtime control", manifest: this.manifest, viewers: this.store.inspect() });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/control") {
      reply(response, 404, { ok: false, error: "只支持 GET /v1/health 和 POST /v1/control。" });
      return;
    }
    let requestId = "invalid-request";
    try {
      const parsed = parseRuntimeControlServiceRequest(await readJson(request));
      requestId = parsed.requestId;
      const result = this.apply(parsed);
      const body: RuntimeControlResponse = { version: 1, requestId, ok: true, result };
      reply(response, 200, body);
    } catch (cause) {
      const body: RuntimeControlResponse = { version: 1, requestId, ok: false, error: messageOf(cause) };
      this.log("runtime-control-request-rejected", { requestId, error: body.error });
      reply(response, 400, body);
    }
  }

  private apply(request: RuntimeControlServiceRequest): unknown {
    const nowMs = Date.now();
    if (request.op === "record-start") return this.startRecording(request.viewerId, nowMs);
    if (request.op === "record-stop") return this.stopRecording(request.viewerId, nowMs);
    if (request.op === "replay-start") return this.startReplay(request.viewerId, request.session, request.speed ?? 1, request.loop ?? false, nowMs);
    if (request.op === "replay-stop") return { viewerId: request.viewerId, stopped: this.stopReplay(request.viewerId) };
    if (request.op === "inspect") return {
      viewers: this.store.inspect(),
      recordings: [...this.recordings.keys()].sort((left, right) => left - right),
      replays: [...this.replays.entries()].map(([viewerId, replay]) => ({ viewerId, sessionId: replay.session.id, speed: replay.speed, loop: replay.loop }))
    };
    const result = this.store.apply(request, nowMs);
    this.capture(request, nowMs);
    this.publish(request.viewerId, nowMs);
    this.summarizeRuntimeRequest(request);
    return result;
  }

  private summarizeRuntimeRequest(request: Exclude<RuntimeControlRequest, { op: "inspect" }>): void {
    this.runtimeRequestLog ??= {
      startedAt: new Date().toISOString(),
      count: 0,
      operations: {},
      viewers: new Set(),
      lastRequestId: request.requestId
    };
    this.runtimeRequestLog.count += 1;
    this.runtimeRequestLog.operations[request.op] = (this.runtimeRequestLog.operations[request.op] ?? 0) + 1;
    this.runtimeRequestLog.viewers.add(request.viewerId);
    this.runtimeRequestLog.lastRequestId = request.requestId;
    if (!this.runtimeRequestLogTimer) {
      this.runtimeRequestLogTimer = setTimeout(() => this.flushRuntimeRequestLog(), 1_000);
      this.runtimeRequestLogTimer.unref?.();
    }
  }

  private flushRuntimeRequestLog(): void {
    if (this.runtimeRequestLogTimer) clearTimeout(this.runtimeRequestLogTimer);
    this.runtimeRequestLogTimer = undefined;
    const summary = this.runtimeRequestLog;
    this.runtimeRequestLog = undefined;
    if (!summary) return;
    this.log("runtime-control-request-batch", {
      startedAt: summary.startedAt,
      count: summary.count,
      operations: summary.operations,
      viewers: [...summary.viewers].sort((left, right) => left - right),
      lastRequestId: summary.lastRequestId
    });
  }

  private startRecording(viewerId: number, nowMs: number): unknown {
    if (this.recordings.has(viewerId)) throw new Error(`角色 ${viewerId} 已经在录制输入会话。`);
    if (this.replays.has(viewerId)) throw new Error(`角色 ${viewerId} 正在回放动作数据，不能同时开始录制。`);
    const viewer = this.store.inspect().find((candidate) => candidate.id === viewerId);
    if (!viewer) throw new Error(`找不到运行中的角色窗口：${viewerId}`);
    const events = this.store.snapshot(viewerId, nowMs).sources.flatMap((source): RuntimeInputSessionEvent[] => {
      const ttlMs = source.expiresAtMs === undefined ? undefined : Math.max(50, source.expiresAtMs - nowMs);
      const baseline: RuntimeInputSessionEvent[] = [];
      if (source.motion || source.parameters || source.expressions) baseline.push({
        atMs: 0,
        op: "set",
        source: {
          id: source.id,
          priority: source.priority,
          blend: source.blend,
          ...(ttlMs === undefined ? {} : { ttlMs }),
          ...(source.motion ? { motion: structuredClone(source.motion) } : {}),
          ...(source.parameters ? { parameters: structuredClone(source.parameters) } : {}),
          ...(source.expressions ? { expressions: structuredClone(source.expressions) } : {})
        }
      });
      if (source.behavior) baseline.push({
        atMs: 0,
        op: "trigger",
        sourceId: source.id,
        behaviorId: source.behavior.id,
        strength: source.blend,
        ...(ttlMs === undefined ? {} : { durationMs: ttlMs }),
        priority: source.priority
      });
      return baseline;
    });
    const recording: ActiveRecording = { startedAtMs: nowMs, recordedAt: new Date(nowMs).toISOString(), viewer, events };
    this.recordings.set(viewerId, recording);
    this.log("runtime-input-recording-started", { viewerId });
    return { viewerId, recording: true, startedAt: recording.recordedAt };
  }

  private stopRecording(viewerId: number, nowMs: number): { viewerId: number; recording: false; session: RuntimeInputSession } {
    const recording = this.recordings.get(viewerId);
    if (!recording) throw new Error(`角色 ${viewerId} 没有正在录制的输入会话。`);
    this.recordings.delete(viewerId);
    const session: RuntimeInputSession = {
      version: 1,
      id: randomUUID(),
      recordedAt: recording.recordedAt,
      durationMs: Math.max(0, nowMs - recording.startedAtMs),
      viewer: {
        projectDirectory: recording.viewer.projectDirectory,
        projectName: recording.viewer.projectName,
        ...(recording.viewer.revision === undefined ? {} : { revision: recording.viewer.revision })
      },
      events: recording.events
    };
    this.log("runtime-input-recording-stopped", { viewerId, sessionId: session.id, durationMs: session.durationMs, events: session.events.length });
    return { viewerId, recording: false, session };
  }

  private capture(request: Exclude<RuntimeControlRequest, { op: "inspect" }>, nowMs: number): void {
    const recording = this.recordings.get(request.viewerId);
    if (!recording) return;
    const atMs = Math.max(0, nowMs - recording.startedAtMs);
    if (request.op === "set") recording.events.push({ atMs, op: "set", source: structuredClone(request.source) });
    if (request.op === "trigger") recording.events.push({
      atMs, op: "trigger", sourceId: request.sourceId,
      ...(request.behaviorId ? { behaviorId: request.behaviorId } : {}),
      ...(request.expressionId ? { expressionId: request.expressionId } : {}),
      ...(request.strength === undefined ? {} : { strength: request.strength }),
      ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
      ...(request.priority === undefined ? {} : { priority: request.priority })
    });
    if (request.op === "release") recording.events.push({ atMs, op: "release", ...(request.sourceId ? { sourceId: request.sourceId } : {}) });
  }

  private startReplay(viewerId: number, input: RuntimeInputSession, speed: number, loop: boolean, nowMs: number): unknown {
    if (this.replays.has(viewerId)) throw new Error(`角色 ${viewerId} 已经在回放输入会话。`);
    if (this.recordings.has(viewerId)) throw new Error(`角色 ${viewerId} 正在录制动作数据，不能同时开始回放。`);
    const viewer = this.store.inspect().find((candidate) => candidate.id === viewerId);
    if (!viewer) throw new Error(`找不到运行中的角色窗口：${viewerId}`);
    if (viewer.projectName !== input.viewer.projectName) throw new Error(`输入会话属于“${input.viewer.projectName}”，当前角色是“${viewer.projectName}”。`);
    if (input.viewer.revision !== undefined && viewer.revision !== input.viewer.revision) {
      throw new Error(`输入会话属于 revision ${input.viewer.revision}，当前角色是 revision ${viewer.revision ?? "未知"}，不能可靠回放。`);
    }
    this.validateReplay(viewer, input, speed);
    const replay = { session: input, speed, loop, startedAtMs: nowMs, cursor: 0, sourceIds: new Set<string>(), timer: undefined as unknown as ReturnType<typeof setInterval> };
    replay.timer = setInterval(() => this.tickReplay(viewerId), 8);
    this.replays.set(viewerId, replay);
    this.publish(viewerId, nowMs);
    this.log("runtime-input-replay-started", { viewerId, sessionId: input.id, speed, loop });
    this.onReplayState(viewerId, { replaying: true, reason: "started" });
    this.tickReplay(viewerId, nowMs);
    return { viewerId, replaying: true, sessionId: input.id, speed, loop, durationMs: input.durationMs };
  }

  private validateReplay(viewer: RuntimeViewerDescriptor, session: RuntimeInputSession, speed: number): void {
    const validation = new RuntimeControlStore();
    validation.registerViewer(viewer);
    for (const event of session.events) validation.apply(this.requestForEvent(viewer.id, session.id, event, speed), event.atMs);
  }

  private tickReplay(viewerId: number, nowMs = Date.now()): void {
    const replay = this.replays.get(viewerId);
    if (!replay) return;
    const elapsed = (nowMs - replay.startedAtMs) * replay.speed;
    while (replay.cursor < replay.session.events.length && replay.session.events[replay.cursor]!.atMs <= elapsed) {
      const event = replay.session.events[replay.cursor]!;
      if (event.op === "release" && !event.sourceId) {
        this.releaseReplaySources(viewerId, replay, nowMs);
        replay.cursor += 1;
        continue;
      }
      const request = this.requestForEvent(viewerId, replay.session.id, event, replay.speed);
      this.store.apply(request, nowMs);
      if (request.op === "set") replay.sourceIds.add(request.source.id);
      if (request.op === "trigger") replay.sourceIds.add(request.sourceId);
      if (request.op === "release" && request.sourceId) replay.sourceIds.delete(request.sourceId);
      this.publish(viewerId, nowMs);
      replay.cursor += 1;
    }
    if (elapsed < replay.session.durationMs) return;
    this.releaseReplaySources(viewerId, replay, nowMs);
    if (replay.loop) {
      replay.cursor = 0;
      replay.startedAtMs = nowMs;
      this.publish(viewerId, nowMs);
      return;
    }
    clearInterval(replay.timer);
    this.replays.delete(viewerId);
    this.publish(viewerId, nowMs);
    this.log("runtime-input-replay-finished", { viewerId, sessionId: replay.session.id });
    this.onReplayState(viewerId, { replaying: false, reason: "finished" });
  }

  private stopReplay(viewerId: number): boolean {
    const replay = this.replays.get(viewerId);
    if (!replay) return false;
    clearInterval(replay.timer);
    this.releaseReplaySources(viewerId, replay, Date.now());
    this.replays.delete(viewerId);
    this.publish(viewerId);
    this.log("runtime-input-replay-stopped", { viewerId, sessionId: replay.session.id });
    this.onReplayState(viewerId, { replaying: false, reason: "stopped" });
    return true;
  }

  private releaseReplaySources(viewerId: number, replay: ActiveReplay, nowMs: number): void {
    for (const sourceId of replay.sourceIds) this.store.apply({ version: 1, requestId: randomUUID(), op: "release", viewerId, sourceId }, nowMs);
    replay.sourceIds.clear();
  }

  private publish(viewerId: number, nowMs = Date.now()): void {
    this.onChange(viewerId, this.presentationSnapshot(viewerId, nowMs));
  }

  private presentationSnapshot(viewerId: number, nowMs = Date.now()): RuntimeControlSnapshot {
    const snapshot = this.store.snapshot(viewerId, nowMs);
    const replay = this.replays.get(viewerId);
    if (!replay) return snapshot;
    const prefix = `replay:${replay.session.id}:`;
    return { ...snapshot, sources: snapshot.sources.filter((source) => source.id.startsWith(prefix)) };
  }

  private requestForEvent(viewerId: number, sessionId: string, event: RuntimeInputSessionEvent, speed: number): Exclude<RuntimeControlRequest, { op: "inspect" }> {
    const sourceId = (id: string) => `replay:${sessionId}:${id}`;
    if (event.op === "set") return {
      version: 1, requestId: randomUUID(), op: "set", viewerId,
      source: {
        ...structuredClone(event.source),
        id: sourceId(event.source.id),
        ...(event.source.ttlMs === undefined ? {} : { ttlMs: Math.max(50, event.source.ttlMs / speed) })
      }
    };
    if (event.op === "trigger") return {
      version: 1, requestId: randomUUID(), op: "trigger", viewerId, sourceId: sourceId(event.sourceId),
      ...(event.behaviorId ? { behaviorId: event.behaviorId } : {}),
      ...(event.expressionId ? { expressionId: event.expressionId } : {}),
      ...(event.strength === undefined ? {} : { strength: event.strength }),
      ...(event.durationMs === undefined ? {} : { durationMs: Math.max(50, event.durationMs / speed) }),
      ...(event.priority === undefined ? {} : { priority: event.priority })
    };
    if (event.sourceId) return { version: 1, requestId: randomUUID(), op: "release", viewerId, sourceId: sourceId(event.sourceId) };
    return { version: 1, requestId: randomUUID(), op: "release", viewerId };
  }

  private writeManifest(manifest: RuntimeControlManifest): void {
    mkdirSync(this.profileDirectory, { recursive: true });
    writeFileSync(join(this.profileDirectory, "runtime-control.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}
