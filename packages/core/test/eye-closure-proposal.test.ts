import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { createProject, loadProject, loadCalibration } from "../src/project.js";
import { planPrimaryPartAgent, runPrimaryPartAgent } from "../src/primary-part-agent.js";
import { makeAssetRequests } from "../src/assets.js";
import { prepareEyeClosure } from "../src/eye-closure-proposal.js";
import { evaluateLayerAuthoring } from "../src/model.js";
import { neutralMotionState } from "../src/deform.js";
import { runModelAgent } from "../src/model-agent.js";
import { validateAuthoringPreview } from "../src/authoring-preview.js";

describe("original-art eye production", () => {
  it("creates closure without replacement artwork, persists masks and mode, and preserves keys on a second run", async () => {
    const root = artifactPath("eye-closure-production");
    await mkdir(root, { recursive: true });
    await createProject({ input: resolve("test/fixtures/semantic.psd"), output: root, seed: 42 });
    const before = await loadProject(root);
    expect(before.layers.some((layer) => layer.role === "eyeClosed")).toBe(false);
    const options = { part: "eyes" as const, instruction: "制作原图眨眼" };
    const plan = await planPrimaryPartAgent(root, options);
    expect(plan.blockers).toEqual([]);
    expect(plan.assetRequests).toEqual([]);
    const first = await runPrimaryPartAgent(root, options);
    expect(first.visualReview).toBe("unreviewed");
    const report = JSON.parse(await readFile(first.reportPath!, "utf8"));
    expect(report).toMatchObject({ status: "awaiting-visual-review", executionStatus: "succeeded", visualReview: "unreviewed" });
    const after = await loadProject(root);
    // Use a known orientation-preserving thin aperture. The default artistic draft may itself need repair.
    const reviewProject = structuredClone(after);
    for (const l of reviewProject.layers.filter(l => l.role === "eyeWhite" || l.role === "eyelash")) {
      const b = reviewProject.model.bindings.find(b => b.id === `eye-closure-${l.id}`)!;
      b.keyforms.find(k => k.values[0] === 1)!.meshPointDeltas = Object.fromEntries(l.mesh.points.map((p, i) => [String(i), { x: 0, y: (l.bounds.y + l.bounds.height / 2 - p.y) * .98 }]));
    }
    const closureReview = validateAuthoringPreview(reviewProject, { id: "full-blink", label: "完整闭合", parameters: { "param-blink": 1 } });
    expect(closureReview.issues.filter(i => i.code === "mesh-inversion" || i.code === "eye-outside")).toEqual([]);
    const invalid = structuredClone(reviewProject), white = invalid.layers.find(l => l.role === "eyeWhite")!;
    const whiteBinding = invalid.model.bindings.find(b => b.id === `eye-closure-${white.id}`)!;
    whiteBinding.keyforms.find(k => k.values[0] === 1)!.meshPointDeltas = Object.fromEntries(white.mesh.points.map((p, i) => [String(i), { x: 2 * (white.bounds.x + white.bounds.width / 2 - p.x), y: 0 }]));
    expect(validateAuthoringPreview(invalid, { id: "inverted-blink", label: "翻折不能以闭眼豁免", parameters: { "param-blink": 1 } }).issues.some(i => i.code === "mesh-inversion" && i.layerId === white.id)).toBe(true);
    expect(after.runtime.features.blink).toBe(true);
    expect(makeAssetRequests(after).requests.some((request) => request.kind === "closed-eye")).toBe(false);
    for (const iris of after.layers.filter((layer) => layer.role === "iris")) {
      expect(iris.blinkMode).toBe("geometry");
      expect(after.layers.find((layer) => layer.id === iris.clipLayerId)?.role).toBe("eyeWhite");
    }
    const revision = (await loadCalibration(root)).revision;
    await runPrimaryPartAgent(root, options);
    expect((await loadCalibration(root)).revision).toBe(revision);
    expect((await loadProject(root)).model.bindings).toEqual(after.model.bindings);
    const repeated = await runModelAgent(root, { specification: { version: 1, kind: "puppetloom-rig-spec", scope: "selected",
      baseRevision: revision, goal: "保留已制作闭眼形状，检查执行结果与视觉结论分离", parts: [{ part: "eyes",
        rationale: ["现有眼白、睫毛和遮罩已经制作，重跑不能覆盖关键形。"],
        intent: { amplitude: 0.76, response: 0.72, stability: 0.66 } }] } });
    expect(repeated).toMatchObject({ ok: true, status: "awaiting-visual-review", visualReview: "unreviewed", toRevision: revision });
    expect(repeated.parts[0]?.status).toBe("awaiting-visual-review");
    expect((await loadProject(root)).model.bindings).toEqual(after.model.bindings);
    const geometricLash = after.layers.find((layer) => layer.role === "eyelash")!;
    const blink = { ...neutralMotionState, blink: 1 };
    const closedPoints = evaluateLayerAuthoring(after, geometricLash, blink).points;
    expect(closedPoints).not.toEqual(geometricLash.mesh.points);
    const textureLash = { ...geometricLash, blinkMode: "texture" as const };
    expect(evaluateLayerAuthoring(after, textureLash, blink).points).toEqual(textureLash.mesh.points);
    expect(evaluateLayerAuthoring(after, { ...textureLash, blinkMode: "geometry" }, blink).points).toEqual(closedPoints);
    const edited = structuredClone(after);
    edited.model.bindings.push({ id: "artist-custom-blink", parameterIds: ["param-blink"], target: { kind: "layer", id: edited.layers.find((layer) => layer.role === "eyelash")!.id }, keyforms: [{ values: [0] }, { values: [1], transform: { rotationDegrees: 3 } }] });
    const original = structuredClone(edited);
    await expect(prepareEyeClosure(root, edited, edited.layers)).rejects.toThrow("自定义眨眼绑定");
    expect(edited).toEqual(original);
    const parentEdited = structuredClone(after);
    const lash = parentEdited.layers.find((layer) => layer.role === "eyelash")!;
    parentEdited.model.deformers.push({ id: "artist-lid-parent", name: "Artist lid", kind: "rotation", pivot: { ...lash.pivot } });
    lash.deformerId = "artist-lid-parent";
    parentEdited.model.bindings.push({ id: "artist-parent-blink", parameterIds: ["param-blink"], target: { kind: "deformer", id: "artist-lid-parent" }, keyforms: [{ values: [0] }, { values: [1], transform: { rotationDegrees: 4 } }] });
    await expect(prepareEyeClosure(root, parentEdited, parentEdited.layers)).rejects.toThrow("父级已有眨眼绑定");
  }, 60000);
});
