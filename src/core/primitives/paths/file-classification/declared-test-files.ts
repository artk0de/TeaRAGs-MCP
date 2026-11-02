/**
 * Files that are test code by DECLARATION (bd tea-rags-mcp-52wk3.10) — an
 * additive input to test classification beside the path conventions.
 *
 * A language may know, from one file, that ANOTHER file compiles only in the
 * test build (Rust's `#[cfg(test)] mod testutil;`). No path shape carries that
 * fact, so an indexing run computes the set once on the main thread and
 * installs it here; an enrichment worker installs the copy its call envelope
 * carries. `classify().isTest` and the codegraph exclusion read it at call
 * time, so a filter built once sees each run's set.
 *
 * A REGISTRY keyed by the project root (normalized absolute path). One process
 * serves many projects — the MCP server, an enrichment worker taking calls for
 * several roots — and two runs of different projects may interleave, so a
 * single slot let project A's declared paths classify project B's files
 * (`src/test_utils.rs` is a common path). Every reader therefore names ITS OWN
 * root, and an install replaces only that root's entry. A reader without a
 * root sees no declared file at all — conventions only. Nothing installed for
 * a root → nothing declared, so a context that never runs an index classifies
 * exactly as before.
 */
import { resolve } from "node:path";

const declaredByRoot = new Map<string, ReadonlySet<string>>();

/** An empty root names no project — `resolve("")` would silently mean the cwd. */
function rootKey(projectRoot: string): string | undefined {
  return projectRoot === "" ? undefined : resolve(projectRoot);
}

/**
 * Install `relativePaths` as the declared test files of `projectRoot`,
 * replacing that root's earlier set and no other. An empty set drops the entry.
 */
export function installDeclaredTestFiles(projectRoot: string, relativePaths: Iterable<string>): void {
  const key = rootKey(projectRoot);
  if (key === undefined) return;
  const declared = new Set(relativePaths);
  if (declared.size === 0) declaredByRoot.delete(key);
  else declaredByRoot.set(key, declared);
}

function declaredFor(projectRoot: string): ReadonlySet<string> | undefined {
  const key = rootKey(projectRoot);
  return key === undefined ? undefined : declaredByRoot.get(key);
}

/** `projectRoot`'s installed set, sorted — what a call envelope carries to a worker isolate. */
export function installedDeclaredTestFiles(projectRoot: string): string[] {
  return [...(declaredFor(projectRoot) ?? [])].sort();
}

/** Whether the run of `projectRoot` declared `relPath` (relative to that root) as test code. */
export function isDeclaredTestFile(relPath: string, projectRoot: string): boolean {
  return declaredFor(projectRoot)?.has(relPath) ?? false;
}
