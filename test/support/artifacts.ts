import { resolve } from "node:path";

export function artifactPath(...parts: string[]): string {
  const root = process.env.PUPPETLOOM_ARTIFACT_RUN_ROOT;
  if (!root) throw new Error("测试产物根目录尚未通过托管预检。" );
  return resolve(root, ...parts);
}
