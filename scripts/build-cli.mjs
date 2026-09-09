import { spawn } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliBuildManifest, cliBuildPackages, cliOutputIdentity, cliSourceIdentity, inspectCliBuild } from "./lib/cli-build-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  if (process.argv.includes("--check")) {
    const result = await inspectCliBuild(root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.current) process.exitCode = 2;
  } else {
    const before = await cliSourceIdentity(root);
    for (const pkg of cliBuildPackages) {
      await new Promise((success, reject) => {
        const child = spawn(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, pkg, "tsconfig.json")], { cwd: root, stdio: "inherit", windowsHide: true });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? success() : reject(new Error(`${pkg} 编译退出码 ${code}`)));
      });
    }
    const source = await cliSourceIdentity(root);
    if (source.sha256 !== before.sha256) throw new Error("编译期间源码发生变化，请重新构建；未发布构建身份。" );
    const output = await cliOutputIdentity(root);
    const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const manifest = { protocol: 1, version, builtAt: new Date().toISOString(), sourceSha256: source.sha256, outputSha256: output.sha256, sources: source.hashes, outputs: output.hashes };
    const path = join(root, cliBuildManifest);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, path);
    process.stdout.write(`CLI build ${source.sha256.slice(0, 12)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
