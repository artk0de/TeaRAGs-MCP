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
 * ONE set per isolate — the latest run's, tagged with its project root — and
 * an install replaces it wholesale. A reader has no root, so a set kept per
 * project would answer for every project ever indexed in a long-lived process:
 * `src/test_utils.rs` declared in one crate would classify the same path of
 * the next crate as a test. Two runs of one process on two projects at the
 * SAME time share the slot, and the later install wins. Nothing installed →
 * nothing declared, so a context that never runs an index classifies exactly
 * as before.
 */

let installed: { readonly projectRoot: string; readonly declared: ReadonlySet<string> } | undefined;

/** Install `relativePaths` as the declared test files of `projectRoot`'s run, replacing any earlier set. */
export function installDeclaredTestFiles(projectRoot: string, relativePaths: Iterable<string>): void {
  installed = { projectRoot, declared: new Set(relativePaths) };
}

/** `projectRoot`'s installed set, sorted — what a call envelope carries to a worker isolate. Empty for any other root. */
export function installedDeclaredTestFiles(projectRoot: string): string[] {
  return installed?.projectRoot === projectRoot ? [...installed.declared].sort() : [];
}

/** Whether the installed run declared `relPath` as test code. */
export function isDeclaredTestFile(relPath: string): boolean {
  return installed?.declared.has(relPath) ?? false;
}
