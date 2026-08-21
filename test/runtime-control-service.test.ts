import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRuntimeControlRequest, parseRuntimeControlServiceRequest } from "../packages/core/src/runtime-control.js";
import { RuntimeControlService } from "../apps/desktop/electron/runtime-control-service.js";

afterEach(() => vi.useRealTimers());

describe("desktop input session recording and replay", () => {
  it("records effective control events and isolates replay from live sources", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const service = new RuntimeControlService({ profileDirectory: "D:\\Tools\\PuppetLoom\\e2e\\runtime-session-test", port: 0 });
    service.registerViewer({
      id: 1, projectDirectory: "E:\\Characters\\A", projectName: "A",
      parameters: [{ id: "smile", name: "Smile", min: 0, default: 0, max: 1 }],
      expressions: [{ id: "happy", name: "Happy" }], behaviors: []
    });
    service.applyLocal(parseRuntimeControlServiceRequest({ version: 1, requestId: "record", op: "record-start", viewerId: 1 }));
    vi.advanceTimersByTime(100);
    service.applyLocal(parseRuntimeControlRequest({ version: 1, requestId: "camera", op: "set", viewerId: 1, source: { id: "camera", motion: { headYaw: 0.7 }, ttlMs: 500 } }));
    vi.advanceTimersByTime(100);
    service.applyLocal(parseRuntimeControlRequest({ version: 1, requestId: "live", op: "set", viewerId: 1, source: { id: "live", priority: 90, motion: { mouthOpen: 0.4 } } }));
    vi.advanceTimersByTime(100);
    const stopped = service.applyLocal(parseRuntimeControlServiceRequest({ version: 1, requestId: "stop", op: "record-stop", viewerId: 1 })) as { session: { durationMs: number; events: unknown[] } };
    expect(stopped.session.durationMs).toBe(300);
    expect(stopped.session.events).toHaveLength(2);

    service.applyLocal(parseRuntimeControlRequest({ version: 1, requestId: "release-camera", op: "release", viewerId: 1, sourceId: "camera" }));
    service.applyLocal(parseRuntimeControlServiceRequest({ version: 1, requestId: "replay", op: "replay-start", viewerId: 1, session: stopped.session }));
    vi.advanceTimersByTime(110);
    const active = service.snapshot(1).sources;
    expect(active.some((source) => source.id.startsWith("replay:") && source.motion?.headYaw === 0.7)).toBe(true);
    expect(active.some((source) => source.id === "live")).toBe(false);
    expect(service.store.snapshot(1).sources.some((source) => source.id === "live")).toBe(true);
    vi.advanceTimersByTime(250);
    expect(service.snapshot(1).sources.map((source) => source.id)).toEqual(["live"]);
  });

  it("rejects replay against a different saved revision", () => {
    const service = new RuntimeControlService({ profileDirectory: "D:\\Tools\\PuppetLoom\\e2e\\runtime-session-revision-test", port: 0 });
    service.registerViewer({
      id: 1, projectDirectory: "E:\\Characters\\A", projectName: "A", revision: 4,
      parameters: [], expressions: [], behaviors: []
    });
    expect(() => service.applyLocal(parseRuntimeControlServiceRequest({
      version: 1, requestId: "replay", op: "replay-start", viewerId: 1,
      session: {
        version: 1, id: "old-session", recordedAt: "2026-08-20T00:00:00.000Z", durationMs: 0,
        viewer: { projectDirectory: "E:\\Characters\\A", projectName: "A", revision: 3 }, events: []
      }
    }))).toThrow(/revision 3/);
  });

  it("starts a recording with the inputs that are already active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const service = new RuntimeControlService({ profileDirectory: "D:\\Tools\\PuppetLoom\\e2e\\runtime-session-baseline-test", port: 0 });
    service.registerViewer({ id: 1, projectDirectory: "E:\\Characters\\A", projectName: "A", revision: 4, parameters: [], expressions: [], behaviors: [] });
    service.applyLocal(parseRuntimeControlRequest({
      version: 1, requestId: "pointer", op: "set", viewerId: 1,
      source: { id: "pointer", priority: 20, ttlMs: 250, motion: { lookTargetX: 0.8, lookTargetY: -0.4, lookTargetStrength: 1 } }
    }));
    service.applyLocal(parseRuntimeControlServiceRequest({ version: 1, requestId: "record", op: "record-start", viewerId: 1 }));
    vi.advanceTimersByTime(100);
    const stopped = service.applyLocal(parseRuntimeControlServiceRequest({ version: 1, requestId: "stop", op: "record-stop", viewerId: 1 })) as { session: { events: Array<{ atMs: number; source?: { id: string; ttlMs?: number } }> } };
    expect(stopped.session.events[0]).toMatchObject({ atMs: 0, source: { id: "pointer", ttlMs: 250 } });
  });
});
