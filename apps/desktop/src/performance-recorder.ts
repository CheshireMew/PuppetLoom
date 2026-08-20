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

function supportedMimeType(): string {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"];
  const selected = candidates.find((value) => MediaRecorder.isTypeSupported(value));
  if (!selected) throw new Error("当前 Chromium 运行时不支持 WebM MediaRecorder。" );
  return selected;
}

/** Streams canvas recording chunks to Electron main so long sessions stay bounded in memory. */
export async function startPerformanceRecording(
  sourceCanvas: HTMLCanvasElement,
  options: PerformanceRecordingOptions,
  audioStream?: MediaStream,
): Promise<PerformanceRecorder> {
  const recordingCanvas = document.createElement("canvas");
  recordingCanvas.width = options.width;
  recordingCanvas.height = options.height;
  const context = recordingCanvas.getContext("2d", { alpha: options.background.mode === "transparent" });
  if (!context) throw new Error("无法创建 WebM 录制画布。" );
  let drawRequest = 0;
  let stopped = false;
  const frameInterval = 1000 / Math.max(1, options.fps);
  let nextDrawAt = performance.now();
  const draw = (now: number) => {
    if (now + 0.5 >= nextDrawAt) {
      if (options.background.mode === "solid") {
        context.fillStyle = options.background.color;
        context.fillRect(0, 0, recordingCanvas.width, recordingCanvas.height);
      } else context.clearRect(0, 0, recordingCanvas.width, recordingCanvas.height);
      const scale = Math.min(recordingCanvas.width / sourceCanvas.width, recordingCanvas.height / sourceCanvas.height);
      const width = sourceCanvas.width * scale;
      const height = sourceCanvas.height * scale;
      context.drawImage(sourceCanvas, (recordingCanvas.width - width) / 2, (recordingCanvas.height - height) / 2, width, height);
      nextDrawAt += Math.max(1, Math.floor((now - nextDrawAt) / frameInterval) + 1) * frameInterval;
    }
    if (!stopped) drawRequest = window.requestAnimationFrame(draw);
  };
  draw(performance.now());
  const canvasStream = recordingCanvas.captureStream(options.fps);
  const audioTracks = audioStream?.getAudioTracks() ?? [];
  const stream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
  const startedAtMs = Date.now();
  let sessionId: string | undefined;
  try {
    const mimeType = supportedMimeType();
    const session = await window.puppetloom.startPerformanceRecording({
      mimeType,
      fps: options.fps,
      width: recordingCanvas.width,
      height: recordingCanvas.height,
      sourceWidth: sourceCanvas.width,
      sourceHeight: sourceCanvas.height,
      hasAudio: audioTracks.length > 0,
      background: options.background,
      ...(options.targetDurationMs === undefined ? {} : { targetDurationMs: options.targetDurationMs }),
      startedAt: new Date(startedAtMs).toISOString()
    });
    sessionId = session.id;
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, ...(audioTracks.length > 0 ? { audioBitsPerSecond: 128_000 } : {}) });
    let writes = Promise.resolve();
    let recorderError: Error | undefined;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size <= 0) return;
      writes = writes.then(async () => {
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        await window.puppetloom.appendPerformanceRecording(session.id, bytes);
      });
    });
    recorder.addEventListener("error", (event) => {
      recorderError = new Error(`WebM 录制失败：${event.error.message}`);
    });
    recorder.start(1000);
    return {
      async stop(inputSession) {
        try {
          if (recorder.state !== "inactive") {
            await new Promise<void>((resolveStop) => {
              recorder.addEventListener("stop", () => resolveStop(), { once: true });
              recorder.stop();
            });
          }
          await writes;
          if (recorderError) throw recorderError;
          return await window.puppetloom.stopPerformanceRecording(session.id, Date.now() - startedAtMs, inputSession);
        } catch (cause) {
          await window.puppetloom.failPerformanceRecording(session.id, cause instanceof Error ? cause.message : String(cause)).catch(() => undefined);
          throw cause;
        } finally {
          stopped = true;
          if (drawRequest) window.cancelAnimationFrame(drawRequest);
          canvasStream.getTracks().forEach((track) => track.stop());
        }
      }
    };
  } catch (cause) {
    stopped = true;
    if (drawRequest) window.cancelAnimationFrame(drawRequest);
    canvasStream.getTracks().forEach((track) => track.stop());
    if (sessionId) await window.puppetloom.failPerformanceRecording(sessionId, cause instanceof Error ? cause.message : String(cause)).catch(() => undefined);
    throw cause;
  }
}
