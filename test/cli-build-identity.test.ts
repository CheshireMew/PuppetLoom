import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { inspectCliBuild } from "../scripts/lib/cli-build-identity.mjs";
import { artifactPath } from "./support/artifacts.js";

describe("CLI build identity", () => {
  it("rejects changed sources, changed or missing output and an undeclared stale module", async () => {
    const root = artifactPath("build-identity-workspace");
    const manifestPath = "apps/cli/dist/build-identity.json";
    const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8")) as { sources: Record<string, string>; outputs: Record<string, string> };
    for (const path of [...Object.keys(manifest.sources), ...Object.keys(manifest.outputs), manifestPath]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await copyFile(resolve(path), join(root, path));
    }
    expect((await inspectCliBuild(root)).current).toBe(true);
    const source = "apps/cli/src/index.ts";
    await writeFile(join(root, source), `${await readFile(join(root, source), "utf8")}\n// changed\n`);
    expect(await inspectCliBuild(root)).toMatchObject({ current: false, problems: ["源码或构建配置已变化"] });
    await copyFile(resolve(source), join(root, source));
    const output = "apps/cli/dist/index.js";
    await writeFile(join(root, output), "throw new Error('changed');\n");
    expect(await inspectCliBuild(root)).toMatchObject({ current: false, problems: ["编译文件已变化"] });
    await copyFile(resolve(output), join(root, output));
    await rename(join(root, output), join(root, "withheld-index.js"));
    expect((await inspectCliBuild(root)).current).toBe(false);
    await rename(join(root, "withheld-index.js"), join(root, output));
    await writeFile(join(root, "apps/cli/dist/stale.js"), "export const stale = true;\n");
    expect(await inspectCliBuild(root)).toMatchObject({ current: false, problems: [expect.stringContaining("stale.js")] });
  });

  it("discovers commands and options from the running CLI registry with a current build identity", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((success, reject) => {
      const child = spawn(process.execPath, [resolve("apps/cli/dist/index.js"), "capabilities", "--json"], { cwd: resolve("."), windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => success({ code, stdout, stderr }));
    });
    expect(result.code, result.stderr).toBe(0);
    const description = JSON.parse(result.stdout);
    expect(description).toMatchObject({ protocol: 1, build: { current: true }, skill: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    const author = description.commands.find((command: { name: string }) => command.name === "author");
    expect(author.commands.find((command: { name: string }) => command.name === "geometry").options).toContainEqual(expect.objectContaining({ flags: "--limit <number>" }));
  });
});
