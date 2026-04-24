import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_FILE_NAME = ".qdrant-required-version";
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function resolveVersionFilePath(): string {
  // Works for both `src/core/infra/qdrant-version.ts` (dev via tsx/vitest)
  // and `build/core/infra/qdrant-version.js` (published package layout):
  // in both cases the file lives three levels up at the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", VERSION_FILE_NAME);
}

function loadVersion(): string {
  const content = readFileSync(resolveVersionFilePath(), "utf-8").trim();
  if (!SEMVER_RE.test(content)) {
    // Invariant violation — the package is misbuilt if this file is absent
    // or malformed. Plain Error per typed-errors.md "programming errors" rule.
    throw new Error(`${VERSION_FILE_NAME} must contain semver X.Y.Z, got: ${content}`);
  }
  return content;
}

/**
 * Single source of truth for the Qdrant server version this package targets.
 *
 * Used in two places:
 *  - Embedded daemon downloads and runs exactly this version.
 *  - External Qdrant servers (QDRANT_URL) are validated to be at least this
 *    version at startup (see checkExternalQdrantVersion).
 *
 * Sourced from `.qdrant-required-version` at the repo root so the value is
 * visible in diffs and ships with the npm package independently of compiled
 * JS. Loaded eagerly at module import — a malformed/missing file fails fast.
 */
export const QDRANT_VERSION = loadVersion();

export function compareSemver(a: string, b: string): number {
  if (!SEMVER_RE.test(a)) {
    throw new Error(`compareSemver: expected semver X.Y.Z, got a=${a}`);
  }
  if (!SEMVER_RE.test(b)) {
    throw new Error(`compareSemver: expected semver X.Y.Z, got b=${b}`);
  }
  const [a1, a2, a3] = a.split(".").map((n) => parseInt(n, 10));
  const [b1, b2, b3] = b.split(".").map((n) => parseInt(n, 10));
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

export function isSemver(value: string): boolean {
  return SEMVER_RE.test(value);
}
