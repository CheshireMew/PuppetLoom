import { createDefaultAuthoringModel } from "./model.js";
import { puppetLoomProjectSchema } from "./schema.js";
import { PUPPETLOOM_PROJECT_VERSION, type PuppetLoomProject } from "./types.js";

/** The single audited boundary for base project JSON, including legacy migration. */
export function parsePuppetLoomProject(value: unknown): PuppetLoomProject {
  const parsed = puppetLoomProjectSchema.parse(value);
  if (parsed.version === PUPPETLOOM_PROJECT_VERSION && parsed.model) return parsed as PuppetLoomProject;
  const { model: _legacyModel, ...legacy } = parsed;
  return {
    ...legacy,
    version: PUPPETLOOM_PROJECT_VERSION,
    model: createDefaultAuthoringModel()
  } as PuppetLoomProject;
}
