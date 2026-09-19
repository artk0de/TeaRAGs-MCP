/**
 * Shared inputs and helpers for the TS symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `TSCallResolver(tsOptions, mode)` pair).
 * `collectImportedFiles` is the one helper several strategies AND the
 * orchestrator's dispatch path share — factored here so it lives once.
 */

import type { AmbiguousResolveMode, CallContext } from "../../../../../contracts/types/codegraph.js";
import { reexportOriginFile as kernelReexportOriginFile } from "../../../kernel/reexport-origin.js";
import { lookupEcmascriptSymbols } from "../../../shared/ecmascript-symbol-lookup.js";
import { mapImportToFile, type ProjectFileProbe, type TsCompilerOptions } from "../ts-path-mapper.js";

export interface ResolverConfig {
  tsOptions: TsCompilerOptions;
  mode: AmbiguousResolveMode;
  /**
   * Project-tree oracle the path mapper uses to pick a specifier's real
   * extension — `./Button.js` is `Button.ts` in one project and `Button.tsx`
   * in the next (bd tea-rags-mcp-f3zcy). Omitted only by tests that build a
   * config literal; the mapper then keeps its conservative `.ts` mapping.
   */
  fileExists?: ProjectFileProbe;
  /**
   * Max cone size before CHA devirtualization collapses to a single
   * `poly-base` edge (bd tea-rags-mcp-k4wpn). `|cone| ≤ coneMax` persists N
   * `cone` edges (confidence `1/N`); `> coneMax` persists one base-decl edge
   * expanded at query time. Defaults to `CONE_MAX_DEFAULT` (8) when omitted;
   * env `CODEGRAPH_TS_CONE_MAX` overrides at composition.
   */
  coneMax?: number;
}

/** Default cone-size threshold; env `CODEGRAPH_TS_CONE_MAX` overrides at composition. */
export const CONE_MAX_DEFAULT = 8;

/**
 * The set of in-project files the caller imports, each mapped through the
 * tsconfig path mapper. Bare npm specifiers (mapped to `null`) are excluded.
 * Used to narrow ambiguous candidates to files the caller can actually reach.
 */
export function collectImportedFiles(
  ctx: CallContext,
  tsOptions: TsCompilerOptions,
  fileExists?: ProjectFileProbe,
): Set<string> {
  const files = new Set<string>();
  for (const imp of ctx.imports) {
    const file = mapImportToFile(imp.importText, ctx.callerFile, tsOptions, fileExists);
    if (file) files.add(file);
  }
  return files;
}

/**
 * The kernel's barrel hop (`kernel/reexport-origin.ts`, relocated there for
 * Python's `__init__.py` re-exports, bd tea-rags-mcp-9fgdi) bound to the
 * ECMAScript family's lookup (bd tea-rags-mcp-t5cji), so a TypeScript barrel
 * can never be followed onto a Ruby or Python namesake. `ts-named-import`,
 * `ts-imported-callee` and `strategies/index.ts` keep importing it from here.
 */
export function reexportOriginFile(
  name: string,
  importedFile: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): string | null {
  return kernelReexportOriginFile(name, importedFile, ctx, mode, lookupEcmascriptSymbols);
}
