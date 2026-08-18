import { describe, expect, it } from "vitest";
import { makeGridMesh } from "../src/mesh.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import { createSecondaryPartAgentProposal, type SecondaryModelAgentPart } from "../src/secondary-part-agent.js";
import type { LayerBinding, PuppetLoomProject, SemanticRole } from "../src/types.js";

function layer(id: string, role: SemanticRole, x: number, y: number, width = 0.2, height = 0.24): LayerBinding {
  const bounds = { x, y, width, height };
  return {
    id,
    sourceName: id,
    sourcePath: [id],
    role,
    side: role === "ear" || role === "arm" || role === "sideHair" ? "left" : "center",
    order: 1,
    opacity: 1,
    blendMode: "normal",
    bounds,
    texture: `textures/${id}.png`,
    pivot: { x: x + width * (role === "tail" ? 0.03 : 0.5), y: y + height * (role === "tail" ? 0.08 : 0.15) },
    ...(role === "frontHair" ? { secondaryAnchors: { ahogeRoot: { x: x + width * 0.5, y: y + height * 0.35 } } } : {}),
    mesh: makeGridMesh(bounds, 5, 5),
    weights: { head: ["backHair", "sideHair", "frontHair", "ear", "headwear"].includes(role) ? 1 : 0, body: ["topWear", "arm", "bottomWear", "tail", "accessory"].includes(role) ? 1 : 0, gaze: 0, physics: 0.5 },
    parentGroup: ["backHair", "sideHair", "frontHair", "ear", "headwear"].includes(role) ? "head" : "body"
  };
}

function project(): PuppetLoomProject {
  return {
    version: 4,
    name: "secondary-agent-fixture",
    canvas: { width: 1000, height: 1000 },
    source: { originalFileName: "fixture.psd", psdSha256: "1".repeat(64), psdPath: "source/fixture.psd" },
    rigLevel: "grouped",
    layers: [
      layer("back", "backHair", 0.28, 0.08, 0.44, 0.46),
      layer("side", "sideHair", 0.16, 0.18, 0.16, 0.38),
      layer("front", "frontHair", 0.34, 0.08, 0.32, 0.34),
      layer("ear", "ear", 0.16, 0.2, 0.14, 0.2),
      layer("headwear", "headwear", 0.38, 0.03, 0.24, 0.18),
      layer("top", "topWear", 0.28, 0.55, 0.44, 0.22),
      layer("arm", "arm", 0.12, 0.56, 0.16, 0.28),
      layer("skirt", "bottomWear", 0.3, 0.73, 0.4, 0.22),
      layer("tail", "tail", 0.72, 0.55, 0.2, 0.35),
      layer("accessory", "accessory", 0.47, 0.52, 0.08, 0.24)
    ],
    model: createDefaultAuthoringModel(),
    anchors: { neck: { x: 0.5, y: 0.52 }, bodyCenter: { x: 0.5, y: 0.68 } },
    runtime: {
      seed: 42,
      profile: "coherent-v1",
      envelope: { headYaw: 0.36, headPitch: 0.25, headRollDegrees: 2, bodySway: 0.01, bodyRollDegrees: 1, gazeX: 0, gazeY: 0, breath: 0.003, globalScale: 1 },
      features: { headTurn: true, bodyFollow: true, gaze: false, hairPhysics: true, blink: false, mouthMotion: false }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] },
    disabledReasons: []
  };
}

describe("secondary part Agent", () => {
  const parts: SecondaryModelAgentPart[] = ["backHair", "ahoge", "ears", "headwear", "topCloth", "skirt", "tail", "accessory"];

  it.each(parts)("builds, repairs and validates %s without changing unrelated layers", (part) => {
    const proposal = createSecondaryPartAgentProposal(project(), { part, instruction: "自然跟随，轻微滞后和回弹" });
    expect(proposal.layers.length).toBeGreaterThan(0);
    expect(proposal.operations.some((operation) => operation.op === "upsert-physics")).toBe(true);
    expect(proposal.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "other-layers-preserved", passed: true }),
      expect.objectContaining({ id: "root-continuity", passed: true }),
      expect.objectContaining({ id: "pose-safety", passed: true })
    ]));
    expect(proposal.checks.every((check) => check.passed)).toBe(true);
  });

  it("executes an external Agent's stronger tail intent and records deterministic repair passes", () => {
    const proposal = createSecondaryPartAgentProposal(project(), {
      part: "tail",
      instruction: "外部 Agent 已经看图并填写规格",
      intent: {
        amplitude: 1.08,
        response: 0.46,
        stability: 0.34,
        lagResponse: 6.2,
        lagDamping: 0.68,
        deformationScale: 1.05,
        explanation: ["尾巴在连续帧中不够可见。"]
      }
    });
    expect(proposal.intent.amplitude).toBeGreaterThan(0.9);
    expect(proposal.intent.lagDamping).toBeLessThan(0.8);
    expect(proposal.intent.amplitude).toBeLessThanOrEqual(1.4);
    expect(proposal.repairs.every((repair, index) => repair.pass === index + 1)).toBe(true);
  });

  it("authors the ahoge as one root hinge instead of a flexible translated chain", () => {
    const proposal = createSecondaryPartAgentProposal(project(), { part: "ahoge", instruction: "以发根为轴轻微晃动" });
    expect(proposal.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rigid-root-hinge", passed: true })
    ]));
    const rigidity = proposal.checks.find((check) => check.id === "rigid-root-hinge")!;
    expect(rigidity.details.maximumRadialError).toBeLessThanOrEqual(1e-8);
    expect(rigidity.details.maximumAngularSpread).toBeLessThanOrEqual(1e-5);
  });

  it("locks the clothing waist, reduces skirt amplitude, and places merged back bows behind overlapping arms", () => {
    const fixture = project();
    const skirt = fixture.layers.find((candidate) => candidate.id === "skirt")!;
    const arm = fixture.layers.find((candidate) => candidate.id === "arm")!;
    skirt.order = 8;
    arm.order = 5;
    arm.bounds = { x: 0.24, y: 0.56, width: 0.16, height: 0.28 };
    arm.mesh = makeGridMesh(arm.bounds, 5, 5);

    const proposal = createSecondaryPartAgentProposal(fixture, { part: "skirt", instruction: "裙摆克制摆动，腰线固定，后腰蝴蝶结放到手臂后面" });
    const proposedSkirt = proposal.project.layers.find((candidate) => candidate.id === "skirt")!;
    const proposedArm = proposal.project.layers.find((candidate) => candidate.id === "arm")!;
    const waistPhysics = proposedSkirt.mesh.points
      .map((point, index) => ({ point, value: proposedSkirt.mesh.influences?.physics?.[index] ?? 1 }))
      .filter(({ point }) => point.y <= proposedSkirt.bounds.y + proposedSkirt.bounds.height * 0.2)
      .map(({ value }) => value);

    expect(proposal.intent.amplitude).toBeLessThanOrEqual(0.45);
    expect(waistPhysics.length).toBeGreaterThan(0);
    expect(waistPhysics.every((value) => value === 0)).toBe(true);
    expect(proposedSkirt.order).toBeLessThan(proposedArm.order);
    expect(proposal.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "waist-bow-behind-arms", passed: true })
    ]));
  });

  it("keeps both the upper and lower bodice edges out of secondary cloth bindings", () => {
    const proposal = createSecondaryPartAgentProposal(project(), { part: "topCloth", instruction: "上衣保持贴合，袖子轻微跟随" });
    const top = proposal.project.layers.find((candidate) => candidate.id === "top")!;
    const edgeValues = top.mesh.points
      .map((point, index) => ({ point, value: top.mesh.influences?.physics?.[index] ?? 1 }))
      .filter(({ point }) => point.y <= top.bounds.y + top.bounds.height * 0.12 || point.y >= top.bounds.y + top.bounds.height * 0.88)
      .map(({ value }) => value);
    expect(edgeValues.length).toBeGreaterThan(0);
    expect(edgeValues.every((value) => value === 0)).toBe(true);
  });
});
