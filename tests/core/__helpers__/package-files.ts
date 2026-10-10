import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Absolute path of a file inside an installed npm package, found through Node
 * module resolution rather than a checkout-relative `node_modules/...` path.
 * Agent worktrees carry no `node_modules` of their own (packages resolve from
 * the main checkout up the directory tree), so a hand-built root-relative path
 * is ENOENT there (bd tea-rags-mcp-zpllv).
 */
export function resolvePackageFile(packageName: string, relativePath: string): string {
  return join(dirname(require.resolve(`${packageName}/package.json`)), relativePath);
}

/** Absolute path of a binary a package installs into the `node_modules/.bin` that holds it. */
export function resolvePackageBin(packageName: string, binName: string): string {
  return join(dirname(dirname(require.resolve(`${packageName}/package.json`))), ".bin", binName);
}
