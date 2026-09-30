/**
 * Collection-completion hook — the seam through which a codegraph sub-graph
 * other than symbols rebuilds its tables at the end of an enrichment run
 * (bd tea-rags-mcp-x4rpp).
 *
 * The symbols provider owns the codegraph family's one run lifecycle and runs
 * the hooks through ONE seam, `CodegraphEnrichmentProvider#completeCollection`,
 * on its main-thread instance: after an enrichment run settled and the worker
 * released its run state (`EnrichmentCoordinator#completeRun`), or from a
 * reindex that opened no enrichment run — deletion-only, nothing to chunk (bd
 * tea-rags-mcp-l1ot.2) — so a hook must be cheap when its inputs did not move.
 * Never from the worker's finalize (bd tea-rags-mcp-vtuu4): a hook allocating
 * beside the whole-project `ts.Program` ran a large repository's enrichment
 * worker out of heap. A sub-graph that derives its tables from the collection
 * as a whole — not per file, and without a payload of its own yet — plugs in
 * here instead of registering a second enrichment provider, which would stamp a
 * marker onto every point of every index for no payload.
 *
 * Hooks run best-effort, after the symbol graph's own metrics: a hook that
 * throws is logged and never fails the run.
 */

import type { GraphDbClient } from "../../../contracts/types/codegraph.js";

/** What a hook gets at collection completion. */
export interface CodegraphCollectionCompletionContext {
  /** Absolute root of the indexed project (the codegraph provider's `resolveRoot`). */
  projectRoot: string;
  /**
   * The collection's graph DB, write-capable (daemon-proxied in production).
   * The temporal-cochange methods of both sub-graphs only — a hook never
   * touches the symbol graph's own tables.
   */
  graphDb: Pick<
    GraphDbClient,
    | "readTemporalCochangeMeta"
    | "replaceTemporalCochange"
    | "replaceTemporalSymbolCommits"
    | "storedTemporalSymbolCommitFilePaths"
    | "deleteTemporalSymbolCommitFiles"
  >;
}

export interface CodegraphCollectionCompletionHook {
  /** Names the hook in the failure log line. */
  readonly name: string;
  onCollectionComplete: (context: CodegraphCollectionCompletionContext) => Promise<unknown>;
}
