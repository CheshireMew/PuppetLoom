import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isTestArtifactProject, recentProjectDisplayName, usableRecentProjects } from "../apps/desktop/electron/recent-projects.js";
import { artifactPath } from "./support/artifacts.js";

describe("recent project filtering", () => {
  it("uses the project directory name when legacy metadata only says source", () => {
    const directory = resolve("workspace/models/blue-whale-maid");
    expect(recentProjectDisplayName("source", directory)).toBe(basename(directory));
    expect(recentProjectDisplayName("Blue Whale", directory)).toBe("Blue Whale");
  });

  it("hides stale and test-artifact entries from the normal launcher", async () => {
    const directory = artifactPath(`recent-project-${process.pid}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "puppetloom.json"), "{}\n", "utf8");
    const entries = [
      { directory, name: "source", openedAt: "2026-08-20T00:00:00.000Z" },
      { directory: resolve(directory, "missing"), name: "stale", openedAt: "2026-08-19T00:00:00.000Z" }
    ];
    expect(isTestArtifactProject(directory)).toBe(true);
    expect(await usableRecentProjects(entries)).toEqual([]);
    expect(await usableRecentProjects(entries, true)).toEqual([
      { directory: resolve(directory), name: basename(directory), openedAt: "2026-08-20T00:00:00.000Z" }
    ]);
  });
});
