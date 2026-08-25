import { describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { editPerformanceTake, importPerformanceTake, listPerformanceTakes, readPerformanceTake } from "../src/take-library.js";

const session = { version: 1, id: "source-session", recordedAt: "2026-08-24T00:00:00.000Z", durationMs: 1000, viewer: { projectDirectory: "E:\\Characters\\A", projectName: "A", revision: 1 }, events: [
  { atMs: 0, op: "set", source: { id: "camera", motion: { headYaw: 0, headPitch: 0 } } },
  { atMs: 500, op: "set", source: { id: "camera", motion: { headYaw: 1, headPitch: 0.8 } } },
  { atMs: 900, op: "release", sourceId: "camera" }
] };

describe("performance Take library", () => {
  it("preserves the imported take and creates a trimmed, retimed, filtered edit as a child", async () => {
    const root = artifactPath(`take-library-${process.pid}-${Date.now()}`);
    const original = await importPerformanceTake(root, session, { name: "Original", tags: ["camera"] });
    const edited = await editPerformanceTake(root, original.id, { name: "Close-up", trim: { startMs: 200, endMs: 800 }, speed: 2, smoothWindow: 2, muteMotion: ["headPitch"] });
    expect(edited).toMatchObject({ name: "Close-up", parentTakeId: original.id, durationMs: 300 });
    const document = await readPerformanceTake(root, edited.id); expect(document.session.events[0]).toMatchObject({ atMs: 0, op: "set" });
    expect(document.session.events.some((event) => event.op === "set" && event.source.motion?.headPitch !== undefined)).toBe(false);
    expect(await listPerformanceTakes(root)).toHaveLength(2);
  });
});
