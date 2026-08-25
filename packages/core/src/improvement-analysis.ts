import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { listCalibrationSessions } from "./calibration-store.js";
import { scanProjectLibrary } from "./project-health.js";
import { loadProject } from "./project.js";

export type ImprovementCandidateKind = "recurring-gap" | "accepted-layer-correction" | "accepted-runtime-tuning" | "accepted-authoring-pattern";
export interface ImprovementCandidate {
  id: string;
  kind: ImprovementCandidateKind;
  title: string;
  projectCount: number;
  evidenceCount: number;
  projects: string[];
  confidence: number;
  rationale: string;
  proposedChange: string;
  values?: Record<string, number>;
}
export interface ImprovementAnalysisReport {
  version: 1;
  root: string;
  generatedAt: string;
  scannedProjects: number;
  acceptedSessions: number;
  candidates: ImprovementCandidate[];
  policy: string[];
}

interface Aggregate { kind: ImprovementCandidateKind; title: string; projects: Set<string>; evidence: number; rationale: string; proposedChange: string; values: Record<string, number[]> }
function normalized(value: string): string { return value.toLowerCase().replace(/\d+/g, "#").replace(/[^a-z\u3400-\u9fff]+/gi, "-").replace(/^-|-$/g, ""); }
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
function add(map: Map<string, Aggregate>, signature: string, input: Omit<Aggregate, "projects" | "evidence" | "values"> & { project: string; values?: Record<string, number> }): void {
  const entry = map.get(signature) ?? { kind: input.kind, title: input.title, projects: new Set(), evidence: 0, rationale: input.rationale, proposedChange: input.proposedChange, values: {} };
  entry.projects.add(input.project); entry.evidence += 1;
  for (const [key, value] of Object.entries(input.values ?? {})) (entry.values[key] ??= []).push(value);
  map.set(signature, entry);
}

/** Finds promotion candidates only from repeated gaps or user-accepted evidence across multiple projects. */
export async function analyzeCrossProjectImprovements(rootDirectory: string): Promise<ImprovementAnalysisReport> {
  const library = await scanProjectLibrary(resolve(rootDirectory), { maxDepth: 8, maximumProjects: 500 });
  const aggregate = new Map<string, Aggregate>(); let acceptedSessions = 0;
  await Promise.all(library.projects.map(async (health) => {
    const label = health.project;
    for (const issue of health.issues.filter((issue) => issue.severity !== "info")) add(aggregate, `gap:${issue.code}`, { kind: "recurring-gap", title: `重复缺口：${issue.message}`, project: label, rationale: "多个项目独立出现同一生产缺口。", proposedChange: `改进导入体检或默认工作流，自动发现并引导处理 ${issue.code}。` });
    const [project, sessions] = await Promise.all([loadProject(health.projectDirectory), listCalibrationSessions(health.projectDirectory)]);
    for (const session of sessions.filter((value) => value.evidenceStatus === "accepted")) {
      acceptedSessions += 1;
      for (const [layerId, override] of Object.entries(session.patch.overrides.layers ?? {})) {
        const layer = project.layers.find((candidate) => candidate.id === layerId); if (!layer) continue;
        if (override.role || override.side || override.parentGroup || override.garmentStructure) {
          const key = `${normalized(layer.sourceName)}:${override.role ?? layer.role}:${override.side ?? layer.side}:${override.parentGroup ?? layer.parentGroup}:${override.garmentStructure ?? layer.garmentStructure ?? "none"}`;
          add(aggregate, `layer:${key}`, { kind: "accepted-layer-correction", title: `可复用图层修正：${layer.sourceName}`, project: label, rationale: "相同命名模式的图层修正在多个项目中被人工接受。", proposedChange: "加入候选分类/父级/衣物结构规则，先作为可撤销建议，不直接改写项目。" });
        }
      }
      const tuning = session.patch.overrides.runtime?.motionTuning;
      if (tuning && Object.keys(tuning).length) add(aggregate, "runtime:motion-tuning", { kind: "accepted-runtime-tuning", title: "跨角色运动调校基线", project: label, rationale: "多个角色的人工接受修订调整了同一组全局运动参数。", proposedChange: "用跨项目中位数形成新的候选默认值，并保留角色级覆盖。", values: Object.fromEntries(Object.entries(tuning).filter((entry): entry is [string, number] => typeof entry[1] === "number")) });
      for (const operation of session.patch.authoring?.operations ?? []) {
        const signature = operation.op === "upsert-parameter" ? `${operation.op}:${operation.parameter.semantic ?? operation.parameter.group}` : operation.op;
        add(aggregate, `authoring:${signature}`, { kind: "accepted-authoring-pattern", title: `可复用 Authoring 模式：${signature}`, project: label, rationale: "同类 Authoring 操作在多个角色的视觉证据中被接受。", proposedChange: "蒸馏为显式、幂等的规划器候选，并继续要求逐角色视觉确认。" });
      }
    }
  }));
  const candidates = [...aggregate.entries()].filter(([, entry]) => entry.projects.size >= 2).map(([signature, entry]): ImprovementCandidate => {
    const values = Object.fromEntries(Object.entries(entry.values).filter(([, list]) => list.length).map(([key, list]) => [key, Number(median(list).toFixed(4))]));
    return {
      id: normalized(signature), kind: entry.kind, title: entry.title, projectCount: entry.projects.size, evidenceCount: entry.evidence, projects: [...entry.projects].sort(),
      confidence: Number(Math.min(0.95, 0.45 + entry.projects.size * 0.1 + Math.min(0.2, entry.evidence * 0.02)).toFixed(2)), rationale: entry.rationale, proposedChange: entry.proposedChange,
      ...(Object.keys(values).length ? { values } : {})
    };
  }).sort((left, right) => right.confidence - left.confidence || right.projectCount - left.projectCount || left.id.localeCompare(right.id));
  return { version: 1, root: resolve(rootDirectory), generatedAt: new Date().toISOString(), scannedProjects: library.projects.length, acceptedSessions, candidates, policy: ["至少两个不同项目支持才成为候选。", "只使用人工 accepted 的修订作为正向证据。", "报告不会自动改项目、默认值或模型。", "正式提升为默认规则前仍需真实角色回归和目视确认。"] };
}

export async function writeImprovementAnalysis(report: ImprovementAnalysisReport, outputDirectory: string): Promise<string> {
  const output = resolve(outputDirectory); await mkdir(output, { recursive: false });
  await writeFile(join(output, "improvement-candidates.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const rows = report.candidates.map((candidate) => `| ${candidate.title} | ${candidate.kind} | ${candidate.projectCount} | ${candidate.evidenceCount} | ${candidate.confidence.toFixed(2)} |`).join("\n") || "| 暂无达到阈值的候选 | — | — | — | — |";
  await writeFile(join(output, "improvement-candidates.md"), `# PuppetLoom 跨项目优化候选\n\n扫描 ${report.scannedProjects} 个项目，读取 ${report.acceptedSessions} 个已接受会话。\n\n| 候选 | 类型 | 项目 | 证据 | 置信度 |\n| --- | --- | ---: | ---: | ---: |\n${rows}\n\n${report.policy.map((item) => `- ${item}`).join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return output;
}
