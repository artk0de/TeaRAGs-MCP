/**
 * Shared inputs and helpers for the TS symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `TSCallResolver(tsOptions, mode)` pair).
 * `collectImportedFiles` is the one helper several strategies AND the
 * orchestrator's dispatch path share — factored here so it lives once.
 */

import type { AmbiguousResolveMode, CallContext } from "../../../../../contracts/types/codegraph.js";
import { mapImportToFile, type TsCompilerOptions } from "../ts-path-mapper.js";

export interface ResolverConfig {
  tsOptions: TsCompilerOptions;
  mode: AmbiguousResolveMode;
}

/**
 * The set of in-project files the caller imports, each mapped through the
 * tsconfig path mapper. Bare npm specifiers (mapped to `null`) are excluded.
 * Used to narrow ambiguous candidates to files the caller can actually reach.
 */
export function collectImportedFiles(ctx: CallContext, tsOptions: TsCompilerOptions): Set<string> {
  const files = new Set<string>();
  for (const imp of ctx.imports) {
    const file = mapImportToFile(imp.importText, ctx.callerFile, tsOptions);
    if (file) files.add(file);
  }
  return files;
}
