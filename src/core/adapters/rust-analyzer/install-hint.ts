/**
 * The one line a Rust index shows when no rust-analyzer is found (bd s3i8m.6).
 * A missing binary never fails indexing — the last Rust chain slot is simply
 * absent — so this line is the only trace of the gap, emitted once per index
 * run and shown by `prime` and `get_index_status`.
 */

import type { RustAnalyzerExecutable } from "./rust-analyzer-executable.js";

export const RUST_ANALYZER_INSTALL_HINT =
  "rust-analyzer not found — install with 'rustup component add rust-analyzer' (or 'brew install rust-analyzer'), or set CODEGRAPH_RUST_ANALYZER_PATH";

/** Language key the index stores for Rust chunks. */
const RUST_LANGUAGE = "rust";

/**
 * The hint for an index holding `languages`, or null. `locate` runs only when
 * Rust is present, so a non-Rust project never pays the probe.
 */
export function rustAnalyzerInstallHintFor(
  languages: readonly string[],
  locate: () => RustAnalyzerExecutable | null,
): string | null {
  if (!languages.includes(RUST_LANGUAGE)) return null;
  return locate() === null ? RUST_ANALYZER_INSTALL_HINT : null;
}

/** Answers the install hint for a project path and the languages its index holds. */
export type RustAnalyzerInstallHintLookup = (input: { path: string; languages: readonly string[] }) => string | null;
