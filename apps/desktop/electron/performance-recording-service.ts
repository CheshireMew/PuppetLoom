import { closeSync, existsSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";

export type PerformanceRecordingBackground =
  | { mode: "transparent" }
  | { mode: "solid"; color: string };

export interface PerformanceRecordingInputSession {
  output: string;
  durationMs: number;
  events: number;
}

export interface PerformanceRecordingMetadata {
  mimeType: string;
  fps: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  hasAudio: boolean;
  background: PerformanceRecordingBackground;
  targetDurationMs?: number;
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
  relativeOutput: string;
  relativeReport: string;
}

export interface PerformanceRecordingResult extends PerformanceRecordingSession {
  durationMs: number;
  bytes: number;
  hasAudio: boolean;
  inputSession?: PerformanceRecordingInputSession;
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
  if (!value || typeof value !== "object") throw new Error("WebM 녹화 메타데이터가 올바르지 않습니다.");
  if (typeof value.mimeType !== "string" || !value.mimeType.toLowerCase().startsWith("video/webm")) throw new Error("퍼포먼스 녹화는 WebM만 지원합니다.");
  if (!Number.isFinite(value.fps) || value.fps < 1 || value.fps > 60) throw new Error("녹화 프레임 속도는 1에서 60 사이여야 합니다.");
  if (!Number.isInteger(value.width) || value.width < 1 || value.width > 16384 || !Number.isInteger(value.height) || value.height < 1 || value.height > 16384) {
    throw new Error("녹화 캔버스 크기가 올바르지 않습니다.");
  }
  if (!Number.isInteger(value.sourceWidth) || value.sourceWidth < 1 || value.sourceWidth > 16384 || !Number.isInteger(value.sourceHeight) || value.sourceHeight < 1 || value.sourceHeight > 16384) {
    throw new Error("녹화 원본 캔버스 크기가 올바르지 않습니다.");
  }
  if (typeof value.hasAudio !== "boolean") throw new Error("녹화 오디오 트랙 표시가 올바르지 않습니다.");
  if (!value.background || (value.background.mode !== "transparent" && value.background.mode !== "solid")) throw new Error("녹화 배경 설정이 올바르지 않습니다.");
  if (value.background.mode === "solid" && (typeof value.background.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.background.color))) throw new Error("단색 녹화 배경은 #RRGGBB여야 합니다.");
  if (value.targetDurationMs !== undefined && (!Number.isFinite(value.targetDurationMs) || value.targetDurationMs <= 0 || value.targetDurationMs > 24 * 60 * 60 * 1000)) throw new Error("자동 중지 시간은 0보다 크고 24시간을 넘을 수 없습니다.");
  if (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) throw new Error("녹화 시작 시간이 올바르지 않습니다.");
  return { ...value, background: { ...value.background } };
}

function safeStamp(iso: string): string {
  return iso.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function relativeProjectPath(projectDirectory: string, target: string): string {
  return relative(projectDirectory, target).replaceAll("\\", "/");
}

function validateInputSession(value: PerformanceRecordingInputSession | undefined): PerformanceRecordingInputSession | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value.output !== "string" || value.output.length < 1) throw new Error("동기화 입력 세션 경로가 올바르지 않습니다.");
  if (!Number.isFinite(value.durationMs) || value.durationMs < 0 || !Number.isInteger(value.events) || value.events < 0) throw new Error("동기화 입력 세션 요약이 올바르지 않습니다.");
  return { ...value };
}

/** Owns streamed WebM files. Interrupted recordings remain recoverable as .partial.webm. */
export class PerformanceRecordingService {
  private readonly active = new Map<string, ActiveRecording>();
  private readonly activeByViewer = new Map<number, string>();

  start(request: PerformanceRecordingStartRequest): PerformanceRecordingSession {
    if (!Number.isInteger(request.viewerId) || request.viewerId < 1) throw new Error("녹화 창 번호가 올바르지 않습니다.");
    if (this.activeByViewer.has(request.viewerId)) throw new Error("현재 캐릭터 창이 이미 퍼포먼스를 녹화 중입니다.");
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
    if (existsSync(output) || existsSync(partial) || existsSync(report)) throw new Error("녹화 출력 경로가 충돌합니다. 녹화를 다시 시작해 주세요.");
    const descriptor = openSync(partial, "wx");
    const active: ActiveRecording = {
      id, viewerId: request.viewerId, projectDirectory, projectName: request.projectName,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
      output,
      partial,
      report,
      relativeOutput: relativeProjectPath(projectDirectory, output),
      relativeReport: relativeProjectPath(projectDirectory, report),
      descriptor,
      bytes: 0,
      metadata,
      serverStartedAt
    };
    this.active.set(id, active);
    this.activeByViewer.set(request.viewerId, id);
    this.writeReport(active, "recording");
    return {
      id,
      viewerId: request.viewerId,
      output,
      report,
      relativeOutput: relativeProjectPath(projectDirectory, output),
      relativeReport: relativeProjectPath(projectDirectory, report)
    };
  }

  append(viewerId: number, id: string, chunk: Uint8Array, position?: number): { id: string; bytes: number } {
    const active = this.owned(viewerId, id);
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 || chunk.byteLength > MAX_CHUNK_BYTES) throw new Error("WebM 청크가 비어 있거나 64 MiB 제한을 초과합니다.");
    if (position !== undefined && (!Number.isInteger(position) || position < 0 || !Number.isSafeInteger(position + chunk.byteLength))) throw new Error("WebM 청크 쓰기 위치가 올바르지 않습니다.");
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const writePosition = position ?? active.bytes;
    let offset = 0;
    while (offset < buffer.byteLength) offset += writeSync(active.descriptor, buffer, offset, buffer.byteLength - offset, writePosition + offset);
    active.bytes = Math.max(active.bytes, writePosition + buffer.byteLength);
    return { id, bytes: active.bytes };
  }

  stop(viewerId: number, id: string, durationMs: number, inputSession?: PerformanceRecordingInputSession): PerformanceRecordingResult {
    const active = this.owned(viewerId, id);
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("녹화 길이가 올바르지 않습니다.");
    const linkedInput = validateInputSession(inputSession);
    if (active.bytes < 1) {
      this.finish(active, "failed", { durationMs, error: "비디오 인코더가 데이터를 생성하지 않았습니다." });
      throw new Error("녹화에서 비디오 데이터가 생성되지 않았습니다. 빈 partial 파일과 실패 보고서를 남겨 두었습니다.");
    }
    closeSync(active.descriptor);
    renameSync(active.partial, active.output);
    this.active.delete(id);
    this.activeByViewer.delete(viewerId);
    this.writeReport(active, "completed", { durationMs, ...(linkedInput ? { inputSession: linkedInput } : {}), completedAt: new Date().toISOString() });
    return {
      id,
      viewerId,
      output: active.output,
      report: active.report,
      relativeOutput: relativeProjectPath(active.projectDirectory, active.output),
      relativeReport: relativeProjectPath(active.projectDirectory, active.report),
      durationMs,
      bytes: active.bytes,
      hasAudio: active.metadata.hasAudio,
      ...(linkedInput ? { inputSession: linkedInput } : {})
    };
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
    if (!active || active.viewerId !== viewerId) throw new Error("현재 캐릭터 창에 속한 녹화 세션을 찾을 수 없습니다.");
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
