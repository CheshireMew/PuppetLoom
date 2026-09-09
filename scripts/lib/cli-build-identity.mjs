import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const cliBuildPackages = ["packages/core", "packages/renderer", "apps/cli"];
export const cliBuildManifest = "apps/cli/dist/build-identity.json";
const normalize = (path) => path.replace(/\\/g, "/");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function files(root, directory) {
  const result = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = normalize(join(directory, entry.name));
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`构建输入或输出不能是链接：${path}`);
  }
  return result.sort();
}

async function fingerprint(root, paths) {
  const entries = [];
  for (const path of [...paths].sort()) entries.push([path, digest(await readFile(join(root, path)))]);
  return Object.fromEntries(entries);
}

export async function cliSourceIdentity(root) {
  const paths = ["package.json", "package-lock.json", "tsconfig.base.json", "scripts/build-cli.mjs", "scripts/lib/cli-build-identity.mjs", "scripts/lib/cli-build-identity.d.mts"];
  for (const pkg of cliBuildPackages) paths.push(`${pkg}/package.json`, `${pkg}/tsconfig.json`, ...await files(root, `${pkg}/src`));
  const hashes = await fingerprint(root, paths);
  return { hashes, sha256: digest(JSON.stringify(hashes)) };
}

export async function cliOutputIdentity(root) {
  const paths = [];
  const expected = [];
  for (const pkg of cliBuildPackages) {
    paths.push(...(await files(root, `${pkg}/dist`)).filter((path) => path !== cliBuildManifest));
    for (const source of await files(root, `${pkg}/src`)) {
      if (!source.endsWith(".ts") || source.endsWith(".d.ts")) continue;
      const output = source.replace(`${pkg}/src/`, `${pkg}/dist/`).slice(0, -3);
      expected.push(`${output}.js`, `${output}.js.map`, `${output}.d.ts`);
    }
  }
  const actual = new Set(paths), wanted = new Set(expected);
  const missing = expected.filter((path) => !actual.has(path));
  const extra = paths.filter((path) => !wanted.has(path));
  if (missing.length || extra.length) throw new Error(`构建文件集合不完整：${JSON.stringify({ missing, extra })}`);
  const hashes = await fingerprint(root, paths);
  return { hashes, sha256: digest(JSON.stringify(hashes)) };
}

export async function inspectCliBuild(root) {
  try {
    const manifest = JSON.parse(await readFile(join(root, cliBuildManifest), "utf8"));
    if (manifest.protocol !== 1) throw new Error("构建身份协议不支持。" );
    const [source, output] = await Promise.all([cliSourceIdentity(root), cliOutputIdentity(root)]);
    const problems = [];
    if (source.sha256 !== manifest.sourceSha256) problems.push("源码或构建配置已变化");
    if (output.sha256 !== manifest.outputSha256) problems.push("编译文件已变化");
    return { current: problems.length === 0, protocol: 1, version: manifest.version, sourceSha256: manifest.sourceSha256, outputSha256: manifest.outputSha256, builtAt: manifest.builtAt, packages: cliBuildPackages, problems };
  } catch (error) {
    return { current: false, protocol: 1, packages: cliBuildPackages, problems: [error instanceof Error ? error.message : String(error)] };
  }
}

export async function skillIdentity(root) {
  const directory = "skills/live2d-puppet";
  const paths = (await files(root, directory)).filter((path) => /\.(md|ps1|py|mjs|yaml)$/.test(path) && !path.includes("/tests/"));
  return { path: normalize(relative(root, resolve(root, directory))), sha256: digest(JSON.stringify(await fingerprint(root, paths))) };
}
