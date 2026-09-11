/**
 * Composition of the codegraph payload heal (bd tea-rags-mcp-a2ddb).
 *
 * The heal has three parts that live in three layers and cannot see each other:
 * the DuckDB diff + baseline (`adapters/duckdb`), the signal arithmetic
 * (`domains/trajectory/codegraph`), and the Qdrant rewrite
 * (`domains/ingest/pipeline/enrichment`). `domains/ingest` may not import
 * `domains/trajectory`, so the wiring belongs here, at the core composition
 * root — the same reason `IndexRunDaemonGuard` is assembled in `bootstrap`
 * rather than inside the coordinator that uses it.
 *
 * The two builder closures are BULK-backed and memoised per run, not per-item
 * reads. Per item they would be one `getFileMetricsBulk` + one `getFanInP95`
 * per file and three point reads per symbol — tens of thousands of daemon
 * round-trips on a first heal, which names every file there is. Instead the
 * first call of each loads the whole graph's signals once (exactly what the
 * provider's finalize pass does) and every later call is a map lookup.
 */

import type { GraphDbClient } from "../../../contracts/types/codegraph.js";
import {
  CodegraphPayloadHealer,
  type CodegraphPayloadHealOutcome,
  type CodegraphPayloadHealRunner,
} from "../../../domains/ingest/pipeline/enrichment/codegraph-payload-heal.js";
import {
  buildCodegraphChunkSignals,
  buildCodegraphFileSignals,
} from "../../../domains/trajectory/codegraph/symbols/payload-signals.js";

/** Per-file metrics read in batches of this size, mirroring the provider's finalize read-back. */
const HEAL_METRICS_READ_BATCH = 2000;

const ZERO_FILE_METRICS = { fanIn: 0, fanOut: 0, transitiveImpact: 0 };

export interface CodegraphPayloadHealRunnerDeps {
  qdrant: {
    scrollFiltered: (
      collectionName: string,
      filter: Record<string, unknown>,
      limit: number,
      pageSize?: number,
      payloadInclude?: string[],
    ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
    batchSetPayload: (
      collectionName: string,
      operations: { payload: Record<string, unknown>; points: (string | number)[]; key?: string }[],
    ) => Promise<void>;
  };
  /**
   * Opens the graph client for the PHYSICAL collection name the caller already
   * resolved. The heal never re-resolves: the pool resolves whatever string it
   * is handed literally, so an alias here opens a second, empty shadow database
   * (the 6goqa / snbzk class of incident) and the diff comes back saying
   * nothing ever changed.
   */
  acquireGraphDb: (collectionName: string) => Promise<GraphDbClient>;
  /** The codegraph provider's own key, so the heal addresses the same payload subtree the applier does. */
  providerKey: string;
}

/**
 * Wire the heal for one process. The returned runner is stateless between
 * calls — every `run` opens its own per-run signal caches, because the graph it
 * reads is exactly what the run just rebuilt.
 */
export function createCodegraphPayloadHealRunner(deps: CodegraphPayloadHealRunnerDeps): CodegraphPayloadHealRunner {
  return {
    run: async (
      collectionName: string,
      skipRelPaths: ReadonlySet<string>,
      enrichedAt?: string,
    ): Promise<CodegraphPayloadHealOutcome> => {
      const graphDb = await deps.acquireGraphDb(collectionName);
      const changed = await graphDb.diffSymbolSignals();
      if (changed.symbols.length === 0 && changed.files.length === 0) {
        // Nothing moved. The baseline already equals the current graph, so
        // refreshing it would be a no-op write on the shared daemon.
        return { pointsRewritten: 0, filesTouched: 0 };
      }

      const healer = new CodegraphPayloadHealer({
        qdrant: deps.qdrant,
        providerKey: deps.providerKey,
        ...createSignalBuilders(
          graphDb,
          changed.files.map((f) => f.relPath),
        ),
      });
      const outcome = await healer.heal(collectionName, changed, skipRelPaths, enrichedAt);

      // ONLY after the rewrite landed. Refreshing the baseline first would erase
      // the diff, and a heal that threw would leave the drift invisible until
      // each affected file happened to change again.
      await graphDb.refreshSymbolSignalsPrev();
      return outcome;
    },
  };
}

/**
 * The two injected builders, each backed by ONE bulk read taken lazily on first
 * use. `heal` skips the files this run already rewrote, so the file read is
 * scoped to the diff's own paths while the symbol read is whole-graph — which
 * is what `getChunkSignalsBulk` is, there being no setwise per-symbol form.
 */
function createSignalBuilders(
  graphDb: GraphDbClient,
  changedFilePaths: readonly string[],
): {
  buildFileSignals: (relPath: string) => Promise<Record<string, unknown> | null>;
  buildChunkSignals: (relPath: string, symbolId: string) => Promise<Record<string, unknown> | null>;
} {
  let filePass:
    | Promise<{ metrics: Map<string, { fanIn: number; fanOut: number; transitiveImpact: number }>; fanInP95: number }>
    | undefined;
  let chunkPass: Promise<Map<string, { fanIn: number; fanOut: number; pageRank: number }>> | undefined;

  const loadFileSignals = async (): Promise<{
    metrics: Map<string, { fanIn: number; fanOut: number; transitiveImpact: number }>;
    fanInP95: number;
  }> => {
    // p95 over the FULL file universe, read ONCE — the same value every file of
    // the pass compares against, or `isHub` is decided per batch and the
    // biggest file of a small diff is misclassified as a hub.
    const fanInP95 = await graphDb.getFanInP95();
    const metrics = new Map<string, { fanIn: number; fanOut: number; transitiveImpact: number }>();
    for (let start = 0; start < changedFilePaths.length; start += HEAL_METRICS_READ_BATCH) {
      const batch = changedFilePaths.slice(start, start + HEAL_METRICS_READ_BATCH);
      for (const [relPath, m] of await graphDb.getFileMetricsBulk(batch)) metrics.set(relPath, m);
    }
    return { metrics, fanInP95 };
  };

  return {
    buildFileSignals: async (relPath) => {
      filePass ??= loadFileSignals();
      const { metrics, fanInP95 } = await filePass;
      return buildCodegraphFileSignals(metrics.get(relPath) ?? ZERO_FILE_METRICS, fanInP95);
    },
    buildChunkSignals: async (_relPath, symbolId) => {
      chunkPass ??= graphDb.getChunkSignalsBulk();
      return buildCodegraphChunkSignals((await chunkPass).get(symbolId));
    },
  };
}
