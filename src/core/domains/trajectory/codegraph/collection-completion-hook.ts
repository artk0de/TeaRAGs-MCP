/**
 * Collection-completion hook — the seam through which a codegraph sub-graph
 * other than symbols rebuilds its tables at the end of an enrichment run
 * (bd tea-rags-mcp-x4rpp).
 *
 * The symbols provider owns the codegraph family's one run lifecycle: the
 * pinned worker, the DuckDB write handle, and the point where a collection's
 * graph is whole (`CodegraphEnrichmentProvider#finalizeSignals`, or the
 * completion owner's `readBack` under language affinity). A sub-graph that
 * derives its tables from the collection as a whole — not per file, and without
 * a payload of its own yet — plugs in here instead of registering a second
 * enrichment provider, which would stamp a marker onto every point of every
 * index for no payload.
 *
 * Hooks run best-effort, after the symbol graph's own metrics: a hook that
 * throws is logged and never fails the run.
 */

import type { GraphDbClient } from "../../../contracts/types/codegraph.js";

/** What a hook gets at collection completion. */
export interface CodegraphCollectionCompletionContext {
  /** Absolute root of the indexed project (the codegraph provider's `resolveRoot`). */
  projectRoot: string;
  /** The collection's graph DB, write-capable (daemon-proxied in production). */
  graphDb: Pick<GraphDbClient, "readTemporalCochangeMeta" | "replaceTemporalCochange">;
}

export interface CodegraphCollectionCompletionHook {
  /** Names the hook in the failure log line. */
  readonly name: string;
  onCollectionComplete: (context: CodegraphCollectionCompletionContext) => Promise<unknown>;
}
