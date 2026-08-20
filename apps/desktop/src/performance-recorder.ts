export interface PerformanceRecordingResult {
  id: string;
  output: string;
  report: string;
  durationMs: number;
  bytes: number;
  hasAudio: boolean;
}

export interface PerformanceRecorder {
  stop(): Promise<PerformanceRecordingResult>;
}

function supportedMimeType(): string {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"];
  const selected = candidates.find((value) => MediaRecorder.isTypeSupported(value));
  if (!selected) throw new Error("当前 Chromium 运行时不支持 WebM MediaRecorder。" );
  return selected;
}

/** Streams canvas recording chunks to Electron main so long sessions stay bounded in memory. */
export async function startPerformanceRecording(
  canvas: HTMLCanvasElement,
  audioStream?: MediaStream,
  fps = 30
): Promise<PerformanceRecorder> {
  const canvasStream = canvas.captureStream(fps);
  const audioTracks = audioStream?.getAudioTracks() ?? [];
  const stream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
  const mimeType = supportedMimeType();
  const startedAtMs = Date.now();
  const session = await window.puppetloom.startPerformanceRecording({
    mimeType,
    fps,
    width: canvas.width,
    height: canvas.height,
    hasAudio: audioTracks.length > 0,
    startedAt: new Date(startedAtMs).toISOString()
  });
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
    async stop() {
      try {
        if (recorder.state !== "inactive") {
          await new Promise<void>((resolveStop) => {
            recorder.addEventListener("stop", () => resolveStop(), { once: true });
            recorder.stop();
          });
        }
        await writes;
        if (recorderError) throw recorderError;
        return await window.puppetloom.stopPerformanceRecording(session.id, Date.now() - startedAtMs);
      } catch (cause) {
        await window.puppetloom.failPerformanceRecording(session.id, cause instanceof Error ? cause.message : String(cause)).catch(() => undefined);
        throw cause;
      } finally {
        canvasStream.getTracks().forEach((track) => track.stop());
      }
    }
  };
}
