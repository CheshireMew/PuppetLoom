import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneProjectForTest } from "../scripts/lib/test-project-clone.mjs";
import { artifactPath } from "./support/artifacts.js";

describe("real project test clone", () => {
  it("hard-links immutable assets, copies editable state, and excludes accumulated reports and drafts", async () => {
    const root = artifactPath("test-project-clone");
    const source = join(root, "source-project");
    const target = join(root, "target-project");
    await mkdir(join(source, "source"), { recursive: true });
    await mkdir(join(source, "textures"), { recursive: true });
    await mkdir(join(source, "calibration", "locks"), { recursive: true });
    await mkdir(join(source, "reports"), { recursive: true });
    await writeFile(join(source, "puppetloom.json"), "{\"name\":\"fixture\"}");
    await writeFile(join(source, "source", "source.psd"), Buffer.alloc(8192, 1));
    await writeFile(join(source, "textures", "texture.png"), Buffer.alloc(4096, 2));
    await writeFile(join(source, "calibration", "current.json"), "{\"revision\":1}");
    await writeFile(join(source, "calibration", "draft.json"), "{\"pending\":true}");
    await writeFile(join(source, "calibration", "locks", "owner.json"), "{}");
    await writeFile(join(source, "reports", "old.png"), Buffer.alloc(32 * 1024, 3));

    const objectRoot = join(root, "shared-objects");
    const report = await cloneProjectForTest(source, target, { objectRoot });
    expect(report).toMatchObject({ linkedFiles: 2, copiedFiles: 2, seededObjects: 2, linkedBytes: 12 * 1024 });
    const psdHash = createHash("sha256").update(Buffer.alloc(8192, 1)).digest("hex");
    const [sourcePsd, targetPsd, objectPsd] = await Promise.all([
      stat(join(source, "source", "source.psd"), { bigint: true }),
      stat(join(target, "source", "source.psd"), { bigint: true }),
      stat(join(objectRoot, psdHash.slice(0, 2), psdHash), { bigint: true })
    ]);
    expect(targetPsd.ino).not.toBe(sourcePsd.ino);
    expect(targetPsd.ino).toBe(objectPsd.ino);
    const [sourceCalibration, targetCalibration] = await Promise.all([
      stat(join(source, "calibration", "current.json"), { bigint: true }),
      stat(join(target, "calibration", "current.json"), { bigint: true })
    ]);
    expect(targetCalibration.ino).not.toBe(sourceCalibration.ino);
    expect(await readFile(join(target, "calibration", "current.json"), "utf8")).toBe("{\"revision\":1}");
    await expect(access(join(target, "reports"))).rejects.toThrow();
    await expect(access(join(target, "calibration", "draft.json"))).rejects.toThrow();
    await expect(access(join(target, "calibration", "locks"))).rejects.toThrow();
  });
});
