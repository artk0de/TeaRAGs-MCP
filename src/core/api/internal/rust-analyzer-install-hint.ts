/**
 * Shared guard for the injected rust-analyzer install-hint lookup (bd s3i8m.6).
 * A missing binary never fails a run or a read, so a lookup that is absent or
 * throws answers "no hint" — the hint is advice, never a failure path.
 */

import type { RustAnalyzerInstallHintLookup } from "../../adapters/rust-analyzer/index.js";

export function safeRustAnalyzerInstallHint(
  lookup: RustAnalyzerInstallHintLookup | undefined,
  input: { path: string; languages: readonly string[] },
): string | null {
  if (!lookup) return null;
  try {
    return lookup(input);
  } catch {
    return null;
  }
}
