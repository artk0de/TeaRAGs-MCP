import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigValueInvalidError } from "../errors.js";

const VERSION_FILE_NAME = ".qdrant-required-version";
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function resolveVersionFilePath(): string {
  // Works for both `src/bootstrap/config/qdrant-compat.ts` (dev via tsx/vitest)
  // and `build/bootstrap/config/qdrant-compat.js` (published package layout):
  // in both cases the file lives three levels up at the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", VERSION_FILE_NAME);
}

export function readMinQdrantVersion(): string {
  const path = resolveVersionFilePath();
  const content = readFileSync(path, "utf-8").trim();
  if (!SEMVER_RE.test(content)) {
    throw new ConfigValueInvalidError("MIN_QDRANT_VERSION", content, `semver X.Y.Z from ${VERSION_FILE_NAME}`);
  }
  return content;
}

export function compareSemver(a: string, b: string): number {
  if (!SEMVER_RE.test(a)) {
    throw new ConfigValueInvalidError("compareSemver.a", a, "semver X.Y.Z");
  }
  if (!SEMVER_RE.test(b)) {
    throw new ConfigValueInvalidError("compareSemver.b", b, "semver X.Y.Z");
  }
  const [a1, a2, a3] = a.split(".").map((n) => parseInt(n, 10));
  const [b1, b2, b3] = b.split(".").map((n) => parseInt(n, 10));
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}
