# Package-manager archive

PuppetLoom uses the root `package-lock.json` and the `npm@11.12.1` declaration in `package.json` as its only active dependency truth.

The `pnpm/` files are retained only to preserve the repository's earlier local state. They did not describe the workspace importers under `apps/*` and `packages/*`, are not installation inputs, and must not be updated alongside npm.
