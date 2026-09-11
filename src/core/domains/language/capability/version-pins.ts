import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { LanguageCapability } from "../../../contracts/types/language.js";
import { versionAxisSources, type PinnedVersionAxis } from "./version-axes.js";

export interface VersionPin {
  version: number;
  digest: string;
}

export type VersionPins = Record<string, Partial<Record<PinnedVersionAxis, VersionPin>>>;

function sourceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .map((entry) => join(path, entry))
    .filter((file) => statSync(file).isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts"));
}

/** sha256 over sorted repo-relative paths + contents; null when nothing exists. */
export function digestSources(paths: readonly string[], root: string = process.cwd()): string | null {
  const files = paths.flatMap((p) => sourceFiles(join(root, p))).sort();
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function computeVersionPins(caps: Map<string, LanguageCapability>, root?: string): VersionPins {
  const pins: VersionPins = {};
  for (const [language, cap] of [...caps].sort(([a], [b]) => a.localeCompare(b))) {
    for (const { axis, paths } of versionAxisSources(language)) {
      const digest = digestSources(paths, root);
      if (digest === null) continue;
      (pins[language] ??= {})[axis] = { version: cap.versions[axis], digest };
    }
  }
  return pins;
}
