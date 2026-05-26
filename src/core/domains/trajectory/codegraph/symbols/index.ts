/**
 * SymbolsTrajectory L2 — the slice-1 codegraph trajectory.
 *
 * Wraps the codegraph-symbols provider + signals + presets in a single
 * `Trajectory` instance. Created by `createCodegraphTrajectories` (L1
 * factory) when codegraph is enabled.
 */

import type { Trajectory } from "../../../../contracts/types/trajectory.js";
import { codegraphFilters } from "./filters.js";
import { CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, CODEGRAPH_SYMBOLS_FILE_SIGNALS } from "./payload-signals.js";
import { CodegraphEnrichmentProvider, type CodegraphProviderDeps } from "./provider.js";
import { CODEGRAPH_SYMBOLS_DERIVED_SIGNALS } from "./rerank/derived-signals/index.js";
import { CODEGRAPH_SYMBOLS_PRESETS } from "./rerank/presets/index.js";

export type SymbolsTrajectoryDeps = CodegraphProviderDeps;

export function createSymbolsTrajectory(deps: SymbolsTrajectoryDeps): Trajectory {
  // Spread preserves both routing modes — pool (production via bootstrap)
  // and direct graphDb/symbolTable (tests). `CodegraphEnrichmentProvider`
  // enforces the "exactly one mode" invariant in its constructor.
  const provider = new CodegraphEnrichmentProvider({
    ...deps,
    derivedSignals: CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
    presets: CODEGRAPH_SYMBOLS_PRESETS,
  });
  return {
    key: "codegraph.symbols",
    name: "CodegraphSymbols",
    description: "Symbol-level dependency graph and Tier 1 metrics",
    payloadSignals: [...CODEGRAPH_SYMBOLS_FILE_SIGNALS, ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS],
    derivedSignals: CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
    filters: codegraphFilters,
    presets: CODEGRAPH_SYMBOLS_PRESETS,
    enrichment: provider,
  };
}

export { CodegraphEnrichmentProvider } from "./provider.js";
export { CODEGRAPH_LANGUAGES, type CodegraphLanguageConfig } from "./provider.js";
export { InMemoryGlobalSymbolTable } from "./symbol-table.js";
export { CODEGRAPH_SYMBOLS_FILE_SIGNALS, CODEGRAPH_SYMBOLS_CHUNK_SIGNALS } from "./payload-signals.js";
export { codegraphFilters } from "./filters.js";
