import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isValidSemver } from "./semver.js";

/** Reads the tea-rags package version from disk. */
export interface VersionSource {
  /**
   * Returns the currently-installed tea-rags version (e.g. "1.23.1").
   * Throws if the package is malformed (programming invariant: every
   * installed npm package must have a parseable package.json with a
   * semver `version`).
   */
  getCurrent: () => string;
}

/**
 * Resolves package.json by walking up from this file. Works for both:
 *  - `src/cli/update-check/version-source.ts` (dev via tsx/vitest), and
 *  - `build/cli/update-check/version-source.js` (published layout),
 * because in both cases the file is exactly three levels below the
 * package root. Mirrors `src/core/infra/qdrant-version.ts:resolveVersionFilePath`.
 */
function resolvePackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "package.json");
}

export class PackageJsonVersionSource implements VersionSource {
  getCurrent(): string {
    const path = resolvePackageJsonPath();
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    const { version } = parsed;
    if (typeof version !== "string" || !isValidSemver(version)) {
      throw new Error(`PackageJsonVersionSource: package.json at ${path} has invalid version: ${String(version)}`);
    }
    return version;
  }
}
