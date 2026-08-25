import { TextureSender, getPlatform, sendTextureFromPaintEvent, type PaintDefect } from "@napolab/texture-bridge-core";
import { BrowserWindow } from "electron";

export interface SpoutOutputOptions {
  name?: string;
  width?: number;
  height?: number;
  fps?: 24 | 30 | 60;
}

export interface SpoutOutputStatus {
  supported: boolean;
  active: boolean;
  sourceViewerId?: number;
  senderName?: string;
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  droppedFrames?: number;
  lastDefect?: PaintDefect["reason"];
  lastError?: string;
  message: string;
}

interface ActiveSpoutOutput {
  sourceViewerId: number;
  senderName: string;
  width: number;
  height: number;
  fps: 24 | 30 | 60;
  frames: number;
  droppedFrames: number;
  lastDefect?: PaintDefect["reason"];
  lastError?: string;
  sender: TextureSender;
  window: BrowserWindow;
  stopping: boolean;
}

export interface SpoutOutputServiceOptions {
  rendererPage: string;
  preload: string;
  onMirrorCreated: (mirror: BrowserWindow, sourceViewerId: number) => void;
  onMirrorClosed: (mirrorId: number) => void;
  log?: (event: string, details?: Record<string, unknown>) => void;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  return candidate;
}

function senderName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || "PuppetLoom").slice(0, 255);
}

/** Owns zero-copy Electron OSR -> D3D11 -> Spout2 sessions for viewer windows. */
export class SpoutOutputService {
  private readonly sessions = new Map<number, ActiveSpoutOutput>();
  private readonly log: NonNullable<SpoutOutputServiceOptions["log"]>;

  constructor(private readonly options: SpoutOutputServiceOptions) {
    this.log = options.log ?? (() => undefined);
  }

  supported(): boolean {
    try { return process.platform === "win32" && getPlatform().toLowerCase().includes("spout"); }
    catch { return false; }
  }

  status(sourceViewerId: number): SpoutOutputStatus {
    const session = this.sessions.get(sourceViewerId);
    if (!session) return { supported: this.supported(), active: false, message: this.supported() ? "Spout2 已就绪。" : "当前环境没有可用的 Windows Spout2 原生发送器。" };
    return {
      supported: true,
      active: true,
      sourceViewerId,
      senderName: session.senderName,
      width: session.width,
      height: session.height,
      fps: session.fps,
      frames: session.frames,
      droppedFrames: session.droppedFrames,
      ...(session.lastDefect ? { lastDefect: session.lastDefect } : {}),
      ...(session.lastError ? { lastError: session.lastError } : {}),
      message: session.lastError ? `Spout2 原生发送失败：${session.lastError}` : session.lastDefect ? `Spout2 正在输出，但最近一帧被丢弃：${session.lastDefect}` : "Spout2 正在输出共享纹理。"
    };
  }

  async start(input: { sourceViewerId: number; projectDirectory: string; projectName: string; revision?: number; options?: SpoutOutputOptions }): Promise<SpoutOutputStatus> {
    if (!this.supported()) throw new Error("当前环境没有可用的 Windows Spout2 原生发送器。");
    await this.stop(input.sourceViewerId);
    const width = boundedInteger(input.options?.width, 1080, 64, 4096, "Spout2 宽度");
    const height = boundedInteger(input.options?.height, 1080, 64, 4096, "Spout2 高度");
    const fpsValue = input.options?.fps ?? 60;
    if (fpsValue !== 24 && fpsValue !== 30 && fpsValue !== 60) throw new Error("Spout2 帧率必须是 24、30 或 60。" );
    const fps = fpsValue;
    const name = senderName(input.options?.name ?? `${input.projectName} · PuppetLoom`);
    const sender = new TextureSender(name, width, height);
    const window = new BrowserWindow({
      width,
      height,
      show: false,
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }
      }
    });
    const session: ActiveSpoutOutput = { sourceViewerId: input.sourceViewerId, senderName: name, width, height, fps, frames: 0, droppedFrames: 0, sender, window, stopping: false };
    this.sessions.set(input.sourceViewerId, session);
    try { this.options.onMirrorCreated(window, input.sourceViewerId); }
    catch (cause) {
      sender.stop();
      this.sessions.delete(input.sourceViewerId);
      window.destroy();
      throw cause;
    }
    window.webContents.setFrameRate(fps);
    window.webContents.on("paint", (details) => {
      const texture = details.texture;
      if (!texture) {
        session.droppedFrames += 1;
        session.lastDefect = "no-texture";
        return;
      }
      try {
        const defect = sendTextureFromPaintEvent(sender, texture.textureInfo);
        if (defect) {
          session.droppedFrames += 1;
          session.lastDefect = defect.reason;
        } else {
          session.frames += 1;
          delete session.lastDefect;
          delete session.lastError;
        }
      } catch (cause) {
        session.droppedFrames += 1;
        session.lastError = cause instanceof Error ? cause.message : String(cause);
        this.log("spout-frame-error", { sourceViewerId: input.sourceViewerId, error: session.lastError });
      } finally {
        texture.release();
      }
    });
    window.once("closed", () => {
      this.options.onMirrorClosed(window.id);
      if (!session.stopping) {
        session.stopping = true;
        sender.stop();
        this.sessions.delete(input.sourceViewerId);
      }
    });
    try {
      await window.loadFile(this.options.rendererPage, { query: {
        viewer: "1",
        output: "spout",
        project: input.projectDirectory,
        ...(input.revision === undefined ? {} : { revision: String(input.revision) })
      } });
    } catch (cause) {
      await this.stop(input.sourceViewerId);
      throw cause;
    }
    this.log("spout-output-started", { sourceViewerId: input.sourceViewerId, senderName: name, width, height, fps });
    return this.status(input.sourceViewerId);
  }

  async stop(sourceViewerId: number): Promise<SpoutOutputStatus> {
    const session = this.sessions.get(sourceViewerId);
    if (!session) return this.status(sourceViewerId);
    session.stopping = true;
    session.sender.stop();
    if (!session.window.isDestroyed()) session.window.destroy();
    this.options.onMirrorClosed(session.window.id);
    this.sessions.delete(sourceViewerId);
    this.log("spout-output-stopped", { sourceViewerId, frames: session.frames, droppedFrames: session.droppedFrames });
    return this.status(sourceViewerId);
  }

  async stopAll(): Promise<void> {
    for (const sourceViewerId of [...this.sessions.keys()]) await this.stop(sourceViewerId);
  }
}
