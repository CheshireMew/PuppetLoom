export const cliBuildPackages: string[];
export const cliBuildManifest: string;
export function cliSourceIdentity(root: string): Promise<{ hashes: Record<string, string>; sha256: string }>;
export function cliOutputIdentity(root: string): Promise<{ hashes: Record<string, string>; sha256: string }>;
export function inspectCliBuild(root: string): Promise<{ current: boolean; protocol: number; version?: string; sourceSha256?: string; outputSha256?: string; builtAt?: string; packages: string[]; problems: string[] }>;
export function skillIdentity(root: string): Promise<{ path: string; sha256: string }>;
