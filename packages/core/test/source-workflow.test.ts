import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { finalizeSourceReview, prepareSourceTask, reviewSourceCandidate } from "../src/source-workflow.js";

describe("source preparation workflow", () => {
  it("keeps the original, candidate and visual evidence bound to one review decision", async () => {
    const directory = artifactPath(`source-workflow-${process.pid}-${Date.now()}`);
    const prepared = await prepareSourceTask({ reference: "test/fixtures/semantic-reference.png", output: directory, name: "Semantic fixture" });
    expect(prepared.task).toMatchObject({ status: "awaiting-decomposition", reference: { width: 512, height: 512 } });

    const result = await reviewSourceCandidate({ task: directory, psd: "test/fixtures/semantic.psd" });
    expect(result).toMatchObject({ blockers: [], task: { status: "awaiting-visual-review", reviews: [{ index: 1 }] }, review: { valid: true, requiresVisualReview: true } });
    expect((await stat(result.review.artifacts.comparison!)).isFile()).toBe(true);
    expect((await stat(result.review.artifacts.layerContactSheet)).isFile()).toBe(true);

    const finalized = await finalizeSourceReview({ task: directory, review: 1, decision: "ready", note: "并排重组一致，逐图层结构完整。" });
    expect(finalized.status).toBe("ready");
    expect(finalized.reviews[0]!.status).toBe("ready");
    expect(JSON.parse(await readFile(`${directory}/reviews/0001/visual-decision.json`, "utf8"))).toMatchObject({ decision: "ready", review: 1 });
  });
});
