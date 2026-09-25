/**
 * The nested `src/**\/CLAUDE.md` domain navigators, shared by every guard that
 * scans them (`navigator-code-references.test.ts` for citation SHAPE,
 * `navigator-enumerations.test.ts` for enumerated SETS).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Repo root, from `tests/`. */
export const REPO_ROOT = join(import.meta.dirname, "..");

/** Every nested navigator under `src/`, repo-relative with POSIX separators. */
export function navigators(): string[] {
  return readdirSync(join(REPO_ROOT, "src"), { recursive: true, encoding: "utf8" })
    .map((entry) => `src/${entry.split(/[\\/]/).join("/")}`)
    .filter((file) => file.endsWith("/CLAUDE.md"))
    .sort();
}
