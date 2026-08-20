import { stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

export interface StoredRecentProject {
  directory: string;
  name: string;
  openedAt: string;
}

const genericProjectNames = new Set(["source", "character", "unnamed"]);

export function recentProjectDisplayName(name: string, directory: string): string {
  const trimmed = name.trim();
  return !trimmed || genericProjectNames.has(trimmed.toLocaleLowerCase()) ? basename(resolve(directory)) : trimmed;
}

export function isTestArtifactProject(directory: string): boolean {
  const normalized = resolve(directory).toLocaleLowerCase();
  return normalized.includes(`${sep}test${sep}artifacts${sep}`.toLocaleLowerCase());
}

export async function usableRecentProjects(entries: unknown, includeTestProjects = false): Promise<StoredRecentProject[]> {
  if (!Array.isArray(entries)) return [];
  const candidates = entries.filter((entry): entry is StoredRecentProject => Boolean(
    entry && typeof entry === "object"
    && typeof (entry as StoredRecentProject).directory === "string"
    && typeof (entry as StoredRecentProject).name === "string"
    && typeof (entry as StoredRecentProject).openedAt === "string"
  ));
  const checked = await Promise.all(candidates.map(async (entry) => {
    const directory = resolve(entry.directory);
    if (!includeTestProjects && isTestArtifactProject(directory)) return undefined;
    try {
      const projectFile = await stat(join(directory, "puppetloom.json"));
      if (!projectFile.isFile()) return undefined;
      return { ...entry, directory, name: recentProjectDisplayName(entry.name, directory) };
    } catch {
      return undefined;
    }
  }));
  return checked.filter((entry): entry is StoredRecentProject => Boolean(entry));
}
