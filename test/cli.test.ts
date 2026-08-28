import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { artifactPath } from "./support/artifacts.js";

const cliProject = artifactPath(`cli-project-${process.pid}-${Date.now()}`);

function cli(args: string[], environment: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve("apps/cli/dist/index.js"), ...args], { cwd: resolve("."), windowsHide: true, env: { ...process.env, ...environment } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe("CLI contract", () => {
  beforeAll(async () => {
    const result = await cli(["create", "--input", "test/fixtures/semantic.psd", "--output", cliProject, "--seed", "42", "--json"]);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  }, 120_000);

  it("returns JSON and exit 0 for a usable PSD", async () => {
    const result = await cli(["inspect", "--input", "test/fixtures/semantic.psd", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, suggestedRigLevel: "semantic" });
  });

  it("uses exit 2 for invalid PSD input", async () => {
    const result = await cli(["inspect", "--input", "test/fixtures/corrupted.psd", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("uses exit 3 for file-system or project errors", async () => {
    const result = await cli(["verify", "--project", "test/fixtures/not-a-project", "--json"]);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, exitCode: 3 });
  });

  it("returns machine-readable exit 2 for an invalid Agent scope", async () => {
    const result = await cli(["agent", "plan", "--project", cliProject, "--scope", "hair-ish", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      exitCode: 2,
      error: expect.stringContaining("不支持的 Agent 范围")
    });
  });

  it("returns machine-readable exit 2 when an Agent command misses a required option", async () => {
    const result = await cli(["agent", "plan", "--scope", "whole", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      exitCode: 2,
      error: expect.stringContaining("--project")
    });
  });

  it("plans and reviews PSD repair work without overwriting an input", async () => {
    const files = artifactPath(`cli-psd-repair-${process.pid}-${Date.now()}`);
    await mkdir(files, { recursive: true });
    const recipe = resolve(files, "recipe.json");
    await writeFile(recipe, JSON.stringify({
      version: 1,
      kind: "puppetloom-photoshop-psd-repair",
      basePsd: resolve("test/fixtures/semantic.psd"),
      sources: [],
      operations: [{ op: "set-visibility", layer: "face", visible: true }],
      checks: { requiredLayers: ["face"], opaqueInteriorLayers: [] }
    }));
    const planned = await cli(["psd", "repair", "--recipe", recipe, "--output", resolve(files, "new.psd"), "--workdir", resolve(files, "repair-run"), "--dry-run", "--json"]);
    expect(planned.code).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({ ok: true, stage: "psd-repair-planned", dryRun: true, engine: "photoshop-com" });

    const reviewDirectory = resolve(files, "review");
    const reviewed = await cli(["psd", "review", "--input", "test/fixtures/semantic.psd", "--recipe", recipe, "--workdir", reviewDirectory, "--json"]);
    expect(reviewed.code).toBe(4);
    expect(JSON.parse(reviewed.stdout)).toMatchObject({ ok: false, completed: false, status: "awaiting-visual-review", stage: "psd-repair-awaiting-visual-review", readyForCreate: false, requiresVisualReview: true });
    expect((await stat(resolve(reviewDirectory, "layer-contact-sheet.png"))).isFile()).toBe(true);

    const decisionPath = resolve(reviewDirectory, "visual-review.json");
    const decision = JSON.parse(await readFile(decisionPath, "utf8")) as { status: string; reviewer: string | null; checks: Array<{ status: string; note: string }> };
    decision.status = "accepted";
    decision.reviewer = "CLI contract reviewer";
    for (const check of decision.checks) Object.assign(check, { status: "pass", note: "已检查对应视觉证据。" });
    await writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    const finalized = await cli(["psd", "finalize", "--workdir", reviewDirectory, "--decision", decisionPath, "--json"]);
    expect(finalized.code).toBe(0);
    expect(JSON.parse(finalized.stdout)).toMatchObject({ ok: true, completed: true, status: "accepted", stage: "psd-repair-visual-review-finalized", readyForCreate: true });
  }, 120_000);

  it("lets an external Agent generate, edit and validate a revision-pinned rig specification", async () => {
    const generated = await cli(["agent", "specification", "--project", cliProject, "--scope", "frontHair", "--json"]);
    expect(generated.code).toBe(0);
    const specification = JSON.parse(generated.stdout) as {
      kind: string;
      baseRevision: number;
      goal: string;
      anatomy: Record<string, unknown>;
      parts: Array<{ part: string; layerIds: string[]; rationale: string[]; intent: { amplitude: number; deformationScale: number } }>;
    };
    expect(specification).toMatchObject({ kind: "puppetloom-rig-spec", scope: "selected", baseRevision: 0, parts: [{ part: "frontHair" }] });
    const files = artifactPath(`cli-agent-spec-${process.pid}-${Date.now()}`);
    await mkdir(files, { recursive: true });
    const rawTemplatePath = resolve(files, "unreviewed-template.json");
    await writeFile(rawTemplatePath, JSON.stringify(specification));
    const rawTemplatePlan = await cli(["agent", "plan", "--project", cliProject, "--spec", rawTemplatePath, "--json"]);
    expect(rawTemplatePlan.code).toBe(2);
    expect(JSON.parse(rawTemplatePlan.stderr).error).toContain("未审查模板");

    specification.goal = "外部 Agent 看图后决定让前发更克制";
    specification.parts[0]!.rationale = ["连续转头证据中发梢摆幅偏大。"];
    specification.parts[0]!.intent.amplitude = 0.65;
    specification.parts[0]!.intent.deformationScale = 0.7;
    const current = JSON.parse(await readFile(resolve(cliProject, "puppetloom.json"), "utf8")) as {
      layers: Array<{ id: string; pivot: { x: number; y: number }; hairStrands?: unknown; mesh: { points: unknown[]; influences?: { physicsRelease?: number[] } } }>;
    };
    const frontHair = current.layers.find((layer) => layer.id === specification.parts[0]!.layerIds[0])!;
    specification.anatomy = {
      layers: {
        [frontHair.id]: {
          pivot: frontHair.pivot,
          ...(frontHair.hairStrands ? { hairStrands: frontHair.hairStrands } : {
            vertexInfluences: { physicsRelease: Object.fromEntries(frontHair.mesh.points.map((_, index) => [String(index), frontHair.mesh.influences?.physicsRelease?.[index] ?? 0])) }
          })
        }
      }
    };
    const path = resolve(files, "rig-spec.json");
    await writeFile(path, JSON.stringify(specification));
    const planned = await cli(["agent", "plan", "--project", cliProject, "--spec", path, "--json"]);
    expect(planned.code).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({
      inputMode: "structured-specification",
      instruction: specification.goal,
      specification: { parts: [{ intent: { amplitude: 0.65, deformationScale: 0.7 } }] }
    });

    const mixed = await cli(["agent", "plan", "--project", cliProject, "--spec", path, "--scope", "frontHair", "--json"]);
    expect(mixed.code).toBe(2);
    expect(JSON.parse(mixed.stderr).error).toContain("不能再传");
  }, 120_000);

  it("lets explicit layerIds route an unknown layer into accessory planning", async () => {
    const unknownProject = artifactPath(`cli-unknown-accessory-${process.pid}-${Date.now()}`);
    const created = await cli(["create", "--input", "test/fixtures/semantic.psd", "--output", unknownProject, "--seed", "42", "--json"]);
    expect(created.code).toBe(0);
    const projectPath = resolve(unknownProject, "puppetloom.json");
    const project = JSON.parse(await readFile(projectPath, "utf8")) as {
      layers: Array<{ id: string; sourceName: string; role: string }>;
    };
    for (const layer of project.layers) if (layer.role === "accessory") layer.role = "unknown";
    const target = project.layers.find((layer) => layer.sourceName === "accessory_ribbon");
    expect(target).toBeDefined();
    await writeFile(projectPath, JSON.stringify(project));

    const files = artifactPath(`cli-unknown-accessory-spec-${process.pid}-${Date.now()}`);
    await mkdir(files, { recursive: true });
    const specificationPath = resolve(files, "rig-spec.json");
    await writeFile(specificationPath, JSON.stringify({
      version: 1,
      kind: "puppetloom-rig-spec",
      scope: "selected",
      baseRevision: 0,
      goal: "把未识别但已确认的装饰图层作为配饰制作",
      parts: [{
        part: "accessory",
        layerIds: [target!.id],
        rationale: ["图层轮廓完整，自动命名不足以判断语义，因此由外部 Agent 显式指定。"],
        intent: {
          amplitude: 0.45,
          response: 0.56,
          stability: 0.64,
          lagResponse: 7.4,
          lagDamping: 0.78,
          deformationScale: 0.82
        }
      }]
    }));

    const planned = await cli(["agent", "plan", "--project", unknownProject, "--spec", specificationPath, "--json"]);
    expect(planned.code).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({
      canApply: true,
      parts: [{ part: "accessory", status: "ready", targetLayerIds: [target!.id] }]
    });
  }, 120_000);

  it("keeps every whole-model responsibility visible and blocks omitted available parts", async () => {
    const generated = await cli(["agent", "specification", "--project", cliProject, "--scope", "whole", "--json"]);
    expect(generated.code).toBe(0);
    const specification = JSON.parse(generated.stdout) as {
      scope: "whole";
      goal: string;
      anatomy: Record<string, unknown>;
      parts: Array<{ part: string; layerIds: string[]; rationale: string[] }>;
    };
    expect(specification.scope).toBe("whole");
    expect(specification.parts.length).toBeGreaterThan(0);
    specification.goal = "外部 Agent 已查看整模基线，并逐项确认现有部位的制作意图";
    for (const part of specification.parts) part.rationale = [`已检查 ${part.part} 的基线和连续运动，需要按本规格制作。`];
    const current = JSON.parse(await readFile(resolve(cliProject, "puppetloom.json"), "utf8")) as {
      runtime: { semanticCage: { points: Record<string, { position: { x: number; y: number } }> } };
      layers: Array<{
        id: string;
        pivot: { x: number; y: number };
        hairStrands?: unknown;
        headwearPerspective?: unknown;
        mesh: { points: unknown[]; influences?: { physicsRelease?: number[] } };
      }>;
    };
    const geometryParts = new Set(["headFace", "mouth", "frontHair", "backHair", "ears", "headwear", "topCloth"]);
    const headwearLayerIds = new Set(specification.parts.find((part) => part.part === "headwear")?.layerIds ?? []);
    const geometryLayerIds = new Set(specification.parts.filter((part) => geometryParts.has(part.part)).flatMap((part) => part.layerIds));
    specification.anatomy = {
      semanticPoints: Object.fromEntries([
        "eyeLeft", "eyeRight", "nose", "mouthLeft", "mouth", "mouthRight", "chin"
      ].flatMap((id) => current.runtime.semanticCage.points[id] ? [[id, current.runtime.semanticCage.points[id].position]] : [])),
      layers: Object.fromEntries([...geometryLayerIds].map((id) => {
        const layer = current.layers.find((candidate) => candidate.id === id)!;
        return [id, {
          pivot: layer.pivot,
          mesh: layer.mesh,
          ...(layer.hairStrands ? { hairStrands: layer.hairStrands } : {}),
          vertexInfluences: {
            physicsRelease: Object.fromEntries(layer.mesh.points.map((_, index) => [String(index), layer.mesh.influences?.physicsRelease?.[index] ?? 0]))
          },
          ...(headwearLayerIds.has(id) ? { headwearPerspective: layer.headwearPerspective ?? null } : {})
        }];
      }))
    };

    const files = artifactPath(`cli-whole-spec-${process.pid}-${Date.now()}`);
    await mkdir(files, { recursive: true });
    const path = resolve(files, "whole-rig-spec.json");
    await writeFile(path, JSON.stringify(specification));
    const planned = await cli(["agent", "plan", "--project", cliProject, "--spec", path, "--json"]);
    expect(planned.code).toBe(0);
    const plan = JSON.parse(planned.stdout) as {
      scope: string;
      requestedParts: string[];
      parts: Array<{ part: string; status: string; blockers: string[] }>;
      canApply: boolean;
    };
    expect(plan.scope).toBe("whole");
    expect(plan.requestedParts).toEqual([
      "headFace", "eyes", "mouth", "frontHair", "backHair", "ahoge", "ears",
      "headwear", "body", "topCloth", "skirt", "tail", "accessory"
    ]);
    expect(plan.parts.map((part) => part.part)).toEqual(plan.requestedParts);

    const omitted = { ...specification, parts: specification.parts.slice(1) };
    const omittedPath = resolve(files, "whole-rig-spec-omitted.json");
    await writeFile(omittedPath, JSON.stringify(omitted));
    const omittedPlan = await cli(["agent", "plan", "--project", cliProject, "--spec", omittedPath, "--json"]);
    expect(omittedPlan.code).toBe(0);
    const omission = JSON.parse(omittedPlan.stdout) as { canApply: boolean; parts: Array<{ status: string; blockers: string[] }> };
    expect(omission.canApply).toBe(false);
    expect(omission.parts.some((part) => part.status === "blocked" && part.blockers.some((blocker) => blocker.includes("整模规格漏掉")))).toBe(true);
  }, 120_000);

  it("creates and verifies a project through the public commands", async () => {
    const result = await cli(["verify", "--project", cliProject, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, rigLevel: "semantic" });
  });

  it("describes, calibrates, renders and compares through Agent-facing commands", async () => {
    const described = await cli(["describe", "--project", cliProject, "--json"]);
    expect(described.code).toBe(0);
    const description = JSON.parse(described.stdout) as {
      calibrationRevision: number;
      coordinateSystem: { sideConvention: string };
      layers: Array<{ id: string }>;
    };
    expect(description.calibrationRevision).toBe(0);
    expect(description.coordinateSystem.sideConvention).toBe("anatomical");
    const detailed = await cli(["describe", "--project", cliProject, "--layer", description.layers[0]!.id, "--revision", "0", "--json"]);
    expect(detailed.code).toBe(0);
    const detail = JSON.parse(detailed.stdout) as {
      selectedLayer: {
        id: string;
        sourcePath: string[];
        alphaTopology: { componentCount: number };
        mesh: { points: Array<{ index: number; delta: { x: number; y: number }; influences: { pin: number } }> };
      };
    };
    expect(detail.selectedLayer.sourcePath.length).toBeGreaterThan(0);
    expect(detail.selectedLayer.alphaTopology.componentCount).toBeGreaterThan(0);
    const point = detail.selectedLayer.mesh.points[0]!;
    const files = artifactPath(`cli-calibration-${process.pid}-${Date.now()}`);
    await mkdir(files, { recursive: true });
    const patch = resolve(files, "patch.json");
    await writeFile(patch, JSON.stringify({
      baseRevision: 0,
      label: "CLI 稀疏网格契约校准",
      overrides: {
        layers: {
          [detail.selectedLayer.id]: {
            meshPointDeltas: { [String(point.index)]: point.delta },
            vertexInfluences: { pin: { [String(point.index)]: point.influences.pin } }
          }
        }
      }
    }));
    const calibrated = await cli(["calibrate", "--project", cliProject, "--patch", patch, "--json"]);
    expect(calibrated.code).toBe(0);
    expect(JSON.parse(calibrated.stdout)).toMatchObject({ ok: true, revision: 1 });
    const history = await cli(["history", "--project", cliProject, "--json"]);
    expect(history.code).toBe(0);
    const historySummary = JSON.parse(history.stdout) as {
      currentRevision: number;
      headSessionId: string;
      sessions: Array<Record<string, unknown>>;
    };
    expect(historySummary.currentRevision).toBe(1);
    expect(historySummary.sessions).toHaveLength(1);
    expect(historySummary.sessions[0]).toMatchObject({
      id: historySummary.headSessionId,
      fromRevision: 0,
      toRevision: 1,
      label: "CLI 稀疏网格契约校准"
    });
    expect(historySummary.sessions[0]).not.toHaveProperty("patch");
    expect(historySummary.sessions[0]).not.toHaveProperty("afterOverrides");

    const fullHistory = await cli(["history", "--project", cliProject, "--full", "--json"]);
    expect(fullHistory.code).toBe(0);
    const completeSession = (JSON.parse(fullHistory.stdout) as { sessions: Array<Record<string, unknown>> }).sessions[0]!;
    expect(completeSession).toHaveProperty("patch");
    expect(completeSession).toHaveProperty("afterOverrides");
    const rendered = await cli(["render", "--project", cliProject, "--suite", "poses", "--size", "640", "--focus", "headFace", "--output", resolve(files, "render"), "--json"]);
    expect(rendered.code).toBe(0);
    expect(JSON.parse(rendered.stdout)).toMatchObject({ renderSize: 640, focus: { scope: "headFace" } });
    expect((await stat(resolve(files, "render", "pose-sheet.png"))).isFile()).toBe(true);
    expect((await stat(resolve(files, "render", "focus-pose-sheet.png"))).isFile()).toBe(true);
    const compared = await cli(["compare", "--project", cliProject, "--from", "0", "--to", "1", "--output", resolve(files, "compare"), "--json"]);
    expect(compared.code).toBe(0);
    expect((await stat(resolve(files, "compare", "before-after.png"))).isFile()).toBe(true);
  }, 120_000);

  it("creates a separate project when migrating an updated PSD", async () => {
    const output = artifactPath(`cli-migration-${process.pid}-${Date.now()}`);
    const result = await cli([
      "migrate",
      "--project", cliProject,
      "--input", "test/fixtures/semantic.psd",
      "--output", output,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const migration = JSON.parse(result.stdout) as {
      outputDirectory: string;
      appliedRevision?: number;
      mapping: Array<{ sourceLayerId: string; targetLayerId?: string; status: string; migratedFields: string[]; skippedFields: string[] }>;
      reportPath: string;
      patchPath: string;
    };
    expect(migration.outputDirectory).toBe(output);
    expect(migration.appliedRevision).toBe(1);
    expect(migration.mapping.every((entry) => entry.status === "exact")).toBe(true);
    expect((await stat(migration.reportPath)).isFile()).toBe(true);
    expect((await stat(migration.patchPath)).isFile()).toBe(true);

    const calibratedLayer = migration.mapping.find((entry) => entry.migratedFields.includes("meshPointDeltas"));
    expect(calibratedLayer?.targetLayerId).toBeTruthy();
    const migratedProject = JSON.parse(await readFile(resolve(output, "puppetloom.json"), "utf8")) as { layers: Array<{ id: string; texture: string }> };
    const migratedTexture = migratedProject.layers.find((layer) => layer.id === calibratedLayer!.targetLayerId)!.texture;
    const texturePath = resolve(output, migratedTexture);
    await writeFile(texturePath, Buffer.concat([await readFile(texturePath), Buffer.from([0])]));
    const changedOutput = artifactPath(`cli-migration-changed-${process.pid}-${Date.now()}`);
    const changedResult = await cli([
      "migrate", "--project", output, "--input", "test/fixtures/semantic.psd", "--output", changedOutput, "--json"
    ]);
    expect(changedResult.code).toBe(0);
    const changed = JSON.parse(changedResult.stdout) as { mapping: Array<{ sourceLayerId: string; status: string; migratedFields: string[]; skippedFields: string[] }> };
    const changedLayer = changed.mapping.find((entry) => entry.sourceLayerId === calibratedLayer!.targetLayerId)!;
    expect(changedLayer.status).toBe("geometry-changed");
    expect(changedLayer.skippedFields).toEqual(expect.arrayContaining(["meshPointDeltas", "vertexInfluences"]));
    expect(changedLayer.migratedFields).not.toEqual(expect.arrayContaining(["meshPointDeltas", "vertexInfluences"]));
  }, 120_000);

  it("lets an Agent inspect and transactionally author a parameter with visual previews", async () => {
    const inspected = await cli(["author", "inspect", "--project", cliProject, "--json"]);
    expect(inspected.code).toBe(0);
    const authoring = JSON.parse(inspected.stdout) as { revision: number; parameters: Array<{ id: string }> };
    expect(authoring.parameters.some((parameter) => parameter.id === "param-head-yaw")).toBe(true);
    const described = JSON.parse((await cli(["describe", "--project", cliProject, "--json"])).stdout) as { layers: Array<{ id: string }> };
    const files = artifactPath(`cli-authoring-${process.pid}-${Date.now()}`);
    await mkdir(files, { recursive: true });
    const patch = resolve(files, "authoring.json");
    await writeFile(patch, JSON.stringify({
      version: 1,
      baseRevision: authoring.revision,
      label: "CLI AI authoring contract",
      operations: [
        { op: "upsert-parameter", parameter: { id: "expression-smile", name: "Smile", group: "Expression", kind: "continuous", min: 0, default: 0, max: 1 } },
        {
          op: "upsert-binding",
          binding: {
            id: "expression-smile-opacity",
            parameterIds: ["expression-smile"],
            target: { kind: "layer", id: described.layers[0]!.id },
            keyforms: [{ values: [0] }, { values: [1], opacityMultiplier: 0.85 }]
          }
        }
      ]
    }));
    const applied = await cli(["author", "apply", "--project", cliProject, "--patch", patch, "--json"]);
    expect(applied.code).toBe(0);
    const result = JSON.parse(applied.stdout) as {
      revision: number;
      session: { patch: { authoring: { operations: unknown[]; previews: Array<{ parameters: Record<string, number> }> } } };
      evidence: { after: { artifacts: Array<{ id: string }> } };
    };
    expect(result.revision).toBe(authoring.revision + 1);
    expect(result.session.patch.authoring.operations).toHaveLength(2);
    expect(result.session.patch.authoring.previews.map((preview) => preview.parameters)).toEqual([
      { "expression-smile": 0 }, { "expression-smile": 1 }
    ]);
    expect(result.evidence.after.artifacts.some((artifact) => artifact.id.startsWith("authoring-"))).toBe(true);
    const reopened = JSON.parse((await cli(["author", "inspect", "--project", cliProject, "--json"])).stdout) as {
      revision: number;
      parameters: Array<{ id: string }>;
      bindings: Array<{ id: string }>;
      layerOrder: Array<{ layerId: string; order: number }>;
    };
    expect(reopened.revision).toBe(result.revision);
    expect(reopened.parameters.some((parameter) => parameter.id === "expression-smile")).toBe(true);
    expect(reopened.bindings.some((binding) => binding.id === "expression-smile-opacity")).toBe(true);

    const target = reopened.layerOrder[0]!;
    const reference = reopened.layerOrder.at(-1)!;
    const orderPatch = resolve(files, "layer-order.json");
    await writeFile(orderPatch, JSON.stringify({
      version: 1,
      baseRevision: reopened.revision,
      label: "Move a complete layer in back-to-front order",
      operations: [{ op: "move-layer", layerId: target.layerId, afterLayerId: reference.layerId }]
    }));
    const moved = await cli(["author", "apply", "--project", cliProject, "--patch", orderPatch, "--json"]);
    expect(moved.code).toBe(0);
    const movedResult = JSON.parse(moved.stdout) as { revision: number; session: { patch: { authoring: { operations: Array<{ op: string }> } } } };
    expect(movedResult.revision).toBe(reopened.revision + 1);
    expect(movedResult.session.patch.authoring.operations).toEqual(expect.arrayContaining([expect.objectContaining({ op: "move-layer" })]));
    const reordered = JSON.parse((await cli(["author", "inspect", "--project", cliProject, "--json"])).stdout) as {
      revision: number;
      layerOrder: Array<{ layerId: string; order: number }>;
    };
    expect(reordered.revision).toBe(movedResult.revision);
    expect(reordered.layerOrder.at(-1)?.layerId).toBe(target.layerId);
  }, 120_000);

  it("exports the effective AI-authored revision as a verified portable directory", async () => {
    const output = artifactPath(`cli-portable-${process.pid}-${Date.now()}`);
    const exported = await cli(["export", "--project", cliProject, "--output", output, "--json"]);
    expect(exported.code).toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({
      outputDirectory: output,
      manifest: { project: expect.any(String), sourceRevision: expect.any(Number) },
      verification: { valid: true }
    });
    const inspected = JSON.parse((await cli(["author", "inspect", "--project", output, "--json"])).stdout) as {
      revision: number;
      parameters: Array<{ id: string }>;
    };
    expect(inspected.revision).toBe(0);
    expect(inspected.parameters.some((parameter) => parameter.id === "expression-smile")).toBe(true);
    const repeated = await cli(["export", "--project", cliProject, "--output", output, "--json"]);
    expect(repeated.code).toBe(3);
  }, 120_000);

  it("plans, prepares, finalizes and verifies the official Cubism runtime boundary", async () => {
    const planned = await cli(["cubism", "plan", "--project", cliProject, "--json"]);
    expect(planned.code).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({
      editorApiVersion: "1.1.0",
      requiresEditorMocExport: true,
      strictReady: false,
      coverage: { sourceParameters: expect.any(Number), targetParameters: expect.any(Number) }
    });

    const preparedOutput = artifactPath(`cli-cubism-prepare-${process.pid}-${Date.now()}`);
    const prepared = await cli(["cubism", "prepare", "--project", cliProject, "--output", preparedOutput, "--json"]);
    expect(prepared.code).toBe(0);
    expect(JSON.parse(prepared.stdout)).toMatchObject({ outputDirectory: preparedOutput, plan: { requiresEditorMocExport: true } });
    expect((await stat(resolve(preparedOutput, "puppetloom", "cubism-bridge.json"))).isFile()).toBe(true);

    const editorRuntime = artifactPath(`cli-cubism-editor-${process.pid}-${Date.now()}`);
    await mkdir(resolve(editorRuntime, "textures"), { recursive: true });
    await writeFile(resolve(editorRuntime, "fixture.moc3"), Buffer.from("MOC3official-editor-placeholder"));
    await copyFile("test/fixtures/semantic-reference.png", resolve(editorRuntime, "textures", "texture_00.png"));
    const editorModel = resolve(editorRuntime, "fixture.model3.json");
    await writeFile(editorModel, JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "fixture.moc3", Textures: ["textures/texture_00.png"] },
      Groups: [], HitAreas: []
    }));
    const finalOutput = artifactPath(`cli-cubism-final-${process.pid}-${Date.now()}`);
    const finalized = await cli(["cubism", "finalize", "--project", cliProject, "--editor-model", editorModel, "--output", finalOutput, "--json"]);
    expect(finalized.code).toBe(0);
    expect(JSON.parse(finalized.stdout)).toMatchObject({ outputDirectory: finalOutput, verification: { valid: true } });
    const verified = await cli(["cubism", "verify", "--model", resolve(finalOutput, "fixture.model3.json"), "--json"]);
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ valid: true, moc: "fixture.moc3" });
  }, 120_000);

  it("uses exit 2 for malformed calibration JSON", async () => {
    const files = artifactPath(`cli-invalid-calibration-${process.pid}-${Date.now()}`);
    await mkdir(files, { recursive: true });
    const patch = resolve(files, "broken.json");
    await writeFile(patch, "{ definitely-not-json");
    const result = await cli(["calibrate", "--project", cliProject, "--patch", patch, "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("treats unavailable optional supplements as non-blocking", async () => {
    const result = await cli(["enhance", "--project", cliProject, "--assets", "test/fixtures/no-supplements", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      accepted: [],
      rejected: [
        { requestId: "closed-eye-left" },
        { requestId: "closed-eye-right" },
        { requestId: "mouth-open-small" }
      ]
    });
  });

  it("opens the transparent player through the play command", async () => {
    const applicationProfile = artifactPath(`cli-play-user-data-${process.pid}-${Date.now()}`);
    const result = await cli(["play", "--project", cliProject, "--revision", "0"], {
      PUPPETLOOM_E2E_EXIT_AFTER_MS: "900",
      PUPPETLOOM_E2E_USER_DATA: applicationProfile
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const recent = JSON.parse(await readFile(resolve(applicationProfile, "recent-projects.json"), "utf8")) as Array<{ directory: string }>;
    expect(recent[0]?.directory).toBe(resolve(cliProject));
  }, 30_000);

  it("opens the project editor through the edit command", async () => {
    const result = await cli(["edit", "--project", cliProject], { PUPPETLOOM_E2E_EXIT_AFTER_MS: "900", PUPPETLOOM_ALLOW_MULTIPLE: "1" });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("PuppetLoom：");
  }, 30_000);
});
