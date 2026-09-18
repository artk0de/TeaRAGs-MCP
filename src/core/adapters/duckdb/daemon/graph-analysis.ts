import type { CycleScope, GraphDbClient } from "../../../contracts/types/codegraph.js";
import { pageRank } from "../../../infra/graph/page-rank.js";
import { tarjanScc } from "../../../infra/graph/tarjan-scc.js";
import { CodegraphDaemonRequestAbortedError } from "../errors.js";

const OP = "computeAndPersistCyclesAndSignals";

/**
 * Run SCC (file + method scopes) and PageRank over the whole graph and
 * persist the results. Moved verbatim from `provider.ts`'s
 * `recomputeGraphMetricsStreaming` body so the heavy pass executes daemon-side.
 *
 * `signal` is the requesting connection's (bd tea-rags-mcp-f924y): once it
 * closes, the pass stops at the next phase boundary instead of spending minutes
 * of CPU and GBs of adjacency on a result nobody will read. Stopping between
 * phases is safe — every phase is a wholesale recompute the next run redoes.
 */
export async function computeAndPersistCyclesAndSignals(graphDb: GraphDbClient, signal?: AbortSignal): Promise<void> {
  const fileAdj = await collectAdjacency(graphDb, "file");
  stopIfRequesterGone(signal);
  await graphDb.replaceCycles("file", tarjanScc(fileAdj.adjacency));
  stopIfRequesterGone(signal);
  const methodAdj = await collectAdjacency(graphDb, "method");
  stopIfRequesterGone(signal);
  // Tarjan SCC stays unweighted — cycle detection is structural. PageRank is
  // confidence-weighted (bd tea-rags-mcp-s5ato): an m-way dynamic fan-out at
  // confidence 1/m distributes ONE call site's rank across the fan, not m.
  await graphDb.replaceCycles("method", tarjanScc(methodAdj.adjacency));
  stopIfRequesterGone(signal);
  await graphDb.replacePageRanks(pageRank(methodAdj.adjacency, { weights: methodAdj.edgeWeights }).ranks);
}

function stopIfRequesterGone(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CodegraphDaemonRequestAbortedError(OP);
}

/**
 * Drain `graphDb.streamAdjacency(scope)` into the compact
 * `Map<string, string[]>` shape that `tarjanScc` and `pageRank` consume —
 * building the Map exactly once instead of letting the adapter pre-bucket.
 * The per-edge confidence (third stream element, method scope only) is
 * bucketed into an index-aligned weight map for the weighted PageRank pass;
 * absent weights (file scope, legacy rows) default to 1.
 */
async function collectAdjacency(
  graphDb: GraphDbClient,
  scope: CycleScope,
): Promise<{ adjacency: Map<string, string[]>; edgeWeights: Map<string, number[]> }> {
  const adjacency = new Map<string, string[]>();
  const edgeWeights = new Map<string, number[]>();
  for await (const [source, target, weight] of graphDb.streamAdjacency(scope)) {
    const list = adjacency.get(source);
    const wList = edgeWeights.get(source);
    if (list && wList) {
      list.push(target);
      wList.push(weight ?? 1);
    } else {
      adjacency.set(source, [target]);
      edgeWeights.set(source, [weight ?? 1]);
    }
  }
  return { adjacency, edgeWeights };
}
