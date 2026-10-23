/**
 * The `.rs` tree listing both Rust index runners key their caches on (the
 * rust-analyzer SCIP content key; the rustc call-site reuse stamps).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One `.rs` file of the project: repo-relative path plus the stat that keys a cache. */
export interface RustSourceStamp {
  relPath: string;
  size: number;
  mtimeMs: number;
}

const SKIPPED_SOURCE_DIRS = new Set(["target", "node_modules"]);

/** Every `.rs` file under the root, skipping `target/`, `node_modules/` and dot-directories. */
export function listRustSources(projectRoot: string): RustSourceStamp[] {
  const stamps: RustSourceStamp[] = [];
  const walk = (dir: string, relDir: string): void => {
    let dirEntries;
    try {
      dirEntries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_SOURCE_DIRS.has(entry.name)) walk(join(dir, entry.name), relPath);
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        try {
          const stat = statSync(join(dir, entry.name));
          stamps.push({ relPath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // vanished between listing and stat: not part of the tree
        }
      }
    }
  };
  walk(projectRoot, "");
  return stamps;
}
