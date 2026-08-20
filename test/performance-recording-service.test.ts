import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PerformanceRecordingService } from "../apps/desktop/electron/performance-recording-service.js";

function projectDirectory(label: string): string {
  return join("D:\\Tools", "PuppetLoom", "e2e", "performance-recording-service", `${label}-${randomUUID()}`);
}

const metadata = {
  mimeType: "video/webm;codecs=vp8",
  fps: 30,
  width: 640,
  height: 720,
  sourceWidth: 1440,
  sourceHeight: 1440,
  hasAudio: false,
  background: { mode: "solid" as const, color: "#00ff00" },
  targetDurationMs: 2_000,
  startedAt: "2026-08-20T00:00:00.000Z"
};

describe("performance recording service", () => {
  it("streams chunks into one completed WebM and writes a durable report", () => {
    const service = new PerformanceRecordingService();
    const session = service.start({ viewerId: 7, projectDirectory: projectDirectory("complete"), projectName: "Test", revision: 32, metadata });
    service.append(7, session.id, Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]));
    service.append(7, session.id, Uint8Array.from([1, 2, 3]));
    const inputSession = { output: "D:\\Tools\\PuppetLoom\\input.runtime-input.json", durationMs: 1240, events: 8 };
    const result = service.stop(7, session.id, 1250, inputSession);
    expect(result.bytes).toBe(7);
    expect(result.durationMs).toBe(1250);
    expect(existsSync(result.output)).toBe(true);
    expect([...readFileSync(result.output)]).toEqual([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    const report = JSON.parse(readFileSync(result.report, "utf8")) as Record<string, unknown>;
    expect(report.status).toBe("completed");
    expect(report.project).toMatchObject({ name: "Test", revision: 32 });
    expect(report.media).toMatchObject({ fps: 30, width: 640, height: 720, sourceWidth: 1440, sourceHeight: 1440, background: { mode: "solid", color: "#00ff00" }, targetDurationMs: 2_000 });
    expect(report.inputSession).toEqual(inputSession);
    expect(result.relativeOutput).toMatch(/^reports\/performances\/.+\.webm$/);
    expect(result.relativeReport).toMatch(/^reports\/performances\/.+\.performance\.json$/);
  });

  it("keeps an interrupted partial file and reports why it was not finalized", () => {
    const service = new PerformanceRecordingService();
    const session = service.start({ viewerId: 8, projectDirectory: projectDirectory("interrupted"), projectName: "Test", metadata });
    service.append(8, session.id, Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]));
    service.interruptViewer(8, "window closed");
    const report = JSON.parse(readFileSync(session.report, "utf8")) as { status: string; output: string; error: string };
    expect(report.status).toBe("interrupted");
    expect(report.error).toBe("window closed");
    expect(report.output.endsWith(".partial.webm")).toBe(true);
    expect(existsSync(report.output)).toBe(true);
  });

  it("rejects invalid formats and cross-window appends", () => {
    const service = new PerformanceRecordingService();
    expect(() => service.start({ viewerId: 9, projectDirectory: projectDirectory("invalid"), projectName: "Test", metadata: { ...metadata, mimeType: "video/mp4" } })).toThrow(/WebM/);
    expect(() => service.start({ viewerId: 9, projectDirectory: projectDirectory("invalid-background"), projectName: "Test", metadata: { ...metadata, background: { mode: "solid", color: "green" } } })).toThrow(/#RRGGBB/);
    const session = service.start({ viewerId: 9, projectDirectory: projectDirectory("owner"), projectName: "Test", metadata });
    expect(() => service.append(10, session.id, Uint8Array.from([1]))).toThrow(/当前角色窗口/);
    service.interruptAll("test complete");
  });
});
