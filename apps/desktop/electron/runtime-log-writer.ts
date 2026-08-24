import { appendFile, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RuntimeLogWriterOptions {
  path: string;
  rotateBytes: number;
  maximumTotalBytes: number;
  flushIntervalMs?: number;
  maximumBatchBytes?: number;
}

/** Batches diagnostics so runtime input never waits for filesystem metadata or writes. */
export class RuntimeLogWriter {
  private readonly path: string;
  private readonly rotateBytes: number;
  private readonly maximumTotalBytes: number;
  private readonly flushIntervalMs: number;
  private readonly maximumBatchBytes: number;
  private readonly initialization: Promise<void>;
  private writeChain = Promise.resolve();
  private queue: string[] = [];
  private queuedBytes = 0;
  private activeBytes = 0;
  private totalBytes = 0;
  private rotation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RuntimeLogWriterOptions) {
    this.path = options.path;
    this.rotateBytes = options.rotateBytes;
    this.maximumTotalBytes = options.maximumTotalBytes;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.maximumBatchBytes = options.maximumBatchBytes ?? 64 * 1024;
    this.initialization = this.initialize();
  }

  log(event: string, details: Record<string, unknown> = {}): void {
    try {
      const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`;
      this.queue.push(line);
      this.queuedBytes += Buffer.byteLength(line);
      if (this.queuedBytes >= this.maximumBatchBytes) {
        void this.flush().catch(() => undefined);
      } else if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush().catch(() => undefined);
        }, this.flushIntervalMs);
        this.timer.unref?.();
      }
    } catch {
      // Diagnostics must never block the runtime path.
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return this.writeChain;
    const payload = this.queue.join("");
    const payloadBytes = this.queuedBytes;
    this.queue = [];
    this.queuedBytes = 0;
    const operation = this.writeChain.then(async () => {
      await this.initialization;
      if (this.totalBytes + payloadBytes > this.maximumTotalBytes) return;
      if (this.activeBytes > 0 && this.activeBytes + payloadBytes > this.rotateBytes) await this.rotate();
      await appendFile(this.path, payload, "utf8");
      this.activeBytes += payloadBytes;
      this.totalBytes += payloadBytes;
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    await this.flush().catch(() => undefined);
    await this.writeChain;
  }

  private async initialize(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const policyPath = join(directory, "runtime-log-policy.json");
    try {
      await writeFile(policyPath, `${JSON.stringify({
        version: 1,
        owner: "PuppetLoom desktop runtime",
        activeLog: this.path,
        rotateBytes: this.rotateBytes,
        maximumTotalBytes: this.maximumTotalBytes,
        cleanup: "report-only"
      }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    const names = await readdir(directory);
    const runtimeLogs = names.filter((name) => /^runtime(?:-[\dT.Z-]+-\d+(?:-\d+)?)?\.log$/.test(name));
    const sizes = await Promise.all(runtimeLogs.map(async (name) => ({ name, size: (await stat(join(directory, name))).size })));
    this.totalBytes = sizes.reduce((sum, item) => sum + item.size, 0);
    this.activeBytes = sizes.find((item) => join(directory, item.name) === this.path)?.size ?? 0;
  }

  private async rotate(): Promise<void> {
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const archived = join(dirname(this.path), `runtime-${stamp}-${process.pid}-${this.rotation}.log`);
    this.rotation += 1;
    await rename(this.path, archived);
    this.activeBytes = 0;
  }
}
