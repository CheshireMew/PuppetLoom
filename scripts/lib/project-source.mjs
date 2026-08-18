import { access } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_CANONICAL_PROJECT = "workspace/models/blue-whale-maid";

/**
 * Resolves the one durable local character project used as the source for
 * disposable test clones. An explicit argument wins, followed by the local
 * environment override and finally the repository convention.
 */
export async function resolveProjectSource(argument, environment = process.env) {
  const project = resolve(argument ?? environment.PUPPETLOOM_CANONICAL_PROJECT ?? DEFAULT_CANONICAL_PROJECT);
  try {
    await access(resolve(project, "puppetloom.json"));
    await access(resolve(project, "calibration", "current.json"));
  } catch (cause) {
    throw new Error(`找不到正式 PuppetLoom 项目：${project}。请建立 ${DEFAULT_CANONICAL_PROJECT}，或设置 PUPPETLOOM_CANONICAL_PROJECT。`, { cause });
  }
  return project;
}
