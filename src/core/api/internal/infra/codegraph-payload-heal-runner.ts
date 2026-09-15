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
 * The builder closures are BULK-backed and memoised per run, not per-item
 * reads. Per item they would be one `getFileMetricsBulk` + one `getFanInP95`
 * per file and three point reads per symbol — tens of thousands of daemon
 * round-trips on a first heal, which names every file there is. Instead the
 * first call of each loads the whole graph's signals once (exactly what the
 * provider's finalize pass does) and every later call is a map lookup.
 */

import type {
  ChunkGraphSignals,
  GraphDbClient,
  PersistedSymbolLineRanges,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { ChunkSignalOverlay } from "../../../contracts/types/provider.js";
import {
  CodegraphPayloadHealer,
  type CodegraphPayloadHealChunkRef,
  type CodegraphPayloadHealOutcome,
  type CodegraphPayloadHealRunner,
} from "../../../domains/ingest/pipeline/enrichment/codegraph-payload-heal.js";
import {
  CodegraphChunkSettlementTally,
  settleCodegraphChunkSignals,
  type CodegraphChunkRangeSource,
} from "../../../domains/trajectory/codegraph/symbols/chunk-signal-settlement.js";
import { buildCodegraphFileSignals } from "../../../domains/trajectory/codegraph/symbols/payload-signals.js";

/** Per-file metrics read in batches of this size, mirroring the provider's finalize read-back. */
const HEAL_METRICS_READ_BATCH = 2000;

const ZERO_FILE_METRICS = { fanIn: 0, fanOut: 0, transitiveImpact: 0 };

/** The key one healed point is settled under — the settlement is per point, so any single key does. */
const HEALED_POINT = "point";

export interface CodegraphPayloadHealRunnerDeps {
  qdrant: {
    scrollPayloadPages: (
      collectionName: string,
      payloadInclude: string[],
      pageSize?: number,
    ) => AsyncGenerator<{ id: string | number; payload: Record<string, unknown> }[]>;
    /** The per-file read shape of the heal (bd tea-rags-mcp-ivp12). */
    scrollFiltered: (
      collectionName: string,
      filter: Record<string, unknown>,
      limit: number,
      pageSize?: number,
      payloadInclude?: string[],
    ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
    /** Collection size, the input to choosing between the two read shapes. */
    countPoints: (collectionName: string, filter?: Record<string, unknown>) => Promise<number>;
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
  acquireGraphDb: (collectionName: PhysicalCollectionName) => Promise<GraphDbClient>;
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
      collectionName: PhysicalCollectionName,
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

      const settlementTally = new CodegraphChunkSettlementTally();
      const healer = new CodegraphPayloadHealer({
        qdrant: deps.qdrant,
        providerKey: deps.providerKey,
        ...createSignalBuilders(
          graphDb,
          changed.files.map((f) => f.relPath),
          [...new Set(changed.symbols.map((s) => s.relPath))],
          settlementTally,
        ),
      });
      const outcome = await healer.heal(collectionName, changed, skipRelPaths, enrichedAt);
      // Unconditional and once per run: an unsettled point keeps a payload the
      // graph no longer agrees with, and nothing else says so.
      const unsettled = settlementTally.describeUnsettled("payload heal");
      if (unsettled !== undefined) process.stderr.write(`${unsettled}\n`);

      // ONLY after the rewrite landed. Refreshing the baseline first would erase
      // the diff, and a heal that threw would leave the drift invisible until
      // each affected file happened to change again.
      await graphDb.refreshSymbolSignalsPrev();
      return outcome;
    },
  };
}

/**
 * The injected builders and the chunk-owner resolver, each backed by bulk reads
 * taken lazily on first use. `heal` skips the files this run already rewrote,
 * so the file read is scoped to the diff's own paths and the range read to the
 * files whose symbols moved, while the symbol read is whole-graph — which is
 * what `getChunkSignalsBulk` is, there being no setwise per-symbol form.
 *
 * The chunk half is ONE settlement per point (bd tea-rags-mcp-39xca.2), the
 * computation every other producer of `codegraph.symbols.chunk.*` runs: the
 * resolver hands back the owner it settled, and `buildChunkSignals` hands back
 * the signals that same settlement computed — never a second derivation. A
 * point the settlement leaves unsettled resolves to no owner, so the healer
 * leaves its payload alone, and the tally counts it.
 */
function createSignalBuilders(
  graphDb: GraphDbClient,
  changedFilePaths: readonly string[],
  changedSymbolFilePaths: readonly string[],
  settlementTally: CodegraphChunkSettlementTally,
): {
  buildFileSignals: (relPath: string) => Promise<Record<string, unknown> | null>;
  buildChunkSignals: (relPath: string, symbolId: string) => Promise<Record<string, unknown> | null>;
  resolveChunkOwner: (relPath: string, chunk: CodegraphPayloadHealChunkRef) => Promise<string | undefined>;
} {
  let filePass:
    | Promise<{ metrics: Map<string, { fanIn: number; fanOut: number; transitiveImpact: number }>; fanInP95: number }>
    | undefined;
  let chunkPass:
    | Promise<{ signals: Map<SymbolId, ChunkGraphSignals>; ranges: Map<string, PersistedSymbolLineRanges> }>
    | undefined;
  /** Owner → the signals its settlement computed, read back by `buildChunkSignals`. */
  const settledSignals = new Map<SymbolId, ChunkSignalOverlay>();

  const loadPersistedRanges = async (): Promise<Map<string, PersistedSymbolLineRanges>> => {
    const ranges = new Map<string, PersistedSymbolLineRanges>();
    for (let start = 0; start < changedSymbolFilePaths.length; start += HEAL_METRICS_READ_BATCH) {
      const batch = changedSymbolFilePaths.slice(start, start + HEAL_METRICS_READ_BATCH);
      for (const [relPath, fileRanges] of await graphDb.getSymbolLineRangesBulk(batch)) ranges.set(relPath, fileRanges);
    }
    return ranges;
  };

  const loadChunkSettlementInputs = async (): Promise<{
    signals: Map<SymbolId, ChunkGraphSignals>;
    ranges: Map<string, PersistedSymbolLineRanges>;
  }> => {
    const signals = await graphDb.getChunkSignalsBulk();
    return { signals, ranges: await loadPersistedRanges() };
  };

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
    buildChunkSignals: async (_relPath, symbolId) => Promise.resolve(settledSignals.get(symbolId) ?? null),
    // Persisted ranges, not the walk's: the heal runs outside any walk. A point
    // with no line span, a file whose rows predate migration 024, or one the
    // graph holds no row for is UNSETTLED — never the anchor owner the heal used
    // to fall back to (bd tea-rags-mcp-39xca.2).
    resolveChunkOwner: async (relPath, chunk) => {
      chunkPass ??= loadChunkSettlementInputs();
      const { signals, ranges } = await chunkPass;
      if (chunk.startLine === undefined || chunk.endLine === undefined) {
        settlementTally.recordUnsettled(relPath, "chunk-without-line-span", 1);
        return undefined;
      }
      const settlement = settleCodegraphChunkSignals(
        persistedRangeSource(ranges.get(relPath)),
        [{ chunkId: HEALED_POINT, startLine: chunk.startLine, endLine: chunk.endLine, symbolId: chunk.symbolId }],
        signals,
      );
      settlementTally.record(relPath, settlement, 1);
      if (settlement.kind !== "signals") return undefined;
      const settled = settlement.chunks.get(HEALED_POINT);
      if (settled?.kind !== "owned") return undefined;
      settledSignals.set(settled.owner, settled.signals);
      return settled.owner;
    },
  };
}

/** A file absent from the range read has no row at all — zero ranges, zero unranged rows. */
function persistedRangeSource(persisted: PersistedSymbolLineRanges | undefined): CodegraphChunkRangeSource {
  return { kind: "persisted", ranges: persisted?.ranges ?? [], rowsWithoutRanges: persisted?.rowsWithoutRanges ?? 0 };
}
