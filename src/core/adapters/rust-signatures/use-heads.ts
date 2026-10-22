/**
 * The crate names a project's Rust code imports (bd s3i8m.7): the first
 * segment of every `use` path and every `extern crate`. A dependency crate's
 * signatures are read only when one of these names it — never the whole lock.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const USE_HEAD = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+(?:::)?([A-Za-z_][A-Za-z0-9_]*)/gm;
const EXTERN_CRATE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?extern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const CRATE_RELATIVE: ReadonlySet<string> = new Set(["crate", "self", "super", "std", "core", "alloc"]);
/** Directories that never hold the project's own sources: build output, VCS, vendored JS. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["target", "node_modules"]);

export function rustUseHeadsOf(source: string): Set<string> {
  const heads = new Set<string>();
  for (const pattern of [USE_HEAD, EXTERN_CRATE]) {
    for (const match of source.matchAll(pattern)) {
      const head = match[1];
      if (head !== undefined && !CRATE_RELATIVE.has(head)) heads.add(head);
    }
  }
  return heads;
}

/**
 * Every use head across the project's `.rs` files. Hidden directories (`.git`,
 * `.claude` worktrees) and build output are skipped; an unreadable entry is
 * skipped, never thrown.
 */
export function readProjectRustUseHeads(projectRoot: string): Set<string> {
  const heads = new Set<string>();
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) visit(path);
      } else if (entry.name.endsWith(".rs")) {
        try {
          for (const head of rustUseHeadsOf(readFileSync(path, "utf8"))) heads.add(head);
        } catch {
          // unreadable: skipped
        }
      }
    }
  };
  visit(projectRoot);
  return heads;
}
