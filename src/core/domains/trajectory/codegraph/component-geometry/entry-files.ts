/**
 * How many files the re-export-cycle evidence path may hold — the facade plus
 * at most 7 import hops (bd tea-rags-mcp-89k7k.3). The path IS the evidence: a
 * facade→…→source chain longer than this says nothing actionable, so
 * reachability beyond the cap counts as absent and carries no flag. Not an env
 * knob.
 */
export const RE_EXPORT_CYCLE_PATH_CAP = 8;

/**
 * Entry-file vocabulary per language — the file that makes its directory a
 * module with a facade. The single source: no language capability declares
 * it. Go is absent on purpose: a Go package boundary is compiler-enforced, so
 * its directories are assessed as `language-enforced` instead.
 */
export const MODULE_ENTRY_FILE_NAMES: Readonly<Record<string, readonly string[]>> = {
  typescript: ["index.ts", "index.tsx"],
  javascript: ["index.js"],
  python: ["__init__.py"],
  rust: ["mod.rs", "lib.rs"],
};
