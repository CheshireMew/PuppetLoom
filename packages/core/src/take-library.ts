import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { PuppetLoomError } from "./errors.js";
import { parseRuntimeInputSession, runtimeMotionInputKeys, type RuntimeInputSession, type RuntimeInputSessionEvent, type RuntimeMotionInputKey } from "./runtime-control.js";

export interface PerformanceTakeDocument {
  version: 1;
  id: string;
  name: string;
  tags: string[];
  note?: string;
  createdAt: string;
  parentTakeId?: string;
  edit?: TakeEditOperations;
  session: RuntimeInputSession;
}

export interface TakeEditOperations {
  name?: string;
  tags?: string[];
  note?: string;
  trim?: { startMs: number; endMs: number };
  speed?: number;
  muteSources?: string[];
  muteMotion?: RuntimeMotionInputKey[];
  muteParameters?: string[];
  muteExpressions?: string[];
  smoothWindow?: number;
}

export interface PerformanceTakeSummary {
  id: string;
  name: string;
  tags: string[];
  createdAt: string;
  parentTakeId?: string;
  durationMs: number;
  events: number;
  path: string;
}

function takeDirectory(projectDirectory: string): string {
  return join(resolve(projectDirectory), "performances", "takes");
}

function parseTake(value: unknown): PerformanceTakeDocument {
  if (!value || typeof value !== "object") throw new PuppetLoomError("INVALID_INPUT", "Take 文件必须是对象。");
  const raw = value as Partial<PerformanceTakeDocument>;
  if (raw.version !== 1 || typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string" || !raw.name || !Array.isArray(raw.tags) || typeof raw.createdAt !== "string") throw new PuppetLoomError("INVALID_INPUT", "Take 文件缺少 version、id、name、tags 或 createdAt。");
  return { ...raw, tags: [...new Set(raw.tags.map(String).filter(Boolean))], session: parseRuntimeInputSession(raw.session) } as PerformanceTakeDocument;
}

async function uniqueTakePath(root: string, id: string): Promise<string> {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const target = join(takeDirectory(root), `${safe}.take.json`);
  try { await access(target); throw new PuppetLoomError("INVALID_INPUT", `Take 已存在：${safe}`); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

export async function importPerformanceTake(projectDirectory: string, sessionValue: unknown, options: { name?: string; tags?: string[]; note?: string } = {}): Promise<PerformanceTakeSummary> {
  const session = parseRuntimeInputSession(sessionValue);
  const root = resolve(projectDirectory);
  const id = randomUUID();
  const document: PerformanceTakeDocument = {
    version: 1, id, name: options.name?.trim() || `Take ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    tags: [...new Set((options.tags ?? []).map((tag) => tag.trim()).filter(Boolean))], ...(options.note?.trim() ? { note: options.note.trim() } : {}),
    createdAt: new Date().toISOString(), session
  };
  const path = await uniqueTakePath(root, id);
  await mkdir(takeDirectory(root), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return summary(document, path);
}

export async function listPerformanceTakes(projectDirectory: string): Promise<PerformanceTakeSummary[]> {
  const directory = takeDirectory(projectDirectory);
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => name.endsWith(".take.json")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const takes = await Promise.all(names.map(async (name) => {
    const path = join(directory, name);
    return summary(parseTake(JSON.parse(await readFile(path, "utf8")) as unknown), path);
  }));
  return takes.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readPerformanceTake(projectDirectory: string, takeId: string): Promise<PerformanceTakeDocument> {
  const path = join(takeDirectory(projectDirectory), `${takeId.replace(/[^a-zA-Z0-9_-]/g, "-")}.take.json`);
  return parseTake(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function trimSession(session: RuntimeInputSession, startMs: number, endMs: number): RuntimeInputSession {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > session.durationMs) throw new PuppetLoomError("INVALID_INPUT", `裁切范围必须满足 0 <= start < end <= ${session.durationMs}。`);
  const latest = new Map<string, Extract<RuntimeInputSessionEvent, { op: "set" }>>();
  for (const event of session.events) {
    if (event.atMs > startMs) break;
    if (event.op === "set") latest.set(event.source.id, event);
    if (event.op === "release") event.sourceId ? latest.delete(event.sourceId) : latest.clear();
  }
  const baseline = [...latest.values()].map((event): RuntimeInputSessionEvent => ({
    atMs: 0, op: "set", source: {
      ...structuredClone(event.source),
      ...(event.source.ttlMs === undefined ? {} : { ttlMs: Math.max(50, event.source.ttlMs - Math.max(0, startMs - event.atMs)) })
    }
  }));
  const events = session.events.filter((event) => event.atMs > startMs && event.atMs <= endMs).map((event) => ({ ...structuredClone(event), atMs: event.atMs - startMs }));
  return parseRuntimeInputSession({ ...session, id: randomUUID(), recordedAt: new Date().toISOString(), durationMs: endMs - startMs, events: [...baseline, ...events].sort((a, b) => a.atMs - b.atMs) });
}

function editSession(session: RuntimeInputSession, operations: TakeEditOperations): RuntimeInputSession {
  let next = operations.trim ? trimSession(session, operations.trim.startMs, operations.trim.endMs) : structuredClone(session);
  const mutedSources = new Set(operations.muteSources ?? []);
  const mutedMotion = new Set(operations.muteMotion ?? []);
  const mutedParameters = new Set(operations.muteParameters ?? []);
  const mutedExpressions = new Set(operations.muteExpressions ?? []);
  const history = new Map<string, Map<RuntimeMotionInputKey, number[]>>();
  const window = Math.max(1, Math.min(120, Math.round(operations.smoothWindow ?? 1)));
  const events = next.events.flatMap((event): RuntimeInputSessionEvent[] => {
    const sourceId = event.op === "set" ? event.source.id : event.sourceId;
    if (sourceId && mutedSources.has(sourceId)) return [];
    if (event.op !== "set") return [event];
    const source = structuredClone(event.source);
    if (source.motion) {
      const byKey = history.get(source.id) ?? new Map<RuntimeMotionInputKey, number[]>();
      history.set(source.id, byKey);
      for (const key of runtimeMotionInputKeys) {
        if (mutedMotion.has(key)) { delete source.motion[key]; continue; }
        const value = source.motion[key];
        if (value === undefined || window === 1) continue;
        const values = [...(byKey.get(key) ?? []), value].slice(-window);
        byKey.set(key, values);
        source.motion[key] = values.reduce((sum, current) => sum + current, 0) / values.length;
      }
      if (Object.keys(source.motion).length === 0) delete source.motion;
    }
    if (source.parameters) { for (const id of mutedParameters) delete source.parameters[id]; if (Object.keys(source.parameters).length === 0) delete source.parameters; }
    if (source.expressions) { for (const id of mutedExpressions) delete source.expressions[id]; if (Object.keys(source.expressions).length === 0) delete source.expressions; }
    if (!source.motion && !source.parameters && !source.expressions && !source.characterState) return [];
    return [{ ...event, source }];
  });
  const speed = operations.speed ?? 1;
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 4) throw new PuppetLoomError("INVALID_INPUT", "Take 速度必须在 0.1 到 4 之间。");
  next = parseRuntimeInputSession({ ...next, id: randomUUID(), recordedAt: new Date().toISOString(), durationMs: Math.round(next.durationMs / speed), events: events.map((event) => ({ ...event, atMs: Math.round(event.atMs / speed) })) });
  return next;
}

export async function editPerformanceTake(projectDirectory: string, takeId: string, operations: TakeEditOperations): Promise<PerformanceTakeSummary> {
  const parent = await readPerformanceTake(projectDirectory, takeId);
  const id = randomUUID();
  const document: PerformanceTakeDocument = {
    version: 1, id, name: operations.name?.trim() || `${parent.name} · 编辑`, tags: operations.tags ? [...new Set(operations.tags.map((tag) => tag.trim()).filter(Boolean))] : parent.tags,
    ...(operations.note?.trim() ? { note: operations.note.trim() } : parent.note ? { note: parent.note } : {}), createdAt: new Date().toISOString(), parentTakeId: parent.id,
    edit: structuredClone(operations), session: editSession(parent.session, operations)
  };
  const path = await uniqueTakePath(projectDirectory, id);
  await mkdir(takeDirectory(projectDirectory), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return summary(document, path);
}

export async function exportPerformanceTake(projectDirectory: string, takeId: string, output: string, format: "session-json" | "events-csv" = "session-json"): Promise<string> {
  const take = await readPerformanceTake(projectDirectory, takeId);
  const target = resolve(output);
  try { await access(target); throw new PuppetLoomError("INVALID_INPUT", `导出文件已存在，不会覆盖：${target}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(resolve(target, ".."), { recursive: true });
  if (format === "session-json") await writeFile(target, `${JSON.stringify(take.session, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  else {
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = [["atMs", "op", "source", "payload"], ...take.session.events.map((event) => [event.atMs, event.op, event.op === "set" ? event.source.id : event.sourceId ?? "", JSON.stringify(event)])];
    await writeFile(target, `${rows.map((row) => row.map(escape).join(",")).join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  }
  return target;
}

function summary(document: PerformanceTakeDocument, path: string): PerformanceTakeSummary {
  return { id: document.id, name: document.name, tags: document.tags, createdAt: document.createdAt, ...(document.parentTakeId ? { parentTakeId: document.parentTakeId } : {}), durationMs: document.session.durationMs, events: document.session.events.length, path };
}
