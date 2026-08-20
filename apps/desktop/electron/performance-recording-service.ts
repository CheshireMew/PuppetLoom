import { closeSync, existsSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export interface PerformanceRecordingMetadata {
  mimeType: string;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  startedAt: string;
}

export interface PerformanceRecordingStartRequest {
  viewerId: number;
  projectDirectory: string;
  projectName: string;
  revision?: number;
  metadata: PerformanceRecordingMetadata;
}

export interface PerformanceRecordingSession {
  id: string;
  viewerId: number;
  output: string;
  report: string;
}

export interface PerformanceRecordingResult extends PerformanceRecordingSession {
  durationMs: number;
  bytes: number;
  hasAudio: boolean;
}

interface ActiveRecording extends PerformanceRecordingSession {
  projectDirectory: string;
  projectName: string;
  revision?: number;
  partial: string;
  descriptor: number;
  bytes: number;
  metadata: PerformanceRecordingMetadata;
  serverStartedAt: string;
}

type RecordingStatus = "recording" | "completed" | "failed" | "interrupted";

const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

function recordingError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function validateMetadata(value: PerformanceRecordingMetadata): PerformanceRecordingMetadata {
  if (!value || typeof value !== "object") throw new Error("WebM 录制元数据无效。" );
  if (typeof value.mimeType !== "string" || !value.mimeType.toLowerCase().startsWith("video/webm")) throw new Error("表演录制只接受 WebM。" );
  if (!Number.isFinite(value.fps) || value.fps < 1 || value.fps > 60) throw new Error("录制帧率必须在 1 到 60 之间。" );
  if (!Number.isInteger(value.width) || value.width < 1 || value.width > 16384 || !Number.isInteger(value.height) || value.height < 1 || value.height > 16384) {
    throw new Error("录制画布尺寸无效。" );
  }
  if (typeof value.hasAudio !== "boolean") throw new Error("录制音轨标记无效。" );
  if (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) throw new Error("录制开始时间无效。" );
  return { ...value };
}

function safeStamp(iso: string): string {
  return iso.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

/** Owns append-only WebM files. Interrupted recordings remain recoverable as .partial.webm. */
export class PerformanceRecordingService {
  private readonly active = new Map<string, ActiveRecording>();
  private readonly activeByViewer = new Map<number, string>();

  start(request: PerformanceRecordingStartRequest): PerformanceRecordingSession {
    if (!Number.isInteger(request.viewerId) || request.viewerId < 1) throw new Error("录制窗口编号无效。" );
    if (this.activeByViewer.has(request.viewerId)) throw new Error("当前角色窗口已经在录制表演。" );
    const projectDirectory = resolve(request.projectDirectory);
    const metadata = validateMetadata(request.metadata);
    const id = randomUUID();
    const serverStartedAt = new Date().toISOString();
    const directory = join(projectDirectory, "reports", "performances");
    mkdirSync(directory, { recursive: true });
    const base = `${safeStamp(serverStartedAt)}-${id.slice(0, 8)}`;
    const output = join(directory, `${base}.webm`);
    const partial = join(directory, `${base}.partial.webm`);
    const report = join(directory, `${base}.performance.json`);
    if (existsSync(output) || existsSync(partial) || existsSync(report)) throw new Error("录制输出路径发生冲突，请重新开始录制。" );
    const descriptor = openSync(partial, "wx");
    const active: ActiveRecording = {
      id, viewerId: request.viewerId, projectDirectory, projectName: request.projectName,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
      output, partial, report, descriptor, bytes: 0, metadata, serverStartedAt
    };
    this.active.set(id, active);
    this.activeByViewer.set(request.viewerId, id);
    this.writeReport(active, "recording");
    return { id, viewerId: request.viewerId, output, report };
  }

  append(viewerId: number, id: string, chunk: Uint8Array): { id: string; bytes: number } {
    const active = this.owned(viewerId, id);
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 || chunk.byteLength > MAX_CHUNK_BYTES) throw new Error("WebM 分块为空或超过 64 MiB 限制。" );
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < buffer.byteLength) offset += writeSync(active.descriptor, buffer, offset, buffer.byteLength - offset);
    active.bytes += buffer.byteLength;
    return { id, bytes: active.bytes };
  }

  stop(viewerId: number, id: string, durationMs: number): PerformanceRecordingResult {
    const active = this.owned(viewerId, id);
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("录制时长无效。" );
    if (active.bytes < 1) {
      this.finish(active, "failed", { durationMs, error: "MediaRecorder 没有产生视频数据。" });
      throw new Error("录制没有产生视频数据，已保留空的 partial 文件和失败报告。" );
    }
    closeSync(active.descriptor);
    renameSync(active.partial, active.output);
    this.active.delete(id);
    this.activeByViewer.delete(viewerId);
    this.writeReport(active, "completed", { durationMs, completedAt: new Date().toISOString() });
    return { id, viewerId, output: active.output, report: active.report, durationMs, bytes: active.bytes, hasAudio: active.metadata.hasAudio };
  }

  fail(viewerId: number, id: string, error: unknown, durationMs?: number): void {
    const active = this.owned(viewerId, id);
    this.finish(active, "failed", { ...(durationMs === undefined ? {} : { durationMs }), error: recordingError(error) });
  }

  interruptViewer(viewerId: number, reason: string): void {
    const id = this.activeByViewer.get(viewerId);
    if (!id) return;
    const active = this.active.get(id);
    if (active) this.finish(active, "interrupted", { error: reason });
  }

  interruptAll(reason: string): void {
    for (const active of [...this.active.values()]) this.finish(active, "interrupted", { error: reason });
  }

  private owned(viewerId: number, id: string): ActiveRecording {
    const active = this.active.get(id);
    if (!active || active.viewerId !== viewerId) throw new Error("找不到属于当前角色窗口的录制会话。" );
    return active;
  }

  private finish(active: ActiveRecording, status: Exclude<RecordingStatus, "recording" | "completed">, extra: Record<string, unknown>): void {
    try { closeSync(active.descriptor); } catch { /* already closed */ }
    this.active.delete(active.id);
    this.activeByViewer.delete(active.viewerId);
    this.writeReport(active, status, { ...extra, endedAt: new Date().toISOString() });
  }

  private writeReport(active: ActiveRecording, status: RecordingStatus, extra: Record<string, unknown> = {}): void {
    writeFileSync(active.report, `${JSON.stringify({
      version: 1,
      kind: "puppetloom-performance-recording",
      id: active.id,
      status,
      project: { directory: active.projectDirectory, name: active.projectName, ...(active.revision === undefined ? {} : { revision: active.revision }) },
      viewerId: active.viewerId,
      media: { ...active.metadata, bytes: active.bytes },
      output: status === "completed" ? active.output : active.partial,
      finalOutput: active.output,
      report: active.report,
      serverStartedAt: active.serverStartedAt,
      ...extra
    }, null, 2)}\n`, "utf8");
  }
}
