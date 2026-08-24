import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWindowPreferences, visibleWindowBounds, WindowPreferencesStore } from "../apps/desktop/electron/window-preferences.js";
import { artifactPath } from "./support/artifacts.js";

describe("desktop window preferences", () => {
  it("migrates the previous global mouse-tracking preference", () => {
    const migrated = parseWindowPreferences({ version: 1, mouseTracking: false, updatedAt: "2026-08-01T00:00:00.000Z" });
    expect(migrated).toMatchObject({ version: 2, viewerDefaults: { mouseTracking: false }, viewers: {} });
  });

  it("keeps restored windows fully visible after the display layout changes", () => {
    const workAreas = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: 0, width: 1280, height: 984 }];
    expect(visibleWindowBounds(
      { x: 3400, y: -900, width: 1440, height: 900 },
      workAreas,
      { width: 1440, height: 900 },
      { width: 900, height: 640 }
    )).toEqual({ x: 480, y: 0, width: 1440, height: 900 });
    expect(visibleWindowBounds(
      { x: -1500, y: 800, width: 900, height: 900 },
      workAreas,
      { width: 720, height: 720 },
      { width: 220, height: 220 },
      1
    )).toEqual({ x: -1280, y: 84, width: 900, height: 900 });
  });

  it("persists control and per-project viewer state without persisting click-through", () => {
    const path = artifactPath("window-preferences-" + process.pid + "-" + Date.now() + ".json");
    const store = new WindowPreferencesStore(path);
    store.updateControl({ bounds: { x: 73, y: 91, width: 1000, height: 700 }, maximized: false });
    store.updateViewer("E:\\Characters\\Alice", {
      bounds: { x: 120, y: 80, width: 640, height: 720 },
      alwaysOnTop: false,
      mouseTracking: false,
      scale: 0.8
    });
    const reloaded = new WindowPreferencesStore(path);
    expect(reloaded.control()).toEqual({ bounds: { x: 73, y: 91, width: 1000, height: 700 }, maximized: false });
    expect(reloaded.viewer("e:\\characters\\alice")).toEqual({
      bounds: { x: 120, y: 80, width: 640, height: 720 },
      alwaysOnTop: false,
      mouseTracking: false,
      scale: 0.8
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("clickThrough");
  });
});
