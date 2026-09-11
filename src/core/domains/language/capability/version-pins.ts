import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { LanguageCapability, LanguageSupportVersions } from "../../../contracts/types/language.js";
import { SHARED_LANGUAGE, sharedVersions } from "../kernel/capability.js";
import { versionAxisSources, type PinnedVersionAxis, type VersionAxisSources } from "./version-axes.js";

export interface VersionPin {
  version: number;
  digest: string;
}

export type VersionPins = Record<string, Partial<Record<PinnedVersionAxis, VersionPin>>>;

/** The half of an axis descriptor a digest is computed from. */
export type VersionAxisSourceSet = Pick<VersionAxisSources, "paths" | "exclude">;

function sourceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .map((entry) => join(path, entry))
    .filter((file) => statSync(file).isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts"));
}

/** A file is pruned when it IS an excluded path or sits under an excluded directory. */
function isExcluded(file: string, excluded: readonly string[]): boolean {
  return excluded.some((path) => file === path || file.startsWith(`${path}${sep}`));
}

/**
 * sha256 over sorted repo-relative paths + contents; null when nothing exists.
 *
 * The digest assumes LF line endings and POSIX path separators — file bytes are
 * hashed as they sit on disk and paths as `node:path` joins them, so the same
 * sources checked out with CRLF, or on Windows, hash differently. The pin file
 * is committed from a POSIX checkout and CI runs on one.
 */
export function digestSources(source: VersionAxisSourceSet, root: string = process.cwd()): string | null {
  const excluded = (source.exclude ?? []).map((path) => join(root, path));
  const files = source.paths
    .flatMap((path) => sourceFiles(join(root, path)))
    .filter((file) => !isExcluded(file, excluded))
    .sort();
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

/**
 * Pin every language's axes, plus the `*` pseudo-language standing for the
 * shared kernel and chunker. `*` has no capability descriptor — its numbers are
 * `sharedVersions`, because the sources it covers belong to no language.
 */
export function computeVersionPins(caps: Map<string, LanguageCapability>, root?: string): VersionPins {
  const pins: VersionPins = {};
  const declared = new Map<string, LanguageSupportVersions>(
    [...caps].map(([language, cap]) => [language, cap.versions]),
  );
  declared.set(SHARED_LANGUAGE, sharedVersions);

  for (const [language, versions] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
    for (const source of versionAxisSources(language)) {
      const digest = digestSources(source, root);
      if (digest === null) continue;
      (pins[language] ??= {})[source.axis] = { version: versions[source.axis], digest };
    }
  }
  return pins;
}
