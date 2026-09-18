import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import type { DependencyDirectoryRelation } from "./types.js";

/**
 * Classify a dependency by where its target's directory sits relative to its
 * source's (see {@link DependencyDirectoryRelation}). Paths are the graph's
 * repo-relative, `/`-separated `relPath`s; a root-level file's directory is the
 * repo root, which contains every other directory.
 */
export function classifyDirectoryRelation(sourceRelPath: RelPath, targetRelPath: RelPath): DependencyDirectoryRelation {
  const sourceDir = directoryOf(sourceRelPath);
  const targetDir = directoryOf(targetRelPath);
  if (sourceDir === targetDir) return "same";
  if (isWithinDirectory(targetDir, sourceDir)) return "descendant";
  if (isWithinDirectory(sourceDir, targetDir)) return "ancestor";
  return "disjoint";
}

function directoryOf(relPath: RelPath): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

/** Strictly below `ancestor` — a whole-segment prefix, so `ab/` is not within `a/`. */
function isWithinDirectory(dir: string, ancestor: string): boolean {
  return ancestor === "" ? dir !== "" : dir.startsWith(`${ancestor}/`);
}
