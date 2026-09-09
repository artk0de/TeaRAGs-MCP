/**
 * The ONE place the Python resolution chain is composed (bd tea-rags-mcp-3yxmy).
 *
 * `PythonCallResolver` used to build the array inline and both offline
 * harnesses — `scripts/codegraph-chain-tally.ts` and
 * `scripts/py-codegraph-jedi-oracle.ts` — kept hand-copied duplicates of it.
 * When `importedName` landed at index 4, the tally was updated and the oracle
 * was not, so the oracle's own `chainDrift` guard fired (117 sites on flask,
 * 552 on ugnest) and every number it printed was void. A copy that must be
 * kept in sync by hand is a copy that will not be, so there is now exactly one
 * copy and the harnesses call it.
 *
 * Order IS precedence — see `python-resolver.ts` for what each pass claims and
 * why the terminal guards must precede `globalShortName`.
 */

import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { PythonImportFileMapper } from "./python-import-file-mapper.js";
import {
  PythonGlobalShortNameSymbolResolutionStrategy,
  PythonImportedNameSymbolResolutionStrategy,
  PythonImportMatchSymbolResolutionStrategy,
  PythonLocalBindingSymbolResolutionStrategy,
  PythonSelfFieldSymbolResolutionStrategy,
  PythonSelfMemberSymbolResolutionStrategy,
  PythonSuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

/**
 * The production chain, in production order.
 *
 * `mapper` is a parameter rather than a local because its memo is keyed by
 * symbol-table identity: `PythonCallResolver` owns ONE instance and hands it in
 * so every consumer it grows shares the resolved-root cache. A caller that has
 * no other consumer — either harness — omits it and gets a private one, which
 * is exactly the per-chain sharing the resolver has today.
 */
export function createPythonSymbolResolutionChain(
  cfg: ResolverConfig,
  mapper: PythonImportFileMapper = new PythonImportFileMapper(),
): SymbolResolutionStrategy[] {
  return [
    new PythonSuperSymbolResolutionStrategy(cfg),
    new PythonSelfFieldSymbolResolutionStrategy(cfg),
    new PythonSelfMemberSymbolResolutionStrategy(cfg),
    new PythonLocalBindingSymbolResolutionStrategy(cfg),
    new PythonImportedNameSymbolResolutionStrategy(cfg, mapper),
    new PythonImportMatchSymbolResolutionStrategy(cfg),
    new PythonGlobalShortNameSymbolResolutionStrategy(cfg),
  ];
}
