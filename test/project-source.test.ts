import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectSource } from "../scripts/lib/project-source.mjs";
import { artifactPath } from "./support/artifacts.js";

async function createProjectMarker(directory: string): Promise<string> {
  await mkdir(join(directory, "calibration"), { recursive: true });
  await writeFile(join(directory, "puppetloom.json"), "{}");
  await writeFile(join(directory, "calibration", "current.json"), "{}");
  return resolve(directory);
}

describe("canonical project source", () => {
  it("prefers an explicit project over the environment override", async () => {
    const explicit = await createProjectMarker(artifactPath(`project-source-explicit-${process.pid}-${Date.now()}`));
    const environment = await createProjectMarker(artifactPath(`project-source-environment-${process.pid}-${Date.now()}`));
    await expect(resolveProjectSource(explicit, { PUPPETLOOM_CANONICAL_PROJECT: environment })).resolves.toBe(explicit);
  });

  it("uses the environment override when no explicit project is supplied", async () => {
    const environment = await createProjectMarker(artifactPath(`project-source-override-${process.pid}-${Date.now()}`));
    await expect(resolveProjectSource(undefined, { PUPPETLOOM_CANONICAL_PROJECT: environment })).resolves.toBe(environment);
  });

  it("rejects a directory that is not a recoverable PuppetLoom project", async () => {
    const missing = artifactPath(`project-source-missing-${process.pid}-${Date.now()}`);
    await expect(resolveProjectSource(missing, {})).rejects.toThrow("找不到正式 PuppetLoom 项目");
  });
});
