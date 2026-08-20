import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelAgentPart } from "./agent.js";
import { modelAgentCapabilities, modelAgentPartDefinitions } from "./agent.js";
import { PuppetLoomError } from "./errors.js";
import { loadCalibration, loadProject } from "./project.js";

export interface PrimaryPartIntentSpecification {
  amplitude: number;
  response: number;
  stability: number;
  /** Exact geometric targets used only by headFace. */
  yawDegrees?: number;
  pitchUpDegrees?: number;
  pitchDownDegrees?: number;
  contourStrength?: number;
  depthStrength?: number;
  farEyeOpacity?: number;
  farBrowOpacity?: number;
  farEarOpacity?: number;
  farSideHairOpacity?: number;
  occlusionFadeStart?: number;
  sideHairDepthSwap?: boolean;
}

export interface FrontHairIntentSpecification extends PrimaryPartIntentSpecification {
  ahogeAmplitude: number;
  ahogeResponse: number;
  ahogeStability: number;
  lagResponse: number;
  lagDamping: number;
  deformationScale: number;
  /** Additional neutral crown fullness, as a fraction of the layer width. */
  crownOutset?: number;
  /** Visible hinge range for the short central fringe. */
  bangLagDegrees?: number;
}

export interface SecondaryPartIntentSpecification extends PrimaryPartIntentSpecification {
  lagResponse: number;
  lagDamping: number;
  deformationScale: number;
}

interface PartSpecificationBase {
  layerIds?: string[];
  rationale: string[];
}

export interface PrimaryPartSpecification extends PartSpecificationBase {
  part: "headFace" | "eyes" | "mouth" | "body";
  intent: PrimaryPartIntentSpecification;
}

export interface FrontHairPartSpecification extends PartSpecificationBase {
  part: "frontHair";
  intent: FrontHairIntentSpecification;
}

export interface SecondaryPartSpecification extends PartSpecificationBase {
  part: "backHair" | "ahoge" | "ears" | "headwear" | "topCloth" | "skirt" | "tail" | "accessory";
  intent: SecondaryPartIntentSpecification;
}

export type ModelAgentPartSpecification = PrimaryPartSpecification | FrontHairPartSpecification | SecondaryPartSpecification;

/**
 * Machine contract produced by an external Agent after it has interpreted the
 * user's goal. PuppetLoom validates and executes this document; it does not try
 * to infer these decisions from prose.
 */
export interface ModelAgentSpecification {
  version: 1;
  kind: "puppetloom-rig-spec";
  scope: "whole" | "selected";
  baseRevision: number;
  goal: string;
  parts: ModelAgentPartSpecification[];
}

const primaryParts = new Set<ModelAgentPart>(["headFace", "eyes", "mouth", "body"]);
const secondaryParts = new Set<ModelAgentPart>(["backHair", "ahoge", "ears", "headwear", "topCloth", "skirt", "tail", "accessory"]);
const templateGoal = "由外部 Agent 看图、理解用户目标后填写；不要原样执行模板。";
const templateRationaleMarker = "外部 Agent 应在看图后调整。";
const defaultSecondaryAmplitude: Record<SecondaryPartSpecification["part"], number> = {
  backHair: 0.82,
  ahoge: 0.9,
  ears: 0.68,
  headwear: 0.62,
  topCloth: 0.46,
  skirt: 0.5,
  tail: 0.9,
  accessory: 0.72
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberIn(record: Record<string, unknown>, key: string, minimum: number, maximum: number, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new PuppetLoomError("INVALID_INPUT", `${path}.${key} 必须是 ${minimum} 到 ${maximum} 之间的有限数字。`);
  }
  return value;
}

function stringList(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new PuppetLoomError("INVALID_INPUT", `${path} 必须是非空字符串数组。`);
  }
  const normalized = value.map((item) => String(item).trim());
  if (new Set(normalized).size !== normalized.length) throw new PuppetLoomError("INVALID_INPUT", `${path} 不能包含重复项。`);
  return normalized;
}

function primaryIntent(value: unknown, path: string): PrimaryPartIntentSpecification {
  if (!isRecord(value)) throw new PuppetLoomError("INVALID_INPUT", `${path} 必须是对象。`);
  return {
    amplitude: numberIn(value, "amplitude", 0.1, 1.4, path),
    response: numberIn(value, "response", 0.1, 1.5, path),
    stability: numberIn(value, "stability", 0.1, 1.5, path)
  };
}

function headFaceIntent(value: unknown, path: string): PrimaryPartIntentSpecification {
  if (!isRecord(value)) throw new PuppetLoomError("INVALID_INPUT", `${path} 必须是对象。`);
  return {
    ...primaryIntent(value, path),
    yawDegrees: numberIn(value, "yawDegrees", 10, 25, path),
    pitchUpDegrees: numberIn(value, "pitchUpDegrees", 8, 20, path),
    pitchDownDegrees: numberIn(value, "pitchDownDegrees", 8, 20, path),
    contourStrength: value.contourStrength === undefined ? 1 : numberIn(value, "contourStrength", 0.4, 1.6, path),
    depthStrength: value.depthStrength === undefined ? 1 : numberIn(value, "depthStrength", 0.4, 1.6, path),
    farEyeOpacity: value.farEyeOpacity === undefined ? 0.68 : numberIn(value, "farEyeOpacity", 0, 1, path),
    farBrowOpacity: value.farBrowOpacity === undefined ? 0.76 : numberIn(value, "farBrowOpacity", 0, 1, path),
    farEarOpacity: value.farEarOpacity === undefined ? 0.55 : numberIn(value, "farEarOpacity", 0, 1, path),
    farSideHairOpacity: value.farSideHairOpacity === undefined ? 0.72 : numberIn(value, "farSideHairOpacity", 0, 1, path),
    occlusionFadeStart: value.occlusionFadeStart === undefined ? 0.58 : numberIn(value, "occlusionFadeStart", 0, 0.95, path),
    sideHairDepthSwap: value.sideHairDepthSwap === undefined ? true : (() => {
      if (typeof value.sideHairDepthSwap !== "boolean") throw new PuppetLoomError("INVALID_INPUT", `${path}.sideHairDepthSwap 必须是布尔值。`);
      return value.sideHairDepthSwap;
    })()
  };
}

function partSpecification(value: unknown, index: number): ModelAgentPartSpecification {
  const path = `parts[${index}]`;
  if (!isRecord(value) || typeof value.part !== "string") throw new PuppetLoomError("INVALID_INPUT", `${path}.part 必须是有效部位 ID。`);
  const part = value.part as ModelAgentPart;
  if (!modelAgentPartDefinitions.some((definition) => definition.part === part)) throw new PuppetLoomError("INVALID_INPUT", `${path}.part 不受支持：${value.part}`);
  const layerIds = stringList(value.layerIds, `${path}.layerIds`);
  const rationale = stringList(value.rationale, `${path}.rationale`);
  if (!rationale) throw new PuppetLoomError("INVALID_INPUT", `${path}.rationale 必须说明外部 Agent 看到了什么，以及为什么采用当前参数。`);
  if (rationale.some((item) => item.includes(templateRationaleMarker))) {
    throw new PuppetLoomError("INVALID_INPUT", `${path}.rationale 仍是模板占位内容。外部 Agent 必须先查看准确 revision 的视觉证据，再填写实际判断。`);
  }
  const common = { ...(layerIds ? { layerIds } : {}), rationale };
  if (part === "frontHair") {
    const intent = primaryIntent(value.intent, `${path}.intent`);
    const source = value.intent as Record<string, unknown>;
    if (layerIds && layerIds.length > 1) throw new PuppetLoomError("INVALID_INPUT", `${path}.layerIds 对前发最多只能指定一个图层。`);
    return {
      ...common,
      part,
      intent: {
        ...intent,
        ahogeAmplitude: numberIn(source, "ahogeAmplitude", 0.1, 1.4, `${path}.intent`),
        ahogeResponse: numberIn(source, "ahogeResponse", 0.1, 1.5, `${path}.intent`),
        ahogeStability: numberIn(source, "ahogeStability", 0.1, 1.5, `${path}.intent`),
        lagResponse: numberIn(source, "lagResponse", 0.1, 30, `${path}.intent`),
        lagDamping: numberIn(source, "lagDamping", 0.1, 3, `${path}.intent`),
        deformationScale: numberIn(source, "deformationScale", 0.1, 2, `${path}.intent`),
        ...(source.crownOutset === undefined ? {} : {
          crownOutset: numberIn(source, "crownOutset", 0, 0.08, `${path}.intent`)
        }),
        ...(source.bangLagDegrees === undefined ? {} : {
          bangLagDegrees: numberIn(source, "bangLagDegrees", 1, 12, `${path}.intent`)
        })
      }
    };
  }
  if (secondaryParts.has(part)) {
    const intent = primaryIntent(value.intent, `${path}.intent`);
    const source = value.intent as Record<string, unknown>;
    return {
      ...common,
      part: part as SecondaryPartSpecification["part"],
      intent: {
        ...intent,
        lagResponse: numberIn(source, "lagResponse", 0.1, 30, `${path}.intent`),
        lagDamping: numberIn(source, "lagDamping", 0.1, 3, `${path}.intent`),
        deformationScale: numberIn(source, "deformationScale", 0.1, 2, `${path}.intent`)
      }
    };
  }
  if (!primaryParts.has(part)) throw new PuppetLoomError("INVALID_INPUT", `${path}.part 不受支持：${part}`);
  return {
    ...common,
    part: part as PrimaryPartSpecification["part"],
    intent: part === "headFace" ? headFaceIntent(value.intent, `${path}.intent`) : primaryIntent(value.intent, `${path}.intent`)
  };
}

export function parseModelAgentSpecification(value: unknown): ModelAgentSpecification {
  if (!isRecord(value)) throw new PuppetLoomError("INVALID_INPUT", "Agent 制作规格必须是 JSON 对象。" );
  if (value.version !== 1 || value.kind !== "puppetloom-rig-spec") throw new PuppetLoomError("INVALID_INPUT", "Agent 制作规格必须使用 version 1 和 kind puppetloom-rig-spec。" );
  if (value.scope !== "whole" && value.scope !== "selected") throw new PuppetLoomError("INVALID_INPUT", "Agent 制作规格的 scope 必须是 whole 或 selected。" );
  if (!Number.isInteger(value.baseRevision) || Number(value.baseRevision) < 0) throw new PuppetLoomError("INVALID_INPUT", "Agent 制作规格的 baseRevision 必须是非负整数。" );
  if (typeof value.goal !== "string" || value.goal.trim().length === 0) throw new PuppetLoomError("INVALID_INPUT", "Agent 制作规格的 goal 不能为空。" );
  if (value.goal.trim() === templateGoal) throw new PuppetLoomError("INVALID_INPUT", "Agent 制作规格仍是未审查模板。外部 Agent 必须先看图并填写真实 goal。" );
  if (!Array.isArray(value.parts) || value.parts.length === 0) throw new PuppetLoomError("INVALID_INPUT", "Agent 制作规格至少要包含一个部位。" );
  const parts = value.parts.map(partSpecification);
  const ids = parts.map((part) => part.part);
  if (new Set(ids).size !== ids.length) throw new PuppetLoomError("INVALID_INPUT", "Agent 制作规格不能重复包含同一部位。" );
  return { version: 1, kind: "puppetloom-rig-spec", scope: value.scope, baseRevision: Number(value.baseRevision), goal: value.goal.trim(), parts };
}

export async function readModelAgentSpecification(path: string): Promise<ModelAgentSpecification> {
  try {
    return parseModelAgentSpecification(JSON.parse(await readFile(resolve(path), "utf8")));
  } catch (error) {
    if (error instanceof PuppetLoomError) throw error;
    throw new PuppetLoomError("INVALID_INPUT", `无法读取 Agent 制作规格：${resolve(path)}`, { cause: error });
  }
}

function defaultPartSpecification(part: ModelAgentPart): ModelAgentPartSpecification {
  if (part === "frontHair") return {
    part,
    intent: {
      amplitude: 0.74,
      response: 0.42,
      stability: 0.46,
      ahogeAmplitude: 0.7992,
      ahogeResponse: 0.36,
      ahogeStability: 0.38,
      lagResponse: 8.2,
      lagDamping: 0.78,
      deformationScale: 0.88,
      crownOutset: 0,
      bangLagDegrees: 3.2
    },
    rationale: ["自然、克制的前发基线；外部 Agent 应在看图后调整。"]
  };
  if (secondaryParts.has(part)) return {
    part: part as SecondaryPartSpecification["part"],
    intent: {
      amplitude: Number((defaultSecondaryAmplitude[part as SecondaryPartSpecification["part"]] * 0.86).toFixed(4)),
      response: 0.46,
      stability: 0.5,
      lagResponse: 7.4,
      lagDamping: 0.82,
      deformationScale: 0.88
    },
    rationale: ["该部位的自然跟随基线；外部 Agent 应在看图后调整。"]
  };
  return {
    part: part as PrimaryPartSpecification["part"],
    intent: part === "headFace"
      ? {
        amplitude: 0.9, response: 0.72, stability: 0.7, yawDegrees: 12, pitchUpDegrees: 12, pitchDownDegrees: 14,
        contourStrength: 1, depthStrength: 1, farEyeOpacity: 0.68, farBrowOpacity: 0.76,
        farEarOpacity: 0.55, farSideHairOpacity: 0.72, occlusionFadeStart: 0.58, sideHairDepthSwap: true
      }
      : { amplitude: 0.76, response: 0.72, stability: 0.66 },
    rationale: ["自然、克制的主运动基线；外部 Agent 应在看图后调整。"]
  };
}

/** Creates a revision-pinned starting document for an external Agent to edit. */
export async function createModelAgentSpecificationTemplate(projectDirectory: string, requested: ModelAgentPart[] | "whole" = "whole"): Promise<ModelAgentSpecification> {
  const root = resolve(projectDirectory);
  const [project, calibration] = await Promise.all([loadProject(root), loadCalibration(root)]);
  const available = new Set(modelAgentCapabilities(project).filter((capability) => capability.available).map((capability) => capability.part));
  const selected = requested === "whole" ? modelAgentPartDefinitions.map((definition) => definition.part).filter((part) => available.has(part)) : requested;
  if (selected.length === 0) throw new PuppetLoomError("INVALID_INPUT", "当前项目没有可生成制作规格的部位。" );
  const unavailable = selected.filter((part) => !available.has(part));
  if (unavailable.length > 0) throw new PuppetLoomError("INVALID_INPUT", `当前项目没有这些部位：${unavailable.join("、")}`);
  return {
    version: 1,
    kind: "puppetloom-rig-spec",
    scope: requested === "whole" ? "whole" : "selected",
    baseRevision: calibration.revision,
    goal: templateGoal,
    parts: selected.map(defaultPartSpecification)
  };
}
