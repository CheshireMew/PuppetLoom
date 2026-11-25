import type { CanvasSource as MediaCanvasSource, MediaStreamAudioTrackSource as MediaAudioSource, Output as MediaOutput, StreamTarget as MediaStreamTarget, StreamTargetChunk, WebMOutputFormat as MediaWebMOutputFormat } from "mediabunny";

export interface PerformanceRecordingResult {
  id: string;
  output: string;
  report: string;
  relativeOutput: string;
  relativeReport: string;
  durationMs: number;
  bytes: number;
  hasAudio: boolean;
  inputSession?: PerformanceRecordingInputSession;
}

export interface PerformanceRecordingInputSession {
  output: string;
  durationMs: number;
  events: number;
}

export interface PerformanceRecordingOptions {
  fps: number;
  width: number;
  height: number;
  background: { mode: "transparent" } | { mode: "solid"; color: string };
  targetDurationMs?: number;
}

export interface PerformanceRecorder {
  stop(inputSession?: PerformanceRecordingInputSession): Promise<PerformanceRecordingResult>;
}

export interface PerformanceRecordingSurface {
  setOutputOverride(output: Pick<PerformanceRecordingOptions, "width" | "height" | "background"> | undefined): void;
}

/** Streams canvas recording chunks to Electron main so long sessions stay bounded in memory. */
export async function startPerformanceRecording(
  sourceCanvas: HTMLCanvasElement,
  options: PerformanceRecordingOptions,
  audioStream: MediaStream | undefined,
  outputSurface: PerformanceRecordingSurface,
): Promise<PerformanceRecorder> {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  const recordingCanvas = sourceCanvas;
  let stopped = false;
  outputSurface.setOutputOverride({ width: options.width, height: options.height, background: options.background });
  const audioTracks = audioStream?.getAudioTracks() ?? [];
  const startedAtMs = Date.now();
  let sessionId: string | undefined;
  let output: MediaOutput<MediaWebMOutputFormat, MediaStreamTarget> | undefined;
  let frameRequest = 0;
  let frameWrite = Promise.resolve();
  let frameError: Error | undefined;
  let videoSource: MediaCanvasSource | undefined;
  let audioSource: MediaAudioSource | undefined;
  try {
    const { CanvasSource, MediaStreamAudioTrackSource, Output, Quality, StreamTarget, WebMOutputFormat } = await import("./recording-codecs.js");
    const codec = "vp8" as const;
    const mimeType = `video/webm;codecs=${codec}${audioTracks.length > 0 ? ",opus" : ""}`;
    const session = await window.puppetloom.startPerformanceRecording({
      mimeType,
      fps: options.fps,
      width: recordingCanvas.width,
      height: recordingCanvas.height,
      sourceWidth,
      sourceHeight,
      hasAudio: audioTracks.length > 0,
      background: options.background,
      ...(options.targetDurationMs === undefined ? {} : { targetDurationMs: options.targetDurationMs }),
      startedAt: new Date(startedAtMs).toISOString()
    });
    sessionId = session.id;
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        return window.puppetloom.appendPerformanceRecording(session.id, chunk.data, chunk.position).then(() => undefined);
      }
    });
    output = new Output({
      format: new WebMOutputFormat(),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 })
    });
    const videoBitsPerSecond = Math.max(2_000_000, Math.min(20_000_000, Math.round(options.width * options.height * options.fps * 0.12)));
    videoSource = new CanvasSource(recordingCanvas, {
      codec,
      quality: new Quality({ bitrate: videoBitsPerSecond }),
      alpha: options.background.mode === "transparent" ? "keep" : "discard",
      latencyMode: "realtime",
      contentHint: "detail"
    });
    output.addVideoTrack(videoSource, { frameRate: options.fps });
    if (audioTracks[0]) {
      audioSource = new MediaStreamAudioTrackSource(audioTracks[0], { codec: "opus", quality: new Quality({ bitrate: 128_000 }) });
      audioSource.errorPromise.catch((cause) => {
        frameError = cause instanceof Error ? cause : new Error(String(cause));
      });
      output.addAudioTrack(audioSource);
    }
    await output.start();
    const activeOutput = output;
    const activeVideoSource = videoSource;
    const activeAudioSource = audioSource;
    const frameIntervalMs = 1000 / Math.max(1, options.fps);
    const frameDurationSeconds = 1 / Math.max(1, options.fps);
    const captureStartedAt = performance.now();
    let nextFrameAt = captureStartedAt;
    let lastTimestamp = -frameDurationSeconds;
    let framePending = false;
    const capture = (now: number) => {
      if (stopped || !videoSource) return;
      if (!framePending && now + 0.5 >= nextFrameAt) {
        framePending = true;
        lastTimestamp = Math.max(lastTimestamp + frameDurationSeconds, (now - captureStartedAt) / 1000);
        frameWrite = videoSource.add(lastTimestamp, frameDurationSeconds)
          .catch((cause) => { frameError = cause instanceof Error ? cause : new Error(String(cause)); })
          .finally(() => { framePending = false; });
        nextFrameAt += Math.max(1, Math.floor((now - nextFrameAt) / frameIntervalMs) + 1) * frameIntervalMs;
      }
      frameRequest = window.requestAnimationFrame(capture);
    };
    frameRequest = window.requestAnimationFrame(capture);
    return {
      async stop(inputSession) {
        if (stopped) throw new Error("表演录制已经停止。" );
        stopped = true;
        if (frameRequest) window.cancelAnimationFrame(frameRequest);
        try {
          await frameWrite;
          if (frameError) throw frameError;
          const finalTimestamp = Math.max(lastTimestamp + frameDurationSeconds, (performance.now() - captureStartedAt) / 1000);
          await activeVideoSource.add(finalTimestamp, frameDurationSeconds);
          activeVideoSource.close();
          activeAudioSource?.close();
          await activeOutput.finalize();
          return await window.puppetloom.stopPerformanceRecording(session.id, Date.now() - startedAtMs, inputSession);
        } catch (cause) {
          await activeOutput.cancel().catch(() => undefined);
          await window.puppetloom.failPerformanceRecording(session.id, cause instanceof Error ? cause.message : String(cause)).catch(() => undefined);
          throw cause;
        } finally {
          outputSurface.setOutputOverride(undefined);
        }
      }
    };
  } catch (cause) {
    stopped = true;
    if (frameRequest) window.cancelAnimationFrame(frameRequest);
    await output?.cancel().catch(() => undefined);
    outputSurface.setOutputOverride(undefined);
    if (sessionId) await window.puppetloom.failPerformanceRecording(sessionId, cause instanceof Error ? cause.message : String(cause)).catch(() => undefined);
    throw cause;
  }
}
