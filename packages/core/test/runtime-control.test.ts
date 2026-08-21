import { describe, expect, it } from "vitest";
import { parseRuntimeControlRequest, parseRuntimeInputSession, RuntimeControlStore, type RuntimeViewerDescriptor } from "../src/runtime-control.js";

function viewer(): RuntimeViewerDescriptor {
  return {
    id: 7,
    projectDirectory: "E:\\Characters\\A",
    projectName: "A",
    revision: 3,
    parameters: [{ id: "smile", name: "微笑", min: 0, default: 0, max: 1 }],
    expressions: [{ id: "happy", name: "开心" }],
    behaviors: [{ id: "wave", name: "挥手", duration: 1.5, loop: false }]
  };
}

describe("runtime control protocol", () => {
  it("rejects invalid semantic ranges at the transport boundary", () => {
    expect(() => parseRuntimeControlRequest({ version: 1, requestId: "bad", op: "set", viewerId: 7, source: { id: "camera", motion: { headYaw: 1.01 } } })).toThrow(/-1 到 1/);
    expect(() => parseRuntimeControlRequest({ version: 1, requestId: "bad", op: "set", viewerId: 7, source: { id: "camera", motion: { blink: -0.01 } } })).toThrow(/0 到 1/);
    expect(() => parseRuntimeControlRequest({ version: 1, requestId: "bad", op: "set", viewerId: 7, source: { id: "pointer", motion: { lookTargetStrength: -0.01 } } })).toThrow(/0 到 1/);
    expect(() => parseRuntimeControlRequest({ version: 1, requestId: "bad", op: "trigger", viewerId: 7, sourceId: "hotkey", behaviorId: "wave", expressionId: "happy" })).toThrow(/必须且只能/);
  });

  it("tracks independent sources, expires stale input, and releases deterministically", () => {
    const store = new RuntimeControlStore();
    store.registerViewer(viewer());
    store.apply(parseRuntimeControlRequest({
      version: 1, requestId: "camera-1", op: "set", viewerId: 7,
      source: { id: "camera", priority: 50, blend: 0.8, ttlMs: 100, motion: { headYaw: 0.75 } }
    }), 1000);
    store.apply(parseRuntimeControlRequest({
      version: 1, requestId: "mic-1", op: "set", viewerId: 7,
      source: { id: "microphone", priority: 60, motion: { mouthOpen: 0.6 } }
    }), 1000);
    expect(store.snapshot(7, 1050).sources.map((source) => source.id)).toEqual(["camera", "microphone"]);
    expect(store.snapshot(7, 1100).sources.map((source) => source.id)).toEqual(["microphone"]);
    const result = store.apply(parseRuntimeControlRequest({ version: 1, requestId: "release", op: "release", viewerId: 7 }), 1101) as { released: boolean };
    expect(result.released).toBe(true);
    expect(store.snapshot(7, 1101).sources).toEqual([]);
  });

  it("validates authored IDs and uses authored behavior duration", () => {
    const store = new RuntimeControlStore();
    store.registerViewer(viewer());
    expect(() => store.apply(parseRuntimeControlRequest({
      version: 1, requestId: "unknown", op: "set", viewerId: 7, source: { id: "agent", parameters: { missing: 0.5 } }
    }), 2000)).toThrow(/不存在参数/);
    const result = store.apply(parseRuntimeControlRequest({
      version: 1, requestId: "wave", op: "trigger", viewerId: 7, sourceId: "hotkey", behaviorId: "wave"
    }), 2000) as { source: { expiresAtMs: number } };
    expect(result.source.expiresAtMs).toBe(3500);
    expect(store.snapshot(7, 3499).sources[0]?.behavior).toEqual({ id: "wave", startedAtMs: 2000 });
    expect(store.snapshot(7, 3500).sources).toEqual([]);
  });

  it("parses a portable, ordered input session and rejects time travel", () => {
    const session = {
      version: 1, id: "session", recordedAt: "2026-08-20T00:00:00.000Z", durationMs: 200,
      viewer: { projectDirectory: "E:\\Characters\\A", projectName: "A", revision: 3 },
      events: [
        { atMs: 50, op: "set", source: { id: "camera", ttlMs: 100, motion: { headYaw: 0.5 } } },
        { atMs: 150, op: "release", sourceId: "camera" }
      ]
    };
    expect(parseRuntimeInputSession(session).events).toHaveLength(2);
    expect(() => parseRuntimeInputSession({ ...session, events: [...session.events].reverse() })).toThrow(/按时间排序/);
  });
});
